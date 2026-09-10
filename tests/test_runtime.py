from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


class FakeUser:
    def __init__(self, email='42', inbounds=None, token='same-secret'):
        self.email = email
        self.inbounds = list(inbounds or [])
        self.token = token

    def CopyFrom(self, other):
        self.email = other.email
        self.inbounds = list(other.inbounds)
        self.token = other.token


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ['HS_PLUGIN_DATA_DIR'] = self.tmp.name
        spec = importlib.util.spec_from_file_location('hs_runtime_test', Path(__file__).parents[1] / 'backend' / 'hs_plugin_runtime.py')
        self.mod = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(self.mod)

    def tearDown(self):
        self.tmp.cleanup()

    def write_state(self, enabled=True, offsets=None):
        Path(self.tmp.name, 'state.json').write_text(json.dumps({
            'version': 2,
            'features': {'host_usage_ratio': {'enabled': enabled}},
            'inbound_offsets': offsets or {},
        }), encoding='utf-8')

    def test_native_identity_keeps_node_ratio(self):
        self.write_state(True, {'vless-main': 0.7})
        self.assertEqual(self.mod.decode_usage_identity('42'), (42, None))

    def test_tracked_inbound_is_split_and_carries_offset(self):
        self.write_state(True, {'vless-main': 0.7})
        users = self.mod.expand_proto_users([FakeUser(inbounds=['vless-main', 'other'])])
        self.assertEqual(len(users), 2)
        self.assertEqual(users[0].email, '42')
        self.assertEqual(users[0].inbounds, ['other'])
        self.assertEqual(users[1].inbounds, ['vless-main'])
        uid, offset = self.mod.decode_usage_identity(users[1].email)
        self.assertEqual(uid, 42)
        self.assertAlmostEqual(offset, 0.7)

    def test_zero_offset_needs_no_alias(self):
        self.write_state(True, {'vless-main': 0.0})
        users = self.mod.expand_proto_users([FakeUser(inbounds=['vless-main'])])
        self.assertEqual(len(users), 1)
        self.assertEqual(users[0].email, '42')
        self.assertEqual(users[0].inbounds, ['vless-main'])

    def test_disabled_feature_restores_base_and_emits_tombstone(self):
        self.write_state(False, {'vless-main': 0.7})
        users = self.mod.expand_proto_users([FakeUser(inbounds=['vless-main', 'other'])])
        self.assertEqual(users[0].inbounds, ['vless-main', 'other'])
        self.assertEqual(users[1].inbounds, [])
        self.assertEqual(self.mod.decode_usage_identity(users[1].email), (42, None))

    def test_alias_preserves_credentials(self):
        self.write_state(True, {'vless-main': 0.7})
        users = self.mod.expand_proto_users([FakeUser(inbounds=['vless-main'], token='secret')])
        self.assertEqual(users[1].token, 'secret')


if __name__ == '__main__':
    unittest.main()
