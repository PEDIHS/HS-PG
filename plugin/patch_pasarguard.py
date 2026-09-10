#!/usr/bin/env python3
"""Idempotent, fail-closed PasarGuard source integrator for HS Plugin."""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1)


def ensure_import(text: str, import_line: str, anchor: str, label: str) -> str:
    if import_line.strip() in text:
        return text
    return replace_once(text, anchor, anchor + import_line, label)


def patch_router(text: str) -> str:
    start, end = "# hs-plugin-router-start", "# hs-plugin-router-end"
    if start in text:
        before, rest = text.split(start, 1)
        _, after = rest.split(end, 1)
        text = before.rstrip() + "\n" + after.lstrip("\n")
    text = text.replace(
        "for router in (([hs_plugin_api.router] if hs_plugin_api else []) + routers):",
        "for router in routers:",
    )
    block = (
        "# hs-plugin-router-start\n"
        "try:\n    from . import hs_plugin_api\n"
        "except Exception:\n    hs_plugin_api = None\n"
        "# hs-plugin-router-end\n\n"
    )
    text = replace_once(text, "api_router = APIRouter()", block + "api_router = APIRouter()", "router")
    return replace_once(
        text,
        "for router in routers:",
        "for router in (([hs_plugin_api.router] if hs_plugin_api else []) + routers):",
        "router loop",
    )


def patch_user(text: str) -> str:
    text = ensure_import(
        text,
        "from app.hs_plugin_runtime import expand_proto_users\n",
        "from app.models.protocol import ProxyProtocol\n",
        "user runtime import",
    )
    if "# hs-plugin-core-users" in text:
        return text
    pos = text.find("async def core_users(")
    if pos < 0:
        raise RuntimeError("core_users function not found")
    ret = text.find("    return bridge_users\n", pos)
    if ret < 0:
        raise RuntimeError("core_users return anchor not found")
    return text[:ret] + "    # hs-plugin-core-users\n    return expand_proto_users(bridge_users)\n" + text[ret + len("    return bridge_users\n"):]


def patch_sync(text: str) -> str:
    text = ensure_import(
        text,
        "from app.hs_plugin_runtime import expand_proto_users\n",
        "from app.utils.logger import get_logger\n",
        "sync runtime import",
    )
    replacements = [
        (
            "    proto_user = await serialize_user(db_user)\n    asyncio.create_task(_dispatch_user_update(proto_user))",
            "    proto_user = await serialize_user(db_user)\n    # hs-plugin-sync-user\n    asyncio.create_task(_dispatch_users_update(expand_proto_users([proto_user])))",
            "sync_user",
        ),
        (
            "    proto_user = _serialize_user_for_node(user.id, user.proxy_settings.dict())\n    asyncio.create_task(_dispatch_user_update(proto_user))",
            "    proto_user = _serialize_user_for_node(user.id, user.proxy_settings.dict())\n    # hs-plugin-remove-user\n    asyncio.create_task(_dispatch_users_update(expand_proto_users([proto_user])))",
            "remove_user",
        ),
        (
            "    proto_users = [_serialize_user_for_node(u.id, u.proxy_settings) for u in users]\n    asyncio.create_task(_dispatch_users_update(proto_users))",
            "    proto_users = [_serialize_user_for_node(u.id, u.proxy_settings) for u in users]\n    # hs-plugin-remove-users\n    asyncio.create_task(_dispatch_users_update(expand_proto_users(proto_users)))",
            "remove_users",
        ),
        (
            "    proto_users = await serialize_users_for_node(filtered)\n    asyncio.create_task(_dispatch_users_update(proto_users))",
            "    proto_users = await serialize_users_for_node(filtered)\n    # hs-plugin-sync-users\n    asyncio.create_task(_dispatch_users_update(expand_proto_users(proto_users)))",
            "sync_users",
        ),
    ]
    for old, new, label in replacements:
        if new in text:
            continue
        text = replace_once(text, old, new, label)
    return text


def patch_usage(text: str) -> str:
    text = ensure_import(
        text,
        "from app.hs_plugin_runtime import decode_usage_identity\n",
        "from app.utils.logger import get_logger\n",
        "usage runtime import",
    )
    if "# hs-plugin-usage:" in text:
        return text
    old = '''    validated_params = []
    invalid_uids = []
    for uid, value in params.items():
        try:
            validated_params.append({"uid": int(uid), "value": value})
        except ValueError, TypeError:
            invalid_uids.append(uid)
'''
    new = '''    validated_params = []
    invalid_uids = []
    for uid, value in params.items():
        try:
            # hs-plugin-usage: Host Ratio is applied before native Node Ratio.
            native_uid, host_ratio = decode_usage_identity(uid)
            validated_params.append({"uid": native_uid, "value": int(value * host_ratio)})
        except (ValueError, TypeError):
            invalid_uids.append(uid)
'''
    return replace_once(text, old, new, "record usage")


