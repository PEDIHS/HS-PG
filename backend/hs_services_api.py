"""Owner control plane and independently scoped node-agent endpoints."""

from __future__ import annotations
import asyncio
import secrets
import time
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel, Field
from sqlalchemy import select
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from app.db import get_db, AsyncSession
from app.db.models import Node, CoreConfig
from app.models.admin import AdminDetails
from app.routers.hs_plugin_api import _require_owner, _load_state
from app import hs_services as store
from app.hs_outbounds import add_warp, revision

router = APIRouter(prefix="/api/hs-services", tags=["HS Services"])


def feature(name):
    if not _load_state().get("features", {}).get(name, {}).get("enabled", False):
        raise HTTPException(409, "Enable this feature in HS Plugin first")


def public_job(job):
    return {
        k: v for k, v in job.items() if k not in ("payload", "lease", "completion_hash")
    }


def fresh(target):
    report = store.read("reports.json").get(str(target), {})
    if time.time() - report.get("updated_at", 0) > 60:
        raise HTTPException(409, "Target agent is offline or has not been enrolled")
    return report


@router.get("/inventory")
async def inventory(
    db: AsyncSession = Depends(get_db), owner: AdminDetails = Depends(_require_owner)
):
    nodes = (await db.execute(select(Node))).scalars().all()
    reports = store.read("reports.json")
    targets = [dict(id="panel", name="Main panel")] + [
        dict(id=str(n.id), name=n.name) for n in nodes
    ]
    for target in targets:
        report = reports.get(target["id"], {})
        target.update(report)
        target["online"] = time.time() - report.get("updated_at", 0) < 60
    trust = []
    from config import server_settings
    from pathlib import Path

    if server_settings.ssl_certfile:
        try:
            cert = x509.load_pem_x509_certificate(
                Path(server_settings.ssl_certfile).read_bytes()
            )
            trust.append(
                dict(
                    id="panel-tls",
                    target="panel",
                    name="Panel TLS",
                    provider="Panel TLS",
                    expires_at=cert.not_valid_after_utc.timestamp(),
                    starts_at=cert.not_valid_before_utc.timestamp(),
                    issuer=cert.issuer.rfc4514_string(),
                    renewable=False,
                    note="Renew via the matching agent-managed certificate below; panel process may require restart",
                )
            )
        except (OSError, ValueError) as exc:
            trust.append(
                dict(
                    id="panel-tls",
                    target="panel",
                    name="Panel TLS",
                    renewable=False,
                    error=str(exc),
                )
            )

    for node in nodes:
        try:
            cert = x509.load_pem_x509_certificate(node.server_ca.encode())
            trust.append(
                dict(
                    id="node-ca-" + str(node.id),
                    target=str(node.id),
                    name=node.name,
                    expires_at=cert.not_valid_after_utc.timestamp(),
                    starts_at=cert.not_valid_before_utc.timestamp(),
                    issuer=cert.issuer.rfc4514_string(),
                    fingerprint=cert.fingerprint(hashes.SHA256()).hex(),
                    provider="Node trust certificate",
                    renewable=False,
                    note="Trust rotation requires updating the node certificate/key and panel trust together",
                )
            )
        except (ValueError, AttributeError):
            trust.append(
                dict(
                    id="node-ca-" + str(node.id),
                    target=str(node.id),
                    name=node.name,
                    error="Invalid or missing node trust certificate",
                    renewable=False,
                )
            )
    return dict(
        targets=targets,
        node_trust=trust,
        jobs=[public_job(j) for j in store.read("jobs.json", [])[-100:]][::-1],
    )


@router.post("/agents/{target}/enroll")
async def enroll(
    target: str,
    db: AsyncSession = Depends(get_db),
    owner: AdminDetails = Depends(_require_owner),
):
    if not target.isdigit() or not await db.get(Node, int(target)):
        raise HTTPException(404, "Node not found")
    return dict(target=target, token=store.enroll(target))


@router.delete("/agents/{target}")
async def revoke(target: str, owner: AdminDetails = Depends(_require_owner)):
    with store.lock():
        agents = store.read("agents.json")
        agents.pop(target, None)
        store.write("agents.json", agents)
    return {"ok": True}


def agent(target: str, authorization: str = Header(default="")):
    if not authorization.startswith("Bearer ") or not store.authenticate(
        target, authorization[7:]
    ):
        raise HTTPException(401, "Invalid agent credential")
    return target


class Report(BaseModel):
    certificates: list[dict] = Field(default_factory=list, max_length=200)
    proxies: list[dict] = Field(default_factory=list, max_length=200)
    capabilities: dict = Field(default_factory=dict)


