import { batchPlay, ps } from "./batchPlay.js";
import { downScaleIfBigger, upScaleIfSmaller, fixMaskEdge, forceResize, cropToSelection, cropPadding } from "../stores.js";

export async function exportCanvas() {
  if (!ps) return null;
  const doc = ps.app.activeDocument;
  if (!doc) return null;

  const tmp = await require("uxp").storage.localFileSystem.createFile("temp.png", { overwrite: true });
  const token = await require("uxp").storage.localFileSystem.createSessionToken(tmp);

  await batchPlay([
    {
      _obj: "save",
      as: {
        _obj: "PNGFormat",
        method: { _enum: "PNGMethod", _value: "quick" },
      },
      in: { _path: token, _kind: "local" },
      copy: true,
      lowerCase: true,
    },
  ]);

  const data = await tmp.read({ format: require("uxp").storage.formats.binary });
  await tmp.delete();
  return data;
}

export async function exportMask() {
  if (!ps) return null;
  // ... mask export logic
  return null;
}
