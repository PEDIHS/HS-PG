#!/usr/bin/env python3
"""HS service agent extension with per-user Fair Use rate enforcement.

This wraps the stable certificate/MTProxy agent instead of duplicating it.  Only
HS-owned nftables table ``inet hs_fair_use`` is touched.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import hs_services_agent as base

FAIR_STATE = Path(os.getenv("HS_SERVICES_AGENT_DATA", "/var/lib/hs-pg-agent")) / "fair-use.json"


def _validate_plan(value) -> list[dict]:
    if not isinstance(value, list) or len(value) > 10000:
        raise ValueError("Invalid Fair Use plan")
    result = []
    marks = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("Invalid Fair Use entry")
        uid = raw.get("user_id")
        mark = raw.get("mark")
        rate = raw.get("rate_mbps")
        tag = raw.get("inbound_tag")
        if type(uid) is not int or uid <= 0:
            raise ValueError("Invalid Fair Use user")
        if type(mark) is not int or not 0x48000000 <= mark <= 0x48FFFFFF or mark in marks:
            raise ValueError("Invalid or duplicate Fair Use mark")
        if type(rate) not in (int, float) or not 0 < float(rate) <= 100000:
            raise ValueError("Invalid Fair Use rate")
        if not isinstance(tag, str) or not 1 <= len(tag) <= 128 or any(ch in tag for ch in '\r\n"'):
            raise ValueError("Invalid Fair Use inbound tag")
        marks.add(mark)
        result.append({"user_id": uid, "mark": mark, "rate_mbps": float(rate), "inbound_tag": tag})
    return result


def _script(plan: list[dict]) -> str:
    lines = [
        "table inet hs_fair_use {",
        "  chain output {",
        "    type filter hook output priority filter; policy accept;",
    ]
    for item in plan:
        kib = max(1, int(item["rate_mbps"] * 1_000_000 / 8 / 1024))
        lines.append(
            f'    meta mark {item["mark"]} limit rate over {kib} kbytes/second counter drop comment "hs-fair u{item["user_id"]} {item["inbound_tag"]}"'
        )
    lines += ["  }", "}", ""]
    return "\n".join(lines)


def apply_fair(payload: dict) -> dict:
    if not shutil.which("nft"):
        raise ValueError("nftables is required for Fair Use rate limiting")
    plan = _validate_plan(payload.get("plan", []))
    revision = payload.get("revision")
    if not isinstance(revision, str) or len(revision) != 64 or any(ch not in "0123456789abcdef" for ch in revision):
        raise ValueError("Invalid Fair Use revision")
    text = _script(plan)
    with tempfile.NamedTemporaryFile("w", delete=False, prefix="hs-fair-", suffix=".nft") as stream:
        os.chmod(stream.name, 0o600)
        stream.write(text)
        path = stream.name
    try:
        # Validate the complete replacement before touching the active table.
        base.run(["nft", "-c", "-f", path])
        subprocess.run(
            ["nft", "delete", "table", "inet", "hs_fair_use"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        try:
            base.run(["nft", "-f", path])
        except Exception:
            # Fail closed with respect to ownership: do not alter any non-HS table.
            raise
    finally:
        Path(path).unlink(missing_ok=True)

    FAIR_STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = FAIR_STATE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"revision": revision, "entries": len(plan)}), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, FAIR_STATE)
    return {"revision": revision, "entries": len(plan), "enforced": True}


_base_inventory = base.inventory
_base_execute = base.execute


def inventory():
    value = _base_inventory()
    value.setdefault("capabilities", {})["fair_rate_limit"] = bool(shutil.which("nft"))
    try:
        value["fair_use"] = json.loads(FAIR_STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        value["fair_use"] = {"revision": None, "entries": 0}
    return value


def execute(job):
    if job.get("action") == "fair-apply":
        return apply_fair(job.get("payload") or {})
    return _base_execute(job)


base.inventory = inventory
base.execute = execute

if __name__ == "__main__":
    base.main()
