from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path


class BackupAgentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.data = root / "data" / "hs-plugin"
        self.preserve = root / "preserve"
        self.pasarguard = root / "pasarguard"
        (self.pasarguard / "backup").mkdir(parents=True)

        os.environ["HS_PLUGIN_DATA_DIR"] = str(self.data)
        os.environ["HS_BACKUP_PRESERVE_ROOT"] = str(self.preserve)
        os.environ["PASARGUARD_ROOT"] = str(self.pasarguard)
        os.environ["PASARGUARD_BIN"] = str(root / "pasarguard-bin")

        module_name = f"hs_backup_agent_test_{uuid.uuid4().hex}"
        spec = importlib.util.spec_from_file_location(
            module_name,
            Path(__file__).parents[1] / "backend" / "hs_backup_agent.py",
        )
        self.mod = importlib.util.module_from_spec(spec)
        assert spec.loader
        spec.loader.exec_module(self.mod)
        self.mod.prepare_dirs()

    def tearDown(self):
        self.tmp.cleanup()

    def test_native_part_regex_matches_pasarguard_format(self):
        match = self.mod.PART_RE.match("backup_20260911010101.part01.zip")
        self.assertIsNotNone(match)
        self.assertEqual(match.group("base"), "backup_20260911010101")
        self.assertEqual(match.group("num"), "01")
        self.assertIsNone(self.mod.PART_RE.match("backup_20260911010101.zip.part01"))

    def test_native_group_keeps_all_parts_in_numeric_order(self):
        backup = self.pasarguard / "backup"
        paths = []
        for number in (3, 1, 2):
            path = backup / f"backup_20260911.part{number:02d}.zip"
            path.write_bytes(bytes([number]))
            paths.append(path)
        selected = self.mod._native_group(paths)
        self.assertEqual([p.name for p in selected], [
            "backup_20260911.part01.zip",
            "backup_20260911.part02.zip",
            "backup_20260911.part03.zip",
        ])

    def test_sanitized_export_excludes_hs_runtime_and_secret(self):
        source = Path(self.tmp.name) / "native.zip"
        target = Path(self.tmp.name) / "web.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr(".env", "TOKEN=ok")
            archive.writestr("pasarguard_data/users.json", "{}")
            archive.writestr("pasarguard_data/hs-plugin/state.json", "secret-state")
            archive.writestr("pasarguard_data/hs-plugin/backup-agent.token", "secret-token")
            archive.writestr("pasarguard_data/hs-plugin/backup-outbox/old.zip", "old")

        self.mod._sanitize_backup_zip(source, target)
        with zipfile.ZipFile(target, "r") as archive:
            names = set(archive.namelist())
        self.assertIn(".env", names)
        self.assertIn("pasarguard_data/users.json", names)
        self.assertFalse(any(name.startswith("pasarguard_data/hs-plugin/") for name in names))

    def test_stage_native_parts_requires_contiguous_set(self):
        source_dir = Path(self.tmp.name) / "uploads"
        source_dir.mkdir()
        items = []
        for number in (1, 2, 3):
            path = source_dir / f"part{number}.bin"
            path.write_bytes(b"chunk")
            items.append((f"backup_abc.part{number:02d}.zip", path))

        primary, staged = self.mod._stage_sources(items, "a" * 32)
        self.assertEqual(primary.name, "hs-backup-import-aaaaaaaaaa.part01.zip")
        self.assertEqual([p.name for p in staged], [
            "hs-backup-import-aaaaaaaaaa.part01.zip",
            "hs-backup-import-aaaaaaaaaa.part02.zip",
            "hs-backup-import-aaaaaaaaaa.part03.zip",
        ])

        broken = [items[0], items[2]]
        with self.assertRaisesRegex(ValueError, "incomplete|contiguous"):
            self.mod._stage_sources(broken, "b" * 32)

    def test_native_restore_candidates_only_expose_first_split_part(self):
        backup = self.pasarguard / "backup"
        normal = backup / "backup_normal.zip"
        normal.write_bytes(b"normal")
        first = backup / "hs-backup-import-test.part01.zip"
        second = backup / "hs-backup-import-test.part02.zip"
        first.write_bytes(b"one")
        second.write_bytes(b"two")

        candidates = self.mod._find_native_restore_candidates()
        names = [p.name for p in candidates]
        self.assertIn(normal.name, names)
        self.assertIn(first.name, names)
        self.assertNotIn(second.name, names)

    def test_restore_runtime_preserves_destination_state_and_token(self):
        state = {
            "version": 2,
            "features": {"backup_web": {"enabled": True}},
            "inbound_offsets": {"vless": 0.7},
        }
        self.mod.STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
        self.mod.TOKEN_FILE.write_text("x" * 64, encoding="utf-8")
        snapshot = self.mod._snapshot_hs_runtime("c" * 32)

        # Simulate PasarGuard's rsync --delete replacing /var/lib/pasarguard.
        self.mod.STATE_FILE.write_text(json.dumps({"features": {"backup_web": {"enabled": False}}}), encoding="utf-8")
        self.mod.TOKEN_FILE.write_text("y" * 64, encoding="utf-8")
        (self.mod.JOBS_DIR / "stale.json").write_text("{}", encoding="utf-8")

        self.mod._restore_hs_runtime(snapshot)
        restored = json.loads(self.mod.STATE_FILE.read_text(encoding="utf-8"))
        self.assertTrue(restored["features"]["backup_web"]["enabled"])
        self.assertEqual(restored["inbound_offsets"], {"vless": 0.7})
        self.assertEqual(self.mod.TOKEN_FILE.read_text(encoding="utf-8"), "x" * 64)
        self.assertEqual(list(self.mod.JOBS_DIR.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
