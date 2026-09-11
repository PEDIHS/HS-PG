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
