#!/usr/bin/env python3
"""HS host/node worker. Executes fixed certificate/MTProxy actions, never arbitrary shell."""

from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import ssl
import subprocess
import select
import threading
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit
import hs_services as store

LOCAL_CONFIG = Path("/etc/hs-pg/services.json")
STATE = Path(os.getenv("HS_SERVICES_AGENT_DATA", "/var/lib/hs-pg-agent"))
MT_BINARY = "/usr/local/bin/mtproto-proxy"
BRIDGE_VERSION = "1.1.0"
BRIDGE_ROOT = Path(os.getenv("HS_BRIDGE_ROOT", "/opt/hs-pg/backend"))
BRIDGE_SOURCE = "https://raw.githubusercontent.com/PEDIHS/HS-PG/main/backend"
BRIDGE_FILES = ("hs_services.py", "hs_services_agent.py")


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
    # Certbot lineages only: node trust and arbitrary PEM files are not ACME certificates.
    certbot_root = Path(local_config().get("certbot_config_dir", "/etc/letsencrypt"))
    sources = [
        (p.parent.name, p, "certbot")
        for p in certbot_root.glob("live/*/fullchain.pem")
    ]
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
                    renewable=bool(shutil.which("certbot")) and (certbot_root / "renewal" / (identity + ".conf")).is_file(),
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


def system_inventory():
    mem = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            mem[key] = int(value.strip().split()[0]) * 1024
    except (OSError, ValueError):
        pass
    try:
        uptime = float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        uptime = 0
    try:
        load1 = os.getloadavg()[0]
    except OSError:
        load1 = 0
    disk = shutil.disk_usage("/")
    addresses=[]
    try:
        raw=json.loads(run(["ip","-j","addr","show"],timeout=5))
        addresses=sorted({a.get("local") for item in raw for a in item.get("addr_info",[]) if a.get("local")})
    except (RuntimeError,ValueError,TypeError,OSError):
        pass
    return dict(
        hostname=socket.gethostname(), kernel=platform.release(), os=platform.platform(),
        uptime_seconds=int(uptime), cpu_cores=os.cpu_count() or 0, load1=load1,
        memory_total=mem.get("MemTotal", 0), memory_available=mem.get("MemAvailable", 0),
        disk_total=disk.total, disk_free=disk.free, addresses=addresses,
    )


def fair_ack_path(path):
    try:
        ack=json.loads(Path(str(path)+'.ack').read_text())
        if time.time()-ack.get('updated_at',0)<25 and ack.get('adapter')=='hs-rate-v1':return ack
    except (OSError,ValueError,TypeError):pass
    return {}


_PG_NODE_CACHE = {"at": 0.0, "rows": []}
_PG_NODE_CACHE_TTL = 60.0


def _pasarguard_nodes_static():
    now = time.monotonic()
    cached = _PG_NODE_CACHE.get("rows", [])
    if cached and now - float(_PG_NODE_CACHE.get("at", 0)) < _PG_NODE_CACHE_TTL:
        return cached
    result=[]
    if not shutil.which("docker"):
        return result
    try:
        rows=run(["docker","ps","--format","{{.ID}}\t{{.Names}}\t{{.Image}}"],timeout=10).splitlines()
        for row in rows:
            parts=row.split("\t",2)
            if len(parts)!=3 or "pasarguard/node" not in parts[2]:continue
            try:
                meta=json.loads(run(["docker","inspect",parts[0]],timeout=10))[0]
            except (RuntimeError,ValueError,IndexError):continue
            env={}
            for value in meta.get("Config",{}).get("Env",[]):
                if "=" in value:
                    key,val=value.split("=",1);env[key]=val
            try: service_port=int(env.get("SERVICE_PORT",0));api_port=int(env.get("API_PORT",0))
            except ValueError: service_port=api_port=0
            mount=next((m for m in meta.get("Mounts",[]) if str(m.get("Destination","")).startswith("/var/lib/")),None)
            fair_file=Path(mount["Source"])/"hs"/"fair-policy.json" if mount and mount.get("Source") else None
            item=dict(container=parts[1],image=parts[2],running=True,service_port=service_port,api_port=api_port)
            try:
                item["xray"]=run(["docker","exec",parts[0],"/usr/local/bin/xray","version"],timeout=10).splitlines()[0][:160]
            except (RuntimeError,IndexError):pass
            item["fair_core_configured"]=bool(env.get("XRAY_EXECUTABLE_PATH","").endswith("xray-hs-fair") and env.get("HS_FAIR_POLICY_FILE"))
            if fair_file:item["_fair_policy_file"]=str(fair_file)
            result.append(item)
    except RuntimeError:
        pass
    _PG_NODE_CACHE["at"] = now
    _PG_NODE_CACHE["rows"] = result
    return result


