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

## Team delivery changes and local checks

The runtime remains `dist/`; do not build the historical Svelte source. The original
bundle's visual layout is preserved. Its narrow integration hooks now load/save a
request journal and honor a recovery action that intentionally skips another layer
insertion. The separate `dist/ps-team-bridge.js` and frontend `../js/team.js` implement
the team protocol.

Run from the repository root:

```sh
node --test tests/*.cjs
python -m unittest discover -s tests -p 'test_*.py'
node --check 'ComfyUI Photoshop Team/dist/ps-team-bridge.js'
node --check 'ComfyUI Photoshop Team/dist/assets/index-B_-tWO9a.js'
git -c core.whitespace=cr-at-eol diff --check
```

The component tests exercise interrupted/lost ACKs, duplicate results/clicks,
browser rebinding during upload, old-session failures, A→B→A login recovery,
preview reservation during insertion, journal failures, document changes, mask
shape changes, and reachable recovery-dialog choices. They use mocked UXP hooks;
they do **not** establish real Photoshop UI or image-placement correctness.

### Worker configuration

Set both `PS_TEAM_INPUT_ROOT` (the absolute scheduler-managed immutable snapshot
root) and `PS_TEAM_REQUIRED=1` on **the frontend ComfyUI runtime and every render
worker** used for company team service. A missing/invalid team snapshot then fails
execution instead of falling back to legacy shared input files. Keep workers on a
private network behind the authenticated scheduler; the environment flag is not
an authentication boundary. Legacy local-only installations can leave
`PS_TEAM_REQUIRED` unset. Valid cache keys include request ID and input-content
hash; invalid metadata returns a NaN change marker before execution rejects it.

### Delivery and recovery behavior

- A soft `received` message only suppresses redundant byte transfers. The frontend
  POSTs `results/{index}/ack` only after confirmed insertion or the user's explicit
  “Already inserted” recovery choice. Status `acknowledged_results` is authoritative
  when reconnecting. Interrupted ACKs retry without resubmitting generation.
- The UXP data folder stores two alternating `ps-team-journal-*.json` files. They
  retain per-origin/per-session job identity, document association, original mask,
  bounds, inserted indexes, and insertion-intent markers. Output pixels stay on
  the server until ACK. A→B→A account changes do not overwrite the other session's
  journal; the authenticated server verifies ownership before any resume.
- Reopening the Web panel resumes requests. After a panel/app restart, click the
  existing Insert action with the original Photoshop document selected. A dialog
  explicitly asks whether that is the original document, because Photoshop's
  numeric document IDs can be reused after restart. Cancel leaves the job intact.
- An interrupted insertion is not retried automatically. The same Insert action
  opens a review dialog: Cancel to inspect layers, “Already inserted” to ACK the
  existing layer, or “Retry after review” after removing a partial layer. Repeated
  clicks cannot stack dialogs. Closing a dialog acts as Cancel.
- Immediately before insertion, the current document's exported mask and bounds
  must exactly match the original capture. This protects nonrectangular selection
  shape too; merely updating the plugin's bounds variable is insufficient. Restore
  the original selection/mask before retrying a mismatch. Older journals without
  the original mask fail closed and require a fresh capture.
- A filesystem/host crash cannot provide a transaction spanning Photoshop layers
  and journal writes. Insertion intent is saved before layer mutation; uncertain
  work requires the explicit review flow above. This is conservative recovery,
  not a guarantee of automatic exactly-once insertion across arbitrary host crashes.

### Required real-host acceptance checks (not run by the Node suite)

Use Adobe UXP Developer Tools and the unchanged runtime manifest. Verify native
recovery dialogs (including Escape/titlebar cancellation), original document
activation, panel/app restart with unsaved and saved documents, and that mask
re-export is deterministic on the supported Photoshop build. Test freehand and
feathered selections, full-canvas/no selection, changed selection with the same
bounding box, multiple result images, selection restoration after insertion, a
closed original document, and interrupted/partial layer insertion. Confirm that
no output is inserted into a similarly numbered unrelated document after restart.

The dialog implementation follows Adobe's documented `uxpShowModal`/`close` API:
https://developer.adobe.com/uxp/guides/how-to/add-modal-dialogs/

### Company and standalone deployment modes

The uploaded standalone `ps_plugin` capability is preserved alongside the company
adapter. Remote Photoshop Web panels default to **company** transport. They use
only owner-checked `/ps/team` sessions, immutable snapshots, reconciled submission,
server-retained results and durable per-image ACKs. An unavailable adapter, 404,
401/403, malformed reply, or 5xx never switches the transport automatically.

