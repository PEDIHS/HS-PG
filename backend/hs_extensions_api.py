"""HS extensions that belong inside native PasarGuard screens.

Routes here intentionally do not create a separate Fair Use page.  Fair Use is
stored per Host and generic Proxy/WireGuard outbounds mutate the selected native
Xray Core after full validation.
"""
from __future__ import annotations

import base64
import fcntl
import ipaddress
import json
import os
import re
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.core.manager import core_manager
from app.db import AsyncSession, get_db
from app.db.models import CoreConfig, ProxyHost, User
from app.models.admin import AdminDetails
from app.routers.authentication import get_current

from app.hs_fair_use_runtime import (
    _read as fair_runtime,
    build_rate_plan,
    derived_status,
    normalize_policy,
    write_runtime,
)

router = APIRouter(prefix="/api/hs-ext", tags=["HS Native Extensions"])
DATA_DIR = Path(os.getenv("HS_PLUGIN_DATA_DIR", "/var/lib/pasarguard/hs-plugin"))
LOCK_FILE = DATA_DIR / ".fair-use.lock"


def _require_auth(current: AdminDetails | None = Depends(get_current)) -> AdminDetails:
    if current is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return current


def _require_owner(current: AdminDetails = Depends(_require_auth)) -> AdminDetails:
    if not current.role or not current.role.is_owner:
        raise HTTPException(status_code=403, detail="HS settings are owner-only")
    return current


@contextmanager
def _lock():
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    with LOCK_FILE.open("a+", encoding="utf-8") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class FairPolicyBody(BaseModel):
    threshold_bytes: int = Field(gt=0, le=2**53 - 1)
    speed_percent: float = Field(ge=1, le=100, allow_inf_nan=False)
    baseline_mbps: float = Field(gt=0, le=100000, allow_inf_nan=False)


async def _host_map(db: AsyncSession) -> dict[int, dict]:
    rows = (
        await db.execute(
            select(ProxyHost.id, ProxyHost.remark, ProxyHost.inbound_tag).order_by(ProxyHost.id.asc())
        )
    ).all()
    return {
        int(host_id): {"id": int(host_id), "remark": remark, "inbound_tag": inbound_tag}
        for host_id, remark, inbound_tag in rows
    }


def _host_policies(runtime: dict) -> dict[str, dict]:
    raw = runtime.get("host_policies", {})
    return raw if isinstance(raw, dict) else {}


async def _compile_locked(db: AsyncSession, host_policies: dict[str, dict]) -> dict:
    hosts = await _host_map(db)
    compiled: dict[str, dict] = {}
    host_ids_by_tag: dict[str, list[int]] = {}
    for raw_id, policy in host_policies.items():
        try:
            host_id = int(raw_id)
        except (TypeError, ValueError):
            continue
        host = hosts.get(host_id)
        if not host or not host.get("inbound_tag"):
            continue
        tag = str(host["inbound_tag"])
        normalized = normalize_policy(policy)
        previous = compiled.get(tag)
        if previous and previous != normalized:
            raise HTTPException(
                409,
                f"Hosts sharing inbound '{tag}' cannot have different Fair Use policies. Use a dedicated inbound.",
            )
        compiled[tag] = normalized
        host_ids_by_tag.setdefault(tag, []).append(host_id)

    current = fair_runtime()
    value = {
        "version": 1,
        "policies": compiled,
        "host_policies": host_policies,
        "host_ids_by_tag": host_ids_by_tag,
        "limited_users": current.get("limited_users", {}),
        "plan_revision": current.get("plan_revision"),
    }
    write_runtime(value)
    return value


