/* Runtime bridge for the restored v1.9.3 package. No UI replacement or rebuild. */
globalThis.createPSTeamBridge = function (hooks) {
  const protocol = 'ps-team-1';
  const randomID = () => Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const panel = randomID();
  const jobs = new Map();
  const received = new Set();
  const inserted = new Set();
  let ready = false, session = null, origin = null, busy = false, active = null;
  let view = null;
  // Every render.png write, active selection and insertion transition shares this queue.
  // The active image stays reserved between beforeInsert() and afterInsert().
  let presentationChain = Promise.resolve();
  let insertion = null;
  function serial(action) {
    const next = presentationChain.then(action);
    presentationChain = next.catch(() => {});
    return next;
  }
  async function selectNext() {
    if (active) return;
    for (const [rid, context] of jobs) for (const [index, image] of context.results) {
      const key = rid + ':' + index;
      if (inserted.has(key)) continue;
      await hooks.preview(image);
      if (jobs.get(rid) === context) active = {key, context};
      return;
    }
  }
  let previousPlacement = null;
  function enabled(url = hooks.url()) {
    try { return !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return true; }
  }
  function send(type, values = {}) {
    if (!view || !origin) throw new Error('Open the ComfyUI Web panel first');
    view.postMessage({protocol, panel, type, ...values}, origin);
  }
  function connect(url) {
    ready = false;
    const next = new URL(url.replace(/^ws/, 'http')).origin;
    if (origin && next !== origin) {
      try { send('unbind'); } catch {}
      session = null;
      serial(() => { jobs.clear(); active = null; });
    }
    origin = next;
    const current = document.querySelector('webview');
    if (current && current !== view) current.addEventListener('loadstart', () => { ready = false; });
    view = current;
    if (view) send('hello', {session_id: session});
    hooks.status('Open Web panel and sign in', 'orange');
  }
  setInterval(() => {
    if (!enabled()) return;
    const current = document.querySelector('webview');
    if (current !== view) {
      view = current;
      if (view) view.addEventListener('loadstart', () => { ready = false; });
    }
    if (view && origin && !ready) { try { send('hello', {session_id: session}); } catch {} }
  }, 3000);
  window.addEventListener('message', async event => {
    const m = event.data;
    if (!view || event.source !== view || event.origin !== origin || !m || m.protocol !== protocol || m.panel !== panel) return;
    try {
      if (m.type === 'ready') {
        if (session && session !== m.session_id && jobs.size) {
          hooks.status('Login changed: previous requests remain bound to the old session', 'orange');
          await serial(() => { jobs.clear(); active = null; });
        }
        session = m.session_id; ready = true; hooks.status('Connected', 'green');
        send('resume', {session_id: session, requests: [...jobs.keys()]});
      } else if (m.type === 'unbound') {
        ready = false; session = null;
        await serial(() => { jobs.clear(); active = null; received.clear(); inserted.clear(); });
        hooks.status('Sign in again', 'orange');
      }
      else if (m.type === 'control') {
        if (m.payload && Object.keys(m.payload).every(k => ['Send_workflow', 'Send_rndrMode', 'alert'].includes(k))) hooks.control(m.payload);
      } else if (m.type === 'state' && jobs.has(m.request_id)) {
        hooks.status(m.state, 'yellow');
      } else if (m.type === 'error') { hooks.status((m.stage || 'Session') + ': ' + m.error, 'darkred'); }
      else if (m.type === 'result' && jobs.has(m.request_id) && typeof m.image === 'string' && Number.isInteger(m.index)) {
        await serial(async () => {
          const context = jobs.get(m.request_id);
          if (!context) return;
          const key = m.request_id + ':' + m.index;
          if (!received.has(key)) {
            context.results.set(m.index, m.image);
            received.add(key);
          }
          // During insertion this only buffers the result; it cannot replace render.png.
          if (!busy) await selectNext();
          send('ack', {request_id: m.request_id, index: m.index});
          hooks.status('Result ready — use the existing insert action', 'green');
        });
      }
    } catch (error) { hooks.status('Result: ' + error.message, 'darkred'); }
  });
  async function capture(config) {
    if (busy) return;
    busy = true;
    try {
      if (!ready) throw new Error('Web panel is not ready; open it and sign in');
      const doc = hooks.document();
      if (!doc) throw new Error('No open Photoshop document');
      const rid = randomID();
      const canvasBase64 = await hooks.canvas();
      const maskBase64 = await hooks.mask();
      const configdata = await config();
      if (hooks.document()?.id !== doc.id || !canvasBase64 || !maskBase64) throw new Error('Canvas/mask export failed or document changed');
      const context = {documentID: doc.id, bounds: hooks.bounds(), results: new Map()};
      jobs.set(rid, context);
      send('generate', {request_id: rid, payload: {canvasBase64, maskBase64, configdata}});
      hooks.status('Uploading', 'yellow');
    } catch (error) { hooks.status('Upload: ' + error.message, 'darkred'); }
    finally {
      busy = false;
      await serial(() => selectNext());
    }
  }
  async function beforeInsert() {
    if (!enabled()) return null;
    return serial(async () => {
      if (busy) throw new Error('Canvas export/insertion is busy');
      await selectNext();
      if (!active) throw new Error('No team result is ready');
      if (inserted.has(active.key)) throw new Error('This result has already been inserted');
      busy = true;
      insertion = active;
      try {
        await hooks.activate(insertion.context.documentID);
        previousPlacement = hooks.setBounds(insertion.context.bounds);
        return insertion.context;
      } catch (error) { insertion = null; busy = false; throw error; }
    });
  }
  async function afterInsert(success) {
    if (!enabled() && !insertion) return;
    return serial(async () => {
      // A second failure notification after a preview error cannot undo a successful insert.
      if (!insertion) return;
      const finished = insertion;
      insertion = null;
      if (success) {
        inserted.add(finished.key);
        if (active === finished) active = null;
      }
      try {
        if (previousPlacement && hooks.restoreBounds) hooks.restoreBounds(previousPlacement);
        previousPlacement = null;
        // Keep busy reserved until the next preview finishes; incoming results queue behind it.
        if (success) await selectNext();
      } finally { previousPlacement = null; busy = false; }
    });
  }
  function control(payload) {
    if (!ready) { hooks.status('Web panel is not ready', 'orange'); return; }
    send('control', {payload});
  }
  return {enabled, connect, capture, control, beforeInsert, afterInsert};
};
