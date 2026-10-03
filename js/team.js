import { app } from '../../../scripts/app.js';

export const teamMode = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
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
      session_id: owner.session, type});
  }
}
function detach(owner) {
  if (binding !== owner) return;
  for (const [rid, item] of pending) forget(rid, item);
  binding = null; upload = null;
  teamPreview.canvas = teamPreview.mask = null;
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
    if (token !== handshakeVersion) return;
    if (!binding || binding.panel !== m.panel || binding.origin !== origin || binding.session !== session.session_id) {
      if (binding) detach(binding);
      binding = {panel: m.panel, session: session.session_id, origin};
    }
    host('ready', {version: VERSION}); receiveControl({photoshopConnected: true});
  } catch (error) {
    if (token === handshakeVersion && binding && [401, 403].includes(error.status)) {
      host('unbound', {error: String(error)}); detach(binding);
    }
    throw error;
  } finally { if (token === handshakeVersion) handshake = null; }
}
export function teamSend(type, data) {
  if (['Send_workflow', 'Send_rndrMode', 'alert'].includes(type)) host('control', {payload: {[type]: data}});
}
export function startTeam(handler) {
  receiveControl = handler;
  if (!teamMode || started) return;
  started = true;
  window.addEventListener('message', async event => {
    if (!window.uxpHost || event.source !== window.uxpHost || !plugins.has(event.origin)) return;
    const m = event.data;
    if (!m || m.protocol !== VERSION || !validID(m.panel)) return;
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
        session_id: m.type === 'hello' ? m.session_id : initial?.session, type: 'error', stage: 'session', error: String(error)});
    }
  });
}