@router.get("/fair-use/hosts")
async def fair_hosts(
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    runtime = fair_runtime()
    hosts = await _host_map(db)
    policies = _host_policies(runtime)
    result = []
    for host_id, host in hosts.items():
        policy = policies.get(str(host_id))
        result.append(
            {
                **host,
                "enabled": bool(policy),
                "fair_limited": bool(policy),
                "policy": policy,
            }
        )
    return {"hosts": result, "status_name": "Fair limited", "status_color": "#f97316"}


@router.put("/fair-use/hosts/{host_id}")
async def save_fair_host(
    host_id: int,
    body: FairPolicyBody,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    hosts = await _host_map(db)
    if host_id not in hosts:
        raise HTTPException(404, "Host not found")
    if not hosts[host_id].get("inbound_tag"):
        raise HTTPException(409, "Select an inbound before enabling Fair Use on this Host")
    policy = normalize_policy(body.model_dump())
    with _lock():
        runtime = fair_runtime()
        policies = dict(_host_policies(runtime))
        policies[str(host_id)] = policy
        compiled = await _compile_locked(db, policies)
    return {
        "ok": True,
        "host_id": host_id,
        "policy": policy,
        "fair_limited": True,
        "inbound_tag": hosts[host_id]["inbound_tag"],
        "compiled_policy": compiled["policies"].get(str(hosts[host_id]["inbound_tag"])),
    }


@router.delete("/fair-use/hosts/{host_id}")
async def delete_fair_host(
    host_id: int,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    with _lock():
        runtime = fair_runtime()
        policies = dict(_host_policies(runtime))
        policies.pop(str(host_id), None)
        await _compile_locked(db, policies)
    return {"ok": True}


@router.get("/fair-use/users")
async def fair_users(
    db: AsyncSession = Depends(get_db),
    _admin: AdminDetails = Depends(_require_auth),
):
    policies = fair_runtime().get("policies", {})
    if not isinstance(policies, dict) or not policies:
        return {"users": [], "count": 0, "status_color": "#f97316"}
    rows = (await db.execute(select(User.id, User.username, User.status, User.used_traffic))).all()
    result = []
    for user_id, username, native_status, used_traffic in rows:
        state = derived_status(native_status, used_traffic, policies)
        if state == "fair_limited":
            reached = [
                tag
                for tag, policy in policies.items()
                if int(used_traffic or 0) >= normalize_policy(policy)["threshold_bytes"]
            ]
            result.append(
                {
                    "id": int(user_id),
                    "username": username,
                    "status": "fair_limited",
                    "label": "Fair limited",
                    "color": "#f97316",
                    "used_traffic": int(used_traffic or 0),
                    "reached_inbound_tags": reached,
                }
            )
    return {"users": result, "count": len(result), "status_color": "#f97316"}


class ProxyOutboundBody(BaseModel):
    tag: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    protocol: str = Field(pattern=r"^(socks|http)$")
    address: str = Field(min_length=1, max_length=253)
    port: int = Field(ge=1, le=65535)
    username: str | None = Field(default=None, max_length=253)
    password: str | None = Field(default=None, max_length=1024)
    inbound_tags: list[str] = Field(default_factory=list, max_length=100)


class WireGuardOutboundBody(BaseModel):
    tag: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    private_key: str = Field(min_length=40, max_length=80)
    address: list[str] = Field(min_length=1, max_length=8)
    peer_public_key: str = Field(min_length=40, max_length=80)
    endpoint: str = Field(min_length=3, max_length=300)
    allowed_ips: list[str] = Field(default_factory=lambda: ["0.0.0.0/0", "::/0"], max_length=32)
    reserved: list[int] | None = Field(default=None, min_length=3, max_length=3)
    mtu: int = Field(default=1280, ge=1280, le=1500)
    inbound_tags: list[str] = Field(default_factory=list, max_length=100)


def _b64key(value: str, label: str) -> str:
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise HTTPException(422, f"Invalid {label}") from exc
    if len(decoded) != 32:
        raise HTTPException(422, f"{label} must decode to 32 bytes")
    return value


def _validate_inbounds(config: dict, values: list[str]) -> list[str]:
    known = {
        str(item.get("tag"))
        for item in config.get("inbounds", [])
        if isinstance(item, dict) and item.get("tag")
    }
    clean = list(dict.fromkeys(str(value) for value in values if str(value)))
    missing = [value for value in clean if value not in known]
    if missing:
        raise HTTPException(422, "Inbound tags not present in selected Core: " + ", ".join(missing))
    return clean


def _append_outbound(config: dict, outbound: dict, inbound_tags: list[str]) -> dict:
    result = deepcopy(config)
    outbounds = result.setdefault("outbounds", [])
    if any(str(item.get("tag")) == outbound["tag"] for item in outbounds if isinstance(item, dict)):
        raise HTTPException(409, "Outbound tag already exists")
    outbounds.append(outbound)
    if inbound_tags:
        result.setdefault("routing", {}).setdefault("rules", []).insert(
            0,
            {"type": "field", "inboundTag": inbound_tags, "outboundTag": outbound["tag"]},
        )
    return result


async def _save_core_config(db: AsyncSession, core: CoreConfig, config: dict) -> None:
    try:
        validated = core_manager.validate_core(
            config,
            core.exclude_inbound_tags,
            core.fallbacks_inbound_tags,
            core.type,
        )
    except Exception as exc:
        raise HTTPException(422, f"Xray rejected outbound configuration: {exc}") from exc
    core.config = config
    await db.commit()
    await db.refresh(core)
    await core_manager.update_core(core, validated)


@router.get("/outbounds/{core_id}")
async def native_outbounds(
    core_id: int,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    core = await db.get(CoreConfig, core_id)
    if not core:
        raise HTTPException(404, "Core not found")
    config = core.config if isinstance(core.config, dict) else {}
    return {
        "core_id": int(core.id),
        "core_name": core.name,
        "type": str(getattr(core.type, "value", core.type)),
        "inbounds": [
            {"tag": item.get("tag"), "protocol": item.get("protocol")}
            for item in config.get("inbounds", [])
            if isinstance(item, dict) and item.get("tag")
        ],
        "outbounds": config.get("outbounds", []),
    }


@router.post("/outbounds/{core_id}/proxy")
async def add_proxy_outbound(
    core_id: int,
    body: ProxyOutboundBody,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    core = await db.get(CoreConfig, core_id)
    if not core:
        raise HTTPException(404, "Core not found")
    config = core.config if isinstance(core.config, dict) else {}
    inbound_tags = _validate_inbounds(config, body.inbound_tags)
    server = {"address": body.address, "port": body.port}
    if body.username or body.password:
        server["users"] = [{"user": body.username or "", "pass": body.password or ""}]
    outbound = {"tag": body.tag, "protocol": body.protocol, "settings": {"servers": [server]}}
    config = _append_outbound(config, outbound, inbound_tags)
    await _save_core_config(db, core, config)
    return {"ok": True, "outbound": outbound, "routed_from": inbound_tags}


@router.post("/outbounds/{core_id}/wireguard")
async def add_wireguard_outbound(
    core_id: int,
    body: WireGuardOutboundBody,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    core = await db.get(CoreConfig, core_id)
    if not core:
        raise HTTPException(404, "Core not found")
    config = core.config if isinstance(core.config, dict) else {}
    inbound_tags = _validate_inbounds(config, body.inbound_tags)
    private_key = _b64key(body.private_key, "private key")
    public_key = _b64key(body.peer_public_key, "peer public key")
    addresses = []
    for value in body.address:
        try:
            addresses.append(str(ipaddress.ip_interface(value)))
        except ValueError as exc:
            raise HTTPException(422, f"Invalid WireGuard address: {value}") from exc
    allowed = []
    for value in body.allowed_ips:
        try:
            allowed.append(str(ipaddress.ip_network(value, strict=False)))
        except ValueError as exc:
            raise HTTPException(422, f"Invalid AllowedIP: {value}") from exc
    if not re.fullmatch(r"(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):\d{1,5}", body.endpoint):
        raise HTTPException(422, "Invalid WireGuard endpoint")
    port = int(body.endpoint.rsplit(":", 1)[1])
    if not 1 <= port <= 65535:
        raise HTTPException(422, "Invalid WireGuard endpoint port")
    settings = {
        "secretKey": private_key,
        "address": addresses,
        "peers": [{"publicKey": public_key, "endpoint": body.endpoint, "allowedIPs": allowed}],
        "mtu": body.mtu,
    }
    if body.reserved is not None:
        if any(type(value) is not int or not 0 <= value <= 255 for value in body.reserved):
            raise HTTPException(422, "Reserved must contain three bytes")
        settings["reserved"] = body.reserved
    outbound = {"tag": body.tag, "protocol": "wireguard", "settings": settings}
    config = _append_outbound(config, outbound, inbound_tags)
    await _save_core_config(db, core, config)
    return {"ok": True, "outbound": outbound, "routed_from": inbound_tags}


@router.delete("/outbounds/{core_id}/{tag}")
async def remove_hs_outbound(
    core_id: int,
    tag: str,
    db: AsyncSession = Depends(get_db),
    _owner: AdminDetails = Depends(_require_owner),
):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", tag):
        raise HTTPException(422, "Invalid outbound tag")
    core = await db.get(CoreConfig, core_id)
    if not core:
        raise HTTPException(404, "Core not found")
    config = deepcopy(core.config if isinstance(core.config, dict) else {})
    before = len(config.get("outbounds", []))
    config["outbounds"] = [
        item for item in config.get("outbounds", []) if str(item.get("tag", "")) != tag
    ]
    if len(config["outbounds"]) == before:
        raise HTTPException(404, "Outbound not found")
    routing = config.get("routing")
    if isinstance(routing, dict) and isinstance(routing.get("rules"), list):
        routing["rules"] = [rule for rule in routing["rules"] if str(rule.get("outboundTag", "")) != tag]
    await _save_core_config(db, core, config)
    return {"ok": True, "removed": tag}
