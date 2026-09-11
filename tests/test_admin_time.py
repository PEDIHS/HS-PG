#!/usr/bin/env python3
"""Focused tests for HS Admin Time pure timing/state behavior."""
from __future__ import annotations

import ast
from datetime import UTC, datetime, timedelta
from enum import Enum
from pathlib import Path


class UserStatus(str, Enum):
    active = "active"
    disabled = "disabled"
    limited = "limited"
    expired = "expired"
    on_hold = "on_hold"


def load_functions(*names: str) -> dict:
    source_path = Path(__file__).parents[1] / "backend" / "hs_admin_time.py"
    tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
    wanted = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    module = ast.Module(body=wanted, type_ignores=[])
    namespace = {
        "UTC": UTC,
        "datetime": datetime,
        "timedelta": timedelta,
        "UserStatus": UserStatus,
    }
    exec(compile(module, str(source_path), "exec"), namespace)
    return namespace


def main() -> None:
    ns = load_functions("_aware", "_remaining_seconds", "_restored_user_state", "_default_state", "_normalize_state")
    restore = ns["_restored_user_state"]
    now = datetime(2026, 9, 11, 3, 0, tzinfo=UTC)

    status, expire, timeout = restore(
        {
            "status": "active",
            "expire_present": True,
            "expire_remaining_seconds": 12 * 86400,
            "expire_elapsed": False,
            "on_hold_timeout_present": False,
            "on_hold_timeout_remaining_seconds": None,
        },
        now,
    )
    assert status == UserStatus.active
    assert expire == now + timedelta(days=12), "12 remaining days must resume as exactly 12 days"
    assert timeout is None

    status, expire, _ = restore(
        {
            "status": "active",
            "expire_present": False,
            "expire_remaining_seconds": None,
            "expire_elapsed": False,
            "on_hold_timeout_present": False,
        },
        now,
    )
    assert status == UserStatus.active and expire is None, "unlimited users must remain unlimited"

    status, expire, _ = restore(
        {
            "status": "active",
            "expire_present": True,
            "expire_remaining_seconds": 0,
            "expire_elapsed": True,
            "on_hold_timeout_present": False,
        },
        now,
    )
    assert status == UserStatus.expired and expire == now, "already-expired users must never be revived"

    state = ns["_normalize_state"]({})
    assert state["features"]["admin_time_limit"]["enabled"] is True
    assert state["admin_time_limits"] == {}
    print("admin time tests: OK")


if __name__ == "__main__":
    main()
