#!/usr/bin/env python3
"""Idempotently register the HS Shield API in PasarGuard's router table."""
from __future__ import annotations

import argparse
import ast
import re
from pathlib import Path

IMPORT_START = "# hs-shield-router-start"
IMPORT_END = "# hs-shield-router-end"
REGISTER_START = "# hs-shield-router-register-start"
REGISTER_END = "# hs-shield-router-register-end"


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
        "    from app import hs_shield_api\n"
        "    from app import hs_services_api\n"
        "except Exception:\n"
        "    import logging\n"
        "    logging.getLogger(__name__).exception('HS Shield/Services router import failed')\n"
        "    hs_services_api = None\n"
        "    hs_shield_api = None\n"
        f"{IMPORT_END}\n\n"
    )
    text = text.replace("api_router = APIRouter()", import_block + "api_router = APIRouter()", 1)
    insert_at = routers_assignment_end(text)
    register_block = (
        "\n"
        f"{REGISTER_START}\n"
        "if hs_shield_api is not None:\n"
        "    routers.insert(0, hs_shield_api.router)\n"
        "if hs_services_api is not None:\n"
        "    routers.insert(0, hs_services_api.router)\n"
        f"{REGISTER_END}\n"
    )
    patched = text[:insert_at] + register_block + text[insert_at:]
    ast.parse(patched)
    return patched


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", required=True)
    parser.add_argument("--shield-api", required=True)
    args = parser.parse_args()

    app = Path(args.app_root)
    router_file = app / "routers" / "__init__.py"
    api_source = Path(args.shield_api)
    if not router_file.is_file():
        raise SystemExit(f"router file not found: {router_file}")
    if not api_source.is_file():
        raise SystemExit(f"shield API source not found: {api_source}")

    sources = {'hs_shield_api.py': api_source}
    for name in ('hs_services_api.py', 'hs_firewall.py', 'hs_services.py', 'hs_outbounds.py', 'hs_fair_use.py'):
        source = api_source.parent / name
        if not source.is_file():
            raise SystemExit(f'Missing HS dependency: {source}')
        sources[name] = source
    generated = {app/name: source.read_text(encoding='utf-8') for name,source in sources.items()}
    original = router_file.read_text(encoding='utf-8')
    generated[router_file] = patch_router(original)
    for target, content in generated.items():
        compile(content, str(target), 'exec')
    for target, content in generated.items():
        if not target.exists() or target.read_text(encoding='utf-8') != content:
            target.write_text(content, encoding='utf-8')


if __name__ == "__main__":
    main()
