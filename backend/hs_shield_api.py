"""Owner-only API for HS Shield telemetry and staged protection state."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.models.admin import AdminDetails
from app.routers.authentication import get_current

router = APIRouter(tags=["HS Shield"], prefix="/api/hs-shield")
DATA_DIR = Path(os.getenv("HS_SHIELD_DATA_DIR", "/var/lib/pasarguard/hs-plugin/shield"))
STATUS_FILE = DATA_DIR / "status.json"
CONFIG_FILE = DATA_DIR / "config.json"
EVENTS_FILE = DATA_DIR / "events.jsonl"

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": True,
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
    auto_stage: bool | None = None


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
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _events(limit: int) -> list[dict[str, Any]]:
    try:
        lines = EVENTS_FILE.read_text(encoding="utf-8").splitlines()
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
async def get_status(
    _owner: AdminDetails = Depends(_require_owner),
):
    status_value = _read_json(
        STATUS_FILE,
        {
            "version": 1,
            "stage": "starting",
            "mode": "observe",
            "enabled": True,
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
    config = _read_json(CONFIG_FILE, DEFAULT_CONFIG)
    # Phase 1 is intentionally observe-only regardless of stale/manual file edits.
    config["mode"] = "observe"
    return {"status": status_value, "config": config, "events": _events(30)}


@router.get("/events")
async def get_events(
    limit: int = Query(default=50, ge=1, le=200),
    _owner: AdminDetails = Depends(_require_owner),
):
    return {"events": _events(limit)}


@router.put("/config")
async def update_config(
    body: ShieldConfigBody,
    _owner: AdminDetails = Depends(_require_owner),
):
    config = _read_json(CONFIG_FILE, DEFAULT_CONFIG)
    for key, value in DEFAULT_CONFIG.items():
        config.setdefault(key, value)
    if body.enabled is not None:
        config["enabled"] = body.enabled
    if body.auto_stage is not None:
        config["auto_stage"] = body.auto_stage
    # Never expose an enforcement switch until preflight + automatic rollback exist.
    config["mode"] = "observe"
    config["safe_fail_open"] = True
    _write_json(CONFIG_FILE, config)
    return {"ok": True, "config": config, "requires_restart": False}
