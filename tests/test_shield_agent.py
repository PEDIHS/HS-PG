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
tcp_state_counts = mod.tcp_state_counts


def telemetry_config():
    config = dict(DEFAULT_CONFIG)
    config["telemetry_enabled"] = True
    return config


def test_normal_stage_under_baseline():
    stage, reasons = stage_for(
        telemetry_config(),
        {"pps": 120.0, "bps": 2_000_000.0, "syn_recv": 4.0},
        {"pps": 100.0, "bps": 1_800_000.0},
    )
    assert stage == "normal"
    assert reasons


def test_elevated_stage_on_packet_spike():
    stage, reasons = stage_for(
        telemetry_config(),
        {"pps": 450.0, "bps": 2_000_000.0, "syn_recv": 5.0},
        {"pps": 100.0, "bps": 2_000_000.0},
    )
    assert stage == "elevated"
    assert any("packet rate" in reason for reason in reasons)


def test_attack_stage_on_syn_pressure():
    stage, reasons = stage_for(
        telemetry_config(),
        {"pps": 120.0, "bps": 2_000_000.0, "syn_recv": 700.0},
        {"pps": 100.0, "bps": 2_000_000.0},
    )
    assert stage == "attack"
    assert any("SYN-RECV" in reason for reason in reasons)


def test_disabled_goes_standby():
    config = telemetry_config()
    config["enabled"] = False
    stage, _ = stage_for(
        config,
        {"pps": 999999.0, "bps": 999999999.0, "syn_recv": 9999.0},
        {"pps": 1.0, "bps": 1.0},
    )
    assert stage == "standby"


def test_monitoring_can_be_disabled_without_disabling_static_firewall_config():
    config = telemetry_config()
    config["enabled"] = True
    config["telemetry_enabled"] = False
    stage, reasons = stage_for(
        config,
        {"pps": 999999.0, "bps": 999999999.0, "syn_recv": 9999.0},
        {"pps": 1.0, "bps": 1.0},
    )
    assert stage == "standby"
    assert any("telemetry" in reason for reason in reasons)


def test_low_cpu_is_default_and_live_monitor_is_opt_in():
    assert DEFAULT_CONFIG["low_cpu_mode"] is True
    assert DEFAULT_CONFIG["telemetry_enabled"] is False
    assert DEFAULT_CONFIG["integration_guard_enabled"] is True


def test_tcp_state_counts_reads_proc_without_subprocess(tmp_path):
    tcp = tmp_path / "tcp"
    tcp6 = tmp_path / "tcp6"
    header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
    tcp.write_text(
        header
        + "   0: 0100007F:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n"
        + "   1: 0100007F:1234 0200007F:5678 01 00000000:00000000 00:00000000 00000000 0 0 2\n"
        + "   2: 0100007F:1235 0200007F:5679 03 00000000:00000000 00:00000000 00000000 0 0 3\n",
        encoding="utf-8",
    )
    tcp6.write_text(
        header
        + "   0: 00000000000000000000000000000000:1234 00000000000000000000000000000000:5678 01 00000000:00000000 00:00000000 00000000 0 0 4\n",
        encoding="utf-8",
    )
    syn, established = tcp_state_counts((tcp, tcp6))
    assert syn == 1
    assert established == 2


if __name__ == "__main__":
    test_normal_stage_under_baseline()
    test_elevated_stage_on_packet_spike()
    test_attack_stage_on_syn_pressure()
    test_disabled_goes_standby()
    test_monitoring_can_be_disabled_without_disabling_static_firewall_config()
    test_low_cpu_is_default_and_live_monitor_is_opt_in()
    print("shield agent tests: OK")
