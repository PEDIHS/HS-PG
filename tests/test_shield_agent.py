from __future__ import annotations

import importlib.util
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "hs_shield_agent_test",
    Path(__file__).parents[1] / "backend" / "hs_shield_agent.py",
)
mod = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(mod)

DEFAULT_CONFIG = mod.DEFAULT_CONFIG
stage_for = mod.stage_for


def test_normal_stage_under_baseline():
    stage, reasons = stage_for(
        dict(DEFAULT_CONFIG),
        {"pps": 120.0, "bps": 2_000_000.0, "syn_recv": 4.0},
        {"pps": 100.0, "bps": 1_800_000.0},
    )
    assert stage == "normal"
    assert reasons


def test_elevated_stage_on_packet_spike():
    stage, reasons = stage_for(
        dict(DEFAULT_CONFIG),
        {"pps": 450.0, "bps": 2_000_000.0, "syn_recv": 5.0},
        {"pps": 100.0, "bps": 2_000_000.0},
    )
    assert stage == "elevated"
    assert any("packet rate" in reason for reason in reasons)


def test_attack_stage_on_syn_pressure():
    stage, reasons = stage_for(
        dict(DEFAULT_CONFIG),
        {"pps": 120.0, "bps": 2_000_000.0, "syn_recv": 700.0},
        {"pps": 100.0, "bps": 2_000_000.0},
    )
    assert stage == "attack"
    assert any("SYN-RECV" in reason for reason in reasons)


def test_disabled_goes_standby():
    config = dict(DEFAULT_CONFIG)
    config["enabled"] = False
    stage, _ = stage_for(
        config,
        {"pps": 999999.0, "bps": 999999999.0, "syn_recv": 9999.0},
        {"pps": 1.0, "bps": 1.0},
    )
    assert stage == "standby"


def test_monitoring_can_be_disabled_without_disabling_static_firewall_config():
    config = dict(DEFAULT_CONFIG)
    config["enabled"] = True
    config["telemetry_enabled"] = False
    stage, reasons = stage_for(
        config,
        {"pps": 999999.0, "bps": 999999999.0, "syn_recv": 9999.0},
        {"pps": 1.0, "bps": 1.0},
    )
    assert stage == "standby"
    assert any("telemetry" in reason for reason in reasons)


def test_low_cpu_and_guard_are_safe_defaults():
    assert DEFAULT_CONFIG["low_cpu_mode"] is True
    assert DEFAULT_CONFIG["telemetry_enabled"] is True
    assert DEFAULT_CONFIG["integration_guard_enabled"] is True


if __name__ == "__main__":
    test_normal_stage_under_baseline()
    test_elevated_stage_on_packet_spike()
    test_attack_stage_on_syn_pressure()
    test_disabled_goes_standby()
    test_monitoring_can_be_disabled_without_disabling_static_firewall_config()
    test_low_cpu_and_guard_are_safe_defaults()
    print("shield agent tests: OK")
