import json
from types import SimpleNamespace

import pytest

import hs_fair_use_runtime as fair


def policy(threshold=100, percent=20, baseline=100):
    return {
        "threshold_bytes": threshold,
        "speed_percent": percent,
        "baseline_mbps": baseline,
    }


def test_status_is_derived_per_user_and_native_status_wins():
    policies = {"in-a": policy(100)}
    assert fair.derived_status("active", 99, policies) == "active"
    assert fair.derived_status("active", 100, policies) == "fair_limited"
    for status in ("disabled", "expired", "limited", "on_hold"):
        assert fair.derived_status(status, 1000, policies) == status


def test_plan_is_per_user_and_per_inbound():
    policies = {
        "a": policy(100, 20, 100),
        "b": policy(200, 50, 80),
    }
    users = [
        {"id": 1, "status": "active", "used_traffic": 100},
        {"id": 2, "status": "active", "used_traffic": 250},
        {"id": 3, "status": "expired", "used_traffic": 999},
    ]
    plan = fair.build_rate_plan(users, policies)
    assert [(x["user_id"], x["inbound_tag"], x["rate_mbps"]) for x in plan] == [
        (1, "a", 20.0),
        (2, "a", 20.0),
        (2, "b", 40.0),
    ]
    assert len({x["mark"] for x in plan}) == len(plan)
    assert all(0x48000000 <= x["mark"] <= 0x48FFFFFF for x in plan)


def test_subscription_only_keeps_fair_hosts_for_limited_user(tmp_path, monkeypatch):
    monkeypatch.setattr(fair, "COMPILED", tmp_path / "fair.json")
    fair.write_runtime({"policies": {"fair-a": policy(100)}})
    hosts = [SimpleNamespace(inbound_tag="fair-a"), SimpleNamespace(inbound_tag="normal-b")]
    user = SimpleNamespace(status=SimpleNamespace(value="active"), used_traffic=100)
    assert [h.inbound_tag for h in fair.filter_subscription_hosts(hosts, user)] == ["fair-a"]
    user.used_traffic = 99
    assert [h.inbound_tag for h in fair.filter_subscription_hosts(hosts, user)] == ["fair-a", "normal-b"]


def test_xray_plan_preserves_native_objects_and_is_idempotent():
    config = {
        "inbounds": [{"tag": "a", "protocol": "vless"}],
        "outbounds": [{"tag": "direct", "protocol": "freedom"}],
        "routing": {"rules": [{"type": "field", "domain": ["example.com"], "outboundTag": "direct"}]},
    }
    plan = fair.build_rate_plan([{"id": 5, "status": "active", "used_traffic": 100}], {"a": policy(100)})
    once = fair.apply_xray_rate_plan(config, plan)
    twice = fair.apply_xray_rate_plan(once, plan)
    assert twice == once
    assert once["outbounds"][0] == config["outbounds"][0]
    generated = [x for x in once["outbounds"] if x["tag"].startswith("hs-fair-")]
    assert len(generated) == 1
    assert generated[0]["streamSettings"]["sockopt"]["mark"] == plan[0]["mark"]
    rule = once["routing"]["rules"][0]
    assert rule["inboundTag"] == ["a"] and rule["user"] == ["5"]


def test_nft_script_has_separate_rate_bucket_per_mark():
    plan = [
        {"user_id": 1, "inbound_tag": "a", "mark": 0x48000001, "rate_mbps": 20},
        {"user_id": 2, "inbound_tag": "a", "mark": 0x48000002, "rate_mbps": 20},
    ]
    text = fair.nft_rate_script(plan)
    assert "table inet hs_fair_use" in text
    assert "meta mark 1207959553" in text
    assert "meta mark 1207959554" in text
    assert text.count("limit rate over") == 2


@pytest.mark.parametrize(
    "bad",
    [
        {"threshold_bytes": 0, "speed_percent": 20, "baseline_mbps": 100},
        {"threshold_bytes": 100, "speed_percent": 0, "baseline_mbps": 100},
        {"threshold_bytes": 100, "speed_percent": 20, "baseline_mbps": 0},
    ],
)
def test_policy_validation_rejects_invalid_values(bad):
    with pytest.raises(ValueError):
        fair.normalize_policy(bad)
