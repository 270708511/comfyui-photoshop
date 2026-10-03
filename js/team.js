import { app } from '../../../scripts/app.js';

export let teamMode = false;
export const usesTeamBridge = () => !!window.uxpHost && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const selectedTransport = () => new URLSearchParams(location.search || '').get('ps_transport') === 'standalone' ? 'standalone' : 'company';
let standalone = null;
const VERSION = 'ps-team-1';
export const teamPreview = {canvas: null, mask: null};
const plugins = new Set(['comfyui.photoshop.team', '3e6d64e0']);
const headers = {'Content-Type': 'application/json', 'X-PS-Team': VERSION};
const pending = new Map();
const MAX_RESULT_RETRIES = 5;
let binding = null, upload = null, handshake = null, handshakeVersion = 0;
let receiveControl = () => {};
let started = false;
function pendingRequest(owner, values = {}) {
  return {binding: owner, acknowledged: new Set(), buffered: new Set(), ackPending: new Set(),
    ackInFlight: new Map(), resultCount: null, inFlight: false, timer: null, retryAttempts: 0,
    retries: 0, ...values};
}
function forget(rid, item) {
  if (item.timer !== null) clearTimeout(item.timer);
  if (pending.get(rid) === item) pending.delete(rid);
}
function current(rid, item) { return pending.get(rid) === item && item.binding === binding; }
function host(type, data = {}, owner = binding) {
  if (owner && owner === binding && window.uxpHost) {
    window.uxpHost.postMessage({...data, protocol: VERSION, panel: owner.panel,
      session_id: owner.session, transport: 'company', type});
  }
}
function detach(owner) {
  if (binding !== owner) return;
  for (const [rid, item] of pending) forget(rid, item);
  binding = null; upload = null; teamMode = false;
  teamPreview.canvas = teamPreview.mask = null;
  window.dispatchEvent(new CustomEvent('ps-team-input'));
  receiveControl({photoshopConnected: false});
}
async function call(path, method = 'GET', body, owner = binding) {
  const response = await fetch('/ps/team/' + path, {method, headers, credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)});
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { detail = 'Request failed'; }
    if ([401, 403].includes(response.status) && owner && owner === binding) {
      host('unbound', {error: detail}, owner); detach(owner);
    }
    const error = new Error(`${response.status}: ${detail}`); error.status = response.status; throw error;
  }
  return response.json();
}
function route(owner, rid) {
  return `sessions/${encodeURIComponent(owner.session)}/requests/${encodeURIComponent(rid)}`;
}
function validID(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
async function run(message) {
  const initial = binding, rid = message.request_id;
  if (!validID(rid)) throw new Error('Invalid request ID');
  if (pending.has(rid)) { await poll(rid); return; }
  if (upload) { host('error', {request_id: rid, stage: 'upload', error: 'Another upload is in progress'}); return; }
  const token = {}; upload = token;
  let stage = 'upload';
  try {
    host('state', {request_id: rid, state: 'uploading'}, initial);
    await call(route(initial, rid) + '/snapshot', 'PUT', message.payload, initial);
    if (binding !== initial) return;
    teamPreview.canvas = 'data:image/png;base64,' + message.payload.canvasBase64;
    teamPreview.mask = 'data:image/jpeg;base64,' + message.payload.maskBase64;
    window.dispatchEvent(new CustomEvent('ps-team-input'));
    stage = 'submit';
    const graph = await app.graphToPrompt();
    if (binding !== initial) return;
    const payload = {prompt: graph.output, extra_data: {extra_pnginfo: {workflow: graph.workflow}}};
    host('state', {request_id: rid, state: 'submitting'}, initial);
    pending.set(rid, pendingRequest(initial, {payload}));
    try { await call(route(initial, rid) + '/submit', 'POST', payload, initial); }
    catch (error) { if (binding !== initial) return; /* status reconciles a lost submit reply */ }
    await poll(rid);
  } catch (error) {
    host('error', {request_id: rid, stage, error: String(error)}, initial);
  } finally { if (upload === token) upload = null; }
}
async function acknowledge(rid, item, index) {
  if (!current(rid, item) || item.ackInFlight.has(index)) return;
  item.ackPending.add(index);
  const operation = call(route(item.binding, rid) + `/results/${index}/ack`, 'POST', {}, item.binding);
  item.ackInFlight.set(index, operation);
  try {
    await operation;
    if (!current(rid, item)) return;
    item.ackPending.delete(index); item.acknowledged.add(index);
    host('acknowledged', {request_id: rid, index}, item.binding);
    if (item.resultCount !== null && item.acknowledged.size === item.resultCount) forget(rid, item);
  } finally { item.ackInFlight.delete(index); }
}
async function poll(rid) {
  const item = pending.get(rid);
  if (!item || !current(rid, item) || item.inFlight) return;
  if (item.timer !== null) { clearTimeout(item.timer); item.timer = null; }
  item.inFlight = true;
  let retryDelivery = false;
  try {
    const state = await call(route(item.binding, rid), 'GET', undefined, item.binding);
    if (!current(rid, item)) return;
    host('state', state, item.binding);
    if (state.state === 'uploaded') {
      if (item.payload && item.retries++ < 3) {
        await call(route(item.binding, rid) + '/submit', 'POST', item.payload, item.binding);
      } else { forget(rid, item); throw new Error('Input saved but workflow was not submitted'); }
    }
    if (state.state === 'success') {
      if (!Number.isInteger(state.result_count) || state.result_count <= 0) throw new Error('SendTo Photoshop produced no result');
      if (item.resultCount !== null && item.resultCount !== state.result_count) throw new Error('Result count changed unexpectedly');
      item.resultCount = state.result_count;
      for (const index of state.acknowledged_results || []) {
        if (!Number.isInteger(index) || index < 0 || index >= item.resultCount) throw new Error('Invalid server acknowledgement');
        item.acknowledged.add(index); item.ackPending.delete(index);
        host('acknowledged', {request_id: rid, index}, item.binding);
      }
      for (const index of [...item.ackPending]) await acknowledge(rid, item, index);
      if (!current(rid, item)) return;
      if (item.acknowledged.size === item.resultCount) { forget(rid, item); return; }
      for (let index = 0; index < item.resultCount; index++) {
        if (item.acknowledged.has(index) || item.buffered.has(index) || item.ackPending.has(index)) continue;
        retryDelivery = true;
        const response = await fetch('/ps/team/' + route(item.binding, rid) + `/results/${index}`, {headers, credentials: 'same-origin'});
        if (!response.ok) {
          const error = new Error('Result download failed: ' + response.status); error.status = response.status; throw error;
        }
        const blob = await response.blob();
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        if (!current(rid, item)) return;
        host('result', {request_id: rid, index, result_count: item.resultCount, image: data}, item.binding);
      }
      // "received" suppresses redundant transfers only. A durable ACK follows insertion.
    }
    if (['error', 'failed', 'cancelled', 'retry_exhausted'].includes(state.state)) {
      forget(rid, item);
      host('error', {request_id: rid, stage: state.error?.stage || 'generation', error: JSON.stringify(state.error || state.state)}, item.binding);
      return;
    }
    if (['dispatch_unknown', 'monitor_timeout'].includes(state.state) && item.lastState !== state.state) {
      host('error', {request_id: rid, stage: 'generation', error: 'GPU state unknown; request retained. Do not submit again.'}, item.binding);
    }
    item.lastState = state.state;
  } catch (error) {
    retryDelivery = true;
    if ([401, 403, 404, 410].includes(error.status)) forget(rid, item);
    if ([401, 403].includes(error.status) && item.binding === binding) {
      host('unbound', {error: String(error)}, item.binding); detach(item.binding);
    } else host('error', {request_id: rid, stage: 'result', error: String(error)}, item.binding);
  } finally {
    item.inFlight = false;
    if (current(rid, item)) {
      if (retryDelivery && item.retryAttempts >= MAX_RESULT_RETRIES) {
        host('error', {request_id: rid, stage: 'result', error: 'Unconfirmed images retained. Reconnect the Web panel to resume delivery; do not generate again.'}, item.binding);
      } else {
        const delay = retryDelivery ? Math.min(1000 * 2 ** item.retryAttempts++, 30000) : 2000;
        item.timer = setTimeout(() => { item.timer = null; poll(rid); }, delay);
      }
    }
  }
}
async function hello(m, origin) {
  if (handshake && handshake.panel === m.panel && handshake.origin === origin && handshake.session === m.session_id) return;
  const token = ++handshakeVersion;
  handshake = {panel: m.panel, origin, session: m.session_id};
  const previous = binding;
  // A rebind never revokes the old server session; its immutable jobs remain resumable.
  if (previous && (previous.panel !== m.panel || previous.origin !== origin || previous.session !== m.session_id)) detach(previous);
  try {
    let session;
    const candidates = [...new Set([m.session_id, ...(Array.isArray(m.session_ids) ? m.session_ids : [])].filter(validID))];
    for (const candidate of candidates) {
      try { session = await call('sessions/' + encodeURIComponent(candidate), 'GET', undefined, null); break; }
      catch (error) { if (![403, 404, 410].includes(error.status)) throw error; }
      if (token !== handshakeVersion) return;
    }
    if (!session) session = await call('sessions', 'POST', undefined, null);
    if (!validID(session?.session_id)) throw new Error('Company adapter returned an invalid session');
    if (token !== handshakeVersion) return;
    if (!binding || binding.panel !== m.panel || binding.origin !== origin || binding.session !== session.session_id) {
      if (binding) detach(binding);
      binding = {panel: m.panel, session: session.session_id, origin};
    }
    teamMode = true; window.dispatchEvent(new CustomEvent('ps-plugin-bound'));
    host('ready', {version: VERSION}); receiveControl({photoshopConnected: true});
  } catch (error) {
    if (token === handshakeVersion && binding && [401, 403].includes(error.status)) {
      host('unbound', {error: String(error)}); detach(binding);
    }
    throw error;
  } finally { if (token === handshakeVersion) handshake = null; }
}
export function teamSend(type, data) {
  if (standalone) { standalone.send(type, data); return; }
  if (['Send_workflow', 'Send_rndrMode', 'alert'].includes(type)) host('control', {payload: {[type]: data}});
}
export function startTeam(handler) {
  receiveControl = handler;
  if (started) return;
  started = true;
  if (selectedTransport() === 'standalone') { standalone = startStandalone(handler); return; }
  window.addEventListener('message', async event => {
    if (!usesTeamBridge() || event.source !== window.uxpHost || !plugins.has(event.origin)) return;
    const m = event.data;
    if (!m || m.protocol !== VERSION || !validID(m.panel) || (m.transport && m.transport !== 'company')) return;
    const initial = binding;
    try {
      if (m.type === 'hello') { await hello(m, event.origin); return; }
      if (!binding || m.panel !== binding.panel || event.origin !== binding.origin || m.session_id !== binding.session) return;
      if (m.type === 'generate') await run(m);
      else if (m.type === 'resume' && Array.isArray(m.requests)) {
        for (const rid of m.requests.filter(validID)) {
          let item = pending.get(rid);
          if (!item || item.binding !== binding) { item = pendingRequest(binding); pending.set(rid, item); }
          item.retryAttempts = 0; poll(rid);
        }
      } else if (['ack', 'received'].includes(m.type) && validID(m.request_id) && Number.isInteger(m.index) && m.index >= 0) {
        let item = pending.get(m.request_id);
        if (!item && m.type === 'ack') { item = pendingRequest(binding); pending.set(m.request_id, item); }
        if (!item || item.binding !== binding || (item.resultCount !== null && m.index >= item.resultCount)) return;
        item.retryAttempts = 0;
        if (m.type === 'received') item.buffered.add(m.index);
        else { try { await acknowledge(m.request_id, item, m.index); } finally { poll(m.request_id); } }
      } else if (m.type === 'cancel' && validID(m.request_id)) {
        await call(route(initial, m.request_id), 'DELETE', undefined, initial);
        if (binding !== initial) return;
        const item = pending.get(m.request_id); if (item) forget(m.request_id, item);
        host('state', {request_id: m.request_id, state: 'cancelled'}, initial);
      } else if (m.type === 'control' && m.payload && Object.keys(m.payload).every(k => ['workflow', 'rndrMode'].includes(k))) receiveControl(m.payload);
      else if (m.type === 'unbind') {
        ++handshakeVersion; handshake = null;
        await call('sessions/' + encodeURIComponent(initial.session), 'DELETE', undefined, initial);
        detach(initial);
      }
    } catch (error) {
      // Handshake errors have no established session yet. Never report an old job to a new binding.
      if (m.type === 'hello' || initial === binding) window.uxpHost.postMessage({protocol: VERSION, panel: m.panel,
        session_id: m.type === 'hello' ? m.session_id : initial?.session, transport: 'company', type: 'error', stage: 'session', error: String(error)});
    }
  });
}

// Upstream multipart/history transport. Isolated from owner-bound company state.
function startStandalone(handler) {
const VERSION = 'ps-team-1'; // Shared UXP protocol, explicitly selected standalone server transport.
const SNAPSHOT_VERSION = 'ps-plugin-1';
const INPUT = '🔹Photoshop ComfyUI Plugin', OUTPUT = '🔹SendTo Photoshop Plugin';
const plugins = new Set(['comfyui.photoshop.team', '3e6d64e0']);
const pending = new Map();
let binding = null, busy = false, handshaking = false, receiveControl = () => {};
const validID = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const randomID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
function host(type, data = {}, target = binding) {
  if (target && target === binding && window.uxpHost) window.uxpHost.postMessage({...data, protocol: VERSION, panel: target.panel, session_id: target.session, transport: 'standalone', type});
}
function clearBinding(expected = binding) {
  if (expected !== binding) return;
  host('unbound');
  // Keep account-namespaced mappings for reconnect; never erase deduplication on logout.
  for (const item of pending.values()) if (item.timer !== null) clearTimeout(item.timer);
  pending.clear(); binding = null; teamMode = false;
  receiveControl({photoshopConnected: false});
  if (teamPreview.canvas) URL.revokeObjectURL(teamPreview.canvas);
  if (teamPreview.mask) URL.revokeObjectURL(teamPreview.mask);
  teamPreview.canvas = teamPreview.mask = null;
  window.dispatchEvent(new CustomEvent('ps-team-input'));
}
async function request(path, options = {}, expected = binding) {
  if (expected && expected !== binding) throw new Error('Login or panel changed; reopen the Web panel');
  const response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', ...options});
  if (!response.ok) {
    const error = new Error('Request failed: ' + response.status); error.status = response.status;
    if ([401, 403].includes(response.status)) clearBinding(expected);
    throw error;
  }
  return response;
}
async function account(expected = binding) {
  const data = await (await request('/auth/whoami', {}, expected)).json();
  if (data.authenticated !== true || typeof data.username !== 'string' || !data.username) {
    clearBinding(expected); throw new Error('Sign in to the ComfyUI Web panel');
  }
  return data.username;
}
async function current(expected) {
  const username = await account(expected);
  if (binding !== expected || username !== expected.username) {
    if (binding === expected) clearBinding();
    throw new Error('Login or panel changed; reopen the Web panel');
  }
}
function persist() {
  if (!binding) return;
  const records = [...pending].map(([rid, item]) => ({rid, snapshot: item.snapshot, prompt: item.prompt,
    job: item.job, outputs: item.outputs, state: item.state, resultCount: item.resultCount, acknowledged: [...item.acknowledged]}));
  sessionStorage.setItem(binding.key, JSON.stringify({session: binding.session, records}));
}
function item(values) {
  return {acknowledged: new Set(), sent: new Set(), buffered: new Set(), resultCount: null, inFlight: false,
    retryAttempts: 0, timer: null, binding, ...values};
}
function reportUnknown(rid) {
  host('error', {request_id: rid, stage: 'submit', error: 'Submission status unknown. No automatic resubmission; check task history before generating again.'});
}
function imageBlob(encoded) {
  const binary = atob(encoded), data = Uint8Array.from(binary, x => x.charCodeAt(0));
  const type = data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png';
  return new Blob([data], {type});
}
function validateUpload(data, directory) {
  if (!data || data.type !== 'input' || data.subfolder !== directory || typeof data.name !== 'string'
      || !data.name || /[\\/:\x00-\x1f]/.test(data.name) || ['.', '..'].includes(data.name)) {
    throw new Error('Upload returned an invalid snapshot path');
  }
  return {name: data.name, subfolder: data.subfolder, type: data.type};
}
async function upload(encoded, name, directory, expected) {
  const form = new FormData(); form.append('image', imageBlob(encoded), name);
  form.append('type', 'input'); form.append('subfolder', directory); form.append('overwrite', 'false');
  return validateUpload(await (await request('/upload/image', {method: 'POST', body: form}, expected)).json(), directory);
}
async function run(message) {
  const rid = message.request_id;
  if (!validID(rid)) throw new Error('Invalid request identifier');
  if (pending.has(rid)) { await poll(rid); return; }
  if (busy) { host('error', {request_id: rid, stage: 'upload', error: 'Another upload is in progress'}); return; }
  busy = true; const initial = binding; let stage = 'upload';
  try {
    await current(initial);
    if ([...pending.values()].filter(r => !['delivered', 'error'].includes(r.state)).length >= 64)
      throw new Error('Too many unfinished requests; receive pending results before generating again');
    const snapshot = randomID(), directory = 'ps_plugin/' + snapshot;
    const canvas = await upload(message.payload.canvasBase64, 'canvas.png', directory, initial);
    await current(initial);
    const mask = await upload(message.payload.maskBase64, 'mask.png', directory, initial);
    await current(initial);
    const graph = await app.graphToPrompt();
    await current(initial);
    const outputs = Object.keys(graph.output).filter(k => graph.output[k].class_type === OUTPUT);
    if (!outputs.length || !Object.values(graph.output).some(n => n.class_type === INPUT)) throw new Error('Workflow requires Photoshop input and SendTo nodes');
    if (canvas.name === mask.name) throw new Error('Canvas and mask must be separate uploaded files');
    if (teamPreview.canvas) URL.revokeObjectURL(teamPreview.canvas);
    if (teamPreview.mask) URL.revokeObjectURL(teamPreview.mask);
    teamPreview.canvas = URL.createObjectURL(imageBlob(message.payload.canvasBase64));
    teamPreview.mask = URL.createObjectURL(imageBlob(message.payload.maskBase64));
    window.dispatchEvent(new CustomEvent('ps-team-input'));
    // Capture the graph used for this request; metadata never changes shared legacy files.
    const payload = {prompt: graph.output, extra_data: {extra_pnginfo: {workflow: graph.workflow,
      ps_plugin: {version: SNAPSHOT_VERSION, snapshot_id: snapshot, request_id: rid,
        canvas, mask, config: message.payload.configdata}}}};
    stage = 'submit';
    const record = item({snapshot, outputs, state: 'dispatch_unknown'}); pending.set(rid, record);
    // Persist BEFORE POST: a page reload/lost reply must not repeat generation.
    persist(); host('state', {request_id: rid, state: 'submitting'});
    let response;
    try {
      response = await (await request('/prompt', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})).json();
    } catch (error) {
      if ([400, 422].includes(error.status)) { record.state = 'error'; persist(); throw error; }
      if (binding === initial) reportUnknown(rid);
      return;
    }
    if (binding !== initial) return;
    if (typeof response.prompt_id !== 'string' || !response.prompt_id) { reportUnknown(rid); return; }
    await current(initial);
    record.prompt = response.prompt_id; record.job = response.job_id; record.state = 'submitted'; persist();
    await poll(rid);
  } catch (error) { if (binding === initial) host('error', {request_id: rid, stage, error: String(error)}, initial); }
  finally { busy = false; }
}
function historyFiles(entry, record, rid) {
  const meta = entry.prompt?.[3]?.extra_pnginfo?.ps_plugin;
  if (!meta || meta.version !== SNAPSHOT_VERSION || meta.snapshot_id !== record.snapshot || meta.request_id !== rid) throw new Error('History does not match this Photoshop request');
  const messages = entry.status?.messages || [];
  if (entry.status?.status_str === 'error' || messages.some(m => ['execution_error', 'execution_interrupted'].includes(m[0]))) {
    const failure = messages.find(m => ['execution_error', 'execution_interrupted'].includes(m[0]));
    const error = new Error(failure?.[1]?.exception_message || 'Workflow failed or was interrupted'); error.terminal = true; throw error;
  }
  if (!entry.status?.completed) return null;
  const files = record.outputs.flatMap(k => entry.outputs?.[k]?.images || []);
  if (!files.length) { const error = new Error('SendTo Photoshop produced no image'); error.terminal = true; throw error; }
  return files.map(file => {
    const subfolder = typeof file.subfolder === 'string' ? file.subfolder.replace(/\\/g, '/') : null;
    if (file.type !== 'output' || subfolder !== 'ps_plugin/' + record.snapshot || typeof file.filename !== 'string'
        || !file.filename || /[\\/:\x00-\x1f]/.test(file.filename) || ['.', '..'].includes(file.filename)) throw new Error('Unexpected output path in task history');
    return {filename: file.filename, subfolder, type: file.type};
  });
}
async function checkJob(record, rid) {
  let job;
  try { job = await (await request('/jobs/' + encodeURIComponent(record.prompt))).json(); }
  catch (error) { if (error.status === 404) return; throw error; }
  if (record.binding !== binding) return;
  // The existing scheduler exposes both public status and its original status.
  const status = job.scheduler_status || job.status;
  if (status === 'monitor_timeout') {
    record.state = 'monitor_unknown'; persist();
    host('error', {request_id: rid, stage: 'result', error: 'Task monitoring timed out; execution status is unknown. Reconnect to check results; do not generate again.'});
  } else if (['error', 'failed', 'cancelled', 'retry_exhausted'].includes(status)) {
    const error = new Error('Task ' + status + (typeof job.error === 'string' ? ': ' + job.error : ''));
    error.terminal = true; throw error;
  }
}
function restore(saved) {
  if (saved == null) return [];
  if (!validID(saved.session) || !Array.isArray(saved.records)) throw new Error('Saved request mapping is invalid; check task history before generating again');
  const ids = new Set();
  return saved.records.map(entry => {
    if (!entry || !validID(entry.rid) || ids.has(entry.rid) || !validID(entry.snapshot)
        || !['dispatch_unknown', 'submitted', 'monitor_unknown', 'error', 'delivered'].includes(entry.state)
        || !Array.isArray(entry.outputs) || !entry.outputs.length || !entry.outputs.every(k => typeof k === 'string' && k.length)
        || (entry.resultCount != null && (!Number.isInteger(entry.resultCount) || entry.resultCount <= 0))
        || !Array.isArray(entry.acknowledged) || !entry.acknowledged.every(i => Number.isInteger(i) && i >= 0 && (entry.resultCount == null || i < entry.resultCount))
        || (['submitted', 'monitor_unknown', 'delivered'].includes(entry.state) && (typeof entry.prompt !== 'string' || !entry.prompt))) {
      throw new Error('Saved request mapping is invalid; check task history before generating again');
    }
    ids.add(entry.rid);
    return {rid: entry.rid, snapshot: entry.snapshot, prompt: entry.prompt,
      job: typeof entry.job === 'string' ? entry.job : undefined, outputs: entry.outputs,
      state: entry.state, resultCount: entry.resultCount ?? null, acknowledged: new Set(entry.acknowledged)};
  });
}
async function poll(rid) {
  const record = pending.get(rid);
  if (!record || record.binding !== binding || record.inFlight) return;
  if (record.state === 'monitor_unknown') record.state = 'submitted';
  if (record.state === 'dispatch_unknown') { reportUnknown(rid); return; }
  if (record.state === 'delivered') {
    for (const index of record.acknowledged) host('acknowledged', {request_id: rid, index}, record.binding);
    return;
  }
  if (record.state === 'error') return;
  if (record.timer !== null) { clearTimeout(record.timer); record.timer = null; }
  record.inFlight = true; let retryDelivery = false;
  try {
    await current(record.binding);
    let history = {};
    try { history = await (await request('/history/' + encodeURIComponent(record.prompt))).json(); }
    catch (error) { if (error.status !== 404) throw error; }
    if (record.binding !== binding) return;
    const entry = history[record.prompt];
    if (!entry) { await checkJob(record, rid); return; }
    const files = historyFiles(entry, record, rid); if (!files) return;
    retryDelivery = true;
    if (record.resultCount !== null && record.resultCount !== files.length) throw new Error('Result count changed unexpectedly');
    record.resultCount = files.length; persist();
    for (const index of record.acknowledged) host('acknowledged', {request_id: rid, index}, record.binding);
    for (let index = 0; index < files.length; index++) {
      if (record.acknowledged.has(index) || record.buffered.has(index)) continue;
      await current(record.binding);
      const blob = await (await request('/view?' + new URLSearchParams({filename: files[index].filename, subfolder: files[index].subfolder, type: files[index].type}))).blob();
      const data = await new Promise((resolve, reject) => { const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
      await current(record.binding);
      if (record.binding !== binding) return;
      record.sent.add(index);
      host('result', {request_id: rid, index, result_count: files.length, image: data});
    }
  } catch (error) {
    retryDelivery = true;
    if (error.terminal) { record.state = 'error'; persist(); }
    host('error', {request_id: rid, stage: 'result', error: String(error)}, record.binding);
  } finally {
    record.inFlight = false;
    if (record.binding === binding && !['error', 'delivered', 'monitor_unknown'].includes(record.state)) {
      if (retryDelivery && record.retryAttempts >= 5) host('error', {request_id: rid, stage: 'result', error: 'Unconfirmed results retained. Reconnect the Web panel to resume; do not generate again.'});
      else record.timer = setTimeout(() => { record.timer = null; poll(rid); }, retryDelivery ? 1000 * 2 ** record.retryAttempts++ : 2000);
    }
  }
}
function teamSend(type, data) {
  if (['Send_workflow', 'Send_rndrMode', 'alert'].includes(type)) host('control', {payload: {[type]: data}});
}
// This is an explicit deployment choice, never an error-recovery fallback.
async function assertNoCompanyAdapter() {
  // The older company adapter has no capabilities route, but its POST-only
  // session collection answers a read-only GET with 405. Neither may be present.
  for (const path of ['/ps/team/capabilities', '/ps/team/sessions']) {
    const response = await fetch(path, {credentials: 'same-origin', cache: 'no-store'});
    if (response.status !== 404) throw new Error('Standalone transport requires an explicit URL choice and a deployment without the company adapter (both read-only probes must return 404). Use the default company URL or ask the administrator.');
  }
}
let started = false, handshakeVersion = 0;
function startTeam(handler) {
  receiveControl = handler;
  if (started) return; started = true;
  window.addEventListener('message', async event => {
    if (!usesTeamBridge() || event.source !== window.uxpHost || !plugins.has(event.origin)) return;
    const m = event.data;
    if (!m || m.protocol !== VERSION || !validID(m.panel) || (m.transport && m.transport !== 'standalone')) return;
    const initial = binding;
    try {
      if (m.type === 'hello') {
        if (handshaking) return; handshaking = true;
        const version = ++handshakeVersion;
        try {
          await assertNoCompanyAdapter();
          const username = await account(initial);
          if (version !== handshakeVersion) return;
          if (!binding || binding.panel !== m.panel || binding.username !== username || binding.origin !== event.origin) {
            if (binding) clearBinding();
            const prefix = 'ps-plugin-1:' + location.origin + ':' + encodeURIComponent(username) + ':';
            const candidates = [...new Set([m.session_id, ...(Array.isArray(m.session_ids) ? m.session_ids : [])].filter(validID))];
            if (candidates.some(candidate => m.session_owners?.[candidate] === username && sessionStorage.getItem(prefix + candidate) === null)) {
              throw new Error('Standalone request mapping is unavailable. Saved Photoshop requests are retained; do not generate again. Restore the original Web panel storage or review server history before operator recovery.');
            }
            let saved = null, records = [];
            for (const candidate of candidates) {
              const value = sessionStorage.getItem(prefix + candidate);
              if (value === null) continue;
              saved = JSON.parse(value); records = restore(saved);
              if (saved.session !== candidate) throw new Error('Saved request mapping is invalid; session does not match');
              break;
            }
            // A fresh panel may reconnect without its earlier session ID. Only use
            // its own account-scoped index, never another panel's active mapping.
            const panelKey = prefix + 'panel:' + m.panel;
            if (!saved) {
              const candidate = sessionStorage.getItem(panelKey);
              if (validID(candidate)) {
                const value = sessionStorage.getItem(prefix + candidate);
                if (value !== null) { saved = JSON.parse(value); records = restore(saved); }
              }
            }
            const session = saved ? saved.session : randomID();
            binding = {panel: m.panel, username, origin: event.origin, key: prefix + session, session};
            for (const entry of records) pending.set(entry.rid, item(entry));
            persist(); sessionStorage.setItem(panelKey, session);
          }
          teamMode = true; window.dispatchEvent(new CustomEvent('ps-plugin-bound'));
          host('ready', {version: VERSION, account_id: username}); receiveControl({photoshopConnected: true});
        } finally { handshaking = false; }
        return;
      }
      if (!binding || m.panel !== binding.panel || event.origin !== binding.origin || m.session_id !== binding.session) return;
      if (m.type === 'generate') await run(m);
      else if (m.type === 'resume' && Array.isArray(m.requests)) {
        await current(binding);
        for (const rid of m.requests.filter(validID)) { const record = pending.get(rid); if (record) { record.retryAttempts = 0; poll(rid); } else reportUnknown(rid); }
      } else if (['received', 'ack'].includes(m.type)) {
        const record = pending.get(m.request_id);
        if (record?.binding === binding && Number.isInteger(m.index) && m.index >= 0 && m.index < record.resultCount) {
          if (m.type === 'received') { record.buffered.add(m.index); return; }
          await current(record.binding);
          const previous = {state: record.state, acknowledged: new Set(record.acknowledged)};
          record.acknowledged.add(m.index);
          if (record.acknowledged.size === record.resultCount) record.state = 'delivered';
          try { persist(); } catch (error) { record.state = previous.state; record.acknowledged = previous.acknowledged; throw error; }
          if (record.state === 'delivered' && record.timer !== null) { clearTimeout(record.timer); record.timer = null; }
          // Confirm only after the local mapping write succeeds.
          host('acknowledged', {request_id: m.request_id, index: m.index}, record.binding);
        }
      } else if (m.type === 'control' && m.payload && Object.keys(m.payload).every(k => ['workflow', 'rndrMode'].includes(k))) receiveControl(m.payload);
      else if (m.type === 'cancel') host('error', {request_id: m.request_id, stage: 'cancel', error: 'Standalone transport cannot safely cancel a shared server job; use the server task history.'});
      else if (m.type === 'unbind') { ++handshakeVersion; clearBinding(); }
    } catch (error) {
      if (m.type === 'hello') window.uxpHost.postMessage({protocol: VERSION, panel: m.panel, session_id: m.session_id, transport: 'standalone', type: 'error', stage: 'session', error: String(error)});
      else if (initial === binding) host('error', {stage: 'session', error: String(error)}, initial);
    }
  });
}
startTeam(handler);
return {send: teamSend};
}
