"""Owner-only API for HS Plugin."""
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
from app.db.models import Node, ProxyHost
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
        "version": 2,
        "features": {"host_usage_ratio": {"enabled": True}},
        "inbound_offsets": {},
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
    value.setdefault("inbound_offsets", {})
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


async def _node_rows(db: AsyncSession) -> list[dict]:
    rows = (
        await db.execute(select(Node.id, Node.name, Node.address, Node.usage_coefficient).order_by(Node.id.asc()))
    ).all()
    return [
        {
            "id": int(node_id),
            "name": name,
            "address": address,
            "usage_ratio": float(usage_coefficient or 1.0),
        }
        for node_id, name, address, usage_coefficient in rows
    ]


def _resolve_inherited_node_ratio(host_addresses, nodes: list[dict]) -> tuple[float, int | None, str]:
    normalized_hosts = {_normalize_address(x) for x in (host_addresses or []) if _normalize_address(x)}
    matched = [n for n in nodes if _normalize_address(n.get("address")) in normalized_hosts]
    if len(matched) == 1:
        node = matched[0]
        return float(node["usage_ratio"]), int(node["id"]), "address-match"

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
            inherited, _node_id, _source = _resolve_inherited_node_ratio(first_addresses.get(inbound_tag), nodes)
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
        inherited_ratio, inherited_node_id, inherited_source = _resolve_inherited_node_ratio(addresses, nodes)
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
    inherited_ratio, inherited_node_id, inherited_source = _resolve_inherited_node_ratio(row.address, nodes)
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
