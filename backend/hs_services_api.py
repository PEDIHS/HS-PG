"""Owner control plane and independently scoped node-agent endpoints."""

from __future__ import annotations
import asyncio
import secrets
import time
from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel, Field
from sqlalchemy import select
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
    enrolled = store.read("agents.json")
    targets = [dict(id="panel", name="Main panel", enrolled=True)] + [
        dict(id=str(n.id), name=n.name, core_id=n.core_config_id, enrolled=str(n.id) in enrolled) for n in nodes
    ]
    for target in targets:
        report = reports.get(target["id"], {})
        target.update(report)
        target["online"] = time.time() - report.get("updated_at", 0) < 60
    return dict(
        targets=targets,
        node_trust=[],
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


@router.post("/agents/{target}/bootstrap")
async def bootstrap(
    target: str,
    db: AsyncSession = Depends(get_db),
    owner: AdminDetails = Depends(_require_owner),
):
    if not target.isdigit() or not await db.get(Node, int(target)):
        raise HTTPException(404, "Node not found")
    return dict(target=target, bootstrap_token=store.issue_bootstrap(target), expires_in=store.BOOTSTRAP_TTL)


class BootstrapExchange(BaseModel):
    bootstrap_token: str = Field(min_length=20, max_length=256)


@router.post("/agents/{target}/exchange")
async def exchange_bootstrap(
    target: str, body: BootstrapExchange, db: AsyncSession = Depends(get_db)
):
    if not target.isdigit() or not await db.get(Node, int(target)):
        raise HTTPException(404, "Node not found")
    token = store.exchange_bootstrap(target, body.bootstrap_token)
    if not token:
        raise HTTPException(401, "Invalid or expired bootstrap token")
    return dict(target=target, token=token, protocol="hs-bridge-v1")


class NodeInstallBootstrap(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    address: str = Field(min_length=1, max_length=256)
    core_id: int = Field(ge=1)
    port: int = Field(default=62050, ge=1024, le=65535)
    api_port: int = Field(default=62051, ge=1024, le=65535)
    usage_coefficient: float = Field(default=1.0, ge=0, le=100)
    keep_alive: int = Field(default=30, ge=0, le=3600)
    default_timeout: int = Field(default=30, ge=3, le=300)
    internal_timeout: int = Field(default=60, ge=3, le=60)


@router.post("/node-bootstrap")
async def node_bootstrap(
    body: NodeInstallBootstrap,
    db: AsyncSession = Depends(get_db),
    owner: AdminDetails = Depends(_require_owner),
):
    if not await db.get(CoreConfig, body.core_id):
        raise HTTPException(404, "Core not found")
    spec = body.model_dump()
    spec["issued_by"] = owner.username
    token = store.issue_node_bootstrap(spec)
    return dict(bootstrap_token=token, expires_in=store.BOOTSTRAP_TTL)


class NodeInstallRegister(BaseModel):
    bootstrap_token: str = Field(min_length=20, max_length=256)
    api_key: str = Field(min_length=36, max_length=36)
    server_ca: str = Field(min_length=64, max_length=12000)


async def _register_pasarguard_node(db, spec, body):
    from app.db.crud.node import create_node as create_db_node
    from app.models.node import NodeCreate
    from app.operation import OperatorType
    from app.operation.node import NodeOperation
    payload = NodeCreate(
        name=spec["name"], address=spec["address"], port=spec["port"], api_port=spec["api_port"],
        usage_coefficient=spec["usage_coefficient"], connection_type="grpc", server_ca=body.server_ca,
        keep_alive=spec["keep_alive"], core_config_id=spec["core_id"], api_key=body.api_key,
        data_limit=0, data_limit_reset_strategy="no_reset", reset_time=-1,
        default_timeout=spec["default_timeout"], internal_timeout=spec["internal_timeout"],
    )
    existing = (await db.execute(select(Node).where(Node.name == spec["name"]))).scalar_one_or_none()
    if existing:
        for key, value in payload.model_dump().items():
            setattr(existing, key, value)
        await db.commit(); await db.refresh(existing); node = existing
    else:
        node = await create_db_node(db, payload)
    operator = NodeOperation(operator_type=OperatorType.API)
    await operator._update_node_impl(node)
    asyncio.create_task(operator._connect_single_node_background(node.id, force_start=True))
    return node


@router.post("/node-register")
async def node_register(body: NodeInstallRegister, db: AsyncSession = Depends(get_db)):
    spec = store.consume_node_bootstrap(body.bootstrap_token)
    if not spec:
        raise HTTPException(401, "Invalid or expired bootstrap token")
    if not await db.get(CoreConfig, int(spec["core_id"])):
        raise HTTPException(409, "Core no longer exists")
    try:
        node = await _register_pasarguard_node(db, spec, body)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    token = store.enroll(str(node.id))
    return dict(
        target=str(node.id), token=token, protocol="hs-bridge-v1",
        node=dict(id=node.id, name=node.name, address=node.address, port=node.port, api_port=node.api_port),
    )


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
    fair_use: dict = Field(default_factory=dict)
    bridge: dict = Field(default_factory=dict)
    system: dict = Field(default_factory=dict)
    pasarguard: dict = Field(default_factory=dict)
    job_running: bool = False


@router.post("/agents/{target}/poll")
async def poll(body: Report, target: str = Depends(agent), db: AsyncSession = Depends(get_db)):
    with store.lock():
        reports = store.read("reports.json")
        reports[target] = {**body.model_dump(), "updated_at": time.time()}
        store.write("reports.json", reports)
    from app.hs_fair_runtime import manifest
    policy=await manifest(db,target)
    return dict(job=None if body.job_running else store.claim(target), fair_policy=policy)


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
    if not cert or cert.get("provider")!="certbot" or not cert.get("renewable"):
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


class GroupFairBody(BaseModel):
    mode: str = Field(default="always", pattern="^(threshold|always)$")
    threshold_bytes: int = Field(default=0, ge=0, le=2**53 - 1)
    speed_percent: float = Field(ge=1, le=100, allow_inf_nan=False)
    baseline_mbps: float = Field(gt=0, le=100000, allow_inf_nan=False)


async def _expanded_host_fair(db):
    from app.db.models import ProxyHost
    from app.hs_fair_use import validate_policy
    hosts=(await db.execute(select(ProxyHost))).scalars().all()
    legacy=store.read("fair-use.json")
    canonical=store.read("fair-use-inbounds.json")
    grouped={}
    for host in hosts:
        if host.inbound_tag:
            grouped.setdefault(host.inbound_tag,[]).append(host)
    expanded={};shared={};migrations={}
    for tag,items in grouped.items():
        policy=None
        value=canonical.get(tag)
        if value:
            try:policy=validate_policy(value)
            except ValueError:pass
        if policy is None:
            for host in sorted(items,key=lambda value:value.id):
                value=legacy.get(str(host.id))
                if value:
                    try:policy=validate_policy(value);migrations[tag]=policy;break
                    except ValueError:pass
        if policy is None:continue
        ids=[int(host.id) for host in items]
        for host in items:
            expanded[str(host.id)]=policy
            shared[str(host.id)]=ids
    if migrations:
        with store.lock():
            current=store.read("fair-use-inbounds.json")
            before=dict(current)
            for tag,policy in migrations.items():current.setdefault(tag,policy)
            if current!=before:store.write("fair-use-inbounds.json",current)
    return expanded,shared


@router.get("/fair-use")
async def fair_settings(
    db: AsyncSession = Depends(get_db),
    owner: AdminDetails = Depends(_require_owner),
):
    from app.db.models import Group
    reports=store.read('reports.json')
    policies,shared=await _expanded_host_fair(db)
    group_rows=(await db.execute(select(Group.id,Group.name))).all()
    return dict(
        policies=policies,
        group_policies=store.read('fair-use-groups.json'),
        groups=[dict(id=int(identity),name=name) for identity,name in group_rows],
        shared_hosts=shared,
        enforcement_available=any(
            r.get('fair_use',{}).get('adapter')=='hs-rate-v1'
            and time.time()-r.get('fair_use',{}).get('updated_at',0)<25
            for r in reports.values()
        ),
        blocker='Per-user pacing requires the HS-enabled Xray core and connected node agent.',
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
    if not host.inbound_tag:
        raise HTTPException(422, "Host has no inbound")
    siblings=(await db.execute(
        select(ProxyHost).where(ProxyHost.inbound_tag==host.inbound_tag)
    )).scalars().all()
    core_rows=(await db.execute(select(CoreConfig))).scalars().all()
    matching=[c for c in core_rows if any(
        i.get('tag')==host.inbound_tag
        and i.get('protocol') in {'vless','vmess','trojan','shadowsocks','socks','http'}
        for i in c.config.get('inbounds',[])
    )]
    if not matching:
        raise HTTPException(409,'Fair Use requires a supported Xray inbound.')
    policy=validate_policy(body.model_dump())
    with store.lock():
        inbound_policies=store.read("fair-use-inbounds.json")
        inbound_policies[host.inbound_tag]=policy
        store.write("fair-use-inbounds.json",inbound_policies)
        legacy=store.read("fair-use.json")
        for sibling in siblings:
            legacy[str(sibling.id)]=policy
        store.write("fair-use.json",legacy)
    return dict(
        policy=policy,state="saved",enforced=False,
        inbound_tag=host.inbound_tag,
        affected_host_ids=sorted(int(s.id) for s in siblings),
        affected_core_ids=sorted(int(c.id) for c in matching),
        note="Saved with the Host. Every Host sharing this inbound uses the same policy.",
    )


@router.delete("/hosts/{host_id}/fair-use")
async def delete_fair(
    host_id: int,
    db: AsyncSession = Depends(get_db),
    owner: AdminDetails = Depends(_require_owner),
):
    from app.db.models import ProxyHost
    host=await db.get(ProxyHost,host_id)
    if not host:raise HTTPException(404,"Host not found")
    siblings=(await db.execute(
        select(ProxyHost.id).where(ProxyHost.inbound_tag==host.inbound_tag)
    )).scalars().all()
    with store.lock():
        inbound_policies=store.read("fair-use-inbounds.json")
        inbound_policies.pop(host.inbound_tag,None)
        store.write("fair-use-inbounds.json",inbound_policies)
        legacy=store.read("fair-use.json")
        for identity in siblings:legacy.pop(str(identity),None)
        store.write("fair-use.json",legacy)
    return {"ok":True,"affected_host_ids":sorted(int(x) for x in siblings)}


@router.put("/groups/{group_id}/fair-use")
async def save_group_fair(
    group_id:int,
    body:GroupFairBody,
    db:AsyncSession=Depends(get_db),
    owner:AdminDetails=Depends(_require_owner),
):
    from app.db.models import Group
    from app.hs_fair_use import validate_policy
    group=await db.get(Group,group_id)
    if not group:raise HTTPException(404,"Group not found")
    value=body.model_dump()
    if value['mode']=='threshold' and value['threshold_bytes']<=0:
        raise HTTPException(422,"Threshold mode requires a positive traffic threshold")
    policy=validate_policy(value)
    with store.lock():
        policies=store.read('fair-use-groups.json');policies[str(group_id)]=policy;store.write('fair-use-groups.json',policies)
    return dict(policy=policy,state='saved',group_id=group_id,note='Saved with the Group and applied to every inbound assigned to it.')


@router.delete("/groups/{group_id}/fair-use")
async def delete_group_fair(
    group_id:int,
    db:AsyncSession=Depends(get_db),
    owner:AdminDetails=Depends(_require_owner),
):
    from app.db.models import Group
    if not await db.get(Group,group_id):raise HTTPException(404,"Group not found")
    with store.lock():
        policies=store.read('fair-use-groups.json');policies.pop(str(group_id),None);store.write('fair-use-groups.json',policies)
    return {"ok":True}


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
    policies,_=await _expanded_host_fair(db)
    return evaluate(
        dict(id=user.id, status=user.status, used_traffic=user.used_traffic),
        policies,
        ids,
        enforced=False,
    )
