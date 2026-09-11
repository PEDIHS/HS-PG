from pathlib import Path

from patch_extensions import patch_files


def test_extension_patcher_registers_routes_subscription_and_usage_hook(tmp_path):
    app = tmp_path / "app"
    (app / "routers").mkdir(parents=True)
    (app / "subscription").mkdir()
    (app / "jobs").mkdir()

    (app / "routers" / "__init__.py").write_text(
        "from fastapi import APIRouter\napi_router = APIRouter()\nrouters = []\nfor router in routers:\n    api_router.include_router(router)\n"
    )
    (app / "subscription" / "share.py").write_text(
        "from app.core.hosts import host_manager\n"
        "async def run(user):\n"
        "    hosts = await filter_hosts(list((await host_manager.get_hosts()).values()), user.status)\n"
        "    return hosts\n"
    )
    (app / "jobs" / "record_usages.py").write_text(
        "import time\n"
        "from app.operation.admin_sync import enforce_admin_limits_now\n"
        "async def _record_user_usages_impl():\n"
        "    job_duration = time.time()\n"
        "async def _record_node_usages_impl():\n"
        "    job_duration = time.time()\n"
    )

    sources = {}
    for name in ("api.py", "runtime.py", "reconcile.py", "services.py"):
        path = tmp_path / name
        path.write_text("VALUE = 1\n")
        sources[name] = path

    args = (app, sources["api.py"], sources["runtime.py"], sources["reconcile.py"], sources["services.py"])
    patch_files(*args)
    first = {
        p: p.read_text()
        for p in (app / "routers" / "__init__.py", app / "subscription" / "share.py", app / "jobs" / "record_usages.py")
    }
    patch_files(*args)
    second = {p: p.read_text() for p in first}
    assert first == second
    assert "routers.insert(0, hs_extensions_api.router)" in first[app / "routers" / "__init__.py"]
    assert "filter_subscription_hosts(hosts, user)" in first[app / "subscription" / "share.py"]
    assert "await reconcile_fair_use(logger=logger)" in first[app / "jobs" / "record_usages.py"]
    assert (app / "routers" / "hs_extensions_api.py").is_file()
    assert (app / "hs_fair_use_runtime.py").is_file()
    assert (app / "hs_fair_reconcile.py").is_file()
    assert (app / "hs_services_runtime.py").is_file()
