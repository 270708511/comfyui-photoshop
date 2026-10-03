# Native workflow review build

This is a local review implementation, based on plugin `061445599793ababb32e8ff68259ca56b5921450` and company server `7b7df4cccdc50d3cef28cf54bbca6c85245242cc`. It includes the unpublished non-clickable status/ATS diagnostic repair. No repository push or company deployment has been performed.

## What changes

The restored UXP runtime now has native account login, ComfyUI workspace selection, saved workflow listing, typed prepared-workflow parameters and generation. The company path uses native HTTP and the existing signed-cookie login; it never stores passwords or invents a token system. WebView is an optional editor only. Existing canvas/mask export, preview, original-document insertion and durable insertion ACK remain in use.

Company account and workspace ID remain separate. The existing full workspace list is retained; there is no new workspace ACL. Requests and results still belong to the authenticated company account. Switching workspace does not reassign running jobs. Editing an address does not change an already-applied connection; Apply/Reconnect performs a guarded transition.

Python production files `py/nodePlugin.py`, `py/Backend.py`, `py/nodeRemoteConnection.py` and `__init__.py` are unchanged. Their snapshot, image, mask, cache and batch-output behavior has additional regression coverage. Company server changes are in `ps_team_api.py`, not only deployment scripts.

## Install only in an approved test environment

1. Preserve the old plugin folder and server state. Review/apply the paired server patch against `7b7df4c`; keep its frontend 1.53.6 patch and validation. Existing nginx `/ps/team/` routing covers the new endpoints; no access/security setting needs widening.
2. Add `js/native-workflow-preparation.js` to the existing ComfyUI Photoshop custom-node package. Keep its Python files and other JS. ComfyUI automatically loads this new browser extension from `WEB_DIRECTORY`.
3. In UXP Developer Tool, load the supplied `PhotoshopTeam/manifest.json`. Do not rebuild from the incomplete Svelte source. Set the company address in the existing settings, then use native Connect and Login. Passwords are cleared after submission and are never journaled.
4. Choose a workspace and refresh its real saved workflow list. Unprepared, changed or unavailable files remain visible but cannot execute. Native data transport is independent of whether WebView opens.
5. In a normally working ComfyUI browser, open the Photoshop menu command “Prepare saved workflow for Photoshop”. Choose a saved file, explicitly consent to loading it (unsaved graph changes may be replaced), inspect the generated scalar mappings, then save the preparation. Refresh/select it in the native panel.
6. Use native parameter controls and existing Photoshop input controls, then Generate/Execute. Use the existing Insert action for each returned image. Cancellation addresses an exact request. Optional editor mode changes do not modify an already-prepared graph: prepare a separate saved variant instead.

## Supported preparation scope

This first implementation is deliberately bounded. It loads the exact saved UI JSON and uses the installed frontend's official graphToPrompt; it does not attempt a generic Python/UXP UI-graph converter. Ordinary scalar mappings and fixed, explicitly mapped built-in seed inputs are supported. Unknown queue callbacks, dynamic seed controls and nested graphs/subgraphs are rejected with a reason. Linked seed values remain graph links. Native scalar integer parameters must be JavaScript-safe integers; the existing Photoshop config seed remains a decimal string.

Preparations bind workspace, saved path, source hash, mapping, relevant node schemas and reported runtime versions. An edit makes the preparation stale. Schema/version fingerprints cannot prove unchanged custom-node implementation code or external frontend patch identity; re-prepare/retest when those change. Shared-workspace preparations follow the existing shared visibility rules; they are not authentication credentials.

## Recovery and validation boundaries

The UXP data folder stores two-slot bridge and native request journals, including image/mask material needed for safe recovery, but no passwords/cookies. Preserve these files if recovery fails. A request with an uncertain submit outcome is reconciled under its existing ID, never silently regenerated. Result receipt is not ACK; ACK follows confirmed insertion. After a Photoshop restart, explicitly review/rebind the original document and any interrupted insertion.

A timed-out login/logout may still be completing in the host; further cookie writes are blocked until it settles. There is no certificate/ATS bypass or automatic HTTP-to-HTTPS rewrite. HTTP still exposes credentials and images to transport interception. Use controlled accounts and non-sensitive images for host validation.

Actual Photoshop/macOS HTTP, Cookie persistence, UI rendering and insertion have NOT been validated here. Passing Node mocks or a loopback HTTP test with a Node cookie jar does not establish UXP behavior. Actual full ComfyUI/GPU execution is also not a fresh result of this build. CPU Torch/Pillow node tests are component tests, not a complete ComfyUI deployment.

## Tests

- `node --test tests/*.cjs` for plugin regressions. `test_native_http_contract.cjs` uses the sibling server fixture, Python API dependencies and a loopback-only server with mocked ComfyUI/GPU.
- `python -m unittest discover -s tests -p 'test_*nodes.py'` for Python protocol and real CPU Torch/Pillow component tests.
- Server: `python -m unittest discover -s tests -p 'test_*.py'` and `python -m unittest tests_scheduler_team_dispatch`.
- The external server frontend real-asset tests require genuine 1.53.6 assets via `FRONTEND_TEST_SOURCE`. They are not counted as passing when skipped.

No main/develop merge, public publication, production rollout or destructive state migration is included. Rollback retains the prior plugin and compatible server database; do not delete in-flight journals or treat a rollback to a broken Mac WebView as a successful fallback.
