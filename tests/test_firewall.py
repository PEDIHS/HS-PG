import pytest
import hs_firewall as fw
from patch_shield_api import patch_router

POLICY = dict(
    management_ports=[22, 2222],
    syn_ports=[443],
    syn_rate=100,
    rules=[
        dict(
            id="block", source="192.0.2.0/24", action="block", protocol="tcp", port=443
        ),
        dict(id="allow", source="192.0.2.10", action="allow", protocol="any"),
    ],
)


def test_rules_preserve_management_ipv6_and_scope():
    result = fw.render_policy(POLICY, exists=True, elevated=True)
    assert result.startswith("delete table inet hs_plugin\n")
    assert "flush ruleset" not in result
    assert result.index("tcp dport { 22, 2222 } accept") < result.index("192.0.2.0/24")
    assert result.index("192.0.2.10/32") < result.index("192.0.2.0/24")
    assert "ip6 saddr" in result and "meter syn_ip" in result
    assert "policy accept" in result
    assert "ct state" not in result
    assert " counter " not in result


@pytest.mark.parametrize(
    "patch",
    [
        {"management_ports": []},
        {"syn_rate": True},
        {"syn_rate": float("inf")},
        {"rules": [dict(id="x", action="block", source="0.0.0.0/0; flush ruleset")]},
    ],
)
def test_invalid_policy_rejected(patch):
    with pytest.raises(ValueError):
        fw.validate_policy({**POLICY, **patch})


def test_preflight_before_apply(monkeypatch):
    calls = []
    monkeypatch.setattr(
        fw, "nft", lambda args, text=None: calls.append((args, text)) or ""
    )
    fw.apply_policy(POLICY)
    assert calls[1][0] == ["--check", "-f", "-"]
    assert calls[2][0] == ["-f", "-"] and calls[1][1] == calls[2][1]


def test_rollback_confirm_and_fast_reenable(tmp_path, monkeypatch):
    clock = [1000.0]
    operations = []
    monkeypatch.setattr(fw.time, "time", lambda: clock[0])
    monkeypatch.setattr(
        fw.subprocess, "run", lambda args, **kw: operations.append(args)
    )
    monkeypatch.setattr(fw, "remove_table", lambda: operations.append("remove"))
    monkeypatch.setattr(fw, "apply_policy", lambda *a: operations.append("apply"))
    monkeypatch.setattr(fw, "preflight_policy", lambda *a: operations.append("preflight"))
    controller = fw.FirewallController(tmp_path)
    config = dict(mode="enforce", enabled=True, policy=POLICY)
    pending = controller.tick(config, "normal")["pending"]
    assert operations.index("apply") > next(
        i
        for i, a in enumerate(operations)
        if isinstance(a, list) and a[0] == "systemd-run"
    )
    confirmed = controller.tick({**config, "confirmed_token": pending["token"]}, "normal")
    assert confirmed["revision"]

    restarted = fw.FirewallController(tmp_path)
    timer_count = sum(isinstance(op, list) and op[0] == "systemd-run" for op in operations)
    restored = restarted.tick(config, "normal")
    assert restored["active"] and restored["pending"] is None
    assert sum(isinstance(op, list) and op[0] == "systemd-run" for op in operations) == timer_count

    # Turning the firewall off removes HS rules but retains confirmation for the exact
    # same policy. Turning it back on does not arm another rollback timer.
    off = controller.tick({"enabled": False, "mode": "observe", "policy": POLICY}, "normal")
    assert not off["active"]
    before = sum(isinstance(op, list) and op[0] == "systemd-run" for op in operations)
    again = controller.tick(config, "normal")
    assert again["active"] and again["pending"] is None
    assert sum(isinstance(op, list) and op[0] == "systemd-run" for op in operations) == before

    # A changed policy is a new revision and still requires confirmation/rollback.
    changed = {**POLICY, "syn_rate": 101}
    new_pending = controller.tick({**config, "policy": changed}, "normal")["pending"]
    assert new_pending and new_pending["token"] != pending["token"]
    clock[0] += 46
    assert not controller.tick({**config, "policy": changed}, "normal")["active"]
    assert "rolled back" in controller.error


def test_router_upgrades_wrong_import_idempotently():
    original = "from fastapi import APIRouter\napi_router = APIRouter()\nrouters = []\nfor router in routers:\n    api_router.include_router(router)\n"
    once = patch_router(original)
    assert patch_router(once) == once
    assert (
        "from app import hs_shield_api" in once
        and "from app import hs_services_api" in once
    )
    old = once.replace("from app import hs_shield_api", "from . import hs_shield_api")
    assert patch_router(old) == once
