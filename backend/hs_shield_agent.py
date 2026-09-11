#!/usr/bin/env python3
"""HS Shield host telemetry and staged threat detector.

Phase 1 is deliberately observe-first: this process never inserts firewall rules,
restarts PasarGuard, or changes Docker networking. It builds the control-plane
telemetry needed for safe, health-checked enforcement in later stages.
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

DATA_DIR = Path(os.getenv("HS_SHIELD_DATA_DIR", "/var/lib/pasarguard/hs-plugin/shield"))
STATUS_FILE = DATA_DIR / "status.json"
CONFIG_FILE = DATA_DIR / "config.json"
EVENTS_FILE = DATA_DIR / "events.jsonl"
INTERVAL = max(1.0, float(os.getenv("HS_SHIELD_INTERVAL", "2")))
MAX_EVENTS = 500

DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": True,
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
    if current.get("mode") != "observe":
        # Enforcement is intentionally unavailable until preflight/rollback is wired.
        current["mode"] = "observe"
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


def count_ss(state: str) -> int:
    if not shutil.which("ss"):
        return 0
    code, output = run(["ss", "-Htan", "state", state], timeout=1.5)
    if code != 0 or not output:
        return 0
    return len(output.splitlines())


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


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(DATA_DIR, 0o700)
    config = ensure_config()
    previous = load_json(STATUS_FILE, {})
    prev_bytes, prev_packets = network_totals()
    prev_time = time.monotonic()
    baseline = previous.get("baseline") if isinstance(previous.get("baseline"), dict) else {"pps": 1.0, "bps": 1.0}
    previous_stage = str(previous.get("stage") or "starting")
    append_event("agent", "HS Shield telemetry agent started in observe-only fail-open mode", "starting")

    while True:
        time.sleep(INTERVAL)
        config = ensure_config()
        current_bytes, current_packets = network_totals()
        current_time = time.monotonic()
        elapsed = max(0.25, current_time - prev_time)
        pps = max(0.0, (current_packets - prev_packets) / elapsed)
        bps = max(0.0, ((current_bytes - prev_bytes) * 8.0) / elapsed)
        prev_bytes, prev_packets, prev_time = current_bytes, current_packets, current_time

        metrics = {
            "pps": round(pps, 2),
            "bps": round(bps, 2),
            "mbps": round(bps / 1_000_000.0, 2),
            "syn_recv": float(count_ss("syn-recv")),
            "established": float(count_ss("established")),
        }

        # Learn only from non-attack traffic so a flood does not poison the baseline.
        alpha = 0.08
        if previous_stage not in {"attack"}:
            baseline["pps"] = max(1.0, (1.0 - alpha) * float(baseline.get("pps", 1.0)) + alpha * pps)
            baseline["bps"] = max(1.0, (1.0 - alpha) * float(baseline.get("bps", 1.0)) + alpha * bps)

        stage, reasons = stage_for(config, metrics, baseline)
        exposure = pasarguard_exposure()
        layers = local_layers()
        ready_count = sum(1 for value in layers.values() if value.get("active"))
        status = {
            "version": 1,
            "updated_at": now_iso(),
            "enabled": bool(config.get("enabled", True)),
            "mode": "observe",
            "enforcement": {
                "active": False,
                "policy": "observe-only",
                "traffic_modified": False,
                "fail_open": True,
                "note": "Phase 1 never changes firewall, Docker or PasarGuard networking.",
            },
            "stage": stage,
            "stage_reasons": reasons,
            "metrics": metrics,
            "baseline": {"pps": round(float(baseline["pps"]), 2), "bps": round(float(baseline["bps"]), 2)},
            "origin": exposure,
            "layers": layers,
            "layers_ready": ready_count,
            "layers_total": len(layers),
        }
        atomic_json(STATUS_FILE, status)

        if stage != previous_stage:
            append_event(
                "stage",
                f"Threat stage changed from {previous_stage} to {stage}",
                stage,
                {"reasons": reasons, "pps": metrics["pps"], "mbps": metrics["mbps"], "syn_recv": int(metrics["syn_recv"])},
            )
            previous_stage = stage


if __name__ == "__main__":
    main()
