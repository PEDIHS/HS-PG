import base64
import copy
import json
import time
from pathlib import Path
import pytest
import hs_services as store
import hs_services_agent as agent
from hs_outbounds import add_warp, revision, wireguard_config
from hs_fair_use import evaluate, validate_policy

PROFILE = (
    "[Interface]\nPrivateKey = "
    + base64.b64encode(b"a" * 32).decode()
    + "\nAddress = 172.16.0.2/32\n[Peer]\nPublicKey = "
    + base64.b64encode(b"b" * 32).decode()
    + "\nEndpoint = engage.cloudflareclient.com:2408\n"
)


@pytest.fixture
def data(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA", tmp_path)
    return tmp_path


def test_queue_is_scoped_idempotent_and_lease_protected(data):
    a = store.enqueue("1", "renew", "example.com")
    b = store.enqueue("1", "renew", "example.com")
    assert a["id"] == b["id"]
    assert store.claim("2") is None
    job = store.claim("1")
    with pytest.raises(ValueError):
        store.finish("2", job["id"], job["lease"], {})
    with pytest.raises(ValueError):
        store.finish("1", job["id"], "bad", {})
    done = store.finish("1", job["id"], job["lease"], {"renewed": True})
    assert done["state"] == "succeeded"
    assert store.finish("1", job["id"], job["lease"], {})["state"] == "succeeded"


def test_expired_lease_is_not_replayed(data):
    store.enqueue("1", "mtproxy-create", "port:8443")
    store.claim("1")
    jobs = store.read("jobs.json")
    jobs[0]["lease_until"] = 0
    store.write("jobs.json", jobs)
    assert store.claim("1") is None
    assert store.read("jobs.json")[0]["state"] == "interrupted"


def test_agent_tokens_are_hashed_scoped_and_rotatable(data):
    token = store.enroll("7")
    assert token not in (data / "agents.json").read_text()
    assert store.authenticate("7", token) and not store.authenticate("8", token)
    store.enroll("7")
    assert not store.authenticate("7", token)
    assert (data / "agents.json").stat().st_mode & 0o777 == 0o600


def test_warp_preserves_core_and_scopes_routing():
    original = {
        "inbounds": [{"tag": "vless"}],
        "outbounds": [{"tag": "direct", "protocol": "freedom"}],
        "routing": {
            "rules": [{"outboundTag": "direct", "domain": ["domain:internal.test"]}]
        },
    }
    before = copy.deepcopy(original)
    result = add_warp(
        original, PROFILE, "hs-warp-test", ["domain:example.com"], ["vless"], [1, 2, 3]
    )
    assert original == before
    assert result["outbounds"][0] == original["outbounds"][0]
    assert result["routing"]["rules"][0]["inboundTag"] == ["vless"]
    assert result["outbounds"][1]["settings"]["reserved"] == [1, 2, 3]
    assert revision(result) != revision(original)
    with pytest.raises(ValueError):
        add_warp(result, PROFILE, "hs-warp-test", ["example.com"])
    with pytest.raises(ValueError):
        add_warp(original, PROFILE, "hs-warp-other", [], ["missing"])
    with pytest.raises(ValueError):
        add_warp(original, PROFILE, "hs-warp-other")


@pytest.mark.parametrize(
    "profile",
    [
        PROFILE.replace("2408", "99999"),
        PROFILE.replace(base64.b64encode(b"a" * 32).decode(), "garbage"),
        PROFILE + "[Peer2]\nPublicKey=x",
    ],
)
def test_warp_invalid_profiles(profile):
    with pytest.raises(ValueError):
        wireguard_config(profile)


def test_fair_per_user_threshold_status_precedence_and_draft():
    policies = {
        "1": dict(threshold_bytes=100_000_000_000, speed_percent=20, baseline_mbps=100)
    }
    u = dict(id=1, status="active", used_traffic=100_000_000_000)
    result = evaluate(u, policies, [1, 2])
    assert result["preview_status"] == "fair_limited" and result["status"] == "active"
    assert result["visible_host_ids"] == ["1", "2"] and result["rates_mbps"] == {
        "1": 20
    }
    assert not result["enforced"]
    result = evaluate(u, policies, [1, 2], True)
    assert result["status"] == "fair_limited" and result["visible_host_ids"] == ["1"]
    for status in ["expired", "disabled", "limited", "on_hold"]:
        assert (
            evaluate({**u, "status": status}, policies, [1, 2], True)["status"]
            == status
        )
    assert (
        evaluate({**u, "id": 2, "used_traffic": 0}, policies, [1, 2], True)["status"]
        == "active"
    )
    assert evaluate(u, policies, [2], True)["status"] == "active"


@pytest.mark.parametrize(
    "key,value",
    [("threshold_bytes", 0), ("speed_percent", float("nan")), ("baseline_mbps", 0)],
)
def test_invalid_fair_policy(key, value):
    p = dict(threshold_bytes=100, speed_percent=20, baseline_mbps=100)
    p[key] = value
    with pytest.raises(ValueError):
        validate_policy(p)


def test_renewal_requires_advanced_expiry(monkeypatch):
    monkeypatch.setattr(
        agent,
        "cert_inventory",
        lambda: [dict(id="example.com", renewable=True, expires_at=100)],
    )
    monkeypatch.setattr(agent, "run", lambda *a, **k: "")
    with pytest.raises(RuntimeError, match="expiry did not advance"):
        agent.renew("example.com")


def test_agent_rejects_arbitrary_job_and_proxy_paths():
    with pytest.raises(ValueError):
        agent.execute(dict(action="shell", resource="anything"))
    with pytest.raises(ValueError):
        agent.proxy_action("../../etc/passwd", "delete")


def test_inventory_only_lists_certbot_and_requires_renewal_config(tmp_path, monkeypatch):
    root = tmp_path / 'letsencrypt'
    for name in ('example.com', 'orphan.example'):
        file = root / 'live' / name / 'fullchain.pem'
        file.parent.mkdir(parents=True)
        file.write_text('test certificate')
    (root / 'renewal').mkdir()
    (root / 'renewal' / 'example.com.conf').write_text('renewal configuration')
    trust = tmp_path / 'node-trust.pem'
    trust.write_text('long-lived internal certificate')
    monkeypatch.setattr(agent, 'local_config', lambda: {'certbot_config_dir': str(root), 'certificates': [{'path': str(trust)}]})
    monkeypatch.setattr(agent.shutil, 'which', lambda _: '/usr/bin/certbot')
    monkeypatch.setattr(agent.ssl._ssl, '_test_decode_cert', lambda _: {
        'notBefore': 'Sep  1 00:00:00 2026 GMT', 'notAfter': 'Nov 30 00:00:00 2026 GMT',
        'subjectAltName': [('DNS', 'example.com')],
    })
    certificates = {c['id']: c for c in agent.cert_inventory()}
    assert set(certificates) == {'example.com', 'orphan.example'}
    assert certificates['example.com']['renewable']
    assert not certificates['orphan.example']['renewable']
    assert all(c['provider'] == 'certbot' for c in certificates.values())


def test_fair_agent_atomic_policy_and_core_ack(tmp_path, monkeypatch):
    monkeypatch.setattr(agent, 'STATE', tmp_path)
    monkeypatch.setattr(agent, 'local_config', lambda: {})
    manifest = {'revision': 'a' * 64, 'rates': {'1\0paid': 2500000}}
    agent.apply_fair_manifest(manifest)
    file = tmp_path / 'fair-policy.json'
    assert json.loads(file.read_text()) == manifest
    assert file.stat().st_mode & 0o777 == 0o600
    assert agent.fair_ack() == {}  # Writing a policy is not enforcement.
    ack = {'adapter': 'hs-rate-v1', 'revision': 'a' * 64, 'updated_at': time.time()}
    (tmp_path / 'fair-policy.json.ack').write_text(json.dumps(ack))
    assert agent.fair_ack() == ack
    with pytest.raises(ValueError):
        agent.apply_fair_manifest({'revision': 'b' * 64, 'rates': {'1\0paid': -10}})
    assert json.loads(file.read_text()) == manifest


def test_bootstrap_is_one_time_hashed_and_rotates_agent(data):
    bootstrap = store.issue_bootstrap('7', ttl=120)
    assert bootstrap not in (data / 'enrollments.json').read_text()
    token = store.exchange_bootstrap('7', bootstrap)
    assert token and token not in (data / 'agents.json').read_text()
    assert store.authenticate('7', token)
    assert store.exchange_bootstrap('7', bootstrap) is None


def test_expired_bootstrap_is_rejected(data):
    bootstrap = store.issue_bootstrap('7', ttl=60)
    records = store.read('enrollments.json')
    records['7']['expires_at'] = 0
    store.write('enrollments.json', records)
    assert store.exchange_bootstrap('7', bootstrap) is None


def test_bridge_update_is_fixed_atomic_and_remote_only(tmp_path, monkeypatch):
    monkeypatch.setattr(agent, "BRIDGE_ROOT", tmp_path)
    (tmp_path / "hs_services.py").write_text("OLD = 1\n")
    (tmp_path / "hs_services_agent.py").write_text("OLD = 2\n")
    payloads={
        "hs_services.py": b"VALUE = 11\n",
        "hs_services_agent.py": b"VALUE = 22\n",
    }
    class Response:
        def __init__(self,data): self.data=data
        def __enter__(self): return self
        def __exit__(self,*args): return False
        def read(self,limit): return self.data[:limit]
    def fake_open(url, timeout=30):
        name=url.rsplit("/",1)[-1]
        assert name in payloads and url.startswith(agent.BRIDGE_SOURCE + "/")
        return Response(payloads[name])
    monkeypatch.setattr(agent.urllib.request, "urlopen", fake_open)
    result=agent.bridge_update()
    assert result["updated"] is True and result["_restart_bridge"] is True
    assert (tmp_path / "hs_services.py").read_text()=="VALUE = 11\n"
    assert (tmp_path / "hs_services_agent.py").read_text()=="VALUE = 22\n"
    with pytest.raises(ValueError, match="remote Node"):
        agent.execute({"action":"bridge-update","resource":"bridge:self"})


def test_bridge_inventory_reports_system_and_protocol(monkeypatch):
    monkeypatch.setattr(agent, 'cert_inventory', lambda: [])
    monkeypatch.setattr(agent, 'proxies', lambda: [])
    monkeypatch.setattr(agent, 'fair_ack', lambda: {})
    monkeypatch.setattr(agent, 'pasarguard_inventory', lambda: {'detected': True, 'container': 'node'})
    report = agent.inventory()
    assert report['bridge']['protocol'] == 'hs-bridge-v1'
    assert report['capabilities']['bridge'] is True
    assert report['pasarguard']['detected'] is True
    assert report['system']['hostname']


def test_local_multi_node_inventory_is_instance_scoped(tmp_path, monkeypatch):
    one = tmp_path / 'node-one'
    two = tmp_path / 'node-two'
    (one / 'hs').mkdir(parents=True)
    (two / 'hs').mkdir(parents=True)
    ack = {'adapter':'hs-rate-v1','revision':'a'*64,'updated_at':time.time()}
    (one / 'hs' / 'fair-policy.json.ack').write_text(json.dumps(ack))
    def fake_run(args, timeout=30):
        if args[:3] == ['docker','ps','--format']:
            return 'c1\tnode\tpasarguard/node:latest\nc2\tnode-p-x\tpasarguard/node:latest\n'
        if args[:2] == ['docker','inspect']:
            cid=args[2]
            source = one if cid == 'c1' else two
            service = '62050' if cid == 'c1' else '62152'
            api = '62051' if cid == 'c1' else '62153'
            return json.dumps([{'Config':{'Env':[f'SERVICE_PORT={service}',f'API_PORT={api}','XRAY_EXECUTABLE_PATH=/var/lib/xray-hs-fair','HS_FAIR_POLICY_FILE=/var/lib/hs/fair-policy.json']},'Mounts':[{'Source':str(source),'Destination':'/var/lib/node'}]}])
        if args[:2] == ['docker','exec']:
            return 'Xray 26.3.27\n'
        raise AssertionError(args)
    monkeypatch.setattr(agent.shutil,'which',lambda name: '/usr/bin/'+name if name=='docker' else None)
    monkeypatch.setattr(agent,'run',fake_run)
    nodes=agent.pasarguard_nodes_inventory()
    assert [(n['service_port'],n['api_port']) for n in nodes] == [(62050,62051),(62152,62153)]
    assert nodes[0]['fair_use']['adapter']=='hs-rate-v1'
    assert nodes[1]['fair_use']=={}
    assert all(n['fair_core_configured'] for n in nodes)


def test_local_manifests_write_each_node_policy_file(tmp_path, monkeypatch):
    one = tmp_path / 'one'
    two = tmp_path / 'two'
    (one / 'hs').mkdir(parents=True)
    (two / 'hs').mkdir(parents=True)
    monkeypatch.setattr(agent, 'pasarguard_nodes_inventory', lambda private=False: [
        {'service_port':62050,'api_port':62051,'_fair_policy_file':str(one/'hs'/'fair-policy.json')},
        {'service_port':62152,'api_port':62153,'_fair_policy_file':str(two/'hs'/'fair-policy.json')},
    ])
    a={'revision':'a'*64,'rates':{'1\0paid':1250000}}
    b={'revision':'b'*64,'rates':{'2\0paid':2500000}}
    agent.apply_local_manifests([
        {'service_port':62050,'api_port':62051,'policy':a},
        {'service_port':62152,'api_port':62153,'policy':b},
    ])
    assert json.loads((one/'hs'/'fair-policy.json').read_text()) == a
    assert json.loads((two/'hs'/'fair-policy.json').read_text()) == b


def test_node_inventory_caches_static_docker_metadata_but_refreshes_ack(tmp_path, monkeypatch):
    source = tmp_path / 'node'
    (source / 'hs').mkdir(parents=True)
    ack_file = source / 'hs' / 'fair-policy.json.ack'
    ack_file.write_text(json.dumps({'adapter':'hs-rate-v1','revision':'a'*64,'updated_at':time.time()}))
    calls = {'ps':0,'inspect':0,'version':0}
    def fake_run(args, timeout=30):
        if args[:3] == ['docker','ps','--format']:
            calls['ps'] += 1
            return 'c1\tnode\tpasarguard/node:latest\n'
        if args[:2] == ['docker','inspect']:
            calls['inspect'] += 1
            return json.dumps([{'Config':{'Env':['SERVICE_PORT=62050','API_PORT=62051','XRAY_EXECUTABLE_PATH=/var/lib/xray-hs-fair','HS_FAIR_POLICY_FILE=/var/lib/hs/fair-policy.json']},'Mounts':[{'Source':str(source),'Destination':'/var/lib/node'}]}])
        if args[:2] == ['docker','exec']:
            calls['version'] += 1
            return 'Xray 26.3.27\n'
        raise AssertionError(args)
    monkeypatch.setattr(agent.shutil,'which',lambda name: '/usr/bin/docker' if name=='docker' else None)
    monkeypatch.setattr(agent,'run',fake_run)
    agent._PG_NODE_CACHE.update(at=0.0, rows=[])
    first = agent.pasarguard_nodes_inventory()
    ack_file.write_text(json.dumps({'adapter':'hs-rate-v1','revision':'b'*64,'updated_at':time.time()}))
    second = agent.pasarguard_nodes_inventory()
    assert calls == {'ps':1,'inspect':1,'version':1}
    assert first[0]['fair_use']['revision'] == 'a'*64
    assert second[0]['fair_use']['revision'] == 'b'*64


def test_local_panel_reuses_persistent_bridge_process(monkeypatch):
    class Out:
        def __init__(self): self.lines=[]
        def readline(self): return self.lines.pop(0) if self.lines else ''
    class In:
        def __init__(self, out): self.out=out; self.pending=''
        def write(self, value): self.pending += value; return len(value)
        def flush(self):
            request=json.loads(self.pending.strip()); self.pending=''
            self.out.lines.append(json.dumps({'ok':True,'result':{'action':request['action']}})+'\n')
    class Proc:
        def __init__(self): self.stdout=Out(); self.stdin=In(self.stdout); self.returncode=None
        def poll(self): return self.returncode
        def terminate(self): self.returncode=0
        def wait(self, timeout=None): return self.returncode
        def kill(self): self.returncode=-9
    created=[]
    def fake_popen(*args, **kwargs):
        proc=Proc(); created.append(proc); return proc
    monkeypatch.setattr(agent,'panel_container',lambda:'panel-cid')
    monkeypatch.setattr(agent.subprocess,'Popen',fake_popen)
    monkeypatch.setattr(agent.select,'select',lambda read,write,error,timeout:(read,[],[]))
    agent._close_local_bridge()
    try:
        assert agent.local_panel('poll', {'n':1}) == {'action':'poll'}
        assert agent.local_panel('poll', {'n':2}) == {'action':'poll'}
        assert len(created) == 1
    finally:
        agent._close_local_bridge()
