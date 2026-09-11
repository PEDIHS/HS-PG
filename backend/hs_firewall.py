"""Validated nftables policy; owns only inet hs_plugin, never the host ruleset."""

from __future__ import annotations
import hashlib
import ipaddress
import json
import shutil
import secrets
import os
import tempfile
import subprocess
import time
from pathlib import Path

TABLE = "hs_plugin"


def validate_policy(raw):
    if not isinstance(raw, dict):
        raise ValueError("Policy must be an object")
    ports = raw.get("management_ports", [22])
    if not isinstance(ports, list) or not ports or len(ports) > 32:
        raise ValueError("At least one protected management port is required")

    def port(v):
        if type(v) is not int or not 1 <= v <= 65535:
            raise ValueError("Ports must be integers between 1 and 65535")
        return v

    rules = raw.get("rules", [])
    if not isinstance(rules, list) or len(rules) > 200:
        raise ValueError("At most 200 rules are supported")
    clean = []
    ids = set()
    for r in rules:
        if not isinstance(r, dict):
            raise ValueError("Invalid rule")
        identity = str(r.get("id", ""))
        if not identity or len(identity) > 64 or identity in ids:
            raise ValueError("Rule IDs must be unique")
        ids.add(identity)
        action = r.get("action")
        protocol = r.get("protocol", "any")
        if action not in ("allow", "block") or protocol not in ("tcp", "udp", "any"):
            raise ValueError("Invalid action or protocol")
        network = str(ipaddress.ip_network(r.get("source", ""), strict=False))
        destination = r.get("port")
        if destination is not None:
            destination = port(destination)
            if protocol == "any":
                raise ValueError("A port requires TCP or UDP")
        clean.append(
            dict(
                id=identity,
                action=action,
                protocol=protocol,
                source=network,
                port=destination,
                enabled=bool(r.get("enabled", True)),
            )
        )
    syn_ports = raw.get("syn_ports", [])
    if not isinstance(syn_ports, list) or len(syn_ports) > 64:
        raise ValueError("Invalid SYN protection ports")
    rate = raw.get("syn_rate", 100)
    if type(rate) is not int or not 10 <= rate <= 100000:
        raise ValueError("SYN rate must be between 10 and 100000 per second")
    return dict(
        management_ports=sorted(set(map(port, ports))),
        rules=clean,
        syn_ports=sorted(set(map(port, syn_ports))),
        syn_rate=rate,
    )


def render_policy(policy, exists=False, elevated=False):
    p = validate_policy(policy)
    lines = [f"delete table inet {TABLE}"] if exists else []
    lines += [
        f"table inet {TABLE} {{",
        " chain input {",
        "  type filter hook input priority -10; policy accept;",
        '  iifname "lo" accept',
        "  ct state established,related accept",
        "  tcp dport { " + ", ".join(map(str, p["management_ports"])) + " } accept",
    ]
    # Explicit allows take priority regardless of UI row ordering.
    for action in ("allow", "block"):
        for r in p["rules"]:
            if not r["enabled"] or r["action"] != action:
                continue
            family = "ip6" if ":" in r["source"] else "ip"
            match = f"{family} saddr {r['source']}"
            if r["protocol"] != "any":
                match += f" meta l4proto {r['protocol']}"
            if r["port"] is not None:
                match += f" {r['protocol']} dport {r['port']}"
            lines.append(
                f"  {match} counter {'accept' if action == 'allow' else 'drop'}"
            )
    if elevated and p["syn_ports"]:
        ports = ", ".join(map(str, p["syn_ports"]))
        # Per-source meters prevent a single source consuming everyone's allowance.
        for family, size in [("ip", 65535), ("ip6", 65535)]:
            lines.append(
                f"  tcp dport {{ {ports} }} tcp flags & (syn | ack) == syn "
                f"meter syn_{family} size {size} {{ {family} saddr timeout 60s "
                f"limit rate over {p['syn_rate']}/second burst {p['syn_rate'] * 2} packets }} counter drop"
            )
    lines += [" }", "}"]
    return "\n".join(lines) + "\n"


def nft(args, text=None):
    p = subprocess.run(
        ["nft", *args], input=text, text=True, capture_output=True, timeout=10
    )
    if p.returncode:
        raise RuntimeError((p.stderr or "nftables failed")[-1500:])
    return p.stdout


def remove_table():
    if not shutil.which("nft"):
        return
    try:
        nft(["list", "table", "inet", TABLE])
    except RuntimeError:
        return
    nft(["delete", "table", "inet", TABLE])


def preflight_policy(policy, elevated=False):
    try:
        nft(["list", "table", "inet", TABLE])
        exists = True
    except RuntimeError:
        exists = False
    script = render_policy(policy, exists, elevated)
    nft(["--check", "-f", "-"], script)
    return script


