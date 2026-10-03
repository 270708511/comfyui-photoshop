"""Dependency-free protocol, cache, and security tests for the Photoshop nodes.

The real Torch/PIL suite in test_ps_plugin_nodes.py covers image execution.
Run: python -m unittest discover -s tests -p 'test_team_nodes.py'
"""
import ast
import asyncio
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch


class SaveImage:
    def save_images(self, images, filename_prefix, prompt, extra_pnginfo):
        self.saved_prefix = filename_prefix
        return {'ui': {'images': [{'filename': 'result.png',
                                  'subfolder': filename_prefix.rsplit('/', 1)[0],
                                  'type': self.type}]}}


source = Path(__file__).resolve().parents[1] / 'py' / 'nodePlugin.py'
tree = ast.parse(source.read_text())
selected = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
                           and node.name in ('_snapshot_config', 'team_snapshot', 'is_changed_file',
                                             'PhotoshopToComfyUI', 'ComfyUIToPhotoshop')], type_ignores=[])
namespace = dict(hashlib=hashlib, json=json, os=os, Path=Path, re=re,
                 torch=types.SimpleNamespace(Tensor=object), SaveImage=SaveImage)
exec(compile(selected, str(source), 'exec'), namespace)
team_snapshot = namespace['team_snapshot']
Node = namespace['PhotoshopToComfyUI']
Output = namespace['ComfyUIToPhotoshop']


class TeamNodesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'PS_TEAM_INPUT_ROOT': str(self.root), 'PS_TEAM_REQUIRED': '1'})
        self.env.start()
        self.folders = patch.dict(namespace, folder_paths=types.SimpleNamespace(
            get_input_directory=lambda: str(self.root / 'input'),
            get_output_directory=lambda: str(self.root / 'output'),
            get_temp_directory=lambda: str(self.root / 'temp')))
        self.folders.start()
        self.sid = 'a' * 32
        self.directory = self.root / self.sid
        self.directory.mkdir()
        for name in ('PS_canvas.png', 'PS_mask.png'):
            (self.directory / name).write_bytes(name.encode())
        self.config = dict(positive='team', negative='', seed='123', slider=25)
        (self.directory / 'config.json').write_text(json.dumps(self.config))
        self.meta = {'ps_team': {'version': 'ps-team-1', 'snapshot_id': self.sid}}
        subfolder = 'ps_plugin/' + self.sid
        uploaded = self.root / 'input' / subfolder
        uploaded.mkdir(parents=True)
        for name in ('canvas.png', 'mask.png'):
            (uploaded / name).write_bytes(name.encode())
        self.plugin = {'ps_plugin': dict(version='ps-plugin-1', snapshot_id=self.sid, request_id='b' * 32,
            canvas=dict(name='canvas.png', subfolder=subfolder, type='input'),
            mask=dict(name='mask.png', subfolder=subfolder, type='input'),
            config=dict(positive='plugin', negative='', seed='321', slider=50))}

    def tearDown(self):
        self.folders.stop()
        self.env.stop()
        self.tmp.cleanup()

    def assert_invalid(self, meta, message=None):
        self.assertTrue(math.isnan(Node.IS_CHANGED(meta)))
        with self.assertRaisesRegex(ValueError, message or ''):
            team_snapshot(meta)

    def test_invalid_or_missing_snapshot_forces_execution_not_cached_reuse(self):
        for meta in (None, {}, [], '', False, 1, {'ps_team': None}, {'ps_team': {}},
                     {'ps_team': {'version': 'ps-team-1', 'snapshot_id': 'b' * 32}},
                     {'ps_team': {'version': 'ps-team-1', 'snapshot_id': '../../outside'}},
                     {'ps_team': {'version': 'ps-team-1', 'snapshot_id': 11111111111111111111111111111111}}):
            with self.subTest(meta=meta):
                self.assert_invalid(meta)

    def test_strict_worker_rejects_plugin_and_legacy_downgrades(self):
        for enabled in ('1', 'true', 'yes', 'TRUE', ' yes '):
            with self.subTest(enabled=enabled), patch.dict(os.environ, {'PS_TEAM_REQUIRED': enabled}):
                self.assert_invalid(self.plugin, 'required')
                self.assert_invalid({}, 'required')
                with self.assertRaisesRegex(ValueError, 'required'):
                    Node().PS_Execute(self.plugin)

    def test_combined_protocol_metadata_is_always_ambiguous(self):
        for strict in ('0', '1'):
            with patch.dict(os.environ, {'PS_TEAM_REQUIRED': strict}):
                for team in (self.meta['ps_team'], None, {}):
                    for plugin in (self.plugin['ps_plugin'], None, {}):
                        with self.subTest(strict=strict, team=team, plugin=plugin):
                            self.assert_invalid(dict(ps_team=team, ps_plugin=plugin), 'Ambiguous')

    def test_trusted_team_paths_and_config_ignore_client_fields(self):
        meta = copy.deepcopy(self.meta)
        meta['ps_team'].update(canvas=self.plugin['ps_plugin']['canvas'], config=self.plugin['ps_plugin']['config'])
        snapshot = team_snapshot(meta)
        self.assertEqual(snapshot['protocol'], 'ps_team')
        self.assertEqual(snapshot['canvas'], self.directory / 'PS_canvas.png')
        self.assertEqual(snapshot['mask'], self.directory / 'PS_mask.png')
        self.assertEqual(snapshot['config'], self.config)

    def test_team_config_must_be_valid(self):
        cases = ['not json', 'null', '[]']
        for key, bad_values in [('positive', [None, 1]), ('negative', [False]),
                                ('seed', [-1, True, 1.5, 'x', str(2 ** 64)]),
                                ('slider', [None, True, -1, 101, float('nan'), float('inf')])]:
            for bad in bad_values:
                config = dict(self.config); config[key] = bad
                cases.append(json.dumps(config))
        for content in cases:
            with self.subTest(content=content):
                (self.directory / 'config.json').write_text(content)
                self.assert_invalid(self.meta, 'config')

    def test_team_root_is_required(self):
        with patch.dict(os.environ, {'PS_TEAM_INPUT_ROOT': ''}):
            self.assert_invalid(self.meta, 'PS_TEAM_INPUT_ROOT')

    def test_cache_key_is_protocol_request_and_content_scoped(self):
        before = Node.IS_CHANGED(self.meta)
        self.assertIsInstance(before, str)
        self.assertEqual(before, Node.IS_CHANGED(self.meta))
        (self.directory / 'PS_canvas.png').write_bytes(b'changed')
        self.assertNotEqual(before, Node.IS_CHANGED(self.meta))
        other = self.root / ('b' * 32)
        other.mkdir()
        for name in ('PS_canvas.png', 'PS_mask.png', 'config.json'):
            (other / name).write_bytes((self.directory / name).read_bytes())
        self.assertNotEqual(Node.IS_CHANGED(self.meta), Node.IS_CHANGED({'ps_team': {'version': 'ps-team-1', 'snapshot_id': other.name}}))
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
            self.assertNotEqual(Node.IS_CHANGED(self.meta), Node.IS_CHANGED(self.plugin))

    def test_config_changes_invalidate_team_cache(self):
        before = Node.IS_CHANGED(self.meta)
        config = dict(self.config, positive='different')
        (self.directory / 'config.json').write_text(json.dumps(config))
        self.assertNotEqual(before, Node.IS_CHANGED(self.meta))

    def test_native_runtime_reads_each_trusted_config_field(self):
        # Exercise the real runtime config/return contract independently of Torch.
        # Pixel conversion is covered separately by the real Torch/PIL suite.
        canvas, expanded_mask = object(), object()
        mask = types.SimpleNamespace(unsqueeze=lambda axis: expanded_mask)

        def provide_images(node):
            node.canvas, node.mask = canvas, mask
            node.width, node.height = 640, 480

        node = Node()
        forged = copy.deepcopy(self.meta)
        forged['ps_team']['config'] = dict(positive='untrusted', negative='untrusted', seed=1, slider=1)
        for config in (
            dict(positive='native prompt \u5f69\u8272', negative='negative text', seed=str(2 ** 64 - 1), slider=100),
            dict(positive='', negative='', seed=0, slider=0),
            dict(positive='changed', negative='new negative', seed=9007199254740993, slider=12.5),
        ):
            with self.subTest(config=config), patch.object(Node, 'SendImg', provide_images):
                (self.directory / 'config.json').write_text(json.dumps(config), encoding='utf-8')
                result = node.PS_Execute(forged)
                self.assertIs(result[0], canvas)
                self.assertIs(result[1], expanded_mask)
                self.assertEqual(result[2:], (config['slider'] / 100, int(config['seed']),
                    config['positive'], config['negative'], 640, 480))
                self.assertEqual(node.canvasDir, str(self.directory / 'PS_canvas.png'))
                self.assertEqual(node.maskImgDir, str(self.directory / 'PS_mask.png'))

    def test_mask_and_every_config_field_invalidate_input_and_output_cache(self):
        def keys():
            return (Node.IS_CHANGED(self.meta), Output.IS_CHANGED(extra_pnginfo=self.meta))

        before = keys()
        (self.directory / 'PS_mask.png').write_bytes(b'native mask changed')
        self.assertTrue(all(a != b for a, b in zip(before, keys())))
        config = dict(self.config)
        for field, value in [('positive', 'updated'), ('negative', 'updated negative'),
                             ('seed', str(2 ** 64 - 1)), ('slider', 87.5)]:
            with self.subTest(field=field):
                before = keys()
                config[field] = value
                (self.directory / 'config.json').write_text(json.dumps(config))
                self.assertTrue(all(a != b for a, b in zip(before, keys())))

    def test_team_output_preserves_entire_batch_and_workflow_metadata(self):
        node = Output(); node.connect_to_backend = AsyncMock()
        images = [object(), object(), object()]
        prompt = {'1': {'class_type': '\U0001f539SendTo Photoshop Plugin', 'inputs': {}}}
        metadata = dict(self.meta, workflow={'id': 'prepared-workflow', 'nodes': []})
        ui = {'images': [dict(filename=f'PS_OUTPUTS_{index}.png', type='output',
                              subfolder='ps_team/' + self.sid) for index in range(3)]}
        with patch.object(node, 'save_images', return_value={'ui': ui}) as save:
            result = asyncio.run(node.execute(images, filename_prefix='../../client-selected',
                                               prompt=prompt, extra_pnginfo=metadata))
            save.assert_called_once_with(images, 'ps_team/' + self.sid + '/PS_OUTPUTS', prompt, metadata)
        self.assertIs(result['ui'], ui)
        self.assertIs(result['result'][0], images)
        self.assertEqual(len(result['ui']['images']), 3)
        node.connect_to_backend.assert_not_awaited()

    def test_directory_and_file_symlinks_are_rejected(self):
        alias = self.root / ('c' * 32)
        alias.symlink_to(self.directory, target_is_directory=True)
        self.assert_invalid({'ps_team': {'version': 'ps-team-1', 'snapshot_id': alias.name}}, 'unsafe')
        for name in ('PS_canvas.png', 'PS_mask.png', 'config.json'):
            item = self.directory / name
            content = item.read_bytes()
            item.unlink()
            item.symlink_to(self.directory / 'elsewhere')
            self.assert_invalid(self.meta, 'unsafe')
            item.unlink()
            item.write_bytes(content)

    def test_plugin_cache_revalidates_images_and_metadata(self):
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
            before = Node.IS_CHANGED(self.plugin)
            self.assertIsInstance(before, str)
            self.assertEqual(before, Node.IS_CHANGED(self.plugin))
            canvas = team_snapshot(self.plugin)['canvas']
            canvas.write_bytes(b'changed')
            self.assertNotEqual(before, Node.IS_CHANGED(self.plugin))
            previous = Node.IS_CHANGED(self.plugin)
            changed = copy.deepcopy(self.plugin); changed['ps_plugin']['request_id'] = 'c' * 32
            self.assertNotEqual(previous, Node.IS_CHANGED(changed))
            canvas.unlink()
            self.assert_invalid(self.plugin)

    def test_malformed_plugin_metadata_never_falls_back_to_legacy(self):
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
            for meta in ({'ps_plugin': None}, {'ps_plugin': []}, {'ps_plugin': {}},
                         {'ps_team': None}, [], False, ''):
                with self.subTest(meta=meta):
                    self.assert_invalid(meta)
            for key in ('version', 'snapshot_id', 'request_id', 'canvas', 'mask', 'config'):
                meta = copy.deepcopy(self.plugin); meta['ps_plugin'][key] = None
                with self.subTest(key=key):
                    self.assert_invalid(meta)
            meta = copy.deepcopy(self.plugin); meta['ps_plugin']['unknown'] = object()
            self.assert_invalid(meta)

    def test_plugin_upload_path_validation_including_windows_paths(self):
        cases = [('name', name) for name in ('../canvas.png', '/canvas.png', 'C:\\canvas.png',
                 '..', 'a/b.png', 'a\\b.png', 'x.', 'x ', 'CON.png', 'NUL', 'LPT1.png', 'a:b.png',
                 'x?.png', 'x*.png', 'x|.png', 'x".png', 'x<.png', 'a\x00.png', 'a\x7f.png')]
        cases += [('subfolder', value) for value in ('../ps_plugin/' + self.sid, 'ps_plugin\\' + self.sid,
                  'C:\\ps_plugin\\' + self.sid, 'ps_plugin/' + 'b' * 32, 'ps_plugin//' + self.sid)]
        cases += [('type', 'output'), ('type', 'temp')]
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
            for key, value in cases:
                with self.subTest(key=key, value=value):
                    meta = copy.deepcopy(self.plugin); meta['ps_plugin']['canvas'][key] = value
                    self.assert_invalid(meta)
            meta = copy.deepcopy(self.plugin); meta['ps_plugin']['mask'] = meta['ps_plugin']['canvas']
            self.assert_invalid(meta, 'separate')

    def test_plugin_parent_directory_symlink_is_rejected(self):
        parent = self.root / 'input' / 'ps_plugin'
        parent.rename(parent.with_name('moved'))
        parent.symlink_to(parent.with_name('moved'), target_is_directory=True)
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
            self.assert_invalid(self.plugin, 'symlink')

    def test_missing_cache_time_hidden_metadata_never_reuses_standalone_cache(self):
        # ComfyUI's IsChangedCache calls get_input_data without extra_data,
        # supplying None for EXTRA_PNGINFO even for a real snapshot request.
        # A normal hash of the legacy files would become False on the next call.
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}), patch.dict(namespace, nodepath=str(self.root)):
            legacy = self.root / 'data' / 'ps_inputs'; legacy.mkdir(parents=True)
            for name in ('PS_canvas.png', 'PS_mask.png', 'config.json'):
                (legacy / name).write_bytes((self.directory / name).read_bytes())
            for _ in range(3):
                self.assertTrue(math.isnan(Node.IS_CHANGED(extra_pnginfo=None)))
                self.assertTrue(math.isnan(Output.IS_CHANGED(output=None, prompt=None, extra_pnginfo=None)))
            # Explicit legacy execution remains available; only unsafe cache reuse changes.
            self.assertIsNone(team_snapshot(None))

    def test_legacy_mode_remains_explicitly_available(self):
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
            self.assertIsNone(team_snapshot(None))
            self.assertIsNone(team_snapshot({}))

    def test_outputs_are_routed_by_validated_protocol(self):
        node = Output(); node.connect_to_backend = AsyncMock()
        for protocol, meta in [('ps_team', self.meta), ('ps_plugin', self.plugin)]:
            with self.subTest(protocol=protocol), patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
                image = object()
                result = asyncio.run(node.execute(image, filename_prefix='../../client-path', extra_pnginfo=meta))
                self.assertIs(result['result'][0], image)
                self.assertEqual(node.saved_prefix, protocol + '/' + self.sid + '/PS_OUTPUTS')
                self.assertEqual(result['ui']['images'][0]['subfolder'], protocol + '/' + self.sid)
                self.assertEqual(result['ui']['images'][0]['type'], 'output')
        node.connect_to_backend.assert_not_awaited()

    def test_output_cache_includes_hidden_snapshot_metadata(self):
        before = Output.IS_CHANGED(output=object(), extra_pnginfo=self.meta)
        self.assertIsInstance(before, str)
        self.assertEqual(before, Output.IS_CHANGED(output=object(), extra_pnginfo=self.meta))
        other = self.root / ('b' * 32); other.mkdir()
        for name in ('PS_canvas.png', 'PS_mask.png', 'config.json'):
            (other / name).write_bytes((self.directory / name).read_bytes())
        changed = {'ps_team': dict(version='ps-team-1', snapshot_id=other.name)}
        self.assertNotEqual(before, Output.IS_CHANGED(output=object(), extra_pnginfo=changed))
        for invalid in (None, self.plugin, {'ps_team': None}, dict(self.meta, **self.plugin)):
            self.assertTrue(math.isnan(Output.IS_CHANGED(output=object(), extra_pnginfo=invalid)))
        with patch.dict(os.environ, {'PS_TEAM_REQUIRED': '0'}):
            before = Output.IS_CHANGED(extra_pnginfo=self.plugin)
            changed = copy.deepcopy(self.plugin); changed['ps_plugin']['request_id'] = 'c' * 32
            self.assertNotEqual(before, Output.IS_CHANGED(extra_pnginfo=changed))
            self.assertTrue(math.isnan(Output.IS_CHANGED(extra_pnginfo={'ps_plugin': None})))

    def test_strict_output_rejects_downgrade_before_writing_or_notifying(self):
        node = Output(); node.connect_to_backend = AsyncMock()
        with patch.object(node, 'save_images') as save:
            for meta in (None, self.plugin, dict(self.meta, **self.plugin)):
                with self.subTest(meta=meta), self.assertRaises(ValueError):
                    asyncio.run(node.execute(object(), extra_pnginfo=meta))
            save.assert_not_called()
        node.connect_to_backend.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