def pasarguard_nodes_inventory(private=False):
    result=[]
    for base in _pasarguard_nodes_static():
        fair_file=base.get("_fair_policy_file")
        item={k:v for k,v in base.items() if k != "_fair_policy_file"}
        item["fair_use"]=fair_ack_path(fair_file) if fair_file else {}
        if private and fair_file:item["_fair_policy_file"]=fair_file
        result.append(item)
    return result


def pasarguard_inventory():
    nodes=pasarguard_nodes_inventory(False)
    result=dict(detected=bool(nodes),nodes=nodes)
    if nodes:result.update({k:v for k,v in nodes[0].items() if k not in {"fair_use"}})
    return result


def fair_ack():
    path=Path(local_config().get('fair_policy_file',str(STATE/'fair-policy.json')))
    return fair_ack_path(path)


def apply_fair_manifest(value, path=None):
    if value is None:return
    if not isinstance(value,dict) or not re.fullmatch('[a-f0-9]{64}',value.get('revision','')):raise ValueError('Invalid fair manifest')
    rates=value.get('rates')
    if not isinstance(rates,dict) or len(rates)>100000:raise ValueError('Invalid fair rates')
    for key,rate in rates.items():
        if not isinstance(key,str) or '\0' not in key or len(key)>512 or type(rate)!=int or not 1<=rate<=12500000000:raise ValueError('Invalid fair entry')
    path=Path(path or local_config().get('fair_policy_file',str(STATE/'fair-policy.json')))
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    data=json.dumps(value,sort_keys=True)
    if path.is_file() and path.read_text()==data:return
    tmp=path.with_suffix('.tmp')
    with tmp.open('w') as stream:
        os.chmod(tmp,0o600);stream.write(data);stream.flush();os.fsync(stream.fileno())
    os.replace(tmp,path)


def apply_local_manifests(values):
    local={(int(n.get('service_port',0)),int(n.get('api_port',0))):n for n in pasarguard_nodes_inventory(True)}
    for item in values or []:
        try:key=(int(item.get('service_port',0)),int(item.get('api_port',0)))
        except (TypeError,ValueError):continue
        node=local.get(key);path=node.get('_fair_policy_file') if node else None
        if path:apply_fair_manifest(item.get('policy'),path)


def panel_container():
    try:
        for row in run(["docker","ps","--format","{{.ID}}\t{{.Image}}"],timeout=10).splitlines():
            cid,image=(row.split("\t",1)+[""])[:2]
            if "pasarguard/panel" in image:return cid
    except RuntimeError:pass
    return ""


_LOCAL_BRIDGE_PROC = None
_LOCAL_BRIDGE_CID = ""
_LOCAL_BRIDGE_LOCK = threading.Lock()


def _close_local_bridge():
    global _LOCAL_BRIDGE_PROC, _LOCAL_BRIDGE_CID
    proc = _LOCAL_BRIDGE_PROC
    _LOCAL_BRIDGE_PROC = None
    _LOCAL_BRIDGE_CID = ""
    if proc is None:
        return
    try:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=2)
    except Exception:
        try: proc.kill()
        except Exception: pass


