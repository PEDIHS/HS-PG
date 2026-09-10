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
        "version": 2,
        "features": {"host_usage_ratio": {"enabled": True}},
        "inbound_offsets": {},
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
        raw.setdefault("version", 2)
        raw.setdefault("features", {}).setdefault("host_usage_ratio", {"enabled": True})
        raw.setdefault("inbound_offsets", {})
        _CACHE_STATE = raw
        _CACHE_MTIME_NS = mtime
        return raw


def host_ratio_enabled(state: dict | None = None) -> bool:
    state = state or load_state()
    return bool(state.get("features", {}).get("host_usage_ratio", {}).get("enabled", True))


def inbound_key(tag: str) -> str:
    return hashlib.sha256(tag.encode("utf-8")).hexdigest()[:12]


def tracked_inbounds(state: dict | None = None) -> dict[str, float]:
    """Return inbound -> additive ratio offset from the native Node ratio.

    Example: Node Ratio 2.0 and Host shown as 2.7 stores offset +0.7. Usage
    observed on that Node is charged with 2.0 + 0.7 = 2.7. If the Node later
    changes to 3.0, the same Host automatically becomes 3.7.
    """
    state = state or load_state()
    result: dict[str, float] = {}
    for tag, value in state.get("inbound_offsets", {}).items():
        if not isinstance(tag, str) or not tag:
            continue
        try:
            offset = float(value)
        except (TypeError, ValueError):
            continue
        if abs(offset) < 1e-12:
            continue
        result[tag] = offset
    return result


def alias_email(uid: int | str, inbound_tag: str) -> str:
    return f"{int(uid)}~hspg~{inbound_key(inbound_tag)}"


def _clone_proto_user(proto_user):
    clone = type(proto_user)()
    clone.CopyFrom(proto_user)
    return clone


def expand_proto_users(proto_users: Iterable) -> list:
    """Split overridden inbounds into stat-attributable aliases."""
    state = load_state()
    offsets = tracked_inbounds(state)
    if not offsets:
        return list(proto_users)

    enabled = host_ratio_enabled(state)
    tags = tuple(offsets)
    output = []
    for user in proto_users:
        original_inbounds = list(user.inbounds)
        original_set = set(original_inbounds)

        base = _clone_proto_user(user)
        if enabled:
            kept = [tag for tag in original_inbounds if tag not in offsets]
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


def decode_usage_identity(name: str) -> tuple[int, float | None]:
    """Return ``(user_id, host_ratio_offset)`` for a stat identity.

    Native identities return ``None``. HS aliases return an additive offset that
    PasarGuard applies on top of the *actual* Node coefficient for that stat.
    """
    try:
        return int(name), None
    except (TypeError, ValueError):
        pass

    match = _ALIAS_RE.fullmatch(str(name))
    if not match:
        raise ValueError(f"unknown HS usage identity: {name}")

    state = load_state()
    offsets = tracked_inbounds(state)
    key = match.group("key")
    matched_offset = None
    for tag, offset in offsets.items():
        if inbound_key(tag) == key:
            matched_offset = offset
            break
    if matched_offset is None:
        raise ValueError(f"stale HS usage identity: {name}")

    host_offset = matched_offset if host_ratio_enabled(state) else None
    return int(match.group("uid")), host_offset


def usage_emails_for_user(uid: int | str) -> list[str]:
    """Identities that can represent a user in online/IP statistics."""
    uid = int(uid)
    emails = [str(uid)]
    for tag in tracked_inbounds():
        emails.append(alias_email(uid, tag))
    return emails
