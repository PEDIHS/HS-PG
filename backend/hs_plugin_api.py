"""Owner-only API for HS Plugin."""
from __future__ import annotations

import fcntl
import json
import os
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.db import AsyncSession, get_db
from app.db.models import ProxyHost
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


def _default_state() -> dict:
    return {
        "version": 1,
        "features": {"host_usage_ratio": {"enabled": True}},
        "inbound_ratios": {},
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
    value.setdefault("features", {}).setdefault("host_usage_ratio", {"enabled": True})
    value.setdefault("inbound_ratios", {})
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


def _require_owner(current_admin: AdminDetails | None = Depends(get_current)) -> AdminDetails:
    if current_admin is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    if not current_admin.role or not current_admin.role.is_owner:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="HS Plugin settings are owner-only")
    return current_admin


async def _host_rows(db: AsyncSession, state: dict) -> list[dict]:
    rows = (
        await db.execute(select(ProxyHost.id, ProxyHost.remark, ProxyHost.inbound_tag).order_by(ProxyHost.id.asc()))
    ).all()
    shared: dict[str, list[int]] = {}
    for host_id, _remark, inbound_tag in rows:
        if inbound_tag:
            shared.setdefault(inbound_tag, []).append(int(host_id))

    ratios = state.get("inbound_ratios", {})
    return [
        {
            "id": int(host_id),
            "remark": remark,
            "inbound_tag": inbound_tag,
            "usage_ratio": float(ratios.get(inbound_tag, 1.0)) if inbound_tag else 1.0,
            "shared_host_ids": shared.get(inbound_tag, []) if inbound_tag else [],
            "shared_inbound": bool(inbound_tag and len(shared.get(inbound_tag, [])) > 1),
        }
        for host_id, remark, inbound_tag in rows
    ]


@router.get("/state")
async def get_state(
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    state = _load_state()
    return {
        "version": state.get("version", 1),
        "features": state.get("features", {}),
        "updated_at": state.get("updated_at"),
        "hosts": await _host_rows(db, state),
        "accounting": {
            "mode": "per-inbound-attribution",
            "shared_inbound_policy": "same-ratio",
            "effective_formula": "raw_usage * host_usage_ratio * node_usage_ratio",
        },
    }


@router.put("/features/{feature_name}")
async def set_feature(
    feature_name: str,
    body: ToggleBody,
    _owner: AdminDetails = Depends(_require_owner),
):
    if feature_name != "host_usage_ratio":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown HS Plugin feature")
    with _write_lock():
        state = _load_state()
        state.setdefault("features", {}).setdefault(feature_name, {})["enabled"] = body.enabled
        _save_state(state)
    return {"ok": True, "feature": feature_name, "enabled": body.enabled, "requires_resync": True}


@router.put("/hosts/{host_id}/usage-ratio")
async def set_host_usage_ratio(
    host_id: int,
    body: RatioBody,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    row = (
        await db.execute(select(ProxyHost.id, ProxyHost.remark, ProxyHost.inbound_tag).where(ProxyHost.id == host_id))
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
    with _write_lock():
        state = _load_state()
        state.setdefault("inbound_ratios", {})[inbound_tag] = float(body.ratio)
        _save_state(state)

    return {
        "ok": True,
        "host_id": host_id,
        "inbound_tag": inbound_tag,
        "usage_ratio": float(body.ratio),
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
