import { app } from '../../../scripts/app.js';

export const teamMode = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const VERSION = 'ps-team-1';
export const teamPreview = {canvas: null, mask: null};
const plugins = new Set(['comfyui.photoshop.team', '3e6d64e0']);
let binding = null;
let busy = false;
let handshaking = false;
const pending = new Map();
const MAX_RESULT_RETRIES = 5;
function pendingRequest(values) {
  return {acknowledged: new Set(), sent: new Set(), resultCount: null, inFlight: false,
    timer: null, retryAttempts: 0, ...values};
}
function forget(rid, item) {
  if (item.timer !== null) clearTimeout(item.timer);
  if (pending.get(rid) === item) pending.delete(rid);
}
let receiveControl = () => {};
const headers = {'Content-Type': 'application/json', 'X-PS-Team': VERSION};
function host(type, data = {}) {
  if (binding && window.uxpHost) window.uxpHost.postMessage({protocol: VERSION, panel: binding.panel, type, ...data});
}
async function call(path, method = 'GET', body) {
  const response = await fetch('/ps/team/' + path, {method, headers, credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)});
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { detail = 'Request failed'; }
    if (response.status === 401 || response.status === 403) {
      host('unbound', {error: detail}); binding = null;
      teamPreview.canvas = teamPreview.mask = null;
    }
    const error = new Error(`${response.status}: ${detail}`); error.status = response.status; throw error;
  }
  return response.json();
}
function route(rid) { return `sessions/${binding.session}/requests/${rid}`; }
async function run(message) {
  if (busy) { host('error', {request_id: message.request_id, stage: 'upload', error: 'Another upload is in progress'}); return; }
  busy = true;
  const initial = binding;
  const rid = message.request_id;
  let stage = 'upload';
  try {
    host('state', {request_id: rid, state: 'uploading'});
    await call(route(rid) + '/snapshot', 'PUT', message.payload);
    if (binding !== initial) return;
    teamPreview.canvas = 'data:image/png;base64,' + message.payload.canvasBase64;
    teamPreview.mask = 'data:image/jpeg;base64,' + message.payload.maskBase64;
    window.dispatchEvent(new CustomEvent('ps-team-input'));
    stage = 'submit';
    // graphToPrompt is the current ComfyUI frontend serialization contract.
    const graph = await app.graphToPrompt();
    const payload = {prompt: graph.output, extra_data: {extra_pnginfo: {workflow: graph.workflow}}};
    host('state', {request_id: rid, state: 'submitting'});
    pending.set(rid, pendingRequest({binding: initial, payload, retries: 0}));
    try { await call(route(rid) + '/submit', 'POST', payload); }
    catch (error) { if (binding !== initial) throw error; /* poll reconciles a lost reply */ }
    await poll(rid);
  } catch (error) {
    host('error', {request_id: rid, stage, error: String(error)});
  } finally { busy = false; }
}
async function poll(rid) {
  const item = pending.get(rid);
  if (!item || item.binding !== binding || item.inFlight) return;
  if (item.timer !== null) { clearTimeout(item.timer); item.timer = null; }
  item.inFlight = true;
  let retryDelivery = false;
  try {
    const state = await call(route(rid));
    if (pending.get(rid) !== item || item.binding !== binding) return;
    host('state', state);
    if (state.state === 'uploaded') {
      if (item.payload && item.retries++ < 3) await call(route(rid) + '/submit', 'POST', item.payload);
      else { forget(rid, item); throw new Error('Input saved but workflow was not submitted'); }
    }
    if (state.state === 'success') {
      retryDelivery = true;
      if (!Number.isInteger(state.result_count) || state.result_count <= 0) throw new Error('SendTo Photoshop produced no result');
      if (item.resultCount !== null && item.resultCount !== state.result_count) throw new Error('Result count changed unexpectedly');
      item.resultCount = state.result_count;
      for (let index = 0; index < item.resultCount; index++) {
        if (item.acknowledged.has(index)) continue;
        const response = await fetch('/ps/team/' + route(rid) + `/results/${index}`, {headers, credentials: 'same-origin'});
        if (!response.ok) {
          const error = new Error('Result download failed: ' + response.status); error.status = response.status; throw error;
        }
        const blob = await response.blob();
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        if (pending.get(rid) !== item || item.binding !== binding) return;
        item.sent.add(index);
        host('result', {request_id: rid, index, result_count: item.resultCount, image: data});
      }
      // Each image must be acknowledged. Missing images/acks retry only delivery, never generation.
    }
    if (['error', 'failed', 'cancelled', 'retry_exhausted'].includes(state.state)) {
      forget(rid, item);
      host('error', {request_id: rid, stage: state.error?.stage || 'generation', error: JSON.stringify(state.error || state.state)});
      return;
    }
    if (['dispatch_unknown', 'monitor_timeout'].includes(state.state)) {
      host('error', {request_id: rid, stage: 'generation', error: 'GPU state unknown; request retained. Do not submit again.'});
    }
  } catch (error) {
    retryDelivery = true;
    if ([401, 403, 404, 410].includes(error.status)) forget(rid, item);
    host('error', {request_id: rid, stage: 'result', error: String(error)});
  } finally {
    item.inFlight = false;
    if (pending.get(rid) === item && item.binding === binding) {
      if (retryDelivery && item.retryAttempts >= MAX_RESULT_RETRIES) {
        host('error', {request_id: rid, stage: 'result', error: 'Unconfirmed images retained. Reconnect the Web panel to resume delivery; do not generate again.'});
      } else {
        const delay = retryDelivery ? Math.min(1000 * 2 ** item.retryAttempts++, 30000) : 2000;
        item.timer = setTimeout(() => { item.timer = null; poll(rid); }, delay);
      }
    }
  }
}
export function teamSend(type, data) {
  if (['Send_workflow', 'Send_rndrMode', 'alert'].includes(type)) host('control', {payload: {[type]: data}});
}
export function startTeam(handler) {
  receiveControl = handler;
  if (!teamMode) return;
  // No legacy socket on a team origin, including when the bridge is unavailable.
  window.addEventListener('message', async event => {
    if (!window.uxpHost || event.source !== window.uxpHost || !plugins.has(event.origin)) return;
    const m = event.data;
    if (!m || m.protocol !== VERSION || typeof m.panel !== 'string') return;
    try {
      if (m.type === 'hello') {
        if (handshaking) return;
        handshaking = true;
        try {
        if (!binding || binding.panel !== m.panel) {
          if (binding) await call('sessions/' + binding.session, 'DELETE').catch(() => {});
          let session;
          try { session = m.session_id ? await call('sessions/' + m.session_id) : await call('sessions', 'POST'); }
          catch (error) {
            if (![403, 404].includes(error.status)) throw error;
            session = await call('sessions', 'POST');
          }
          binding = {panel: m.panel, session: session.session_id, origin: event.origin};
        }
        host('ready', {session_id: binding.session, version: VERSION});
        receiveControl({photoshopConnected: true});
        } finally { handshaking = false; }
        return;
      }
      if (!binding || m.panel !== binding.panel || event.origin !== binding.origin) return;
      if (m.type === 'generate') { await run(m); }
      else if (m.type === 'resume' && Array.isArray(m.requests)) {
        // Only requests from this already-bound server session; a new login cannot claim them.
        if (m.session_id !== binding.session) return;
        for (const rid of m.requests) {
          let item = pending.get(rid);
          if (!item || item.binding !== binding) { item = pendingRequest({binding}); pending.set(rid, item); }
          item.retryAttempts = 0;
          poll(rid);
        }
      } else if (m.type === 'ack') {
        const item = pending.get(m.request_id);
        if (item?.binding === binding && Number.isInteger(m.index) && item.resultCount !== null
            && m.index >= 0 && m.index < item.resultCount && item.sent.has(m.index)) {
          item.acknowledged.add(m.index);
          if (item.acknowledged.size === item.resultCount) forget(m.request_id, item);
        }
      }
      else if (m.type === 'control' && m.payload && Object.keys(m.payload).every(k => ['workflow', 'rndrMode'].includes(k))) receiveControl(m.payload);
      else if (m.type === 'unbind') { await call('sessions/' + binding.session, 'DELETE'); binding = null; pending.clear(); }
    } catch (error) { window.uxpHost.postMessage({protocol: VERSION, panel: m.panel, type: 'error', stage: 'session', error: String(error)}); }
  });
}
