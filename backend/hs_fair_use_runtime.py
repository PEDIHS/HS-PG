"""HS Fair Use runtime.

The runtime keeps Fair Use independent from PasarGuard's native ``UserStatus``
enum: ``fair_limited`` is a derived HS status.  Native disabled/expired/limited/
on-hold states always win.

Traffic shaping uses one deterministic Xray freedom outbound per user/host and
SO_MARK.  The node agent owns the matching nftables rate rules, so limits are
per-user instead of one shared host bucket.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from copy import deepcopy
from pathlib import Path

DATA_DIR = Path(os.getenv("HS_PLUGIN_DATA_DIR", "/var/lib/pasarguard/hs-plugin"))
COMPILED = DATA_DIR / "fair-use-runtime.json"
NATIVE_PRECEDENCE = {"disabled", "expired", "limited", "on_hold"}


def _read() -> dict:
    try:
        value = json.loads(COMPILED.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {"version": 1, "policies": {}, "limited_users": {}}
    return value if isinstance(value, dict) else {"version": 1, "policies": {}, "limited_users": {}}


def write_runtime(value: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    value = dict(value)
    value["version"] = 1
    with tempfile.NamedTemporaryFile("w", dir=DATA_DIR, delete=False, encoding="utf-8") as stream:
        os.chmod(stream.name, 0o600)
        json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(stream.name, COMPILED)


def normalize_policy(value: dict) -> dict:
    threshold = value.get("threshold_bytes")
    percent = value.get("speed_percent")
    baseline = value.get("baseline_mbps")
    if type(threshold) is not int or not 0 < threshold <= 2**53 - 1:
        raise ValueError("threshold_bytes must be a positive integer")
    if type(percent) not in (int, float) or not math.isfinite(percent) or not 1 <= percent <= 100:
        raise ValueError("speed_percent must be between 1 and 100")
    if type(baseline) not in (int, float) or not math.isfinite(baseline) or not 0 < baseline <= 100000:
        raise ValueError("baseline_mbps must be positive")
    return {
        "threshold_bytes": threshold,
        "speed_percent": float(percent),
        "baseline_mbps": float(baseline),
        # A configured threshold automatically makes this host Fair-limited eligible.
        "fair_limited": True,
    }


def derived_status(native_status: str, used_traffic: int, policies: dict[str, dict]) -> str:
    native_status = str(getattr(native_status, "value", native_status or "active"))
    if native_status in NATIVE_PRECEDENCE or native_status != "active":
        return native_status
    used = max(0, int(used_traffic or 0))
    for raw in policies.values():
        try:
            policy = normalize_policy(raw)
        except ValueError:
            continue
        if used >= policy["threshold_bytes"]:
            return "fair_limited"
    return native_status


def limited_policy_tags(used_traffic: int, policies: dict[str, dict]) -> set[str]:
    """Return only policies whose threshold this individual user has reached."""
    used = max(0, int(used_traffic or 0))
    tags: set[str] = set()
    for tag, raw in policies.items():
        try:
            policy = normalize_policy(raw)
        except ValueError:
            continue
        if used >= policy["threshold_bytes"]:
            tags.add(str(tag))
    return tags


def filter_subscription_hosts(hosts: list, user) -> list:
    """Fair-limited users see only hosts configured for Fair Use.

    ``SubscriptionInboundData`` intentionally has no host id, while inbound tags
    are stable in the subscription cache.  The API therefore compiles host
    policies to inbound-tag policies before this hook is used.
    """
    runtime = _read()
    policies = runtime.get("policies", {}) if isinstance(runtime.get("policies"), dict) else {}
    native = str(getattr(getattr(user, "status", "active"), "value", getattr(user, "status", "active")))
    used = int(getattr(user, "used_traffic", 0) or 0)
    if derived_status(native, used, policies) != "fair_limited":
        return hosts
    allowed = set(policies)
    return [host for host in hosts if str(getattr(host, "inbound_tag", "")) in allowed]


def _mark(user_id: int, inbound_tag: str, used: set[int]) -> int:
    # 0x48 = ASCII 'H'.  Keep the sign bit clear and detect the unlikely hash collision.
    raw = hashlib.blake2s(f"{int(user_id)}\0{inbound_tag}".encode(), digest_size=4).digest()
    mark = 0x48000000 | (int.from_bytes(raw, "big") & 0x00FFFFFF)
    while mark in used:
        mark = 0x48000000 | ((mark + 1) & 0x00FFFFFF)
    used.add(mark)
    return mark


def build_rate_plan(users: list[dict], policies: dict[str, dict]) -> list[dict]:
    """Build deterministic per-user/per-inbound rate entries.

    ``policies`` must be keyed by inbound tag.  The usage comparison is always
    against the individual user's authoritative charged total.
    """
    plan: list[dict] = []
    marks: set[int] = set()
    for user in users:
        native = str(getattr(user.get("status"), "value", user.get("status", "active")))
        if native != "active":
            continue
        uid = int(user["id"])
        used = max(0, int(user.get("used_traffic", 0) or 0))
        for tag, raw in policies.items():
            policy = normalize_policy(raw)
            if used < policy["threshold_bytes"]:
                continue
            mark = _mark(uid, str(tag), marks)
            rate = policy["baseline_mbps"] * policy["speed_percent"] / 100.0
            plan.append(
                {
                    "user_id": uid,
                    "inbound_tag": str(tag),
                    "mark": mark,
                    "rate_mbps": rate,
                    "speed_percent": policy["speed_percent"],
                    "baseline_mbps": policy["baseline_mbps"],
                }
            )
    return plan


def apply_xray_rate_plan(config: dict, plan: list[dict], alias_for=None) -> dict:
    """Add HS-owned marked outbounds and user-scoped routing rules.

    Existing HS Fair Use objects are removed before rebuilding, making reconcile
    idempotent.  Other native/user outbounds and routing rules are preserved.
    """
    output = deepcopy(config)
    outbounds = [o for o in output.get("outbounds", []) if not str(o.get("tag", "")).startswith("hs-fair-")]
    routing = output.setdefault("routing", {})
    rules = [r for r in routing.get("rules", []) if not str(r.get("outboundTag", "")).startswith("hs-fair-")]

    known = {str(i.get("tag")) for i in output.get("inbounds", []) if isinstance(i, dict) and i.get("tag")}
    generated_rules = []
    for item in plan:
        tag = str(item["inbound_tag"])
        if tag not in known:
            continue
        uid = int(item["user_id"])
        outbound_tag = f"hs-fair-{uid}-{hashlib.sha1(tag.encode()).hexdigest()[:10]}"
        mark = int(item["mark"])
        outbounds.append(
            {
                "tag": outbound_tag,
                "protocol": "freedom",
                "settings": {},
                "streamSettings": {"sockopt": {"mark": mark}},
            }
        )
        identities = [str(uid)]
        if alias_for is not None:
            alias = alias_for(uid, tag)
            if alias and alias not in identities:
                identities.append(str(alias))
        generated_rules.append(
            {
                "type": "field",
                "inboundTag": [tag],
                "user": identities,
                "outboundTag": outbound_tag,
            }
        )
    output["outbounds"] = outbounds
    routing["rules"] = generated_rules + rules
    return output


def nft_rate_script(plan: list[dict]) -> str:
    """Build the complete nftables ruleset for HS-owned Fair Use marks.

    Xray SO_MARK identifies the exact user/inbound flow.  A byte-rate limiter in
    the output hook drops only packets above that user's configured rate, so TCP
    congestion control converges on the cap without sharing a bucket with other
    users.
    """
    lines = [
        "table inet hs_fair_use {",
        "  chain output {",
        "    type filter hook output priority filter; policy accept;",
    ]
    for item in plan:
        mark = int(item["mark"])
        # nft accepts kbytes/second; floor at 1 KiB/s for a syntactically valid cap.
        kib = max(1, int(float(item["rate_mbps"]) * 1_000_000 / 8 / 1024))
        uid = int(item["user_id"])
        safe_tag = str(item["inbound_tag"]).replace('"', "")[:48]
        lines.append(
            f'    meta mark {mark} limit rate over {kib} kbytes/second counter drop comment "hs-fair u{uid} {safe_tag}"'
        )
    lines += ["  }", "}", ""]
    return "\n".join(lines)
