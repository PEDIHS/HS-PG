"""Owner API and authenticated self-service read endpoints for HS Plugin."""
from __future__ import annotations

import fcntl
import json
import os
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.db import AsyncSession, get_db
from app.db.models import CoreConfig, Node, ProxyHost
from app.hs_admin_time import get_admin_time_info, resume_all_suspended, set_admin_time_days
from app.models.admin import AdminDetails
from app.models.node import NodeListQuery
from app.operation import OperatorType
from app.operation.node import NodeOperation
from app.routers.authentication import get_current

router = APIRouter(tags=["HS Plugin"], prefix="/api/hs-plugin")
node_operator = NodeOperation(operator_type=OperatorType.API)
DATA_DIR = Path(os.getenv("HS_PLUGIN_DATA_DIR", "/var/lib/pasarguard/hs-plugin"))
STATE_FILE = DATA_DIR / "state.json"
LOCK_FILE = DATA_DIR / ".state.lock"


class ToggleBody(BaseModel):
    enabled: bool


class RatioBody(BaseModel):
    ratio: float = Field(ge=0, le=100)


class AdminTimeBody(BaseModel):
    days: int | None = Field(default=None, ge=1, le=36_500)


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


def _load_state() -> dict:
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise TypeError
    except (OSError, json.JSONDecodeError, TypeError):
        value = _default_state()
    value.setdefault("version", 1)
    features = value.setdefault("features", {})
    features.setdefault("host_usage_ratio", {"enabled": True})
    features.setdefault("node_pro", {"enabled": False})
    features.setdefault("backup_web", {"enabled": False})
    features.setdefault("admin_time_limit", {"enabled": True})
    for name in ("certificate_manager", "warp", "mtproxy", "fair_use"):
        features.setdefault(name, {"enabled": False})
    value.setdefault("inbound_offsets", {})
    value.setdefault("admin_time_limits", {})
    return value


@contextmanager
def _write_lock():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK_FILE.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _save_state(value: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    value["updated_at"] = datetime.now(UTC).isoformat()
    tmp = STATE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


def _require_authenticated(current_admin: AdminDetails | None = Depends(get_current)) -> AdminDetails:
    if current_admin is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return current_admin


def _require_owner(current_admin: AdminDetails = Depends(_require_authenticated)) -> AdminDetails:
    if not current_admin.role or not current_admin.role.is_owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="HS Plugin settings are owner-only")
    return current_admin


def _normalize_address(value: str | None) -> str:
    value = (value or "").strip().lower()
    if not value:
        return ""
    candidate = value if "://" in value else f"//{value}"
    try:
        parsed = urlsplit(candidate)
        host = parsed.hostname
        if host:
            return host.rstrip(".")
    except ValueError:
        pass
    return value.strip("[]").split(":", 1)[0].rstrip(".")


def _core_inbound_tags(config: object, excluded: object) -> set[str]:
    if not isinstance(config, dict):
        return set()
    inbounds = config.get("inbounds")
    if not isinstance(inbounds, list):
        return set()
    tags = {
        str(item.get("tag"))
        for item in inbounds
        if isinstance(item, dict) and item.get("tag") is not None and str(item.get("tag"))
    }
    excluded_tags = set(excluded or [])
    return tags - excluded_tags


async def _node_rows(db: AsyncSession) -> list[dict]:
    core_rows = (
        await db.execute(select(CoreConfig.id, CoreConfig.config, CoreConfig.exclude_inbound_tags))
    ).all()
    core_tags = {
        int(core_id): _core_inbound_tags(config, excluded)
        for core_id, config, excluded in core_rows
    }

    rows = (
        await db.execute(
            select(Node.id, Node.name, Node.address, Node.usage_coefficient, Node.core_config_id)
            .order_by(Node.id.asc())
        )
    ).all()
    result = []
    for node_id, name, address, usage_coefficient, core_config_id in rows:
        effective_core_id = int(core_config_id) if core_config_id is not None else 1
        result.append(
            {
                "id": int(node_id),
                "name": name,
                "address": address,
                "usage_ratio": 1.0 if usage_coefficient is None else float(usage_coefficient),
                "core_config_id": effective_core_id,
                "inbound_tags": core_tags.get(effective_core_id, set()),
            }
        )
    return result


