"""HS Admin Time Limit runtime for PasarGuard.

Admin time limits live outside PasarGuard's database so the feature survives
upstream updates without a migration. When an admin time limit expires, all of
that admin's users are snapshotted and temporarily marked expired. Their own
expiry/on-hold clocks are restored relative to the renewal moment, so time is
actually paused rather than consumed while the admin is suspended.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app import scheduler
from app.db import AsyncSession, GetDB
from app.db.models import Admin, AdminStatus, User, UserStatus
from app.node.sync import remove_users, sync_users
from config import runtime_settings

DATA_DIR = Path(os.getenv("HS_PLUGIN_DATA_DIR", "/var/lib/pasarguard/hs-plugin"))
STATE_FILE = DATA_DIR / "state.json"
STATE_LOCK_FILE = DATA_DIR / ".state.lock"
TIME_LOCK_FILE = DATA_DIR / ".admin-time.lock"
SNAPSHOT_DIR = DATA_DIR / "admin-time"
SECONDS_PER_DAY = 86_400
JOB_INTERVAL_SECONDS = max(10, int(os.getenv("HS_ADMIN_TIME_INTERVAL", "15")))


def utc_now() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _iso(value: datetime | None) -> str | None:
    value = _aware(value)
    return value.isoformat() if value else None


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return _aware(datetime.fromisoformat(value))
    except ValueError:
        return None


def _remaining_seconds(value: datetime | None, now: datetime) -> int | None:
    value = _aware(value)
    if value is None:
        return None
    return max(0, int((value - now).total_seconds()))


def _default_state() -> dict:
    return {
        "version": 2,
        "features": {
            "host_usage_ratio": {"enabled": True},
            "node_pro": {"enabled": False},
            "backup_web": {"enabled": False},
            "admin_time_limit": {"enabled": True},
        },
        "inbound_offsets": {},
        "admin_time_limits": {},
        "updated_at": None,
    }


def _normalize_state(value: dict) -> dict:
    value.setdefault("version", 2)
    features = value.setdefault("features", {})
    features.setdefault("host_usage_ratio", {"enabled": True})
    features.setdefault("node_pro", {"enabled": False})
    features.setdefault("backup_web", {"enabled": False})
    features.setdefault("admin_time_limit", {"enabled": True})
    value.setdefault("inbound_offsets", {})
    limits = value.setdefault("admin_time_limits", {})
    if not isinstance(limits, dict):
        value["admin_time_limits"] = {}
    value.setdefault("updated_at", None)
    return value


def _load_state() -> dict:
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise TypeError
    except (OSError, json.JSONDecodeError, TypeError):
        value = _default_state()
    return _normalize_state(value)


def _save_state(value: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    value = _normalize_state(value)
    value["updated_at"] = utc_now().isoformat()
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


@contextmanager
def _state_lock():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with STATE_LOCK_FILE.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


@contextmanager
def _operation_lock():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with TIME_LOCK_FILE.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def feature_enabled() -> bool:
    return bool(_load_state().get("features", {}).get("admin_time_limit", {}).get("enabled", True))


def _entry(username: str) -> dict | None:
    raw = _load_state().get("admin_time_limits", {}).get(username)
    return dict(raw) if isinstance(raw, dict) else None


def _set_entry(username: str, value: dict | None) -> None:
    with _state_lock():
        state = _load_state()
        limits = state.setdefault("admin_time_limits", {})
        if value is None:
            limits.pop(username, None)
        else:
            limits[username] = value
        _save_state(state)


def _snapshot_path(username: str) -> Path:
    digest = hashlib.sha256(username.encode("utf-8")).hexdigest()[:24]
    return SNAPSHOT_DIR / f"admin-{digest}.json"


def _write_snapshot(username: str, snapshot: dict) -> None:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(SNAPSHOT_DIR, 0o700)
    target = _snapshot_path(username)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)


def _load_snapshot(username: str) -> dict | None:
    target = _snapshot_path(username)
    try:
        value = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return None
    if not isinstance(value, dict) or value.get("username") != username:
        return None
    if not isinstance(value.get("users"), dict):
        return None
    return value


def _delete_snapshot(username: str) -> None:
    try:
        _snapshot_path(username).unlink(missing_ok=True)
    except OSError:
        pass


def _snapshot_user(user: User, now: datetime) -> dict:
    expire = _aware(user.expire)
    on_hold_timeout = _aware(user.on_hold_timeout)
    return {
        "status": user.status.value,
        "expire_present": expire is not None,
        "expire_remaining_seconds": _remaining_seconds(expire, now),
        "expire_elapsed": bool(expire is not None and expire <= now),
        "on_hold_timeout_present": on_hold_timeout is not None,
        "on_hold_timeout_remaining_seconds": _remaining_seconds(on_hold_timeout, now),
    }


async def _get_admin(db: AsyncSession, username: str) -> Admin | None:
    stmt = select(Admin).options(selectinload(Admin.role)).where(Admin.username == username)
    return (await db.execute(stmt)).unique().scalar_one_or_none()


async def _get_users(db: AsyncSession, admin_id: int) -> list[User]:
    stmt = select(User).where(User.admin_id == admin_id).order_by(User.id.asc())
    return list((await db.execute(stmt)).scalars().all())


def _assert_supported(admin: Admin) -> None:
    role = getattr(admin, "role", None)
    if role is not None and bool(getattr(role, "is_owner", False)):
        raise PermissionError("Owner account cannot use HS Admin Time Limit")


async def get_admin_time_info(db: AsyncSession, username: str) -> dict:
    admin = await _get_admin(db, username)
    if admin is None:
        raise KeyError(username)

    supported = not bool(admin.role and admin.role.is_owner)
    entry = _entry(username)
    now = utc_now()
    expires_at = _parse_iso(entry.get("expires_at")) if entry else None
    remaining = _remaining_seconds(expires_at, now)
    return {
        "username": username,
        "supported": supported,
        "enabled": feature_enabled(),
        "configured": bool(entry and expires_at),
        "unlimited": not bool(entry and expires_at),
        "duration_days": int(entry.get("duration_days") or 0) if entry else None,
        "expires_at": _iso(expires_at),
        "remaining_seconds": remaining,
        "remaining_days": None if remaining is None else remaining / SECONDS_PER_DAY,
        "suspended": bool(entry and entry.get("suspended")),
        "suspended_at": entry.get("suspended_at") if entry else None,
        "notification_sent_at": entry.get("notification_sent_at") if entry else None,
    }


async def _send_expiry_notification(admin: Admin) -> bool:
    if not admin.telegram_id:
        return False
    try:
        from app.notification.client import send_telegram_message

        await send_telegram_message(
            "⏳ <b>HS Time Limit</b>\n\n"
            "زمان اعتبار اکانت مدیریتی شما به پایان رسید.\n"
            "تمام کاربران شما موقتاً متوقف شده‌اند و زمان باقی‌مانده آن‌ها محفوظ است.\n"
            "پس از تمدید، کاربران از همان زمان و وضعیت قبلی ادامه می‌دهند.",
            chat_id=admin.telegram_id,
        )
        return True
    except Exception:
        return False


async def _suspend_admin_locked(db: AsyncSession, admin: Admin, entry: dict) -> dict:
    now = utc_now()
    username = admin.username
    snapshot = _load_snapshot(username)
    users = await _get_users(db, admin.id)
    was_suspended = bool(entry.get("suspended"))

    if snapshot is None:
        snapshot = {
            "version": 1,
            "username": username,
            "captured_at": now.isoformat(),
            "admin_status_before": admin.status.value,
            "users": {},
        }

    snap_users = snapshot.setdefault("users", {})
    changed_snapshot = False
    users_to_remove: list[User] = []
    for user in users:
        key = str(user.id)
        is_new = key not in snap_users
        if is_new:
            snap_users[key] = _snapshot_user(user, now)
            changed_snapshot = True
        # On the first expiry remove everyone. Later ticks only touch users that
        # were newly created or manually reactivated while their admin is paused.
        if not was_suspended or is_new or user.status != UserStatus.expired:
            if user.status != UserStatus.expired:
                user.status = UserStatus.expired
                user.last_status_change = now
            user.expire = now
            users_to_remove.append(user)

    if changed_snapshot or not _snapshot_path(username).exists():
        # Persist original user clocks before changing any database state.
        _write_snapshot(username, snapshot)

    db_changed = bool(users_to_remove)
    if admin.status != AdminStatus.disabled and admin.status != AdminStatus.limited:
        admin.status = AdminStatus.limited
        admin.last_status_change = now
        db_changed = True

    if db_changed:
        await db.commit()
    if users_to_remove:
        await remove_users(users_to_remove)

    entry = dict(entry)
    entry["suspended"] = True
    if not entry.get("suspended_at"):
        entry["suspended_at"] = now.isoformat()
    if "notification_sent_at" not in entry:
        entry["notification_sent_at"] = None
    _set_entry(username, entry)

    if not entry.get("notification_sent_at") and await _send_expiry_notification(admin):
        entry["notification_sent_at"] = utc_now().isoformat()
        _set_entry(username, entry)

    return entry


def _restored_user_state(record: dict, now: datetime) -> tuple[UserStatus, datetime | None, datetime | None]:
    try:
        original_status = UserStatus(str(record.get("status") or "expired"))
    except ValueError:
        original_status = UserStatus.expired

    expire_present = bool(record.get("expire_present"))
    expire_remaining = record.get("expire_remaining_seconds")
    expire_elapsed = bool(record.get("expire_elapsed"))
    if expire_present:
        try:
            seconds = max(0, int(expire_remaining or 0))
        except (TypeError, ValueError):
            seconds = 0
        restored_expire = now + timedelta(seconds=seconds) if seconds > 0 else now
        if expire_elapsed and original_status in (UserStatus.active, UserStatus.on_hold):
            original_status = UserStatus.expired
    else:
        restored_expire = None

    timeout_present = bool(record.get("on_hold_timeout_present"))
    timeout_remaining = record.get("on_hold_timeout_remaining_seconds")
    if timeout_present:
        try:
            seconds = max(0, int(timeout_remaining or 0))
        except (TypeError, ValueError):
            seconds = 0
        restored_timeout = now + timedelta(seconds=seconds) if seconds > 0 else now
    else:
        restored_timeout = None

    return original_status, restored_expire, restored_timeout


async def _resume_admin_locked(db: AsyncSession, admin: Admin, entry: dict) -> dict:
    username = admin.username
    snapshot = _load_snapshot(username)
    if snapshot is None:
        raise RuntimeError(f"HS Admin Time snapshot is missing for {username}")

    now = utc_now()
    users = await _get_users(db, admin.id)
    users_by_id = {str(user.id): user for user in users}
    for user_id, record in snapshot.get("users", {}).items():
        user = users_by_id.get(str(user_id))
        if user is None or not isinstance(record, dict):
            continue
        status_value, expire_value, timeout_value = _restored_user_state(record, now)
        if user.status != status_value:
            user.status = status_value
            user.last_status_change = now
        user.expire = expire_value
        user.on_hold_timeout = timeout_value

    previous_status = str(snapshot.get("admin_status_before") or "active")
    if admin.status == AdminStatus.disabled or previous_status == AdminStatus.disabled.value:
        target_admin_status = AdminStatus.disabled
    elif admin.data_limit is not None and admin.data_limit > 0 and int(admin.used_traffic or 0) >= admin.data_limit:
        target_admin_status = AdminStatus.limited
    else:
        target_admin_status = AdminStatus.active

    if admin.status != target_admin_status:
        admin.status = target_admin_status
        admin.last_status_change = now

    await db.commit()

    # Re-add only users that should actually be usable. If traffic limits or a
    # manual admin disable still block the admin, node sync remains blocked.
    if target_admin_status == AdminStatus.active:
        resumable = [user for user in users if user.status in (UserStatus.active, UserStatus.on_hold)]
        if resumable:
            await sync_users(resumable)

    entry = dict(entry)
    entry["suspended"] = False
    entry["suspended_at"] = None
    entry["notification_sent_at"] = None
    _set_entry(username, entry)
    _delete_snapshot(username)
    return entry


async def set_admin_time_days(db: AsyncSession, username: str, days: int | None) -> dict:
    admin = await _get_admin(db, username)
    if admin is None:
        raise KeyError(username)
    _assert_supported(admin)

    if days is not None:
        days = int(days)
        if days < 1 or days > 36_500:
            raise ValueError("Time limit must be between 1 and 36500 days")

    with _operation_lock():
        current = _entry(username)
        if current and current.get("suspended"):
            current = await _resume_admin_locked(db, admin, current)

        if days is None:
            _set_entry(username, None)
            _delete_snapshot(username)
        else:
            now = utc_now()
            value = dict(current or {})
            value.update(
                {
                    "username": username,
                    "duration_days": days,
                    "expires_at": (now + timedelta(days=days)).isoformat(),
                    "suspended": False,
                    "suspended_at": None,
                    "notification_sent_at": None,
                    "updated_at": now.isoformat(),
                }
            )
            _set_entry(username, value)

    return await get_admin_time_info(db, username)


async def _cleanup_missing_admin(username: str) -> None:
    _set_entry(username, None)
    _delete_snapshot(username)


async def resume_all_suspended() -> None:
    state = _load_state()
    limits = dict(state.get("admin_time_limits", {}))
    async with GetDB() as db:
        for username, raw in limits.items():
            if not isinstance(raw, dict) or not raw.get("suspended"):
                continue
            with _operation_lock():
                entry = _entry(username)
                if not entry or not entry.get("suspended"):
                    continue
                admin = await _get_admin(db, username)
                if admin is None:
                    await _cleanup_missing_admin(username)
                    continue
                await _resume_admin_locked(db, admin, entry)


async def admin_time_job() -> None:
    if not feature_enabled():
        await resume_all_suspended()
        return

    limits = dict(_load_state().get("admin_time_limits", {}))
    if not limits:
        return

    async with GetDB() as db:
        for username in list(limits):
            with _operation_lock():
                entry = _entry(username)
                if not entry:
                    continue
                admin = await _get_admin(db, username)
                if admin is None:
                    await _cleanup_missing_admin(username)
                    continue
                if admin.role and admin.role.is_owner:
                    await _cleanup_missing_admin(username)
                    continue

                expires_at = _parse_iso(entry.get("expires_at"))
                if expires_at is None:
                    await _cleanup_missing_admin(username)
                    continue

                now = utc_now()
                if expires_at <= now:
                    await _suspend_admin_locked(db, admin, entry)
                elif entry.get("suspended"):
                    await _resume_admin_locked(db, admin, entry)


if runtime_settings.role.runs_scheduler:
    scheduler.add_job(
        admin_time_job,
        "interval",
        seconds=JOB_INTERVAL_SECONDS,
        coalesce=True,
        max_instances=1,
        start_date=utc_now(),
        id="hs_admin_time_limits",
        replace_existing=True,
    )
