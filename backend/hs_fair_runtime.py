"""Fair-use state derived from charged user totals and live, acknowledged core pacing."""
from __future__ import annotations
import hashlib
import json
import time
try:
    from app import hs_services as store
except ImportError:
    import hs_services as store


_cache={}
def snapshot(name):
    path=store.DATA/name
    try:stamp=path.stat().st_mtime_ns
    except OSError:return {}
    key=str(path)
    if _cache.get(key,(None,))[0]!=stamp:_cache[key]=(stamp,store.read(name))
    return _cache[key][1]


def enabled():
    try:
        from app.routers.hs_plugin_api import STATE_FILE
        stamp = STATE_FILE.stat().st_mtime_ns
        key = str(STATE_FILE)
        if _cache.get(key, (None,))[0] != stamp:
            _cache[key] = (stamp, json.loads(STATE_FILE.read_text()))
        return bool(_cache[key][1].get('features',{}).get('fair_use',{}).get('enabled'))
    except ImportError:
        return False
    except (OSError, ValueError):
        return False


def ready(target, revision):
    report=snapshot('reports.json').get(str(target),{})
    ack=report.get('fair_use',{})
    return (time.time()-report.get('updated_at',0)<40 and time.time()-ack.get('updated_at',0)<25
            and ack.get('adapter')=='hs-rate-v1' and ack.get('revision')==revision)


def user_state(user):
    native=str(getattr(getattr(user,'status','active'),'value',getattr(user,'status','active')))
    if native!='active' or not enabled():return None
    uid=str(user.id);used=max(0,int(user.used_traffic or 0))
    state=snapshot('fair-runtime.json')
    policies=snapshot('fair-use.json')
    applicable={};pending=False
    for target,record in state.items():
        ids=record.get('users',{}).get(uid,[])
        current={h:policies[h] for h in ids if h in policies and used>=policies[h]['threshold_bytes']}
        if not current:continue
        if (not ready(target,record.get('revision')) or not set(current).issubset(record.get('reached',{}).get(uid,[])) or any(record.get('policies',{}).get(h)!=policies[h] for h in current)):pending=True
        applicable.update(current)
    if not applicable:return None
    return {'status':'active' if pending else 'fair_limited','pending':pending,'host_ids':list(applicable)}


def filter_hosts(hosts, user):
    state=user_state(user)
    if not state or state['pending']:return [h for h in hosts.values() if not h.status or user.status in h.status]
    # Only this user's eligible policy hosts; never match other hosts by shared tag.
    policies=snapshot('fair-use.json')
    tags=set(getattr(user,'inbounds',[]) or [])
    return [host for identity,host in hosts.items() if str(identity) in policies and host.inbound_tag in tags]


