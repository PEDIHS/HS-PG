"""Automatic Fair Use reconciler executed after PasarGuard usage accounting.

It derives ``fair_limited`` users from their own charged usage, rebuilds HS-owned
Xray routing marks without touching user/native rules, and queues one nftables
rate plan per PasarGuard node.  A zero-entry plan is also queued so reset users
are unthrottled automatically.
"""
from __future__ import annotations

import hashlib
import json
from copy import deepcopy

from sqlalchemy import select

from app.core.manager import core_manager
from app.db import GetDB
from app.db.models import CoreConfig, Node, User
from app.hs_fair_use_runtime import _read, apply_xray_rate_plan, build_rate_plan, derived_status, write_runtime
from app.hs_plugin_runtime import alias_email
from app import hs_services_runtime as services


def _revision(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


async def reconcile_fair_use(logger=None) -> dict:
    runtime = _read()
    policies = runtime.get("policies", {})
    if not isinstance(policies, dict):
        policies = {}

    async with GetDB() as db:
        users_rows = (await db.execute(select(User.id, User.status, User.used_traffic))).all()
        users = [
            {"id": int(uid), "status": status, "used_traffic": int(used or 0)}
            for uid, status, used in users_rows
        ]
        plan = build_rate_plan(users, policies)
        limited = {
            str(item["id"]): {
                "status": "fair_limited",
                "used_traffic": item["used_traffic"],
            }
            for item in users
            if derived_status(item["status"], item["used_traffic"], policies) == "fair_limited"
        }
        next_revision = _revision(plan)
        previous_revision = runtime.get("plan_revision")

        # Always refresh the derived status snapshot, even when the rate plan is unchanged.
        runtime["limited_users"] = limited
        runtime["plan_revision"] = next_revision
        write_runtime(runtime)
        if previous_revision == next_revision:
            return {"changed": False, "limited_users": len(limited), "rate_entries": len(plan)}

        cores = (await db.execute(select(CoreConfig).order_by(CoreConfig.id.asc()))).scalars().all()
        core_tags: dict[int, set[str]] = {}
        changed_cores = 0
        for core in cores:
            config = core.config if isinstance(core.config, dict) else {}
            tags = {
                str(item.get("tag"))
                for item in config.get("inbounds", [])
                if isinstance(item, dict) and item.get("tag")
            }
            core_tags[int(core.id)] = tags
            core_plan = [item for item in plan if item["inbound_tag"] in tags]
            next_config = apply_xray_rate_plan(config, core_plan, alias_for=alias_email)
            if next_config == config:
                continue
            try:
                validated = core_manager.validate_core(
                    next_config,
                    core.exclude_inbound_tags,
                    core.fallbacks_inbound_tags,
                    core.type,
                )
            except Exception as exc:
                if logger:
                    logger.error("HS Fair Use rejected generated core %s: %s", core.id, exc)
                continue
            core.config = deepcopy(next_config)
            await db.flush()
            await core_manager.update_core(core, validated)
            changed_cores += 1
        await db.commit()

        # Node agents apply the byte-rate filters corresponding to the marks in their Core.
        nodes = (await db.execute(select(Node.id, Node.core_config_id))).all()
        queued = 0
        for node_id, core_config_id in nodes:
            core_id = int(core_config_id) if core_config_id is not None else 1
            tags = core_tags.get(core_id, set())
            node_plan = [item for item in plan if item["inbound_tag"] in tags]
            node_revision = _revision(node_plan)
            try:
                services.enqueue(
                    str(int(node_id)),
                    "fair-apply",
                    "fair-plan:" + node_revision,
                    {"revision": node_revision, "plan": node_plan},
                )
                queued += 1
            except Exception as exc:
                if logger:
                    logger.warning("HS Fair Use could not queue node %s: %s", node_id, exc)

    return {
        "changed": True,
        "limited_users": len(limited),
        "rate_entries": len(plan),
        "changed_cores": changed_cores,
        "queued_nodes": queued,
    }
