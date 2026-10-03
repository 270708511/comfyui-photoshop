import { app } from '../../../scripts/app.js';

export let teamMode = false;
export const usesTeamBridge = () => !!window.uxpHost && !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
export const teamPreview = {canvas: null, mask: null};
const VERSION = 'ps-team-1'; // Existing UXP message protocol; no server extension required.
const SNAPSHOT_VERSION = 'ps-plugin-1';
const INPUT = '🔹Photoshop ComfyUI Plugin', OUTPUT = '🔹SendTo Photoshop Plugin';
const plugins = new Set(['comfyui.photoshop.team', '3e6d64e0']);
const pending = new Map();
let binding = null, busy = false, handshaking = false, receiveControl = () => {};
const validID = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const randomID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), x => x.toString(16).padStart(2, '0')).join('');
function host(type, data = {}, target = binding) {
  if (target && window.uxpHost) window.uxpHost.postMessage({protocol: VERSION, panel: target.panel, type, ...data});
}
function clearBinding() {
  host('unbound');
  if (binding) sessionStorage.removeItem(binding.key);
  for (const item of pending.values()) if (item.timer !== null) clearTimeout(item.timer);
  pending.clear(); binding = null; teamMode = false;
  if (teamPreview.canvas) URL.revokeObjectURL(teamPreview.canvas);
  if (teamPreview.mask) URL.revokeObjectURL(teamPreview.mask);
  teamPreview.canvas = teamPreview.mask = null;
  window.dispatchEvent(new CustomEvent('ps-team-input'));
}
async function request(path, options = {}) {
  const response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', ...options});
  if (!response.ok) {
    const error = new Error('Request failed: ' + response.status); error.status = response.status;
    if ([401, 403].includes(response.status)) clearBinding();
    throw error;
  }
  return response;
}
async function account() {
  const data = await (await request('/auth/whoami')).json();
  if (data.authenticated !== true || typeof data.username !== 'string' || !data.username) {
    clearBinding(); throw new Error('Sign in to the ComfyUI Web panel');
  }
  return data.username;
}
async function current(expected) {
  const username = await account();
  if (binding !== expected || username !== expected.username) {
    if (binding === expected) clearBinding();
    throw new Error('Login or panel changed; reopen the Web panel');
  }
}
function persist() {
  if (!binding) return;
  const records = [...pending].map(([rid, item]) => ({rid, snapshot: item.snapshot, prompt: item.prompt,
    job: item.job, outputs: item.outputs, state: item.state, acknowledged: [...item.acknowledged]}));
  sessionStorage.setItem(binding.key, JSON.stringify({session: binding.session, records}));
}
function item(values) {
  return {acknowledged: new Set(), sent: new Set(), resultCount: null, inFlight: false,
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
async function upload(encoded, name, directory) {
  const form = new FormData(); form.append('image', imageBlob(encoded), name);
  form.append('type', 'input'); form.append('subfolder', directory); form.append('overwrite', 'false');
  return validateUpload(await (await request('/upload/image', {method: 'POST', body: form})).json(), directory);
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
    const canvas = await upload(message.payload.canvasBase64, 'canvas.png', directory);
    await current(initial);
    const mask = await upload(message.payload.maskBase64, 'mask.png', directory);
    await current(initial);
    const graph = await app.graphToPrompt();
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
    record.prompt = response.prompt_id; record.job = response.job_id; record.state = 'submitted'; persist();
    await poll(rid);
  } catch (error) { host('error', {request_id: rid, stage, error: String(error)}); }
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
        || !Array.isArray(entry.acknowledged) || !entry.acknowledged.every(i => Number.isInteger(i) && i >= 0)
        || (['submitted', 'monitor_unknown', 'delivered'].includes(entry.state) && (typeof entry.prompt !== 'string' || !entry.prompt))) {
      throw new Error('Saved request mapping is invalid; check task history before generating again');
    }
    ids.add(entry.rid);
    return {rid: entry.rid, snapshot: entry.snapshot, prompt: entry.prompt,
      job: typeof entry.job === 'string' ? entry.job : undefined, outputs: entry.outputs,
      state: entry.state, acknowledged: new Set(entry.acknowledged)};
  });
}
async function poll(rid) {
  const record = pending.get(rid);
  if (!record || record.binding !== binding || record.inFlight) return;
  if (record.state === 'monitor_unknown') record.state = 'submitted';
  if (record.state === 'dispatch_unknown') { reportUnknown(rid); return; }
  if (['error', 'delivered'].includes(record.state)) return;
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
    record.resultCount = files.length;
    for (let index = 0; index < files.length; index++) {
      if (record.acknowledged.has(index)) continue;
      await current(record.binding);
      const blob = await (await request('/view?' + new URLSearchParams({filename: files[index].filename, subfolder: files[index].subfolder, type: files[index].type}))).blob();
      const data = await new Promise((resolve, reject) => { const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
      if (record.binding !== binding) return;
      record.sent.add(index);
      host('result', {request_id: rid, index, result_count: files.length, image: data});
    }
  } catch (error) {
    retryDelivery = true;
    if (error.terminal) { record.state = 'error'; persist(); }
    host('error', {request_id: rid, stage: 'result', error: String(error)});
  } finally {
    record.inFlight = false;
    if (record.binding === binding && !['error', 'delivered', 'monitor_unknown'].includes(record.state)) {
      if (retryDelivery && record.retryAttempts >= 5) host('error', {request_id: rid, stage: 'result', error: 'Unconfirmed results retained. Reconnect the Web panel to resume; do not generate again.'});
      else record.timer = setTimeout(() => { record.timer = null; poll(rid); }, retryDelivery ? 1000 * 2 ** record.retryAttempts++ : 2000);
    }
  }
}
export function teamSend(type, data) {
  if (['Send_workflow', 'Send_rndrMode', 'alert'].includes(type)) host('control', {payload: {[type]: data}});
}
export function startTeam(handler) {
  receiveControl = handler;
  window.addEventListener('message', async event => {
    if (!usesTeamBridge() || event.source !== window.uxpHost || !plugins.has(event.origin)) return;
    const m = event.data;
    if (!m || m.protocol !== VERSION || !validID(m.panel)) return;
    try {
      if (m.type === 'hello') {
        if (handshaking) return; handshaking = true;
        try {
          const username = await account();
          if (!binding || binding.panel !== m.panel || binding.username !== username || binding.origin !== event.origin) {
            if (binding) clearBinding();
            const key = 'ps-plugin-1:' + location.origin + ':' + username + ':' + m.panel;
            const saved = JSON.parse(sessionStorage.getItem(key));
            const records = restore(saved);
            binding = {panel: m.panel, username, origin: event.origin, key, session: validID(saved?.session) ? saved.session : randomID()};
            for (const entry of records) pending.set(entry.rid, item(entry));
            persist();
          }
          teamMode = true; window.dispatchEvent(new CustomEvent('ps-plugin-bound'));
          host('ready', {session_id: binding.session, version: VERSION}); receiveControl({photoshopConnected: true});
        } finally { handshaking = false; }
        return;
      }
      if (!binding || m.panel !== binding.panel || event.origin !== binding.origin) return;
      if (m.type === 'generate') await run(m);
      else if (m.type === 'resume' && m.session_id === binding.session && Array.isArray(m.requests)) {
        await current(binding);
        for (const rid of m.requests) { const record = pending.get(rid); if (record) { record.retryAttempts = 0; poll(rid); } else reportUnknown(rid); }
      } else if (m.type === 'ack') {
        const record = pending.get(m.request_id);
        if (record?.binding === binding && Number.isInteger(m.index) && m.index >= 0 && m.index < record.resultCount && record.sent.has(m.index)) {
          record.acknowledged.add(m.index);
          if (record.acknowledged.size === record.resultCount) { record.state = 'delivered'; if (record.timer !== null) clearTimeout(record.timer); }
          persist();
        }
      } else if (m.type === 'control' && m.payload && Object.keys(m.payload).every(k => ['workflow', 'rndrMode'].includes(k))) receiveControl(m.payload);
      else if (m.type === 'unbind') clearBinding();
    } catch (error) { host('error', {stage: 'session', error: String(error)}, {panel: m.panel}); }
  });
}
