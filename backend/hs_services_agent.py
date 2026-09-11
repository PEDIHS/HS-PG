#!/usr/bin/env python3
"""HS host/node worker. Executes fixed certificate/MTProxy actions, never arbitrary shell."""

from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import ssl
import subprocess
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit
import hs_services as store

LOCAL_CONFIG = Path("/etc/hs-pg/services.json")
STATE = Path(os.getenv("HS_SERVICES_AGENT_DATA", "/var/lib/hs-pg-agent"))
MT_BINARY = "/usr/local/bin/mtproto-proxy"


def run(args, timeout=30):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        # Do not expose command line secrets or ACME provider credentials in API errors.
        raise RuntimeError(
            f"{Path(args[0]).name} failed (exit {p.returncode}); inspect the local service journal"
        )
    return p.stdout


def local_config():
    try:
        return json.loads(LOCAL_CONFIG.read_text())
    except FileNotFoundError:
        return {}


def cert_inventory():
    result = []
    sources = [
        (p.parent.name, p, "certbot")
        for p in Path("/etc/letsencrypt/live").glob("*/fullchain.pem")
    ]
    for item in local_config().get("certificates", []):
        sources.append((item["id"], Path(item["path"]), item.get("provider", "manual")))
    for identity, path, provider in sources:
        try:
            decoded = ssl._ssl._test_decode_cert(str(path))
            expires = ssl.cert_time_to_seconds(decoded["notAfter"])
            starts = ssl.cert_time_to_seconds(decoded["notBefore"])
            domains = [v for k, v in decoded.get("subjectAltName", []) if k == "DNS"]
            result.append(
                dict(
                    id=identity,
                    domains=domains,
                    expires_at=expires,
                    starts_at=starts,
                    provider=provider,
                    renewable=provider == "certbot" and bool(shutil.which("certbot")),
                    issuer=str(decoded.get("issuer", "")),
                    path=str(path),
                )
            )
        except (OSError, ssl.SSLError, ValueError) as exc:
            result.append(
                dict(id=identity, provider=provider, renewable=False, error=str(exc))
            )
    return result


def proxies():
    result = []
    for path in STATE.glob("mt-*.json"):
        try:
            item = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        if not re.fullmatch("[a-f0-9]{32}", item.get("id", "")):
            continue
        try:
            item["active"] = (
                run(
                    ["systemctl", "is-active", "hs-mtproxy-" + item["id"] + ".service"]
                ).strip()
                == "active"
            )
        except RuntimeError:
            item["active"] = False
        result.append(item)
    return result


def inventory():
    return dict(
        updated_at=time.time(),
        certificates=cert_inventory(),
        proxies=proxies(),
        capabilities=dict(
            certbot=bool(shutil.which("certbot")),
            mtproxy=Path(MT_BINARY).is_file(),
            fair_rate_limit=False,
        ),
    )


def renew(identity):
    cert = next((c for c in cert_inventory() if c["id"] == identity), None)
    if (
        not cert
        or not cert.get("renewable")
        or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,253}", identity)
    ):
        raise ValueError("Certificate has no supported renewal provider on this target")
    before = cert.get("expires_at", 0)
    run(
        [
            "certbot",
            "renew",
            "--cert-name",
            identity,
            "--force-renewal",
            "--non-interactive",
        ],
        timeout=600,
    )
    after = next((c for c in cert_inventory() if c["id"] == identity), {})
    if after.get("expires_at", 0) <= before:
        raise RuntimeError(
            "Certificate expiry did not advance; renewal is not reported as successful"
        )
    reload_unit = local_config().get("reload_units", {}).get(identity)
    if reload_unit:
        if not re.fullmatch(r"[a-zA-Z0-9_.@-]+\.service", reload_unit):
            raise ValueError("Invalid local reload service")
        run(["systemctl", "reload", reload_unit])
    return dict(
        certificate=after, activation="reloaded" if reload_unit else "reload_required"
    )