For a deliberately separate installation **without the company adapter**, set the
Photoshop server URL (and therefore its Web panel URL) to, for example,
`https://standalone.example/?ps_transport=standalone`, then apply and reconnect.
Standalone mode first performs two read-only probes: `/ps/team/capabilities` and
`/ps/team/sessions`. Both must return 404. Any other result or network failure
blocks the binding; the second probe detects older company adapters whose
POST-only session collection returns 405 even without a capabilities route.
These absence checks are conservative compatibility checks, not authentication
boundaries. Do not route/filter them to make a company deployment appear absent.
Company servers also reject `ps_plugin` on ordinary prompt submission, and
`PS_TEAM_REQUIRED=1` workers reject standalone metadata.

Standalone retains upstream standard multipart `/upload/image`, `/prompt`,
`/history/{prompt_id}`, optional scheduler `/jobs/{prompt_id}`, and `/view` delivery.
It still requires a same-origin authenticated `/auth/whoami` response with
`authenticated: true` and `username`. Upload-returned names are authoritative;
canvas and mask must both succeed before submission. Only matching SendTo output
paths are retrieved, with Windows path separators normalized and absolute,
traversal, UNC, or other-snapshot paths rejected. Loopback UXP hosts retain the
legacy socket/preview behavior, and ordinary browser visits do not bind the UXP
bridge. Remote unbinding clears node preview pixels, including late image loads.

Both transports use the durable Photoshop insertion journal, strict
panel/origin/session/transport messages, soft `received` receipts, and confirmed
post-insertion `ack`/`acknowledged` exchanges. Their journal connection identities
are separate, so changing transport cannot reinterpret another mode's jobs.
Standalone mappings are stored per account and session in WebView sessionStorage;
logout retains the old account's mapping for A→B→A recovery without exposing its
results to B. ACK confirmation occurs only after the mapping write succeeds.

Standalone does **not** provide company-grade server ownership or durable
submission reconciliation. A lost `/prompt` response stays unknown and never
reposts automatically. If WebView storage is cleared/recreated while the
Photoshop journal retains pending work for that account, reconnect fails visibly
with the journal intact; restore the original WebView storage or manually inspect
server history before operator recovery. It does not silently create a new ready
session. Standalone cancellation is not sent through a shared/global queue API;
use the server's task history. Do not use standalone as a substitute for the
owner-isolated company deployment in a shared service.

The merged Node suite includes actual frontend↔UXP protocol integration in two
VM realms. HTTP responses and Adobe/browser hosting are simulated; no GPU is
needed. It covers both delivery modes, lost ACK recovery, uncertainty review,
forged identities, and fail-closed transport selection. Real-host acceptance
checks above remain required.

## Web panel connection diagnostics (2026-10-03)

The supported Photoshop minimum is 24.1, which introduced panel WebViews
(UXP 6.4). The UXP bridge must not assume the browser's `URL` constructor or
`URLSearchParams` exists. Address parsing is deliberately strict, preserves
explicit `?ps_transport=standalone`, and never follows a different origin as a
trusted Photoshop connection automatically.

When the Web panel is blank:

1. Check the full Photoshop version and operating system. Unload/load the
   plugin after a manifest update; a JavaScript-only reload is insufficient.
2. Apply the complete server URL in Settings. The status now distinguishes
   navigation/loading, a native WebView load error (its code is not an HTTP
   status), an unexpected redirect origin, and a loaded page awaiting the team
   bridge. Invalid addresses are rejected before navigation.
3. In UXP Developer Tool, use the plugin's Debug action and capture the first
   red exception and `[PS Team WebView]` diagnostic after Apply/Connect.
   Navigation diagnostics omit full URLs/querystrings and redact common
   credential fields; still check screenshots before sharing them.
4. A working ordinary browser does not establish the WebView's authenticated
   session. Sign in inside the Web panel. Company mode needs both the reviewed
   server `/ps/team/` adapter/nginx routes and the matching ComfyUI custom-node
   browser extension. Do not switch to standalone to bypass a company login or
   missing company adapter.

The parser, lifecycle and error-display regressions run in a simulated UXP
host with no `URL` global. They do not constitute a real Photoshop, WebView2,
macOS, Windows or production-server acceptance test. A user's blank panel
cannot be assigned a final root cause without the host/load diagnostics.

Official references:
- https://developer.adobe.com/photoshop/uxp/ps_reference/changelog/
- https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/global-members/html-elements/html-web-view-element
- https://developer.adobe.com/uxp/guides/how-to/debugging/
