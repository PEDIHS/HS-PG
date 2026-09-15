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
