"""Fair-use state derived from charged user totals and live, acknowledged core pacing."""
from __future__ import annotations
import hashlib
import json
import os
import time
from pathlib import Path
try:
    from app import hs_services as store
except ImportError:
    import hs_services as store


STATE_FILE = Path(os.getenv('HS_PLUGIN_DATA_DIR', '/var/lib/pasarguard/hs-plugin')) / 'state.json'
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
        stamp = STATE_FILE.stat().st_mtime_ns
        key = str(STATE_FILE)
        if _cache.get(key, (None,))[0] != stamp:
            _cache[key] = (stamp, json.loads(STATE_FILE.read_text()))
        return bool(_cache[key][1].get('features',{}).get('fair_use',{}).get('enabled'))
    except (OSError, ValueError, TypeError):
        return False


def ready(target, revision):
    report=snapshot('reports.json').get(str(target),{})
    ack=report.get('fair_use',{})
    return (time.time()-report.get('updated_at',0)<40 and time.time()-ack.get('updated_at',0)<25
            and ack.get('adapter')=='hs-rate-v1' and ack.get('revision')==revision)


def _policy_digest():
    payload={
        "inbounds":snapshot('fair-use-inbounds.json'),
        "legacy_hosts":snapshot('fair-use.json'),
        "groups":snapshot('fair-use-groups.json'),
        "users":snapshot('fair-use-users.json'),
    }
    return hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def _active(policy,used):
    return policy.get('mode','threshold')=='always' or used>=int(policy.get('threshold_bytes',0))


def _replica_ready(state,target,record,uid,current,policy_digest):
    revision=record.get('revision')
    expected={str(value) for value in record.get('targets',[target])} or {str(target)}
    for peer_target in expected:
        peer=state.get(peer_target)
        if (peer is None or peer.get('revision')!=revision or peer.get('policy_digest')!=policy_digest
                or not ready(peer_target,revision)):
            return False
        if not set(current).issubset(peer.get('reached',{}).get(uid,[])):return False
        if any(peer.get('policies',{}).get(source)!=policy for source,policy in current.items()):return False
    return True


def user_state(user):
    native=str(getattr(getattr(user,'status','active'),'value',getattr(user,'status','active')))
    if native!='active' or not enabled():return None
    uid=str(user.id);used=max(0,int(user.used_traffic or 0))
    state=snapshot('fair-runtime.json');digest=_policy_digest()
    applicable={};tags=set();pending=False
    for target,record in state.items():
        sources=record.get('users',{}).get(uid,[])
        current={source:record.get('policies',{}).get(source) for source in sources}
        current={source:policy for source,policy in current.items() if policy and _active(policy,used)}
        if not current:continue
        if not _replica_ready(state,target,record,uid,current,digest):pending=True
        applicable.update(current)
        source_tags=record.get('source_tags',{})
        for source in current:tags.update(source_tags.get(source,[]))
    if not applicable:return None
    return {
        'status':'active' if pending else 'fair_limited','pending':pending,
        'source_ids':sorted(applicable),'inbound_tags':sorted(tags),
        'user_override':f'u:{uid}' in applicable,
    }


def configured_user_ids():
    if not enabled():return set()
    values=snapshot('fair-use-users.json')
    output=set()
    for identity,value in values.items():
        if not value:continue
        try:output.add(int(identity))
        except (TypeError,ValueError):pass
    return output


def user_configured(user):
    try:return int(user.id) in configured_user_ids()
    except (AttributeError,TypeError,ValueError):return False


def _status_value(value):
    return str(getattr(value,'value',value))


def _host_status_matches(host_id,host,effective_status):
    native={_status_value(value) for value in (getattr(host,'status',None) or [])}
    if snapshot('fair-host-status.json').get(str(host_id)) is True:
        native.add('fair_limited')
    return not native or effective_status in native


def filter_hosts(hosts,user):
    state=user_state(user)
    if not state or state['pending']:
        native_status=_status_value(getattr(user,'status','active'))
        return [host for host_id,host in hosts.items() if _host_status_matches(host_id,host,native_status)]
    tags=set(state.get('inbound_tags',[]))
    effective='active' if state.get('user_override') else 'fair_limited'
    return [host for host_id,host in hosts.items() if host.inbound_tag in tags and _host_status_matches(host_id,host,effective)]


