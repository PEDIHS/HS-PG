from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('hs_patcher', ROOT / 'plugin' / 'patch_pasarguard.py')
mod = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(mod)

BASE = '''from fastapi import APIRouter

api_router = APIRouter()

routers = [
    object(),
]

{loop}
    api_router.include_router(router)

__all__ = ["api_router"]
'''


def check(loop: str) -> None:
    original = BASE.format(loop=loop)
    once = mod.patch_router(original)
    twice = mod.patch_router(once)
    compile(once, '<once>', 'exec')
    compile(twice, '<twice>', 'exec')
    assert once == twice
    assert 'routers.insert(0, hs_plugin_api.router)' in once
    assert loop in once


def test_clean_pasarguard_router():
    check('for router in routers:')


def test_zomorod_wrapped_router():
    check('for router in (([zomorod_admin_subscriptions.router] if zomorod_admin_subscriptions else []) + routers):')


if __name__ == '__main__':
    test_clean_pasarguard_router()
    test_zomorod_wrapped_router()
    print('patcher tests: OK')
