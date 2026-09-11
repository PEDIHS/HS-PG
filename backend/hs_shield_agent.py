#!/usr/bin/env python3
"""HS Shield firewall controller with opt-in low-overhead telemetry.

Steady state must be nearly idle: no ss subprocesses, no repeated nft/systemctl work,
and no Docker probes unless their slow health cadence is due.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from hs_firewall import FirewallController

DATA_DIR = Path(os.getenv("HS_SHIELD_DATA_DIR", "/var/lib/pasarguard/hs-plugin/shield"))
STATUS_FILE = DATA_DIR / "status.json"
CONFIG_FILE = DATA_DIR / "config.json"
EVENTS_FILE = DATA_DIR / "events.jsonl"
CONTROL_INTERVAL = max(2.0, float(os.getenv("HS_SHIELD_CONTROL_INTERVAL", "3")))
NORMAL_SAMPLE_INTERVAL = max(5.0, float(os.getenv("HS_SHIELD_SAMPLE_INTERVAL", "10")))
LOW_CPU_SAMPLE_INTERVAL = max(NORMAL_SAMPLE_INTERVAL, float(os.getenv("HS_SHIELD_LOW_CPU_INTERVAL", "30")))
NORMAL_HEALTH_INTERVAL = max(60.0, float(os.getenv("HS_SHIELD_HEALTH_INTERVAL", "120")))
LOW_CPU_HEALTH_INTERVAL = max(NORMAL_HEALTH_INTERVAL, float(os.getenv("HS_SHIELD_LOW_CPU_HEALTH_INTERVAL", "900")))
MAX_EVENTS = 500

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": True,
    "telemetry_enabled": False,
    "low_cpu_mode": True,
    "integration_guard_enabled": True,
    "mode": "observe",
    "auto_stage": True,
    "safe_fail_open": True,
    "elevated_pps_multiplier": 4.0,
    "attack_pps_multiplier": 8.0,
    "elevated_bps_multiplier": 4.0,
    "attack_bps_multiplier": 8.0,
    "elevated_syn_recv": 128,
    "attack_syn_recv": 512,
}


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def load_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else dict(default)
    except (OSError, ValueError, TypeError):
        return dict(default)


def ensure_config() -> dict[str, Any]:
    current = load_json(CONFIG_FILE, DEFAULT_CONFIG)
    changed = False
    for key, value in DEFAULT_CONFIG.items():
        if key not in current:
            current[key] = value
            changed = True
    if changed or not CONFIG_FILE.exists():
        atomic_json(CONFIG_FILE, current)
    return current


def run(command: list[str], timeout: float = 2.0) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def service_active(name: str) -> bool:
    if not shutil.which("systemctl"):
        return False
    code, output = run(["systemctl", "is-active", name], timeout=1.5)
    return code == 0 and output == "active"


def network_totals() -> tuple[int, int]:
    total_bytes = 0
    total_packets = 0
    try:
        lines = Path("/proc/net/dev").read_text(encoding="utf-8").splitlines()[2:]
    except OSError:
        return 0, 0
    for line in lines:
        if ":" not in line:
            continue
        iface, raw = line.split(":", 1)
        if iface.strip() == "lo":
            continue
        fields = raw.split()
        if len(fields) < 10:
            continue
        try:
            rx_bytes, rx_packets = int(fields[0]), int(fields[1])
            tx_bytes, tx_packets = int(fields[8]), int(fields[9])
        except ValueError:
            continue
        total_bytes += rx_bytes + tx_bytes
        total_packets += rx_packets + tx_packets
    return total_bytes, total_packets


def tcp_state_counts(paths: tuple[Path, ...] | None = None) -> tuple[int, int]:
    """Return SYN_RECV and ESTABLISHED counts without spawning `ss`.

    Linux exposes the TCP state as hexadecimal field 4 in /proc/net/tcp{,6}:
    01 = ESTABLISHED, 03 = SYN_RECV.
    """
    syn_recv = 0
    established = 0
    paths = paths or (Path("/proc/net/tcp"), Path("/proc/net/tcp6"))
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 4:
                continue
            state = fields[3].upper()
            if state == "03":
                syn_recv += 1
            elif state == "01":
                established += 1
    return syn_recv, established


def pasarguard_exposure() -> dict[str, Any]:
    result: dict[str, Any] = {"state": "unknown", "public_bindings": [], "container": None}
    if not shutil.which("docker"):
        return result
    code, ids = run(["docker", "ps", "--filter", "ancestor=pasarguard/panel", "--format", "{{.ID}}"], timeout=2.5)
    if code != 0 or not ids:
        return result
    cid = ids.splitlines()[0].strip()
    result["container"] = cid[:12]
    code, raw = run(["docker", "inspect", "-f", "{{json .HostConfig.PortBindings}}", cid], timeout=2.5)
    if code != 0 or not raw:
        return result
    try:
        bindings = json.loads(raw)
    except ValueError:
        return result
    public: list[dict[str, str]] = []
    if isinstance(bindings, dict):
        for container_port, values in bindings.items():
            for item in values or []:
                if not isinstance(item, dict):
                    continue
                host_ip = str(item.get("HostIp") or "")
                host_port = str(item.get("HostPort") or "")
                if host_ip in {"", "0.0.0.0", "::"}:
                    public.append({"container_port": str(container_port), "host_ip": host_ip or "0.0.0.0", "host_port": host_port})
    result["public_bindings"] = public
    result["state"] = "public" if public else "hidden"
    return result


def local_layers() -> dict[str, Any]:
    return {
        "cloudflare_tunnel": {
            "active": service_active("cloudflared.service") or service_active("cloudflared"),
            "role": "edge-tunnel",
        },
        "haproxy": {"active": service_active("haproxy.service") or service_active("haproxy"), "role": "reverse-proxy"},
        "nftables": {
            "active": service_active("nftables.service") or bool(shutil.which("nft")),
            "role": "local-firewall",
        },
        "fastnetmon": {
            "active": service_active("fastnetmon.service") or service_active("fastnetmon"),
            "role": "detector",
        },
        "hs_detector": {"active": True, "role": "adaptive-detector"},
    }


def stage_for(config: dict[str, Any], metrics: dict[str, float], baseline: dict[str, float]) -> tuple[str, list[str]]:
    if not config.get("enabled", True):
        return "standby", ["shield disabled"]
    if not config.get("telemetry_enabled", False):
        return "standby", ["live security telemetry disabled"]
    reasons: list[str] = []
    pps = metrics["pps"]
    bps = metrics["bps"]
    syn = metrics["syn_recv"]
    pps_base = max(1.0, baseline.get("pps", 1.0))
    bps_base = max(1.0, baseline.get("bps", 1.0))
    pps_ratio = pps / pps_base
    bps_ratio = bps / bps_base

    attack = (
        pps_ratio >= float(config["attack_pps_multiplier"])
        or bps_ratio >= float(config["attack_bps_multiplier"])
        or syn >= int(config["attack_syn_recv"])
    )
    elevated = (
        pps_ratio >= float(config["elevated_pps_multiplier"])
        or bps_ratio >= float(config["elevated_bps_multiplier"])
        or syn >= int(config["elevated_syn_recv"])
    )
    if pps_ratio >= float(config["elevated_pps_multiplier"]):
        reasons.append(f"packet rate {pps_ratio:.1f}x baseline")
    if bps_ratio >= float(config["elevated_bps_multiplier"]):
        reasons.append(f"bandwidth {bps_ratio:.1f}x baseline")
    if syn >= int(config["elevated_syn_recv"]):
        reasons.append(f"SYN-RECV {int(syn)}")
    if attack:
        return "attack", reasons or ["attack threshold crossed"]
    if elevated:
        return "elevated", reasons or ["elevated threshold crossed"]
    return "normal", ["traffic within learned baseline"]


def append_event(kind: str, message: str, stage: str, metadata: dict[str, Any] | None = None) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    event = {
        "at": now_iso(),
        "kind": kind,
        "stage": stage,
        "message": message,
        "metadata": metadata or {},
    }
    with EVENTS_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    try:
        lines = EVENTS_FILE.read_text(encoding="utf-8").splitlines()
        if len(lines) > MAX_EVENTS:
            tmp = EVENTS_FILE.with_suffix(".jsonl.tmp")
            tmp.write_text("\n".join(lines[-MAX_EVENTS:]) + "\n", encoding="utf-8")
            os.chmod(tmp, 0o600)
            os.replace(tmp, EVENTS_FILE)
    except OSError:
        pass


def _fingerprint(config: dict[str, Any]) -> str:
    return json.dumps(
        {
            "enabled": bool(config.get("enabled", True)),
            "telemetry_enabled": bool(config.get("telemetry_enabled", False)),
            "low_cpu_mode": bool(config.get("low_cpu_mode", True)),
            "mode": config.get("mode", "observe"),
            "auto_stage": bool(config.get("auto_stage", True)),
            "policy": config.get("policy", {}),
            "confirmed_token": config.get("confirmed_token"),
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(DATA_DIR, 0o700)
    config = ensure_config()
    previous = load_json(STATUS_FILE, {})
    telemetry_was_enabled = bool(config.get("telemetry_enabled", False))
    prev_bytes, prev_packets = network_totals() if telemetry_was_enabled else (0, 0)
    prev_time = time.monotonic()
    baseline = previous.get("baseline") if isinstance(previous.get("baseline"), dict) else {"pps": 1.0, "bps": 1.0}
    metrics = previous.get("metrics") if isinstance(previous.get("metrics"), dict) else {"pps": 0.0, "bps": 0.0, "mbps": 0.0, "syn_recv": 0.0, "established": 0.0}
    exposure = previous.get("origin") if isinstance(previous.get("origin"), dict) else {"state": "unknown", "public_bindings": [], "container": None}
    layers = previous.get("layers") if isinstance(previous.get("layers"), dict) else {}
    previous_stage = str(previous.get("stage") or "starting")
    stage = previous_stage
    reasons = list(previous.get("stage_reasons") or ["starting"])
    enforcement = previous.get("enforcement") if isinstance(previous.get("enforcement"), dict) else {}
    controller = FirewallController(DATA_DIR)
    next_sample = 0.0
    next_health = 0.0
    last_status_write = 0.0
    last_config_fingerprint = ""
    last_controller_stage: str | None = None
    append_event("agent", "HS Shield started in ultra-low-CPU mode", "starting")

    while True:
        time.sleep(CONTROL_INTERVAL)
        config = ensure_config()
        now = time.monotonic()
        telemetry_enabled = bool(config.get("telemetry_enabled", False))
        low_cpu_mode = bool(config.get("low_cpu_mode", True))
        sample_interval = LOW_CPU_SAMPLE_INTERVAL if low_cpu_mode else NORMAL_SAMPLE_INTERVAL
        health_interval = LOW_CPU_HEALTH_INTERVAL if low_cpu_mode else NORMAL_HEALTH_INTERVAL
        config_fingerprint = _fingerprint(config)
        config_changed = config_fingerprint != last_config_fingerprint
        if config_changed:
            last_config_fingerprint = config_fingerprint

        if telemetry_enabled and not telemetry_was_enabled:
            prev_bytes, prev_packets = network_totals()
            prev_time = time.monotonic()
            next_sample = now + min(2.0, sample_interval)
            next_health = now
        telemetry_was_enabled = telemetry_enabled

        sampled = False
        if telemetry_enabled and now >= next_sample:
            current_bytes, current_packets = network_totals()
            current_time = time.monotonic()
            elapsed = max(0.25, current_time - prev_time)
            pps = max(0.0, (current_packets - prev_packets) / elapsed)
            bps = max(0.0, ((current_bytes - prev_bytes) * 8.0) / elapsed)
            prev_bytes, prev_packets, prev_time = current_bytes, current_packets, current_time
            syn_recv, established = tcp_state_counts()
            metrics = {
                "pps": round(pps, 2),
                "bps": round(bps, 2),
                "mbps": round(bps / 1_000_000.0, 2),
                "syn_recv": float(syn_recv),
                "established": float(established),
            }
            if previous_stage in {"starting", "standby", "unavailable"}:
                baseline = {"pps": max(1.0, pps), "bps": max(1.0, bps)}
            alpha = 0.08
            detected, _ = stage_for(config, metrics, baseline)
            if detected not in {"attack", "elevated"}:
                baseline["pps"] = max(1.0, (1.0 - alpha) * float(baseline.get("pps", 1.0)) + alpha * pps)
                baseline["bps"] = max(1.0, (1.0 - alpha) * float(baseline.get("bps", 1.0)) + alpha * bps)
            stage, reasons = stage_for(config, metrics, baseline)
            next_sample = now + sample_interval
            sampled = True
        elif not telemetry_enabled and (config_changed or stage != "standby"):
            metrics = {"pps": 0.0, "bps": 0.0, "mbps": 0.0, "syn_recv": 0.0, "established": 0.0}
            stage, reasons = stage_for(config, metrics, baseline)
        elif config_changed:
            stage, reasons = stage_for(config, metrics, baseline)

        if telemetry_enabled and now >= next_health:
            exposure = pasarguard_exposure()
            layers = local_layers()
            next_health = now + health_interval
        elif not telemetry_enabled:
            layers = dict(layers)
            layers["hs_detector"] = {"active": False, "role": "monitoring-paused"}

        stage_changed_for_controller = stage != last_controller_stage
        if config_changed or stage_changed_for_controller or controller.pending or not enforcement:
            enforcement = controller.tick(config, stage)
            last_controller_stage = stage
            if (
                isinstance(enforcement, dict)
                and not enforcement.get("active")
                and "rolled back" in str(enforcement.get("error") or "").lower()
                and config.get("mode") == "enforce"
            ):
                config["enabled"] = False
                config["mode"] = "observe"
                config.pop("confirmed_token", None)
                atomic_json(CONFIG_FILE, config)
                last_config_fingerprint = _fingerprint(config)

        heartbeat_interval = 20.0 if telemetry_enabled else 60.0
        should_write = sampled or config_changed or stage_changed_for_controller or controller.pending or (now - last_status_write) >= heartbeat_interval
        if should_write:
            ready_count = sum(1 for value in layers.values() if isinstance(value, dict) and value.get("active"))
            status = {
                "version": 3,
                "updated_at": now_iso(),
                "enabled": bool(config.get("enabled", True)),
                "telemetry_enabled": telemetry_enabled,
                "low_cpu_mode": low_cpu_mode,
                "integration_guard_enabled": bool(config.get("integration_guard_enabled", True)),
                "sample_interval": sample_interval if telemetry_enabled else None,
                "mode": config.get("mode", "observe"),
                "enforcement": enforcement,
                "stage": stage,
                "stage_reasons": reasons,
                "metrics": metrics,
                "baseline": {"pps": round(float(baseline.get("pps", 1.0)), 2), "bps": round(float(baseline.get("bps", 1.0)), 2)},
                "origin": exposure,
                "layers": layers,
                "layers_ready": ready_count,
                "layers_total": len(layers),
            }
            atomic_json(STATUS_FILE, status)
            last_status_write = now

        if telemetry_enabled and stage != previous_stage:
            append_event(
                "stage",
                f"Threat stage changed from {previous_stage} to {stage}",
                stage,
                {"reasons": reasons, "pps": metrics["pps"], "mbps": metrics["mbps"], "syn_recv": int(metrics["syn_recv"])},
            )
        previous_stage = stage


if __name__ == "__main__":
    main()