@router.post("/agents/{target}/poll")
async def poll(body: Report, target: str = Depends(agent)):
    with store.lock():
        reports = store.read("reports.json")
        reports[target] = {**body.model_dump(), "updated_at": time.time()}
        store.write("reports.json", reports)
    return dict(job=store.claim(target))


class Completion(BaseModel):
    id: str = Field(pattern="^[a-f0-9]{32}$")
    lease: str = Field(pattern="^[a-f0-9]{32}$")
    result: dict = Field(default_factory=dict)
    error: str | None = Field(default=None, max_length=2000)


@router.post("/agents/{target}/complete")
async def complete(body: Completion, target: str = Depends(agent)):
    try:
        return public_job(
            store.finish(target, body.id, body.lease, body.result, body.error)
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


class Renew(BaseModel):
    certificate_id: str = Field(min_length=1, max_length=253)


@router.post("/targets/{target}/renew")
async def renew(
    target: str, body: Renew, owner: AdminDetails = Depends(_require_owner)
):
    feature("certificate_manager")
    cert = next(
        (
            c
            for c in fresh(target).get("certificates", [])
            if c.get("id") == body.certificate_id
        ),
        None,
    )
    if not cert or not cert.get("renewable"):
        raise HTTPException(409, "Certificate cannot be renewed by this target agent")
    return public_job(store.enqueue(target, "renew", body.certificate_id))


class ProxyCreate(BaseModel):
    host: str = Field(min_length=1, max_length=253, pattern=r"^[a-zA-Z0-9.:-]+$")
    port: int = Field(ge=1024, le=65535)
    metrics_port: int = Field(default=18888, ge=1024, le=65535)
    ad_tag: str = Field(default="", pattern="^(?:[a-fA-F0-9]{32})?$")


@router.post("/targets/{target}/mtproxy")
async def create_proxy(
    target: str, body: ProxyCreate, owner: AdminDetails = Depends(_require_owner)
):
    feature("mtproxy")
    report = fresh(target)
    if not report.get("capabilities", {}).get("mtproxy"):
        raise HTTPException(
            409, "Install official MTProxy on the selected target first"
        )
    if body.port == body.metrics_port:
        raise HTTPException(422, "Client and statistics ports must differ")
    if any(
        p.get("port") == body.port or p.get("metrics_port") == body.metrics_port
        for p in report.get("proxies", [])
    ):
        raise HTTPException(409, "Port already used by an HS proxy")
    payload = {
        **body.model_dump(),
        "id": secrets.token_hex(16),
        "secret": secrets.token_hex(16),
    }
    return public_job(
        store.enqueue(target, "mtproxy-create", "port:" + str(body.port), payload)
    )


@router.post("/targets/{target}/mtproxy/{identity}/{action}")
async def proxy_action(
    target: str,
    identity: str,
    action: str,
    owner: AdminDetails = Depends(_require_owner),
):
    feature("mtproxy")
    if action not in ("start", "stop", "delete"):
        raise HTTPException(422, "Unknown proxy action")
    if not any(p.get("id") == identity for p in fresh(target).get("proxies", [])):
        raise HTTPException(404, "HS proxy not found")
    return public_job(store.enqueue(target, "mtproxy-" + action, identity))


class WarpBody(BaseModel):
    profile: str = Field(min_length=1, max_length=8192)
    tag: str = Field(pattern="^hs-warp-[a-zA-Z0-9_-]{1,48}$")
    domains: list[str] = Field(default_factory=list, max_length=200)
    inbounds: list[str] = Field(default_factory=list, max_length=200)
    reserved: list[int] | None = Field(default=None, max_length=3)
    expected_revision: str | None = None
    apply: bool = False
    restart_nodes: bool = False


@router.post("/cores/{core_id}/warp")
async def warp(
    core_id: int,
    body: WarpBody,
    db: AsyncSession = Depends(get_db),
    owner: AdminDetails = Depends(_require_owner),
):
    feature("warp")
    from app.models.core import CoreCreate
    from app.operation import OperatorType
    from app.operation.core import CoreOperation
    from app.operation.node import NodeOperation

    core = (
        (
            await db.execute(
                select(CoreConfig).where(CoreConfig.id == core_id).with_for_update()
            )
        ).scalar_one_or_none()
        if body.apply
        else await db.get(CoreConfig, core_id)
    )
    if core is None:
        raise HTTPException(404, "Core not found")
    if str(getattr(core.type, "value", core.type)) not in ("xray", "None"):
        raise HTTPException(409, "This WARP builder currently supports Xray cores")
    current = revision(core.config)
    if body.apply and body.expected_revision != current:
        raise HTTPException(409, "Core changed; preview again before applying")
    try:
        config = add_warp(
            core.config,
            body.profile,
            body.tag,
            body.domains,
            body.inbounds,
            body.reserved,
        )
    except (ValueError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc
    if not body.apply:
        return dict(
            revision=current,
            outbound_tag=body.tag,
            rules=config["routing"]["rules"][:1],
            note="WireGuard credentials validated. Connectivity is verified by the target Xray node after apply.",
        )
    # Keep the original for inspection. Never blindly restore over concurrent native edits.
    with store.lock():
        backups = store.read("core-backups.json")
        backups[str(core_id)] = {
            "config": core.config,
            "revision": current,
            "at": time.time(),
        }
        store.write("core-backups.json", backups)
    response = await CoreOperation(operator_type=OperatorType.API).modify_core(
        db,
        core_id,
        CoreCreate(
            name=core.name,
            config=config,
            type=core.type,
            exclude_inbound_tags=set((core.exclude_inbound_tags or "").split(","))
            - {""}
            if isinstance(core.exclude_inbound_tags, str)
            else core.exclude_inbound_tags,
            fallbacks_inbound_tags=set((core.fallbacks_inbound_tags or "").split(","))
            - {""}
            if isinstance(core.fallbacks_inbound_tags, str)
            else core.fallbacks_inbound_tags,
        ),
        owner,
    )
    if body.restart_nodes:
        await NodeOperation(operator_type=OperatorType.API).restart_all_node(
            db=db, core_id=core_id, admin=owner
        )
    return dict(
        ok=True, revision=revision(config), restart_requested=body.restart_nodes
    )


class FairBody(BaseModel):
    threshold_bytes: int = Field(gt=0, le=2**53 - 1)
    speed_percent: float = Field(ge=1, le=100, allow_inf_nan=False)
    baseline_mbps: float = Field(gt=0, le=100000, allow_inf_nan=False)


@router.get("/fair-use")
async def fair_settings(owner: AdminDetails = Depends(_require_owner)):
    return dict(
        policies=store.read("fair-use.json"),
        enforcement_available=False,
        blocker="The current PasarGuard node bridge has no per-user bandwidth setter. Policies are drafts until a compatible node rate adapter is installed and verified.",
    )


@router.put("/hosts/{host_id}/fair-use")
async def save_fair(
    host_id: int,
    body: FairBody,
    db: AsyncSession = Depends(get_db),
    owner: AdminDetails = Depends(_require_owner),
):
    from app.db.models import ProxyHost
    from app.hs_fair_use import validate_policy

    host = await db.get(ProxyHost, host_id)
    if not host:
        raise HTTPException(404, "Host not found")
    siblings = (
        (
            await db.execute(
                select(ProxyHost.id).where(ProxyHost.inbound_tag == host.inbound_tag)
            )
        )
        .scalars()
        .all()
    )
    policy = validate_policy(body.model_dump())
    with store.lock():
        policies = store.read("fair-use.json")
        for identity in siblings:
            existing = policies.get(str(identity))
            if identity != host_id and existing and existing != policy:
                raise HTTPException(
                    409,
                    "Hosts sharing an inbound cannot have different speed policies. Use a dedicated inbound.",
                )
        policies[str(host_id)] = policy
        store.write("fair-use.json", policies)
    return dict(policy=policy, state="draft", enforced=False)


@router.delete("/hosts/{host_id}/fair-use")
async def delete_fair(host_id: int, owner: AdminDetails = Depends(_require_owner)):
    with store.lock():
        policies = store.read("fair-use.json")
        policies.pop(str(host_id), None)
        store.write("fair-use.json", policies)
    return {"ok": True}


@router.get("/users/{user_id}/fair-use-preview")
async def fair_preview(
    user_id: int,
    db: AsyncSession = Depends(get_db),
    owner: AdminDetails = Depends(_require_owner),
):
    from app.db.models import User, ProxyHost
    from app.hs_fair_use import evaluate

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    tags = await user.inbounds()
    ids = (
        (
            await db.execute(
                select(ProxyHost.id).where(
                    ProxyHost.inbound_tag.in_(tags), ProxyHost.is_disabled.is_(False)
                )
            )
        )
        .scalars()
        .all()
    )
    return evaluate(
        dict(id=user.id, status=user.status, used_traffic=user.used_traffic),
        store.read("fair-use.json"),
        ids,
        enforced=False,
    )