def _resolve_inherited_node_ratio(
    host_addresses,
    nodes: list[dict],
    inbound_tag: str | None = None,
) -> tuple[float, int | None, str]:
    """Resolve the Node ratio that should be shown as the Host baseline."""
    tag_matches = [n for n in nodes if inbound_tag and inbound_tag in n.get("inbound_tags", set())]
    candidates = tag_matches or nodes

    normalized_hosts = {_normalize_address(x) for x in (host_addresses or []) if _normalize_address(x)}
    address_matches = [n for n in candidates if _normalize_address(n.get("address")) in normalized_hosts]
    if len(address_matches) == 1:
        node = address_matches[0]
        source = "inbound-address-match" if tag_matches else "address-match"
        return float(node["usage_ratio"]), int(node["id"]), source

    if len(tag_matches) == 1:
        node = tag_matches[0]
        return float(node["usage_ratio"]), int(node["id"]), "inbound-core-match"

    if tag_matches:
        distinct = {round(float(n["usage_ratio"]), 12) for n in tag_matches}
        if len(distinct) == 1:
            return float(tag_matches[0]["usage_ratio"]), None, "inbound-common-ratio"
        return 1.0, None, "ambiguous-inbound-nodes"

    if len(nodes) == 1:
        node = nodes[0]
        return float(node["usage_ratio"]), int(node["id"]), "single-node"

    distinct = {round(float(n["usage_ratio"]), 12) for n in nodes}
    if len(distinct) == 1 and nodes:
        return float(nodes[0]["usage_ratio"]), None, "common-node-ratio"

    return 1.0, None, "unresolved"


async def _migrate_legacy_ratios(db: AsyncSession, state: dict) -> dict:
    """Convert v1 absolute Host ratios into v2 Node-relative offsets."""
    if int(state.get("version", 1) or 1) >= 2 and "inbound_ratios" not in state:
        state.setdefault("inbound_offsets", {})
        return state

    legacy = state.get("inbound_ratios", {})
    offsets = state.setdefault("inbound_offsets", {})
    if isinstance(legacy, dict) and legacy:
        nodes = await _node_rows(db)
        rows = (
            await db.execute(
                select(ProxyHost.inbound_tag, ProxyHost.address)
                .where(ProxyHost.inbound_tag.is_not(None))
                .order_by(ProxyHost.id.asc())
            )
        ).all()
        first_addresses: dict[str, object] = {}
        for inbound_tag, addresses in rows:
            if inbound_tag and inbound_tag not in first_addresses:
                first_addresses[inbound_tag] = addresses

        for inbound_tag, final_ratio in legacy.items():
            if not isinstance(inbound_tag, str) or not inbound_tag:
                continue
            try:
                final_ratio = float(final_ratio)
            except (TypeError, ValueError):
                continue
            inherited, _node_id, _source = _resolve_inherited_node_ratio(
                first_addresses.get(inbound_tag), nodes, inbound_tag
            )
            offset = final_ratio - inherited
            if abs(offset) >= 1e-9:
                offsets[inbound_tag] = offset

    state.pop("inbound_ratios", None)
    state["version"] = 2
    with _write_lock():
        _save_state(state)
    return state


async def _host_rows(db: AsyncSession, state: dict) -> list[dict]:
    rows = (
        await db.execute(
            select(ProxyHost.id, ProxyHost.remark, ProxyHost.inbound_tag, ProxyHost.address).order_by(ProxyHost.id.asc())
        )
    ).all()
    nodes = await _node_rows(db)
    shared: dict[str, list[int]] = {}
    for host_id, _remark, inbound_tag, _address in rows:
        if inbound_tag:
            shared.setdefault(inbound_tag, []).append(int(host_id))

    offsets = state.get("inbound_offsets", {})
    result = []
    for host_id, remark, inbound_tag, addresses in rows:
        inherited_ratio, inherited_node_id, inherited_source = _resolve_inherited_node_ratio(
            addresses, nodes, inbound_tag
        )
        raw_offset = offsets.get(inbound_tag, 0.0) if inbound_tag else 0.0
        try:
            offset = float(raw_offset)
        except (TypeError, ValueError):
            offset = 0.0
        effective_ratio = max(0.0, inherited_ratio + offset)
        result.append(
            {
                "id": int(host_id),
                "remark": remark,
                "inbound_tag": inbound_tag,
                "usage_ratio": effective_ratio,
                "node_usage_ratio": inherited_ratio,
                "usage_ratio_offset": offset,
                "node_id": inherited_node_id,
                "node_ratio_source": inherited_source,
                "is_overridden": abs(offset) >= 1e-9,
                "shared_host_ids": shared.get(inbound_tag, []) if inbound_tag else [],
                "shared_inbound": bool(inbound_tag and len(shared.get(inbound_tag, [])) > 1),
            }
        )
    return result


