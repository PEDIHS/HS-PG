#!/usr/bin/env python3
"""Idempotently register the HS Web Backup router inside PasarGuard."""
from __future__ import annotations

import argparse
import ast
import re
import shutil
from pathlib import Path

IMPORT_START = "# hs-backup-router-start"
IMPORT_END = "# hs-backup-router-end"
REGISTER_START = "# hs-backup-router-register-start"
REGISTER_END = "# hs-backup-router-register-end"


def _strip_marked_block(text: str, start: str, end: str) -> str:
    pattern = re.compile(rf"\n?{re.escape(start)}.*?{re.escape(end)}\n?", re.S)
    return pattern.sub("\n", text)


def _routers_assignment_end(text: str) -> int:
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
    desired_import = (
        f"{IMPORT_START}\n"
        "try:\n"
        "    from . import hs_backup_api\n"
        "except Exception:\n"
        "    hs_backup_api = None\n"
        f"{IMPORT_END}\n\n"
    )
    desired_register = (
        "\n"
        f"{REGISTER_START}\n"
        "if hs_backup_api is not None:\n"
        "    routers.insert(0, hs_backup_api.router)\n"
        f"{REGISTER_END}\n"
    )

    text = _strip_marked_block(text, IMPORT_START, IMPORT_END)
    text = _strip_marked_block(text, REGISTER_START, REGISTER_END)

    anchor = "api_router = APIRouter()"
    if anchor not in text:
        raise RuntimeError("api_router anchor not found")
    text = text.replace(anchor, desired_import + anchor, 1)

    insert_at = _routers_assignment_end(text)
    text = text[:insert_at] + desired_register + text[insert_at:]
    compile(text, "routers/__init__.py", "exec")
    return text


def patch(app_root: Path, backup_api: Path) -> list[Path]:
    router_path = app_root / "routers" / "__init__.py"
    if not router_path.is_file():
        raise RuntimeError(f"missing PasarGuard router file: {router_path}")
    if not backup_api.is_file():
        raise RuntimeError(f"missing HS backup API: {backup_api}")

    old = router_path.read_text(encoding="utf-8")
    new = patch_router(old)
    if new != old:
        router_path.write_text(new, encoding="utf-8")

    api_dest = app_root / "routers" / "hs_backup_api.py"
    shutil.copy2(backup_api, api_dest)
    compile(api_dest.read_text(encoding="utf-8"), str(api_dest), "exec")
    return [router_path, api_dest]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", required=True)
    parser.add_argument("--backup-api", required=True)
    args = parser.parse_args()

    paths = patch(Path(args.app_root), Path(args.backup_api))
    print("HS Web Backup hooks healthy:")
    for path in paths:
        print(f" - {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