def _persistent_local_panel(cid, action, payload):
    global _LOCAL_BRIDGE_PROC, _LOCAL_BRIDGE_CID
    proc = _LOCAL_BRIDGE_PROC
    if proc is None or proc.poll() is not None or _LOCAL_BRIDGE_CID != cid:
        _close_local_bridge()
        proc = subprocess.Popen(
            ["docker", "exec", "-i", cid, "python", "-u", "-m", "app.hs_local_bridge", "serve"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
        _LOCAL_BRIDGE_PROC = proc
        _LOCAL_BRIDGE_CID = cid
    if proc.stdin is None or proc.stdout is None:
        raise RuntimeError('Local HS bridge pipes unavailable')
    request = json.dumps({"action": action, "payload": payload}, separators=(",", ":"))
    proc.stdin.write(request + "\n")
    proc.stdin.flush()
    ready, _, _ = select.select([proc.stdout], [], [], 45)
    if not ready:
        _close_local_bridge()
        raise TimeoutError('Local HS bridge timed out')
    line = proc.stdout.readline()
    if not line:
        code = proc.poll()
        _close_local_bridge()
        raise RuntimeError(f'Local HS bridge exited unexpectedly ({code})')
    response = json.loads(line)
    if not response.get('ok'):
        raise RuntimeError(response.get('error') or 'Local HS bridge failed')
    return response.get('result', {})


def local_panel(action,payload):
    if action not in {'poll','complete'}:raise ValueError('Invalid local bridge action')
    cid=panel_container()
    if not cid:raise RuntimeError('PasarGuard panel container not found')
    with _LOCAL_BRIDGE_LOCK:
        try:
            return _persistent_local_panel(cid, action, payload)
        except Exception as persistent_error:
            # Deployment/backward-compatibility fallback: an older panel copy may not
            # understand `serve` yet. Keep control-plane availability and retry the
            # persistent transport on the next poll.
            _close_local_bridge()
            proc=subprocess.run(["docker","exec","-i",cid,"python","-m","app.hs_local_bridge",action],input=json.dumps(payload),capture_output=True,text=True,timeout=45)
            if proc.returncode:
                raise RuntimeError('Local HS bridge failed; inspect hs-services-agent journal') from persistent_error
            try:return json.loads(proc.stdout)
            except ValueError as exc:raise RuntimeError('Local HS bridge returned invalid data') from exc


def inventory():
    fair = fair_ack()
    return dict(
        updated_at=time.time(),
        bridge=dict(version=BRIDGE_VERSION, protocol="hs-bridge-v1", transport="outbound-https"),
        system=system_inventory(),
        pasarguard=pasarguard_inventory(),
        certificates=cert_inventory(),
        fair_use=fair,
        proxies=proxies(),
        capabilities=dict(
            bridge=True,
            certbot=bool(shutil.which("certbot")),
            mtproxy=Path(MT_BINARY).is_file(),
            fair_rate_limit=bool(fair),
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
            "--config-dir",
            str(Path(local_config().get("certbot_config_dir", "/etc/letsencrypt"))),
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


def bridge_update():
    """Atomically refresh the fixed HS Bridge runtime from the official repository."""
    BRIDGE_ROOT.mkdir(parents=True, exist_ok=True)
    previous = {}
    hashes = {}
    with tempfile.TemporaryDirectory(prefix="hs-bridge-update-") as folder:
        stage = Path(folder)
        for name in BRIDGE_FILES:
            url = f"{BRIDGE_SOURCE}/{name}"
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read(1024 * 1024 + 1)
            if not data or len(data) > 1024 * 1024 or b"\0" in data:
                raise ValueError("Invalid HS Bridge update payload")
            try:
                data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ValueError("Invalid HS Bridge update encoding") from exc
            target = stage / name
            target.write_bytes(data)
            os.chmod(target, 0o644)
            hashes[name] = hashlib.sha256(data).hexdigest()
        run([sys.executable, "-m", "py_compile", *[str(stage / name) for name in BRIDGE_FILES]], timeout=30)
        for name in BRIDGE_FILES:
            target = BRIDGE_ROOT / name
            previous[name] = target.read_bytes() if target.is_file() else None
        try:
            for name in BRIDGE_FILES:
                target = BRIDGE_ROOT / name
                tmp = target.with_name(target.name + ".update")
                tmp.write_bytes((stage / name).read_bytes())
                os.chmod(tmp, 0o644)
                os.replace(tmp, target)
        except Exception:
            for name, data in previous.items():
                target = BRIDGE_ROOT / name
                if data is None:
                    target.unlink(missing_ok=True)
                else:
                    tmp = target.with_name(target.name + ".rollback")
                    tmp.write_bytes(data); os.chmod(tmp, 0o644); os.replace(tmp, target)
            raise
    return {"updated": True, "files": hashes, "_restart_bridge": True}


def execute(job, remote_bridge=False):
    if job["action"] == "bridge-update":
        if not remote_bridge:
            raise ValueError("Bridge update is only valid for an enrolled remote Node")
        return bridge_update()
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
                    local_panel("complete", completed)
                completion_file.unlink()
            report = inventory()
            if args.panel:
                response=remote("poll", report)
                apply_fair_manifest(response.get("fair_policy"))
                job=response.get("job")
            else:
                response=local_panel("poll", report)
                apply_local_manifests(response.get("manifests",[]))
                job=response.get("job")
            if job:
                result = {}
                error = None
                try:
                    # Keep traffic policy synchronization alive during slow ACME jobs.
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        future=pool.submit(execute,job,bool(args.panel))
                        while True:
                            try:
                                result=future.result(timeout=10)
                                break
                            except FutureTimeout:
                                if future.done():raise
                                try:
                                    heartbeat=inventory();heartbeat['job_running']=True
                                    if args.panel:
                                        apply_fair_manifest(remote('poll',heartbeat).get('fair_policy'))
                                    else:
                                        bridge=local_panel('poll',heartbeat)
                                        apply_local_manifests(bridge.get('manifests',[]))
                                except Exception as exc:
                                    print('HS heartbeat:',type(exc).__name__,flush=True)
                except Exception as exc:
                    error = str(exc)
                restart_bridge = bool(result.pop("_restart_bridge", False)) if isinstance(result, dict) else False
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
                    local_panel("complete", body)
                completion_file.unlink()
                if restart_bridge and args.panel:
                    try:
                        run([
                            "systemd-run", "--quiet", "--on-active=1s",
                            "/bin/systemctl", "restart", "hs-node-bridge.service",
                        ], timeout=10)
                    except Exception as exc:
                        print("HS Bridge update restart:", type(exc).__name__, str(exc), flush=True)
                    return
        except Exception as exc:
            print("HS service agent:", type(exc).__name__, str(exc), flush=True)
        time.sleep(10)


if __name__ == "__main__":
    main()