async def manifest(db,target):
    from sqlalchemy import select
    from app.db.models import Node,CoreConfig,ProxyHost,User,Group,ProxyInbound,users_groups_association,inbounds_groups_association
    from app.hs_fair_use import validate_policy
    node=await db.get(Node,int(target))
    if node is None:return None
    core=await db.get(CoreConfig,node.core_config_id)
    if core is None:return None
    tags={i['tag'] for i in core.config.get('inbounds',[]) if i.get('tag') and i.get('protocol') in {'vless','vmess','trojan','shadowsocks','socks','http'}}
    cores=(await db.execute(select(CoreConfig))).scalars().all()
    tags={tag for tag in tags if sum(any(i.get('tag')==tag for i in c.config.get('inbounds',[])) for c in cores)==1}
    hosts=(await db.execute(select(ProxyHost).where(ProxyHost.inbound_tag.in_(tags)))).scalars().all()
    policies=snapshot('fair-use.json') if enabled() else {}
    # A connection identifies the inbound, not the subscription Host label.
    # Never throttle another Host silently if it starts sharing that inbound.
    counts = {}
    for host in hosts:
        counts[host.inbound_tag] = counts.get(host.inbound_tag, 0) + 1
    configured={str(h.id):(h.inbound_tag,validate_policy(policies[str(h.id)])) for h in hosts if str(h.id) in policies and not h.is_disabled and counts[h.inbound_tag] == 1}
    # Guard against a core being assigned to more nodes after a policy was saved.
    peers=(await db.execute(select(Node.id).where(Node.core_config_id==node.core_config_id))).scalars().all()
    if len(peers)!=1:configured={}
    rates={};users={};reached={}
    rows=(await db.execute(select(User.id,User.used_traffic,ProxyInbound.tag).select_from(User)
        .join(users_groups_association,users_groups_association.c.user_id==User.id)
        .join(Group,Group.id==users_groups_association.c.groups_id)
        .join(inbounds_groups_association,inbounds_groups_association.c.group_id==Group.id)
        .join(ProxyInbound,ProxyInbound.id==inbounds_groups_association.c.inbound_id)
        .where(User.status=='active',Group.is_disabled.is_(False),ProxyInbound.tag.in_(tags)))).all() if configured else []
    by_user={}
    for uid,used,tag in rows:
        item=by_user.setdefault(str(uid),{'used':int(used or 0),'tags':set()});item['tags'].add(tag)
    for uid,user in by_user.items():
        ids=[]
        for identity,(tag,p) in configured.items():
            if tag not in user['tags']:continue
            ids.append(identity)
            if user['used']>=p['threshold_bytes']:reached.setdefault(uid,[]).append(identity)
            factor=p['speed_percent']/100 if user['used']>=p['threshold_bytes'] else 1
            rates[uid+'\0'+tag]=max(1,int(p['baseline_mbps']*125000*factor))
        if ids:users[uid]=ids
    revision=hashlib.sha256(json.dumps(rates,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    with store.lock():
        runtime=store.read('fair-runtime.json');runtime[str(target)]={'revision':revision,'users':users,'reached':reached,'policies':{h:policies[h] for h in configured},'updated_at':time.time()};store.write('fair-runtime.json',runtime)
    return {'revision':revision,'rates':rates}


def limited_groups():
    if not enabled():return {}
    groups={};policies=snapshot('fair-use.json')
    for target,record in snapshot('fair-runtime.json').items():
        if not ready(target,record.get('revision')):continue
        for uid,ids in record.get('reached',{}).items():
            valid=[policies[h]['threshold_bytes'] for h in ids if h in policies and policies[h]==record.get('policies',{}).get(h)]
            if valid:groups.setdefault(min(valid),set()).add(int(uid))
    return groups


def strip_legacy_routes(config):
    """Recognize the exact freedom/mark entries generated by the retired v2 adapter."""
    import re
    from copy import deepcopy
    output=deepcopy(config)
    removed=set()
    for outbound in output.get('outbounds',[]):
        mark=outbound.get('streamSettings',{}).get('sockopt',{}).get('mark')
        if (re.fullmatch(r'hs-fair-\d+-[a-f0-9]{10}',outbound.get('tag','')) and outbound.get('protocol')=='freedom'
            and outbound.get('settings',{})=={} and type(mark)==int and 0x48000000<=mark<=0x48ffffff):removed.add(outbound['tag'])
    if removed:
        output['outbounds']=[o for o in output['outbounds'] if o.get('tag') not in removed]
        routing=output.get('routing',{})
        routing['rules']=[r for r in routing.get('rules',[]) if r.get('outboundTag') not in removed]
    return output


async def retire_core_routes(db):
    from sqlalchemy import select
    from app.db.models import CoreConfig
    cores=(await db.execute(select(CoreConfig).with_for_update())).scalars().all()
    for core in cores:
        updated=strip_legacy_routes(core.config)
        if updated==core.config:continue
        with store.lock():
            backup=store.read('legacy-core-backups.json');backup.setdefault(str(core.id),core.config);store.write('legacy-core-backups.json',backup)
        core.config=updated
    await db.commit()
    with store.lock():
        jobs=store.read('jobs.json',[])
        for job in jobs:
            if job.get('action')=='fair-apply' and job.get('state') in {'queued','running'}:job.update(state='interrupted',error='Legacy packet-drop adapter retired')
        store.write('jobs.json',jobs)
