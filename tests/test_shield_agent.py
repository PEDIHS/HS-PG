from backend.hs_shield_agent import DEFAULT_CONFIG, stage_for


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