def create_proxy(payload):
    identity = payload["id"]
    if not re.fullmatch("[a-f0-9]{32}", identity) or not re.fullmatch(
        "[a-f0-9]{32}", payload["secret"]
    ):
        raise ValueError("Invalid proxy identity or secret")
    port = payload["port"]
    metrics = payload["metrics_port"]
    if (
        type(port) != int
        or type(metrics) != int
        or not 1024 <= port <= 65535
        or not 1024 <= metrics <= 65535
        or port == metrics
    ):
        raise ValueError("Invalid proxy ports")
    if not Path(MT_BINARY).is_file():
        raise ValueError("Install the official MTProxy binary on this target first")
    # Reserve-check both ports before starting the owned systemd unit.
    import socket

    reservations = []
    try:
        for value in (port, metrics):
            sock = socket.socket()
            reservations.append(sock)
            sock.bind(("0.0.0.0", value))
    finally:
        for sock in reservations:
            sock.close()
    folder = STATE / ("mt-" + identity)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, url in [
        ("proxy-secret", "https://core.telegram.org/getProxySecret"),
        ("proxy-multi.conf", "https://core.telegram.org/getProxyConfig"),
    ]:
        with urllib.request.urlopen(url, timeout=20) as response:
            data = response.read(1024 * 1024 + 1)
        if not data or len(data) > 1024 * 1024:
            raise ValueError("Invalid Telegram configuration")
        (folder / name).write_bytes(data)
        os.chmod(folder / name, 0o600)
    tag = payload.get("ad_tag", "")
    if tag and not re.fullmatch("[a-fA-F0-9]{32}", tag):
        raise ValueError("Invalid advertising tag")
    unit = "hs-mtproxy-" + identity + ".service"
    text = f"""[Unit]
Description=HS Telegram proxy {identity}
After=network-online.target
[Service]
Type=simple
WorkingDirectory={folder}
ExecStart={MT_BINARY} -u nobody -p {metrics} -H {port} -S {payload["secret"]} {"-P " + tag if tag else ""} --aes-pwd proxy-secret proxy-multi.conf -M 1
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
[Install]
WantedBy=multi-user.target
"""
    unit_path = Path("/etc/systemd/system") / unit
    if unit_path.exists():
        raise ValueError("Proxy already exists; refresh the inventory")
    unit_path.write_text(text)
    os.chmod(unit_path, 0o600)
    state_path = STATE / ("mt-" + identity + ".json")
    state_path.write_text(json.dumps(payload))
    os.chmod(state_path, 0o600)
    try:
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "--now", unit])
        time.sleep(1)
        run(["systemctl", "is-active", unit])
    except Exception:
        subprocess.run(["systemctl", "disable", "--now", unit], capture_output=True)
        raise
    return dict(id=identity, active=True)


def proxy_action(identity, action):
    if not re.fullmatch("[a-f0-9]{32}", identity) or action not in (
        "start",
        "stop",
        "delete",
    ):
        raise ValueError("Invalid proxy action")
    path = STATE / ("mt-" + identity + ".json")
    if not path.is_file():
        raise ValueError("HS-managed proxy not found")
    unit = "hs-mtproxy-" + identity + ".service"
    if action == "delete":
        run(["systemctl", "disable", "--now", unit])
        (Path("/etc/systemd/system") / unit).unlink()
        run(["systemctl", "daemon-reload"])
        path.unlink()
        shutil.rmtree(STATE / ("mt-" + identity), ignore_errors=True)
    else:
        run(["systemctl", action, unit])
    return dict(id=identity, action=action)


def execute(job):
    if job["action"] == "renew":
        return renew(job["resource"])
    if job["action"] == "mtproxy-create":
        return create_proxy(job["payload"])
    if job["action"].startswith("mtproxy-"):
        return proxy_action(job["resource"], job["action"][8:])
    raise ValueError("Unsupported HS service action")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--panel")
    parser.add_argument("--target", default="panel")
    parser.add_argument("--token-file")
    args = parser.parse_args()
    if args.panel and (urlsplit(args.panel).scheme != "https" or not args.token_file):
        parser.error("Remote agents require an HTTPS panel URL and --token-file")
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)

    def remote(path, body):
        token = Path(args.token_file).read_text().strip()
        req = urllib.request.Request(
            args.panel.rstrip("/")
            + "/api/hs-services/agents/"
            + args.target
            + "/"
            + path,
            data=json.dumps(body).encode(),
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)

    while True:
        try:
            completion_file = STATE / "completion.json"
            if completion_file.is_file():
                completed = json.loads(completion_file.read_text())
                if args.panel:
                    remote("complete", completed)
                else:
                    store.finish(
                        "panel",
                        completed["id"],
                        completed["lease"],
                        completed["result"],
                        completed.get("error"),
                    )
                completion_file.unlink()
            report = inventory()
            if args.panel:
                job = remote("poll", report).get("job")
            else:
                with store.lock():
                    reports = store.read("reports.json")
                    reports["panel"] = report
                    store.write("reports.json", reports)
                job = store.claim("panel")
            if job:
                result = {}
                error = None
                try:
                    result = execute(job)
                except Exception as exc:
                    error = str(exc)
                body = dict(
                    id=job["id"], lease=job["lease"], result=result, error=error
                )
                completion_tmp = STATE / "completion.json.tmp"
                with completion_tmp.open("w") as stream:
                    os.chmod(completion_tmp, 0o600)
                    json.dump(body, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(completion_tmp, completion_file)
                if args.panel:
                    remote("complete", body)
                else:
                    store.finish("panel", job["id"], job["lease"], result, error)
                completion_file.unlink()
        except Exception as exc:
            print("HS service agent:", type(exc).__name__, str(exc), flush=True)
        time.sleep(10)


if __name__ == "__main__":
    main()
