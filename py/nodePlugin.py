from nodes import SaveImage
from server import PromptServer
import hashlib
import asyncio
import json
import base64
import os
import re
from pathlib import Path
import time
import torch
import numpy as np
from PIL import Image, ImageOps
from io import BytesIO
import folder_paths
import aiohttp



nodepath = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _snapshot_config(config):
    if not isinstance(config, dict) or any(not isinstance(config.get(k), str) for k in ("positive", "negative")):
        raise ValueError("Invalid snapshot prompts")
    seed = config.get("seed")
    if (isinstance(seed, bool) or not isinstance(seed, (str, int))
            or not re.fullmatch(r"[0-9]{1,20}", str(seed)) or int(seed) >= 2 ** 64):
        raise ValueError("Invalid snapshot seed")
    slider = config.get("slider")
    if isinstance(slider, bool) or not isinstance(slider, (float, int)) or not 0 <= slider <= 100:
        raise ValueError("Invalid snapshot slider")
    return dict(config)


def team_snapshot(extra_pnginfo):
    """Resolve either protocol without permitting a company-worker downgrade.

    ps_team files/config belong to the authenticated server-owned input root;
    ps_plugin files/config are client uploads and only work outside strict mode.
    The historical function name is kept for callers of both protocols.
    """
    if extra_pnginfo is not None and not isinstance(extra_pnginfo, dict):
        raise ValueError("Invalid Photoshop metadata")
    metadata = extra_pnginfo or {}
    has_team, has_plugin = "ps_team" in metadata, "ps_plugin" in metadata
    if has_team and has_plugin:
        raise ValueError("Ambiguous Photoshop snapshot protocols")
    if os.environ.get("PS_TEAM_REQUIRED", "").strip().lower() in ("1", "true", "yes") and not has_team:
        raise ValueError("Photoshop team snapshot metadata is required on this render worker")
    if not has_team and not has_plugin:
        return None

    protocol = "ps_team" if has_team else "ps_plugin"
    meta = metadata[protocol]
    version = "ps-team-1" if has_team else "ps-plugin-1"
    if not isinstance(meta, dict) or meta.get("version") != version:
        raise ValueError("Invalid Photoshop snapshot metadata")
    snapshot_id = meta.get("snapshot_id")
    if not isinstance(snapshot_id, str) or not re.fullmatch(r"[a-f0-9]{32}", snapshot_id):
        raise ValueError("Invalid Photoshop snapshot ID")

    config_path = None
    if has_team:
        root = os.environ.get("PS_TEAM_INPUT_ROOT")
        if not root:
            raise ValueError("PS_TEAM_INPUT_ROOT is required on this render worker")
        root = Path(root).resolve()
        directory = root / snapshot_id
        # Never follow a symlink into another request or outside the trusted root.
        if directory.is_symlink() or directory.resolve().parent != root:
            raise ValueError("Photoshop team snapshot path is unsafe")
        for name in ("PS_canvas.png", "PS_mask.png", "config.json"):
            item = directory / name
            if item.is_symlink() or item.resolve().parent != directory or not item.is_file():
                raise ValueError("Photoshop team snapshot is incomplete or unsafe")
        canvas, mask = directory / "PS_canvas.png", directory / "PS_mask.png"
        config_path = directory / "config.json"
        try:
            with config_path.open("r", encoding="utf-8") as file:
                config = _snapshot_config(json.load(file))
        except (OSError, UnicodeError, ValueError, TypeError) as error:
            raise ValueError("Invalid Photoshop team snapshot config") from error
    else:
        request_id = meta.get("request_id")
        if not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{32}", request_id):
            raise ValueError("Invalid Photoshop request ID")
        root = Path(folder_paths.get_input_directory()).resolve()
        subfolder = "ps_plugin/" + snapshot_id
        directory = root / "ps_plugin" / snapshot_id
        if directory.resolve() != directory:
            raise ValueError("Snapshot directory may not be a symlink")

        def uploaded_file(key):
            item = meta.get(key)
            if not isinstance(item, dict) or item.get("type") != "input" or item.get("subfolder") != subfolder:
                raise ValueError("Snapshot images must share their own input directory")
            name = item.get("name")
            if (not isinstance(name, str) or not name or name in (".", "..")
                    or re.search(r'[\\/<>:"|?*\x00-\x1f\x7f]', name) or name.endswith((".", " "))
                    or re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", name.split(".", 1)[0])):
                raise ValueError("Invalid snapshot image filename")
            path = directory / name
            if path.resolve() != path or not path.is_file():
                raise ValueError("Snapshot image is missing or escapes its directory")
            return path

        canvas, mask = uploaded_file("canvas"), uploaded_file("mask")
        if canvas == mask:
            raise ValueError("Canvas and mask must be separate files")
        config = _snapshot_config(meta.get("config"))

    try:
        cache = hashlib.sha256(json.dumps(meta, sort_keys=True, allow_nan=False).encode()).hexdigest()
    except (TypeError, ValueError) as error:
        raise ValueError("Invalid Photoshop snapshot metadata") from error
    return {"protocol": protocol, "id": snapshot_id, "canvas": canvas, "mask": mask,
            "config": config, "config_path": config_path, "cache": cache}


def is_changed_file(filepath):
    try:
        with open(filepath, "rb") as f:
            file_hash = hashlib.md5(f.read()).hexdigest()
        if not hasattr(is_changed_file, "file_hashes"):
            is_changed_file.file_hashes = {}
        if filepath in is_changed_file.file_hashes:
            if is_changed_file.file_hashes[filepath] == file_hash:
                return False
        is_changed_file.file_hashes[filepath] = file_hash
        return float("NaN")
    except Exception as e:
        print(f"Error in is_changed_file for {filepath}: {e}")
        return False


class PhotoshopToComfyUI:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "hidden": {"extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("IMAGE", "MASK", "FLOAT", "INT", "STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("Canvas", "Mask", "Slider", "Seed", "+", "-", "W", "H")
    FUNCTION = "PS_Execute"
    CATEGORY = "Photoshop"

    def PS_Execute(self, extra_pnginfo=None):
        snapshot = team_snapshot(extra_pnginfo)
        self.team_mode = snapshot is not None
        if snapshot:
            self.canvasDir = str(snapshot["canvas"])
            self.maskImgDir = str(snapshot["mask"])
            self.snapshot_config = snapshot["config"]
        else:
            self.LoadDir()
        self.loadConfig()
        self.SendImg()

        sliderValue = self.slider / 100

        return (
            self.canvas,
            self.mask.unsqueeze(0),
            sliderValue,
            int(self.seed),
            self.psPrompt,
            self.ngPrompt,
            int(self.width),
            int(self.height),
        )

    def LoadDir(self, retry_count=0):
        try:
            self.canvasDir = os.path.join(
                nodepath, "data", "ps_inputs", "PS_canvas.png"
            )
            self.maskImgDir = os.path.join(nodepath, "data", "ps_inputs", "PS_mask.png")
            self.configJson = os.path.join(nodepath, "data", "ps_inputs", "config.json")
        except:
            time.sleep(0.5)
            if retry_count < 4:
                self.LoadDir(retry_count + 1)
            else:
                raise Exception(
                    "Failed to load directory after 5 attempts. \n 🔴 Make sure you have installed and started the Photoshop Plugin Successfully. \n 🔴 otherwise you can restart your Photoshop and your plugin to fix this problem."
                )

    def loadConfig(self, retry_count=0):
        if getattr(self, "team_mode", False):
            self.ConfigData = self.snapshot_config
        else:
            try:
                with open(self.configJson, "r", encoding="utf-8") as file:
                    self.ConfigData = json.load(file)
            except:
                time.sleep(0.5)
                if retry_count < 4:
                    self.loadConfig(retry_count + 1)
                else:
                    raise Exception(
                        "Failed to load config after 5 attempts. \n 🔴 Make sure you have installed and started the Photoshop Plugin Successfully. \n 🔴 otherwise you can restart your Photoshop and your plugin to fix this problem."
                    )

        self.psPrompt = self.ConfigData["positive"]
        self.ngPrompt = self.ConfigData["negative"]
        self.seed = self.ConfigData["seed"]
        self.slider = self.ConfigData["slider"]

    def SendImg(self):
        self.loadImg(self.canvasDir)
        self.i = ImageOps.exif_transpose(self.i)
        self.canvas = self.i.convert("RGB")
        self.canvas = np.array(self.canvas).astype(np.float32) / 255.0
        self.canvas = torch.from_numpy(self.canvas)[None,]
        self.width, self.height = self.i.size

        self.loadImg(self.maskImgDir)
        self.i = ImageOps.exif_transpose(self.i).convert("RGB")
        if self.team_mode and self.i.size != (self.width, self.height):
            raise ValueError("Canvas and mask dimensions differ")
        self.mask = np.array(self.i.getchannel("B")).astype(np.float32) / 255.0
        self.mask = torch.from_numpy(self.mask)

        # Convert #010101 to #000000
        self.mask = self.mask.numpy()  # Convert to numpy array for easier manipulation
        target_color = 1 / 255.0  # The float representation of #010101
        self.mask[self.mask == target_color] = 0.0  # Change target_color to 0.0
        self.mask = torch.from_numpy(self.mask)

    def loadImg(self, path):
        try:
            with open(path, "rb") as file:
                img_data = file.read()
            self.i = Image.open(BytesIO(img_data))
            self.i.verify()
            self.i = Image.open(BytesIO(img_data))
            self.i.load()
        except Exception as error:
            if getattr(self, "team_mode", False):
                raise ValueError("Photoshop snapshot image is unreadable") from error
            self.i = Image.new(mode="RGB", size=(24, 24), color=(0, 0, 0))
        if not self.i:
            return

    @classmethod
    def IS_CHANGED(cls, extra_pnginfo=None):
        # Some ComfyUI versions omit extra_data when evaluating IS_CHANGED.
        # Missing hidden metadata cannot distinguish a snapshot from legacy mode;
        # force execution so the actual request is validated and read afresh.
        if extra_pnginfo is None:
            return float("NaN")
        try:
            snapshot = team_snapshot(extra_pnginfo)
            if snapshot:
                digest = hashlib.sha256(snapshot["cache"].encode())
                for key in ("canvas", "mask", "config_path"):
                    path = snapshot[key]
                    if path is None:
                        continue
                    file_digest = hashlib.sha256()
                    with path.open("rb") as file:
                        for block in iter(lambda: file.read(1024 * 1024), b""):
                            file_digest.update(block)
                    # Separate files by role and digest, avoiding concatenation collisions.
                    digest.update(key.encode() + b"\0" + file_digest.digest())
                return snapshot["protocol"] + ":" + snapshot["id"] + ":" + digest.hexdigest()
        except Exception:
            # ComfyUI may treat an IS_CHANGED exception as cache-compatible. Force
            # execution so invalid metadata fails instead of reusing another job.
            return float("NaN")
        try:
            configJson = os.path.join(nodepath, "data", "ps_inputs", "config.json")
            canvasDir = os.path.join(nodepath, "data", "ps_inputs", "PS_canvas.png")
            maskImgDir = os.path.join(nodepath, "data", "ps_inputs", "PS_mask.png")

            config_changed = is_changed_file(configJson)
            canvas_changed = is_changed_file(canvasDir)
            mask_changed = is_changed_file(maskImgDir)

            return config_changed or canvas_changed or mask_changed
        except Exception as e:
            print("Error in IS_CHANGED:", e)
            return 0


class ComfyUIToPhotoshop(SaveImage):
    def __init__(self):
        self.output_dir = folder_paths.get_temp_directory()
        self.type = "temp"
        self.prefix_append = "_temp_"
        self.compress_level = 4

    @staticmethod
    def INPUT_TYPES():
        return {
            "required": {
                "output": ("IMAGE",),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "execute"
    CATEGORY = "Photoshop"

    @classmethod
    def IS_CHANGED(cls, output=None, filename_prefix="PS_OUTPUTS", prompt=None, extra_pnginfo=None):
        # Hidden metadata is not part of ComfyUI's ordinary input cache signature.
        # Even a constant-image branch must rerun for a new/invalid snapshot.
        return PhotoshopToComfyUI.IS_CHANGED(extra_pnginfo=extra_pnginfo)

    async def connect_to_backend(self, filename):
        try:
            port = getattr(getattr(PromptServer, "instance", None), "port", None) or os.environ.get("COMFYUI_PORT", "8188")
            url = f"http://127.0.0.1:{port}/ps/renderdone?filename={filename}"
            async with aiohttp.ClientSession() as session:
                async with session.get(url) as response:
                    return await response.text()
        except Exception as e:
            print(f"_PS_ error on send2Ps: {e}")

    async def execute(
        self,
        output: torch.Tensor,
        filename_prefix="PS_OUTPUTS",
        prompt=None,
        extra_pnginfo=None,
    ):
        snapshot = team_snapshot(extra_pnginfo)
        if snapshot:
            self.output_dir = folder_paths.get_output_directory()
            self.type = "output"
            filename_prefix = snapshot["protocol"] + "/" + snapshot["id"] + "/PS_OUTPUTS"
        else:
            self.output_dir = folder_paths.get_temp_directory()
            self.type = "temp"
        x = self.save_images(output, filename_prefix, prompt, extra_pnginfo)
        if not snapshot:
            await self.connect_to_backend(x["ui"]["images"][0]["filename"])
        return {"ui": x["ui"], "result": (output,)}



class ClipPass:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"clip": ("CLIP",)}}

    RETURN_TYPES = ("CLIP",)
    RETURN_NAMES = ("clip",)
    FUNCTION = "exe"
    CATEGORY = "utils"

    def exe(self, clip):
        return (clip,)


class modelPass:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "exe"
    CATEGORY = "utils"

    def exe(self, model):
        return (model,)


NODE_CLASS_MAPPINGS = {
    "🔹Photoshop ComfyUI Plugin": PhotoshopToComfyUI,
    "🔹SendTo Photoshop Plugin": ComfyUIToPhotoshop,
    "🔹ClipPass": ClipPass,
    "🔹modelPass": modelPass,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PhotoshopToComfyUI": "🔹Photoshop ComfyUI Plugin",
    "SendToPhotoshop": "🔹Send To Photoshop",
    "ClipPass": "🔹ClipPass",
    "modelPass": "🔹modelPass",
}
