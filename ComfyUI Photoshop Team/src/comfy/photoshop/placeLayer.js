import { batchPlay, ps } from "./batchPlay.js";

export async function placeLayer(imagePath) {
  if (!ps) return;
  await batchPlay([
    {
      _obj: "place",
      null: { _path: imagePath, _kind: "local" },
      freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
      offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
    },
  ]);
}