def patch_operation_node(text: str) -> str:
    text = ensure_import(
        text,
        "from app.hs_plugin_runtime import usage_emails_for_user\n",
        "from app.operation import BaseOperation, OperatorType\n",
        "node operation runtime import",
    )
    if "# hs-plugin-online-ip:" not in text:
        old_ip = '''    async def _get_node_user_ip_list_safe(self, node_id: int, email: str) -> dict[str, int] | None:
        """Wrapper method that returns None instead of raising exceptions"""
        try:
            node = await node_manager.get_node(node_id)
            if node is None:
                return None

            stats = await node.get_user_online_ip_list(email=email)
            if stats is None:
                return None

            return stats.ips
        except NodeAPIError as e:
            if e.code != 404:
                logger.error(f"Error getting IP list for user {email} on node {node_id}: {e}")
            return None
'''
        new_ip = '''    async def _get_node_user_ip_list_safe(self, node_id: int, email: str) -> dict[str, int] | None:
        """Wrapper method that returns None instead of raising exceptions.

        # hs-plugin-online-ip: aggregate native identity and HS aliases.
        """
        node = await node_manager.get_node(node_id)
        if node is None:
            return None

        combined: dict[str, int] = {}
        identities = usage_emails_for_user(email) if str(email).isdigit() else [str(email)]
        for identity in identities:
            try:
                stats = await node.get_user_online_ip_list(email=identity)
                if stats is None:
                    continue
                for ip, value in stats.ips.items():
                    combined[ip] = max(combined.get(ip, 0), value)
            except NodeAPIError as e:
                if e.code != 404:
                    logger.error(f"Error getting IP list for user {identity} on node {node_id}: {e}")
        return combined or None
'''
        text = replace_once(text, old_ip, new_ip, "online IP aggregation")

    if "# hs-plugin-online-stats:" not in text:
        old_online = '''        try:
            stats = await node.get_user_online_stats(email=f"{db_user.id}")
        except NodeAPIError as e:
            await self.raise_error(message=e.detail, code=e.code)

        if stats is None:
            await self.raise_error(message="Stats not found", code=404)

        return {node_id: stats.value}
'''
        new_online = '''        # hs-plugin-online-stats: aggregate native + per-inbound aliases.
        total = 0
        found = False
        last_error = None
        for identity in usage_emails_for_user(db_user.id):
            try:
                stats = await node.get_user_online_stats(email=identity)
            except NodeAPIError as e:
                last_error = e
                continue
            if stats is not None:
                total += stats.value
                found = True

        if not found:
            if last_error is not None and last_error.code != 404:
                await self.raise_error(message=last_error.detail, code=last_error.code)
            await self.raise_error(message="Stats not found", code=404)

        return {node_id: total}
'''
        text = replace_once(text, old_online, new_online, "online stats aggregation")
    return text


def patch_files(app_root: Path, addon_api: Path, runtime: Path) -> list[Path]:
    targets = {
        app_root / "routers" / "__init__.py": patch_router,
        app_root / "node" / "user.py": patch_user,
        app_root / "node" / "sync.py": patch_sync,
        app_root / "jobs" / "record_usages.py": patch_usage,
        app_root / "operation" / "node.py": patch_operation_node,
    }
    missing = [str(p) for p in targets if not p.is_file()]
    if missing:
        raise RuntimeError("missing PasarGuard files: " + ", ".join(missing))

    originals = {p: p.read_text(encoding="utf-8") for p in targets}
    generated = {p: fn(originals[p]) for p, fn in targets.items()}
    for p, content in generated.items():
        compile(content, str(p), "exec")

    api_dest = app_root / "routers" / "hs_plugin_api.py"
    runtime_dest = app_root / "hs_plugin_runtime.py"
    shutil.copy2(addon_api, api_dest)
    shutil.copy2(runtime, runtime_dest)
    compile(api_dest.read_text(encoding="utf-8"), str(api_dest), "exec")
    compile(runtime_dest.read_text(encoding="utf-8"), str(runtime_dest), "exec")

    for p, content in generated.items():
        if content != originals[p]:
            p.write_text(content, encoding="utf-8")
    return [*targets, api_dest, runtime_dest]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", required=True)
    parser.add_argument("--api-addon", required=True)
    parser.add_argument("--runtime", required=True)
    args = parser.parse_args()
    paths = patch_files(Path(args.app_root), Path(args.api_addon), Path(args.runtime))
    print("HS Plugin integration OK")
    for path in paths:
        print(path)


if __name__ == "__main__":
    main()
