from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("hs_patcher_541", ROOT / "plugin" / "patch_pasarguard.py")
mod = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(mod)


def test_pasarguard_541_batched_usage_shape_is_supported_and_idempotent():
    source = '''from app.utils.logger import get_logger\n\nasync def record_user_stats_batched(all_node_params, usage_coefficients):\n    upsert_params = []\n    for node_id, params in all_node_params.items():\n        coeff = usage_coefficients.get(node_id, 1.0)\n        for p in params:\n            upsert_params.append(\n                {\n                    "uid": int(p["uid"]),\n                    "value": int(p["value"] * coeff),\n                    "node_id": node_id,\n                }\n            )\n    return upsert_params\n\ndef _process_users_stats_response(stats_response):\n    params = {stat.name: stat.value for stat in stats_response.stats}\n    validated_params = []\n    invalid_uids = []\n    for uid, value in params.items():\n        try:\n            validated_params.append({"uid": int(uid), "value": value})\n        except ValueError, TypeError:\n            invalid_uids.append(uid)\n    return validated_params, invalid_uids\n'''
    patched = mod.patch_usage(source)
    assert mod.patch_usage(patched) == patched
    assert "decode_usage_identity(uid)" in patched
    assert 'param["hs_ratio_offset"] = host_offset' in patched
    assert 'param["hs_absolute_ratio"] = legacy_absolute_ratio' in patched
    assert '"value": int(p["value"] * max(0.0, p.get("hs_absolute_ratio", coeff + p.get("hs_ratio_offset", 0.0)))),' in patched
    compile(patched, "<pasarguard-5.4.1-usage>", "exec")
