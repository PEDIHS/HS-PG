"""Per-user/per-host policy evaluation. Enforcement is gated on a node rate adapter.

Never present a draft policy as an enforced limit. Native disabled, expired and
limited states take precedence over the derived Fair limited state.
"""

from __future__ import annotations
import math


def validate_policy(value):
    threshold = value.get("threshold_bytes")
    percent = value.get("speed_percent")
    baseline = value.get("baseline_mbps")
    if type(threshold) != int or threshold <= 0 or threshold > 2**53 - 1:
        raise ValueError("Threshold must be a positive byte count")
    if (
        type(percent) not in (int, float)
        or not math.isfinite(percent)
        or not 1 <= percent <= 100
    ):
        raise ValueError("Speed percentage must be between 1 and 100")
    if (
        type(baseline) not in (int, float)
        or not math.isfinite(baseline)
        or not 0 < baseline <= 100000
    ):
        raise ValueError("A positive baseline Mbps is required to define a percentage")
    return dict(
        threshold_bytes=threshold,
        speed_percent=float(percent),
        baseline_mbps=float(baseline),
        fair_limited=True,
        usage_basis="current_cycle",
    )


def evaluate(user, policies, eligible_hosts, enforced=False):
    """Use this user's authoritative charged total; never a shared host counter."""
    native = str(getattr(user.get("status"), "value", user.get("status", "active")))
    eligible = {str(x) for x in eligible_hosts}
    configured = {
        str(k): validate_policy(v) for k, v in policies.items() if str(k) in eligible
    }
    consumed = max(0, int(user.get("used_traffic", 0)))
    reached = {
        key: p for key, p in configured.items() if consumed >= p["threshold_bytes"]
    }
    limited = native == "active" and bool(reached)
    return dict(
        user_id=user.get("id"),
        native_status=native,
        status="fair_limited" if limited and enforced else native,
        preview_status="fair_limited" if limited else native,
        color="#ea580c" if limited else None,
        enforced=bool(enforced),
        visible_host_ids=sorted(configured)
        if limited and enforced
        else sorted(eligible),
        reached_host_ids=sorted(reached),
        rates_mbps={
            k: p["baseline_mbps"] * p["speed_percent"] / 100 for k, p in reached.items()
        },
    )
