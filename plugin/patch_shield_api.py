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
    return re.sub(rf"\n?{re.escape(start)}.*?{re.escape(end)}\n?", "\n", text, flags=re.S)


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
    if (
        IMPORT_START in text
        and IMPORT_END in text
        and REGISTER_START in text
        and REGISTER_END in text
        and "routers.insert(0, hs_shield_api.router)" in text
    ):
        return text

    text = strip_block(text, IMPORT_START, IMPORT_END)
    text = strip_block(text, REGISTER_START, REGISTER_END)
    if "api_router = APIRouter()" not in text:
        raise RuntimeError("api_router anchor not found")

    import_block = (
        f"{IMPORT_START}\n"
        "try:\n"
        "    from . import hs_shield_api\n"
        "except Exception:\n"
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

    target_api = app / "hs_shield_api.py"
    target_api.write_bytes(api_source.read_bytes())
    original = router_file.read_text(encoding="utf-8")
    patched = patch_router(original)
    if patched != original:
        router_file.write_text(patched, encoding="utf-8")
    compile(target_api.read_text(encoding="utf-8"), str(target_api), "exec")
    compile(router_file.read_text(encoding="utf-8"), str(router_file), "exec")


if __name__ == "__main__":
    main()
