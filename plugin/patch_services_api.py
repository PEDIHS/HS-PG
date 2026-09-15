#!/usr/bin/env python3
"""Idempotently register the HS Services API in PasarGuard's router table."""
from __future__ import annotations

import argparse
import ast
import re
from pathlib import Path

IMPORT_START = "# hs-services-router-start"
IMPORT_END = "# hs-services-router-end"
REGISTER_START = "# hs-services-router-register-start"
REGISTER_END = "# hs-services-router-register-end"


def strip_block(text: str, start: str, end: str) -> str:
    return re.sub(rf"\n?{re.escape(start)}.*?{re.escape(end)}\n?", "", text, flags=re.S)


def routers_assignment_end(text: str) -> int:
    tree = ast.parse(text)
    assignment = None
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(target, ast.Name) and target.id == "routers" for target in targets):
                assignment = node
                break
    if assignment is None or not getattr(assignment, "end_lineno", None):
        raise RuntimeError("routers assignment not found")
    lines = text.splitlines(keepends=True)
    return sum(len(line) for line in lines[: assignment.end_lineno])


def patch_router(text: str) -> str:
    text = strip_block(text, IMPORT_START, IMPORT_END)
    text = strip_block(text, REGISTER_START, REGISTER_END)
    if "api_router = APIRouter()" not in text:
        raise RuntimeError("api_router anchor not found")

    import_block = (
        f"{IMPORT_START}\n"
        "try:\n"
        "    from app import hs_services_api\n"
        "except Exception:\n"
        "    import logging\n"
        "    logging.getLogger(__name__).exception('HS Services/Services router import failed')\n"
        "    hs_services_api = None\n"
        f"{IMPORT_END}\n\n"
    )
    text = text.replace("api_router = APIRouter()", import_block + "api_router = APIRouter()", 1)
    insert_at = routers_assignment_end(text)
    register_block = (
        "\n"
        f"{REGISTER_START}\n"
        "if hs_services_api is not None:\n"
        "    routers.insert(0, hs_services_api.router)\n"
        f"{REGISTER_END}\n"
    )
    patched = text[:insert_at] + register_block + text[insert_at:]
    ast.parse(patched)
    return patched


def patch_native(app):
    from pathlib import Path
    generated={}
    path=app/'subscription/share.py';text=path.read_text()
    original='    hosts = await filter_hosts(list((await host_manager.get_hosts()).values()), user.status)'
    new='    from app.hs_fair_runtime import filter_hosts as hs_subscription_hosts\n    hosts = hs_subscription_hosts(await host_manager.get_hosts(), user)'
    if new not in text:
        if text.count(original)!=1:raise RuntimeError('Native subscription anchor changed')
        text=text.replace(original,new,1)
    generated[path]=text
    path=app/'models/user.py';text=path.read_text()
    marker='    # HS derived state: native database status remains authoritative.'
    if marker not in text:
        anchor='class UserResponse(UserNotificationResponse):'
        if text.count(anchor)!=1:raise RuntimeError('Native user response changed')
        text=text.replace(anchor,anchor+'\n'+marker+\
            '\n    @property\n    def hs_status(self) -> str:\n        from app.hs_fair_runtime import user_state\n        state = user_state(self)\n        return state["status"] if state else self.status.value\n',1)
        # computed_field serializes the derived field, with no new database column.
        text=text.replace(marker+'\n    @property',marker+'\n    @__import__("pydantic").computed_field\n    @property',1)
    anchor='class UserListQuery(BaseModel):'
    if '    hs_fair_limited: bool = False' not in text:text=text.replace(anchor,anchor+'\n    hs_fair_limited: bool = False',1)
    metadata='    # HS feature metadata for native user-list viewers.'
    if metadata not in text:
        users_anchor='class UsersResponse(BaseModel):'
        if text.count(users_anchor)!=1:raise RuntimeError('Native users response changed')
        text=text.replace(users_anchor,users_anchor+'\n'+metadata+'\n    @__import__("pydantic").computed_field\n    @property\n    def hs_fair_use_enabled(self) -> bool:\n        from app.hs_fair_runtime import enabled\n        return enabled()\n',1)
    generated[path]=text
    path=app/'db/crud/user.py';text=path.read_text()
    marker='    # HS Fair limited filter; evaluated before native pagination.'
    if marker not in text:
        a=text.index('async def get_users(');pos=text.index('    filters = []',a)+len('    filters = []')
        text=text[:pos]+'\n'+marker+'\n    if getattr(query, "hs_fair_limited", False):\n        from app.hs_fair_runtime import limited_groups\n        groups = limited_groups()\n        filters.append(or_(*[and_(User.id.in_(ids), User.used_traffic >= threshold) for threshold, ids in groups.items()]) if groups else literal(False))\n        filters.append(User.status == "active")'+text[pos:]
    generated[path]=text
    path=app/'core/manager.py';text=path.read_text()
    anchor='async def init_core_manager():\n    async with GetDB() as db:\n        await core_manager.initialize(db)'
    replacement='async def init_core_manager():\n    async with GetDB() as db:\n        from app.hs_fair_runtime import retire_core_routes\n        await retire_core_routes(db)\n        await core_manager.initialize(db)'
    if replacement not in text:
        if text.count(anchor)!=1:raise RuntimeError('Core startup anchor changed')
        text=text.replace(anchor,replacement,1)
    generated[path]=text
    return generated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", required=True)
    parser.add_argument("--services-api", required=True)
    args = parser.parse_args()

    app = Path(args.app_root)
    router_file = app / "routers" / "__init__.py"
    api_source = Path(args.services_api)
    if not router_file.is_file():
        raise SystemExit(f"router file not found: {router_file}")
    if not api_source.is_file():
        raise SystemExit(f"services API source not found: {api_source}")

    sources = {'hs_services_api.py': api_source}
    for name in ('hs_services.py', 'hs_outbounds.py', 'hs_fair_use.py', 'hs_fair_runtime.py', 'hs_local_bridge.py'):
        source = api_source.parent / name
        if not source.is_file():
            raise SystemExit(f'Missing HS dependency: {source}')
        sources[name] = source
    generated = {app/name: source.read_text(encoding='utf-8') for name,source in sources.items()}
    original = router_file.read_text(encoding='utf-8')
    generated[router_file] = patch_router(original)
    generated.update(patch_native(app))
    for target, content in generated.items():
        compile(content, str(target), 'exec')
    for target, content in generated.items():
        if not target.exists() or target.read_text(encoding='utf-8') != content:
            target.write_text(content, encoding='utf-8')


if __name__ == "__main__":
    main()