async def manifest(db,target):
    from sqlalchemy import select
    from app.db.models import Node,CoreConfig,ProxyHost,User,Group,ProxyInbound,users_groups_association,inbounds_groups_association
    from app.hs_fair_use import validate_policy
    node=await db.get(Node,int(target))
    if node is None:return None
    core=await db.get(CoreConfig,node.core_config_id)
    if core is None:return None
    tags={i['tag'] for i in core.config.get('inbounds',[]) if i.get('tag') and i.get('protocol') in {'vless','vmess','trojan','shadowsocks','socks','http'}}
    hosts=(await db.execute(select(ProxyHost).where(ProxyHost.inbound_tag.in_(tags)))).scalars().all()
    raw_hosts=snapshot('fair-use.json') if enabled() else {}
    raw_inbounds=snapshot('fair-use-inbounds.json') if enabled() else {}
    raw_groups=snapshot('fair-use-groups.json') if enabled() else {}
    raw_users=snapshot('fair-use-users.json') if enabled() else {}
    inbound_rules={};migrations={}
    active_tags={host.inbound_tag for host in hosts if not host.is_disabled and host.inbound_tag}
    for tag in sorted(active_tags):
        value=raw_inbounds.get(tag)
        if value:
            try:inbound_rules[tag]=validate_policy(value);continue
            except ValueError:pass
        for host in sorted((item for item in hosts if item.inbound_tag==tag),key=lambda value:value.id):
            value=raw_hosts.get(str(host.id))
            if value:
                try:
                    inbound_rules[tag]=validate_policy(value);migrations[tag]=inbound_rules[tag];break
                except ValueError:pass
    if migrations:
        with store.lock():
            current=store.read('fair-use-inbounds.json');before=dict(current)
            for tag,policy in migrations.items():current.setdefault(tag,policy)
            if current!=before:store.write('fair-use-inbounds.json',current)
    group_rules={}
    for identity,value in raw_groups.items():
        try:group_rules[str(identity)]=validate_policy(value)
        except ValueError:pass
    user_rules={}
    for identity,value in raw_users.items():
        try:user_rules[str(identity)]=validate_policy(value)
        except ValueError:pass
    peers=sorted(str(value) for value in (await db.execute(select(Node.id).where(Node.core_config_id==node.core_config_id))).scalars().all())
    rates={};users={};reached={};runtime_policies={};source_tags={}
    rows=(await db.execute(select(User.id,User.used_traffic,Group.id,ProxyInbound.tag).select_from(User)
        .join(users_groups_association,users_groups_association.c.user_id==User.id)
        .join(Group,Group.id==users_groups_association.c.groups_id)
        .join(inbounds_groups_association,inbounds_groups_association.c.group_id==Group.id)
        .join(ProxyInbound,ProxyInbound.id==inbounds_groups_association.c.inbound_id)
        .where(User.status=='active',Group.is_disabled.is_(False),ProxyInbound.tag.in_(tags)))).all() if (inbound_rules or group_rules or user_rules) else []
    by_user={}
    for uid,used,gid,tag in rows:
        item=by_user.setdefault(str(uid),{'used':int(used or 0),'tags':{}})
        item['tags'].setdefault(tag,set()).add(str(gid))
    for uid,user in by_user.items():
        all_sources=set();hit=set()
        for tag,gids in user['tags'].items():
            entries=[]
            if uid in user_rules:
                entries.append((f'u:{uid}',user_rules[uid]))
            if tag in inbound_rules:
                source=f'i:{core.id}:{tag}';entries.append((source,inbound_rules[tag]))
            for gid in gids:
                if gid in group_rules:entries.append((f'g:{gid}',group_rules[gid]))
            if not entries:continue
            caps=[]
            for source,policy in entries:
                active=_active(policy,user['used'])
                factor=policy['speed_percent']/100 if active else 1
                caps.append(max(1,int(policy['baseline_mbps']*125000*factor)))
                all_sources.add(source);runtime_policies[source]=policy
                source_tags.setdefault(source,set()).add(tag)
                if active:hit.add(source)
            rates[uid+'\0'+tag]=min(caps)
        if all_sources:users[uid]=sorted(all_sources)
        if hit:reached[uid]=sorted(hit)
    source_tags={key:sorted(value) for key,value in source_tags.items()}
    revision=hashlib.sha256(json.dumps(rates,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    policy_digest=_policy_digest()
    with store.lock():
        runtime=store.read('fair-runtime.json')
        runtime[str(target)]={
            'revision':revision,'policy_digest':policy_digest,'targets':peers,'users':users,
            'reached':reached,'policies':runtime_policies,'source_tags':source_tags,'updated_at':time.time(),
        }
        store.write('fair-runtime.json',runtime)
    return {'revision':revision,'rates':rates}


def limited_groups():
    if not enabled():return {}
    groups={};state=snapshot('fair-runtime.json');digest=_policy_digest()
    for target,record in state.items():
        for uid,sources in record.get('reached',{}).items():
            current={source:record.get('policies',{}).get(source) for source in sources}
            current={source:policy for source,policy in current.items() if policy}
            if not current or not _replica_ready(state,target,record,uid,current,digest):continue
            threshold=min(int(policy.get('threshold_bytes',0)) for policy in current.values())
            groups.setdefault(threshold,set()).add(int(uid))
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
