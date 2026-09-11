"""Owner-only API for HS Shield telemetry, power controls and staged protection state."""
from __future__ import annotations

import fcntl
import json
import os
import tempfile
from collections import deque
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.hs_firewall import validate_policy
from app.models.admin import AdminDetails
from app.routers.authentication import get_current

router = APIRouter(tags=["HS Shield"], prefix="/api/hs-shield")
DATA_DIR = Path(os.getenv("HS_SHIELD_DATA_DIR", "/var/lib/pasarguard/hs-plugin/shield"))
STATUS_FILE = DATA_DIR / "status.json"
CONFIG_FILE = DATA_DIR / "config.json"
EVENTS_FILE = DATA_DIR / "events.jsonl"

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": True,
    "telemetry_enabled": True,
    "low_cpu_mode": True,
    "integration_guard_enabled": True,
    "mode": "observe",
    "auto_stage": True,
    "safe_fail_open": True,
    "elevated_pps_multiplier": 4.0,
    "attack_pps_multiplier": 8.0,
    "elevated_bps_multiplier": 4.0,
    "attack_bps_multiplier": 8.0,
    "elevated_syn_recv": 128,
    "attack_syn_recv": 512,
}


class ShieldConfigBody(BaseModel):
    enabled: bool | None = None
    telemetry_enabled: bool | None = None
    low_cpu_mode: bool | None = None
    integration_guard_enabled: bool | None = None
    auto_stage: bool | None = None
    mode: Literal["observe", "enforce"] | None = None
    policy: dict | None = None


def _require_authenticated(current_admin: AdminDetails | None = Depends(get_current)) -> AdminDetails:
    if current_admin is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return current_admin


def _require_owner(current_admin: AdminDetails = Depends(_require_authenticated)) -> AdminDetails:
    if not current_admin.role or not current_admin.role.is_owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="HS Shield is owner-only")
    return current_admin


def _read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else dict(default)
    except (OSError, ValueError, TypeError):
        return dict(default)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=DATA_DIR, delete=False, encoding="utf-8") as file:
        temp = Path(file.name)
        os.chmod(temp, 0o600)
        json.dump(value, file, ensure_ascii=False)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temp, path)


@contextmanager
def _lock():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with (DATA_DIR / ".config.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _events(limit: int) -> list[dict[str, Any]]:
    try:
        with EVENTS_FILE.open(encoding="utf-8") as handle:
            lines = list(deque(handle, maxlen=limit * 2))
    except OSError:
        return []
    out: list[dict[str, Any]] = []
    for line in reversed(lines[-max(limit * 2, limit):]):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            out.append(value)
        if len(out) >= limit:
            break
    return out


@router.get("/status")
async def get_status(_owner: AdminDetails = Depends(_require_owner)):
    config = {**DEFAULT_CONFIG, **_read_json(CONFIG_FILE, DEFAULT_CONFIG)}
    status_value = _read_json(
        STATUS_FILE,
        {
            "version": 2,
            "stage": "starting",
            "mode": "observe",
            "enabled": True,
            "telemetry_enabled": True,
            "low_cpu_mode": True,
            "integration_guard_enabled": True,
            "enforcement": {
                "active": False,
                "policy": "observe-only",
                "traffic_modified": False,
                "fail_open": True,
            },
            "metrics": {"pps": 0, "bps": 0, "mbps": 0, "syn_recv": 0, "established": 0},
            "baseline": {"pps": 0, "bps": 0},
            "origin": {"state": "unknown", "public_bindings": [], "container": None},
            "layers": {},
            "layers_ready": 0,
            "layers_total": 0,
            "updated_at": None,
        },
    )
    updated = status_value.get("updated_at")
    if not config.get("telemetry_enabled", True):
        stale_after = 75
    elif config.get("low_cpu_mode", True):
        stale_after = 35
    else:
        stale_after = 20
    try:
        stale = not updated or (datetime.now(UTC) - datetime.fromisoformat(updated)).total_seconds() > stale_after
    except (ValueError, TypeError):
        stale = True
    status_value["stale"] = stale
    if stale:
        status_value["stage"] = "unavailable"
    return {"status": status_value, "config": config, "events": _events(30)}


@router.get("/events")
async def get_events(limit: int = Query(default=50, ge=1, le=200), _owner: AdminDetails = Depends(_require_owner)):
    return {"events": _events(limit)}


@router.put("/config")
async def update_config(body: ShieldConfigBody, _owner: AdminDetails = Depends(_require_owner)):
    with _lock():
        config = {**DEFAULT_CONFIG, **_read_json(CONFIG_FILE, DEFAULT_CONFIG)}
        updates = body.model_dump(exclude_none=True)
        if body.policy is not None:
            try:
                updates["policy"] = validate_policy(body.policy)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
        config.update(updates)
        if body.mode == "enforce" or body.policy is not None:
            config.pop("confirmed_token", None)
        config["safe_fail_open"] = True
        _write_json(CONFIG_FILE, config)
    return {"ok": True, "config": config, "requires_restart": False}


class ConfirmBody(BaseModel):
    token: str


@router.post("/confirm")
async def confirm_policy(body: ConfirmBody, _owner: AdminDetails = Depends(_require_owner)):
    import time

    with _lock():
        pending = _read_json(STATUS_FILE, {}).get("enforcement", {}).get("pending") or {}
        if pending.get("token") != body.token or pending.get("deadline", 0) <= time.time():
            raise HTTPException(409, "No matching pending firewall policy")
        config = _read_json(CONFIG_FILE, DEFAULT_CONFIG)
        config["confirmed_token"] = body.token
        _write_json(CONFIG_FILE, config)
    return {"ok": True, "message": "Confirmation queued; check enforcement status"}
