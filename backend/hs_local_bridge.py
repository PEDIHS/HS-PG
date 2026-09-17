"""Local HS control bridge executed inside the PasarGuard panel container."""
from __future__ import annotations

import asyncio
import json
import sys
import time

from sqlalchemy import select

from app import hs_services as store
from app.db.base import GetDB
from app.db.models import Node
from app.hs_fair_runtime import manifest


def _local_instances(report: dict) -> list[dict]:
    value = report.get("pasarguard", {}).get("nodes", [])
    return value if isinstance(value, list) else []


def _addresses(report: dict) -> set[str]:
    value = report.get("system", {}).get("addresses", [])
    return {str(item) for item in value if item}


def _match(node: Node, report: dict) -> dict | None:
    if str(node.address) not in _addresses(report):
        return None
    for item in _local_instances(report):
        try:
            service_port = int(item.get("service_port", 0))
            api_port = int(item.get("api_port", 0))
        except (TypeError, ValueError):
            continue
        if service_port == int(node.port) and api_port == int(node.api_port):
            return item
    return None


def _node_report(panel_report: dict, item: dict) -> dict:
    ack = item.get("fair_use", {}) if isinstance(item.get("fair_use"), dict) else {}
    bridge = dict(panel_report.get("bridge", {}))
    bridge.update(protocol="hs-local-v1", transport="local-host", local=True)
    return {
        "updated_at": time.time(),
        "local": True,
        "enrolled": True,
        "bridge": bridge,
        "system": panel_report.get("system", {}),
        "pasarguard": {k: v for k, v in item.items() if k != "fair_use"},
        "certificates": [],
        "proxies": [],
        "fair_use": ack,
        "capabilities": {
            "bridge": True,
            "local_node": True,
            "certbot": False,
            "mtproxy": False,
            "fair_rate_limit": bool(ack),
        },
    }


async def poll(panel_report: dict) -> dict:
    now = time.time()
    local = []
    async with GetDB() as db:
        nodes = (await db.execute(select(Node))).scalars().all()
        for node in nodes:
            item = _match(node, panel_report)
            if item is not None:
                local.append((node, item))
        with store.lock():
            reports = store.read("reports.json")
            reports["panel"] = {**panel_report, "updated_at": now}
            for node, item in local:
                reports[str(node.id)] = _node_report(panel_report, item)
            store.write("reports.json", reports)
        manifests = []
        for node, item in local:
            manifests.append(
                {
                    "target": str(node.id),
                    "service_port": int(node.port),
                    "api_port": int(node.api_port),
                    "policy": await manifest(db, str(node.id)),
                }
            )
    targets = ["panel"] + [str(node.id) for node, _ in local]
    job = None
    for target in targets:
        job = store.claim(target)
        if job:
            break
    return {
        "local_nodes": [str(node.id) for node, _ in local],
        "manifests": manifests,
        "job": job,
    }


def complete(body: dict) -> dict:
    identity = str(body.get("id", ""))
    lease = str(body.get("lease", ""))
    jobs = store.read("jobs.json", [])
    job = next((item for item in jobs if item.get("id") == identity), None)
    if not job:
        raise ValueError("Unknown local job")
    return store.finish(
        str(job.get("target")), identity, lease, body.get("result", {}), body.get("error")
    )


async def _dispatch(action: str, payload: dict) -> dict:
    if action == "poll":
        return await poll(payload)
    if action == "complete":
        return complete(payload)
    raise ValueError("Invalid local bridge action")


async def _serve() -> None:
    # JSON-lines keeps one imported PasarGuard/SQLAlchemy process alive instead of
    # paying Python + model import cost on every 10-second agent poll.
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            return
        try:
            request = json.loads(line)
            action = str(request.get("action", ""))
            payload = request.get("payload", {})
            if not isinstance(payload, dict):
                raise ValueError("Local bridge payload must be an object")
            result = await _dispatch(action, payload)
            response = {"ok": True, "result": result}
        except Exception as exc:
            response = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()


async def amain() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in {"poll", "complete", "serve"}:
        raise SystemExit("Usage: python -m app.hs_local_bridge poll|complete|serve")
    if sys.argv[1] == "serve":
        await _serve()
        return
    payload = json.load(sys.stdin)
    result = await _dispatch(sys.argv[1], payload)
    json.dump(result, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    asyncio.run(amain())