def apply_policy(policy, elevated=False):
    script = preflight_policy(policy, elevated)
    nft(["-f", "-"], script)


class FirewallController:
    """Independent systemd rollback covers agent/process failure during application."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.state_file = directory / "enforcement.json"
        self.applied = None
        self.pending = None
        self.error = None
        self.rejected = None
        self.started = False
        self.timer_unit = "hs-firewall-rollback"
        try:
            saved = json.loads(self.state_file.read_text())
        except (OSError, ValueError):
            saved = {}
        self.confirmed_revision = saved.get("confirmed_revision")
        self.rejected = saved.get("rejected_revision")

    def persist(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", dir=self.directory, delete=False
        ) as stream:
            os.chmod(stream.name, 0o600)
            json.dump(
                {
                    "confirmed_revision": self.confirmed_revision,
                    "rejected_revision": self.rejected,
                },
                stream,
            )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(stream.name, self.state_file)

    def tick(self, config, stage):
        mode = (
            config.get("mode", "observe") if config.get("enabled", True) else "observe"
        )
        policy = validate_policy(config.get("policy", {}))
        revision = hashlib.sha256(
            json.dumps(policy, sort_keys=True).encode()
        ).hexdigest()
        elevated = (
            stage in ("attack", "elevated") if config.get("auto_stage", True) else True
        )
        armed = False
        try:
            if not self.started:
                subprocess.run(
                    [
                        "systemctl",
                        "stop",
                        self.timer_unit + ".timer",
                        self.timer_unit + ".service",
                    ],
                    capture_output=True,
                    timeout=5,
                )
                remove_table()
                self.started = True
                if (
                    mode == "enforce"
                    and self.confirmed_revision == revision
                    and self.rejected != revision
                ):
                    apply_policy(policy, elevated)
                    self.applied = revision
                    self.elevated = elevated
            if mode != "enforce":
                if self.applied or self.pending:
                    subprocess.run(
                        ["systemctl", "stop", self.timer_unit + ".timer"],
                        capture_output=True,
                        timeout=5,
                    )
                    remove_table()
                if self.confirmed_revision or self.rejected:
                    self.confirmed_revision = self.rejected = None
                    self.persist()
                self.applied = self.pending = self.rejected = None
                self.error = None
            elif self.pending and time.time() >= self.pending["deadline"]:
                remove_table()
                self.rejected = self.pending["revision"]
                self.persist()
                self.applied = self.pending = None
                self.error = "Policy rolled back: confirmation was not received within 45 seconds"
            elif (
                self.pending and config.get("confirmed_token") == self.pending["token"]
            ):
                subprocess.run(
                    ["systemctl", "stop", self.pending["unit"] + ".timer"],
                    check=True,
                    timeout=5,
                    capture_output=True,
                )
                self.applied = self.pending["revision"]
                self.confirmed_revision = self.applied
                self.rejected = None
                self.persist()
                self.pending = None
                self.error = None
            elif (
                not self.pending
                and self.applied != revision
                and self.rejected != revision
            ):
                # Syntax/capability check before arming rollback; invalid policies keep the current table.
                preflight_policy(policy, elevated)
                # Schedule rollback BEFORE a packet can be dropped.
                unit = self.timer_unit
                subprocess.run(
                    ["systemctl", "stop", unit + ".timer", unit + ".service"],
                    capture_output=True,
                    timeout=5,
                )
                subprocess.run(
                    ["systemctl", "reset-failed", unit + ".service"],
                    capture_output=True,
                    timeout=5,
                )
                deadline = time.time() + 45
                subprocess.run(
                    [
                        "systemd-run",
                        "--unit=" + unit,
                        "--on-active=45s",
                        shutil.which("nft") or "/usr/sbin/nft",
                        "delete",
                        "table",
                        "inet",
                        TABLE,
                    ],
                    check=True,
                    timeout=10,
                    capture_output=True,
                )
                armed = True
                apply_policy(policy, elevated)
                armed = False
                self.pending = dict(
                    revision=revision,
                    deadline=deadline,
                    unit=unit,
                    token=secrets.token_hex(16),
                )
                self.applied = None
                self.error = None
            elif self.applied == revision:
                # Refresh only if adaptive stage changes, preserving counters otherwise.
                if getattr(self, "elevated", None) != elevated:
                    apply_policy(policy, elevated)
            self.elevated = elevated
        except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as exc:
            self.error = str(exc)
            if armed:
                subprocess.run(
                    ["systemctl", "stop", self.timer_unit + ".timer"],
                    capture_output=True,
                    timeout=5,
                )
        return dict(
            active=bool(self.applied or self.pending),
            policy=mode,
            traffic_modified=bool(self.applied or self.pending),
            fail_open=True,
            pending=self.pending,
            revision=self.applied,
            error=self.error,
            scope="Host INPUT only; Docker forwarded traffic requires its own policy",
        )
