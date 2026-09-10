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


def test_usage_ratio_is_node_plus_host_offset():
    source = '''from app.utils.logger import get_logger\n\ndef _process_node_chunk(chunk_data):\n    _node_id, params, coeff = chunk_data\n    users_usage = {}\n    for param in params:\n        uid = int(param["uid"])\n        value = int(param["value"] * coeff)\n        users_usage[uid] = value\n    return users_usage\n\nasync def record_user_stats_batched(all_node_params, usage_coefficients):\n    upsert_params = []\n    for node_id, params in all_node_params.items():\n        coeff = usage_coefficients.get(node_id, 1.0)\n        for p in params:\n            upsert_params.append(\n                {\n                    "uid": int(p["uid"]),\n                    "value": int(p["value"] * coeff),\n                    "node_id": node_id,\n                }\n            )\n    return upsert_params\n\ndef _process_users_stats_response(stats_response):\n    params = {stat.name: stat.value for stat in stats_response.stats}\n    validated_params = []\n    invalid_uids = []\n    for uid, value in params.items():\n        try:\n            validated_params.append({"uid": int(uid), "value": value})\n        except ValueError, TypeError:\n            invalid_uids.append(uid)\n    return validated_params, invalid_uids\n\nasync def calculate_users_usage(api_params, usage_coefficient):\n    def _process_usage_sync(chunks_data):\n        users_usage = {}\n        for _, params, coeff in chunks_data:\n            for param in params:\n                uid = int(param["uid"])\n                value = int(param["value"] * coeff)\n                users_usage[uid] = value\n        return users_usage\n    return _process_usage_sync([])\n'''
    patched = mod.patch_usage(source)
    patched_twice = mod.patch_usage(patched)
    assert patched == patched_twice
    assert 'param["hs_ratio_offset"] = host_offset' in patched
    assert 'coeff + param.get("hs_ratio_offset", 0.0)' in patched
    assert 'coeff + p.get("hs_ratio_offset", 0.0)' in patched
    assert 'hs_effective_ratio' not in patched
    assert 'value * host_ratio' not in patched
    compile(patched, '<usage-patched>', 'exec')


if __name__ == '__main__':
    test_clean_pasarguard_router()
    test_zomorod_wrapped_router()
    test_usage_ratio_is_node_plus_host_offset()
    print('patcher tests: OK')
