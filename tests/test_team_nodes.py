"""Small node/cache security tests without requiring a GPU or importing ComfyUI.
Actual CPU ComfyUI integration is separately exercised by verification scripts.
Run: python -m unittest discover -s tests -p 'test_*.py'
"""
import ast
import hashlib
import math
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'py' / 'nodePlugin.py'
tree = ast.parse(source.read_text())
selected = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
                           and node.name in ('team_snapshot', 'is_changed_file', 'PhotoshopToComfyUI')], type_ignores=[])
namespace = dict(hashlib=hashlib, os=os, Path=Path, re=re)
exec(compile(selected, str(source), 'exec'), namespace)
team_snapshot = namespace['team_snapshot']
Node = namespace['PhotoshopToComfyUI']


class TeamNodesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'PS_TEAM_INPUT_ROOT': str(self.root), 'PS_TEAM_REQUIRED': '1'})
        self.env.start()
        self.sid = 'a' * 32
        self.directory = self.root / self.sid
        self.directory.mkdir()
        for name in ('PS_canvas.png', 'PS_mask.png', 'config.json'):
            (self.directory / name).write_bytes(name.encode())
        self.meta = {'ps_team': {'version': 'ps-team-1', 'snapshot_id': self.sid}}

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_invalid_or_missing_snapshot_forces_execution_not_cached_reuse(self):
        for meta in (None, {}, [], {'ps_team': {}}, {'ps_team': {'version': 'ps-team-1', 'snapshot_id': 'b' * 32}},
                     {'ps_team': {'version': 'ps-team-1', 'snapshot_id': '../../outside'}}):
            with self.subTest(meta=meta):
                self.assertTrue(math.isnan(Node.IS_CHANGED(meta)))
                with self.assertRaises(ValueError):
                    team_snapshot(meta)

    def test_cache_key_is_request_and_content_scoped(self):
        before = Node.IS_CHANGED(self.meta)
        self.assertEqual(before, Node.IS_CHANGED(self.meta))
        (self.directory / 'PS_canvas.png').write_bytes(b'changed')
        self.assertNotEqual(before, Node.IS_CHANGED(self.meta))
        other = self.root / ('b' * 32)
        other.mkdir()
        for name in ('PS_canvas.png', 'PS_mask.png', 'config.json'):
            (other / name).write_bytes((self.directory / name).read_bytes())
        self.assertNotEqual(Node.IS_CHANGED(self.meta), Node.IS_CHANGED({'ps_team': {'version': 'ps-team-1', 'snapshot_id': other.name}}))

    def test_directory_and_file_symlinks_are_rejected(self):
        alias = self.root / ('c' * 32)
        alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            team_snapshot({'ps_team': {'version': 'ps-team-1', 'snapshot_id': alias.name}})
        mask = self.directory / 'PS_mask.png'
        mask.unlink()
        mask.symlink_to(self.directory / 'PS_canvas.png')
        with self.assertRaisesRegex(ValueError, 'unsafe'):
            team_snapshot(self.meta)
        self.assertTrue(math.isnan(Node.IS_CHANGED(self.meta)))

    def test_legacy_mode_remains_explicitly_available(self):
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
            self.assertIsNone(team_snapshot(None))


if __name__ == '__main__':
    unittest.main()
