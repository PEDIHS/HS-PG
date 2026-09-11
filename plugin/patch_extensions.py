#!/usr/bin/env python3
"""Idempotently integrate HS native extensions into PasarGuard source."""
from __future__ import annotations

import argparse
import ast
import re
import shutil
from pathlib import Path


def _replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one anchor, found {count}")
    return text.replace(old, new, 1)


def _strip(text: str, start: str, end: str) -> str:
    return re.sub(rf"\n?{re.escape(start)}.*?{re.escape(end)}\n?", "\n", text, flags=re.S)


def _routers_end(text: str) -> int:
    tree = ast.parse(text)
    node = next(
        (
            value
            for value in tree.body
            if isinstance(value, (ast.Assign, ast.AnnAssign))
            and any(
                isinstance(target, ast.Name) and target.id == "routers"
                for target in (value.targets if isinstance(value, ast.Assign) else [value.target])
            )
        ),
        None,
    )
    if node is None or not node.end_lineno:
        raise RuntimeError("routers assignment not found")
    lines = text.splitlines(keepends=True)
    return sum(len(line) for line in lines[: node.end_lineno])


def patch_router(text: str) -> str:
    a, b = "# hs-ext-router-start", "# hs-ext-router-end"
    c, d = "# hs-ext-register-start", "# hs-ext-register-end"
    if a in text and c in text and "routers.insert(0, hs_extensions_api.router)" in text:
        return text
    text = _strip(_strip(text, a, b), c, d)
    anchor = "api_router = APIRouter()"
    if anchor not in text:
        raise RuntimeError("router API anchor not found")
    block = (
        f"{a}\n"
        "try:\n"
        "    from . import hs_extensions_api\n"
        "except Exception:\n"
        "    hs_extensions_api = None\n"
        f"{b}\n\n"
    )
    text = text.replace(anchor, block + anchor, 1)
    pos = _routers_end(text)
    registration = (
        "\n"
        f"{c}\n"
        "if hs_extensions_api is not None:\n"
        "    routers.insert(0, hs_extensions_api.router)\n"
        f"{d}\n"
    )
    return text[:pos] + registration + text[pos:]


def patch_subscription(text: str) -> str:
    import_line = "from app.hs_fair_use_runtime import filter_subscription_hosts\n"
    if import_line not in text:
        text = _replace_once(
            text,
            "from app.core.hosts import host_manager\n",
            "from app.core.hosts import host_manager\n" + import_line,
            "subscription fair-use import",
        )
    desired = (
        "    hosts = await filter_hosts(list((await host_manager.get_hosts()).values()), user.status)\n"
        "    # hs-fair-use: a Fair-limited user receives only Fair Use eligible Hosts.\n"
        "    hosts = filter_subscription_hosts(hosts, user)\n"
    )
    if desired in text:
        return text
    old = "    hosts = await filter_hosts(list((await host_manager.get_hosts()).values()), user.status)\n"
    return _replace_once(text, old, desired, "subscription host filter")


def patch_usage_job(text: str) -> str:
    import_line = "from app.hs_fair_reconcile import reconcile_fair_use\n"
    if import_line not in text:
        text = _replace_once(
            text,
            "from app.operation.admin_sync import enforce_admin_limits_now\n",
            "from app.operation.admin_sync import enforce_admin_limits_now\n" + import_line,
            "fair reconcile import",
        )
    desired = (
        "        # hs-fair-use: refresh derived status, Xray marks and node rate plans after charged usage changes.\n"
        "        try:\n"
        "            await reconcile_fair_use(logger=logger)\n"
        "        except Exception:\n"
        "            logger.exception(\"HS Fair Use reconcile failed after usage recording\")\n\n"
        "        job_duration = time.time() - job_start_time\n"
    )
    if desired in text:
        return text
    old = "        job_duration = time.time() - job_start_time\n"
    # There are two job_duration anchors in this module. Insert only inside user usage.
    user_pos = text.find("async def _record_user_usages_impl():")
    node_pos = text.find("async def _record_node_usages_impl():")
    if user_pos < 0 or node_pos < 0:
        raise RuntimeError("record usage function anchors not found")
    segment = text[user_pos:node_pos]
    if segment.count(old) < 1:
        raise RuntimeError("user usage completion anchor not found")
    segment = segment.replace(old, desired, 1)
    return text[:user_pos] + segment + text[node_pos:]


def patch_files(
    app_root: Path,
    api_source: Path,
    runtime_source: Path,
    reconcile_source: Path,
    services_source: Path,
) -> list[Path]:
    targets = {
        app_root / "routers" / "__init__.py": patch_router,
        app_root / "subscription" / "share.py": patch_subscription,
        app_root / "jobs" / "record_usages.py": patch_usage_job,
    }
    missing = [str(path) for path in targets if not path.is_file()]
    if missing:
        raise RuntimeError("missing PasarGuard files: " + ", ".join(missing))

    originals = {path: path.read_text(encoding="utf-8") for path in targets}
    generated = {path: fn(originals[path]) for path, fn in targets.items()}
    for path, content in generated.items():
        compile(content, str(path), "exec")

    copies = {
        app_root / "routers" / "hs_extensions_api.py": api_source,
        app_root / "hs_fair_use_runtime.py": runtime_source,
        app_root / "hs_fair_reconcile.py": reconcile_source,
        app_root / "hs_services_runtime.py": services_source,
    }
    for destination, source in copies.items():
        shutil.copy2(source, destination)
        compile(destination.read_text(encoding="utf-8"), str(destination), "exec")

    for path, content in generated.items():
        if content != originals[path]:
            path.write_text(content, encoding="utf-8")
    return [*targets, *copies]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", required=True, type=Path)
    parser.add_argument("--api", required=True, type=Path)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--reconcile", required=True, type=Path)
    parser.add_argument("--services", required=True, type=Path)
    args = parser.parse_args()
    changed = patch_files(args.app_root, args.api, args.runtime, args.reconcile, args.services)
    print("HS native extensions integrated:", ", ".join(str(path) for path in changed))


if __name__ == "__main__":
    main()
