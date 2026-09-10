"""HS Plugin runtime hooks for PasarGuard.

This module is copied into ``app/hs_plugin_runtime.py`` by the integrator.
It deliberately owns no PasarGuard database migrations. State lives under
/var/lib/pasarguard/hs-plugin and is read with a tiny mtime cache.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from pathlib import Path
from typing import Iterable

DATA_DIR = Path(os.getenv("HS_PLUGIN_DATA_DIR", "/var/lib/pasarguard/hs-plugin"))
STATE_FILE = DATA_DIR / "state.json"
_ALIAS_RE = re.compile(r"^(?P<uid>\d+)~hspg~(?P<key>[0-9a-f]{12})$")
_LOCK = threading.RLock()
_CACHE_MTIME_NS: int | None = None
_CACHE_STATE: dict | None = None


def _default_state() -> dict:
    return {
        "version": 1,
        "features": {"host_usage_ratio": {"enabled": True}},
        "inbound_ratios": {},
    }


def load_state() -> dict:
    global _CACHE_MTIME_NS, _CACHE_STATE
    try:
        mtime = STATE_FILE.stat().st_mtime_ns
    except OSError:
        return _default_state()

    with _LOCK:
        if _CACHE_STATE is not None and _CACHE_MTIME_NS == mtime:
            return _CACHE_STATE
        try:
            raw = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            raw = _default_state()
        if not isinstance(raw, dict):
            raw = _default_state()
        raw.setdefault("version", 1)
        raw.setdefault("features", {}).setdefault("host_usage_ratio", {"enabled": True})
        raw.setdefault("inbound_ratios", {})
        _CACHE_STATE = raw
        _CACHE_MTIME_NS = mtime
        return raw


def host_ratio_enabled(state: dict | None = None) -> bool:
    state = state or load_state()
    return bool(state.get("features", {}).get("host_usage_ratio", {}).get("enabled", True))


def inbound_key(tag: str) -> str:
    return hashlib.sha256(tag.encode("utf-8")).hexdigest()[:12]


def tracked_inbounds(state: dict | None = None) -> dict[str, float]:
    state = state or load_state()
    result: dict[str, float] = {}
    for tag, value in state.get("inbound_ratios", {}).items():
        if not isinstance(tag, str) or not tag:
            continue
        try:
            ratio = float(value)
        except (TypeError, ValueError):
            continue
        if ratio < 0:
            continue
        result[tag] = ratio
    return result


def alias_email(uid: int | str, inbound_tag: str) -> str:
    return f"{int(uid)}~hspg~{inbound_key(inbound_tag)}"


def _clone_proto_user(proto_user):
    clone = type(proto_user)()
    clone.CopyFrom(proto_user)
    return clone


def expand_proto_users(proto_users: Iterable) -> list:
    """Split tracked inbounds into stat-attributable aliases.

    The alias uses exactly the same proxy credentials as the original user, but
    exists on only one tracked inbound. Xray therefore emits independent user
    stats for that inbound. When the feature is disabled, alias tombstones are
    still emitted so incremental node updates remove stale aliases safely.
    """
    state = load_state()
    ratios = tracked_inbounds(state)
    if not ratios:
        return list(proto_users)

    enabled = host_ratio_enabled(state)
    tags = tuple(ratios)
    output = []
    for user in proto_users:
        original_inbounds = list(user.inbounds)
        original_set = set(original_inbounds)

        base = _clone_proto_user(user)
        if enabled:
            kept = [tag for tag in original_inbounds if tag not in ratios]
            del base.inbounds[:]
            base.inbounds.extend(kept)
        output.append(base)

        for tag in tags:
            alias = _clone_proto_user(user)
            alias.email = alias_email(user.email, tag)
            del alias.inbounds[:]
            if enabled and tag in original_set:
                alias.inbounds.append(tag)
            output.append(alias)
    return output


def decode_usage_identity(name: str) -> tuple[int, float]:
    """Return PasarGuard user id and HS multiplier for an Xray stat identity."""
    try:
        return int(name), 1.0
    except (TypeError, ValueError):
        pass

    match = _ALIAS_RE.fullmatch(str(name))
    if not match:
        raise ValueError(f"unknown HS usage identity: {name}")

    state = load_state()
    ratios = tracked_inbounds(state)
    key = match.group("key")
    matched_ratio = None
    for tag, ratio in ratios.items():
        if inbound_key(tag) == key:
            matched_ratio = ratio
            break
    if matched_ratio is None:
        raise ValueError(f"stale HS usage identity: {name}")

    multiplier = matched_ratio if host_ratio_enabled(state) else 1.0
    return int(match.group("uid")), multiplier


def usage_emails_for_user(uid: int | str) -> list[str]:
    """Identities that can represent a user in online/IP statistics."""
    uid = int(uid)
    emails = [str(uid)]
    for tag in tracked_inbounds():
        emails.append(alias_email(uid, tag))
    return emails
