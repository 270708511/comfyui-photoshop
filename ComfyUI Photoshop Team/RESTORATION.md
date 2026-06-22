# ComfyUI Photoshop Team

This directory is a restoration workspace for the packaged ComfyUI Photoshop plugin v1.9.3.

## Runtime package

`dist/` is the UXP Developer Tools load target. It uses the original verified runtime
assets so the panel layout, panel IDs, WebView behavior, WebSocket protocol and Photoshop
actions remain compatible with the original plugin.

The plugin manifest ID is changed from `3e6d64e0` to `comfyui.photoshop.team` so it can be loaded
alongside the original plugin without replacing it. The original entrypoint IDs are deliberately
renamed to the `comfyui.photoshop.team.*` namespace and the runtime panel references are updated
to match.

## Reverse-engineering reference

`reference/original-v1.9.3.pretty.js` is a formatted, behavior-equivalent view of the original
bundle. It is an inspection reference, not the executable file. Key recovered areas include:

- `WebSocket /ps/ws` transport and message dispatch
- render queue payload generation (`canvasBase64`, `maskBase64`, `configdata`, `queue`)
- Photoshop canvas and mask exports
- render result persistence and layer placement
- original panel composition, state persistence and language resources

## Test procedure

1. In Adobe UXP Developer Tools, Add Plugin and select `dist/manifest.json`.
2. Load the plugin, then open `Ai Panel`, `Settings`, and `ComfyUI Web`.
3. Use `http://127.0.0.1:8188` for the local ComfyUI instance, then apply and reconnect.

Do not run the old Vite/Svelte source as the test target: it is an earlier incomplete rewrite.
It remains in the parent directory only as historical work and is not used by `dist/`.
