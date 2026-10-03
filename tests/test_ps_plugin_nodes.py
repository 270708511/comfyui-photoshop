"""Original-path node behavior using real Torch/PIL; all image fixtures are temporary."""
import asyncio
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


class SaveImage:
    def save_images(self, images, filename_prefix, prompt, extra_pnginfo):
        directory = Path(self.output_dir) / Path(filename_prefix).parent
        directory.mkdir(parents=True, exist_ok=True)
        files = []
        for i, tensor in enumerate(images):
            name = Path(filename_prefix).name + f'_{i}.png'
            Image.fromarray((tensor.numpy() * 255).astype('uint8')).save(directory / name)
            files.append(dict(filename=name, subfolder=str(Path(filename_prefix).parent), type=self.type))
        return {'ui': {'images': files}}


class Nodes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='ps-plugin-nodes-')
        cls.base = Path(cls.tmp.name).resolve()
        folder = types.ModuleType('folder_paths')
        for kind in ['input', 'output', 'temp']:
            (cls.base / kind).mkdir()
            setattr(folder, f'get_{kind}_directory', lambda kind=kind: str(cls.base / kind))
        modules = {'nodes': types.SimpleNamespace(SaveImage=SaveImage),
                   'server': types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=None)),
                   'folder_paths': folder}
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location('ps_test_original_node', ROOT / 'py/nodePlugin.py')
            cls.mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.mod)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def snapshot(self, sid='a' * 32, color=(255, 0, 0), size=(4, 3)):
        subfolder = 'ps_plugin/' + sid
        directory = self.base / 'input' / subfolder
        directory.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', size, color).save(directory / 'canvas (renamed).png')
        Image.new('RGB', size, (255, 255, 255)).save(directory / 'mask (renamed).png')
        return {'ps_plugin': dict(version='ps-plugin-1', snapshot_id=sid, request_id='b' * 32,
            canvas=dict(name='canvas (renamed).png', subfolder=subfolder, type='input'),
            mask=dict(name='mask (renamed).png', subfolder=subfolder, type='input'),
            config=dict(positive='red', negative='', seed='123', slider=25))}

    def test_real_renamed_images_and_config(self):
        result = self.mod.PhotoshopToComfyUI().PS_Execute(self.snapshot())
        self.assertIsInstance(result[0], torch.Tensor)
        self.assertEqual(tuple(result[0].shape), (1, 3, 4, 3))
        self.assertEqual(tuple(result[1].shape), (1, 3, 4))
        self.assertEqual(result[2:], (0.25, 123, 'red', '', 4, 3))
        self.assertTrue(torch.all(result[0][..., 0] == 1))
        self.assertTrue(torch.all(result[1] == 1))

    def test_path_constraints(self):
        original = self.snapshot()
        cases = [('name', '../canvas.png'), ('name', '/canvas.png'), ('name', 'C:\\canvas.png'),
                 ('name', '..'), ('name', 'x.'), ('name', 'x '), ('name', 'a/b.png'),
                 ('type', 'output'), ('subfolder', 'ps_plugin/' + 'c' * 32)]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                meta = copy.deepcopy(original); meta['ps_plugin']['canvas'][key] = value
                with self.assertRaises(ValueError): self.mod.team_snapshot(meta)
        meta = copy.deepcopy(original); meta['ps_plugin']['mask'] = meta['ps_plugin']['canvas']
        with self.assertRaises(ValueError): self.mod.team_snapshot(meta)

    def test_symlink_image_and_directory_rejected(self):
        meta = self.snapshot('d' * 32)
        directory = self.base / 'input' / meta['ps_plugin']['canvas']['subfolder']
        (directory / 'linked.png').symlink_to(directory / 'canvas (renamed).png')
        meta['ps_plugin']['canvas']['name'] = 'linked.png'
        with self.assertRaises(ValueError): self.mod.team_snapshot(meta)
        linked = self.base / 'input/ps_plugin' / ('e' * 32)
        linked.symlink_to(directory, target_is_directory=True)
        meta['ps_plugin']['snapshot_id'] = 'e' * 32
        for key in ['canvas', 'mask']: meta['ps_plugin'][key]['subfolder'] = 'ps_plugin/' + 'e' * 32
        with self.assertRaises(ValueError): self.mod.team_snapshot(meta)

    def test_mismatched_dimensions_and_corrupt_image(self):
        meta = self.snapshot('f' * 32)
        mask = self.base / 'input' / meta['ps_plugin']['mask']['subfolder'] / meta['ps_plugin']['mask']['name']
        Image.new('RGB', (2, 2)).save(mask)
        with self.assertRaisesRegex(ValueError, 'dimensions'): self.mod.PhotoshopToComfyUI().PS_Execute(meta)
        mask.write_bytes(b'invalid image')
        with self.assertRaisesRegex(ValueError, 'unreadable'): self.mod.PhotoshopToComfyUI().PS_Execute(meta)

    def test_parallel_snapshots_have_independent_pixels_and_prompts(self):
        a, b = self.snapshot('1' * 32), self.snapshot('2' * 32, (0, 255, 0))
        b['ps_plugin']['config'].update(positive='green', seed='456')
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda m: self.mod.PhotoshopToComfyUI().PS_Execute(m), [a, b]))
        self.assertEqual(results[0][4], 'red'); self.assertEqual(results[1][4], 'green')
        self.assertTrue(torch.all(results[0][0][..., 0] == 1))
        self.assertTrue(torch.all(results[1][0][..., 0] == 0))
        self.assertEqual(results[1][3], 456)

    def test_cache_and_config_validation(self):
        meta = self.snapshot()
        first = self.mod.PhotoshopToComfyUI.IS_CHANGED(meta)
        self.assertEqual(first, self.mod.PhotoshopToComfyUI.IS_CHANGED(meta))
        meta['ps_plugin']['config']['positive'] = 'blue'
        self.assertNotEqual(first, self.mod.PhotoshopToComfyUI.IS_CHANGED(meta))
        for key, values in [('seed', [-1, True, 'x', str(2**64)]), ('slider', [-1, 101, True, float('nan')]), ('positive', [None, 2])]:
            for value in values:
                with self.subTest(key=key, value=value):
                    bad = copy.deepcopy(meta); bad['ps_plugin']['config'][key] = value
                    with self.assertRaises(ValueError): self.mod.team_snapshot(bad)

    def test_metadata_identifiers_and_obsolete_protocol(self):
        for key in ['snapshot_id', 'request_id', 'version']:
            bad = self.snapshot(); bad['ps_plugin'][key] = 'bad'
            with self.assertRaises(ValueError): self.mod.team_snapshot(bad)
        with self.assertRaises(ValueError): self.mod.team_snapshot({'ps_team': {}})

    def test_local_legacy_image_and_mask_compatibility(self):
        legacy = self.base / 'legacy'; inputs = legacy / 'data/ps_inputs'; inputs.mkdir(parents=True)
        Image.new('RGB', (4, 3), (0, 0, 255)).save(inputs / 'PS_canvas.png')
        Image.new('RGB', (4, 3), (1, 1, 1)).save(inputs / 'PS_mask.png')
        (inputs / 'config.json').write_text(json.dumps(dict(positive='legacy', negative='', seed=7, slider=50)))
        with patch.object(self.mod, 'nodepath', str(legacy)):
            result = self.mod.PhotoshopToComfyUI().PS_Execute()
            self.assertEqual(result[2:], (0.5, 7, 'legacy', '', 4, 3))
            self.assertTrue(torch.all(result[1] == 0))
            self.assertTrue(torch.all(result[0][..., 2] == 1))
            self.mod.PhotoshopToComfyUI.IS_CHANGED()

    def test_async_output_keeps_image_ui_and_switches_back_to_legacy(self):
        node = self.mod.ComfyUIToPhotoshop(); node.connect_to_backend = AsyncMock()
        tensor = torch.ones((2, 3, 4, 3))
        result = asyncio.run(node.execute(tensor, extra_pnginfo=self.snapshot()))
        self.assertIs(result['result'][0], tensor)
        self.assertEqual(len(result['ui']['images']), 2)
        for file in result['ui']['images']:
            self.assertEqual(file['type'], 'output'); self.assertEqual(file['subfolder'], 'ps_plugin/' + 'a' * 32)
            self.assertTrue((self.base / 'output' / file['subfolder'] / file['filename']).is_file())
        node.connect_to_backend.assert_not_awaited()
        legacy = asyncio.run(node.execute(tensor))
        self.assertIs(legacy['result'][0], tensor)
        self.assertEqual(legacy['ui']['images'][0]['type'], 'temp')
        node.connect_to_backend.assert_awaited_once()


if __name__ == '__main__':
    unittest.main(verbosity=2)