@router.get("/state")
async def get_state(
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    state = await _migrate_legacy_ratios(db, _load_state())
    return {
        "version": state.get("version", 2),
        "features": state.get("features", {}),
        "updated_at": state.get("updated_at"),
        "hosts": await _host_rows(db, state),
        "accounting": {
            "mode": "per-inbound-attribution",
            "shared_inbound_policy": "same-ratio",
            "host_ratio_semantics": "node-relative-offset",
            "effective_formula": "raw_usage * max(0, actual_node_usage_ratio + host_ratio_offset)",
        },
    }


@router.put("/features/{feature_name}")
async def set_feature(
    feature_name: str,
    body: ToggleBody,
    _owner: AdminDetails = Depends(_require_owner),
):
    if feature_name not in {"host_usage_ratio", "node_pro", "backup_web", "admin_time_limit", "certificate_manager", "warp", "mtproxy", "fair_use"}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown HS Plugin feature")
    if feature_name == "fair_use" and body.enabled:
        raise HTTPException(409, "Fair use requires a verified per-user node bandwidth adapter; saved policies are drafts")
    with _write_lock():
        state = _load_state()
        state.setdefault("features", {}).setdefault(feature_name, {})["enabled"] = body.enabled
        _save_state(state)

    if feature_name == "admin_time_limit" and not body.enabled:
        # Disabling the feature must never strand users in HS-expired state.
        await resume_all_suspended()

    return {
        "ok": True,
        "feature": feature_name,
        "enabled": body.enabled,
        "requires_resync": feature_name == "host_usage_ratio",
    }


@router.get("/admin-time/me")
async def get_my_admin_time(
    db: AsyncSession = Depends(get_db),
    current_admin: AdminDetails = Depends(_require_authenticated),
):
    """Return only the caller's Admin Time state; safe for non-owner admins."""
    try:
        return await get_admin_time_info(db, current_admin.username)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Admin not found") from exc


@router.get("/admin-time/by-username/{username}")
async def get_admin_time(
    username: str,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    try:
        return await get_admin_time_info(db, username)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Admin not found") from exc


@router.put("/admin-time/by-username/{username}")
async def set_admin_time(
    username: str,
    body: AdminTimeBody,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    try:
        return await set_admin_time_days(db, username, body.days)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Admin not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.post("/admin-time/by-username/{username}/reset")
async def reset_admin_time(
    username: str,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    """Restart the configured Admin Time duration from now.

    This mirrors PasarGuard's reset-data UX: the plan length is preserved while
    the current countdown is reset. A suspended admin is resumed first by the
    existing set_admin_time_days implementation, so paused user clocks remain
    lossless.
    """
    try:
        info = await get_admin_time_info(db, username)
        duration_days = info.get("duration_days")
        if not info.get("configured") or not duration_days:
            raise ValueError("Admin Time is unlimited; set a duration before resetting it")
        return await set_admin_time_days(db, username, int(duration_days))
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Admin not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


@router.put("/hosts/{host_id}/usage-ratio")
async def set_host_usage_ratio(
    host_id: int,
    body: RatioBody,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    row = (
        await db.execute(
            select(ProxyHost.id, ProxyHost.remark, ProxyHost.inbound_tag, ProxyHost.address).where(ProxyHost.id == host_id)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Host not found")
    inbound_tag = row.inbound_tag
    if not inbound_tag:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Host has no inbound")

    sibling_ids = list(
        (
            await db.execute(select(ProxyHost.id).where(ProxyHost.inbound_tag == inbound_tag).order_by(ProxyHost.id.asc()))
        ).scalars().all()
    )
    nodes = await _node_rows(db)
    inherited_ratio, inherited_node_id, inherited_source = _resolve_inherited_node_ratio(
        row.address, nodes, inbound_tag
    )
    if inherited_source in {"ambiguous-inbound-nodes", "unresolved"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot determine a unique Node Usage Ratio baseline for this Host/inbound",
        )
    offset = float(body.ratio) - inherited_ratio

    state = await _migrate_legacy_ratios(db, _load_state())
    with _write_lock():
        offsets = state.setdefault("inbound_offsets", {})
        if abs(offset) < 1e-9:
            offsets.pop(inbound_tag, None)
            offset = 0.0
        else:
            offsets[inbound_tag] = offset
        state["version"] = 2
        _save_state(state)

    return {
        "ok": True,
        "host_id": host_id,
        "inbound_tag": inbound_tag,
        "usage_ratio": max(0.0, inherited_ratio + offset),
        "node_usage_ratio": inherited_ratio,
        "usage_ratio_offset": offset,
        "node_id": inherited_node_id,
        "node_ratio_source": inherited_source,
        "is_overridden": abs(offset) >= 1e-9,
        "affected_host_ids": [int(x) for x in sibling_ids],
        "shared_inbound": len(sibling_ids) > 1,
        "requires_resync": True,
    }


@router.post("/resync")
async def resync_nodes(
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    nodes = await node_operator.get_db_nodes(db, NodeListQuery())
    ok: list[int] = []
    failed: list[dict] = []
    for node in nodes.nodes:
        try:
            await node_operator.sync_node_users(db, node.id, flush_users=True)
            ok.append(int(node.id))
        except Exception as exc:
            failed.append({"id": int(node.id), "error": str(exc)[:240]})
    return {"ok": not failed, "synced_node_ids": ok, "failed": failed}
