/* Runtime bridge for the restored v1.9.3 package. No UI replacement or rebuild. */
globalThis.createPSTeamBridge = function (hooks) {
  const protocol = 'ps-team-1';
  const randomID = () => Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const panel = randomID();
  let jobs = new Map(), journal = {version: 2, revision: 0, connections: {}};
  let ready = false, session = null, origin = null, busy = false, active = null;
  let view = null, epoch = 0, insertion = null, previousPlacement = null, loadError = null, preparingInsert = false;
  let presentationChain = Promise.resolve(), saveChain = Promise.resolve();
  const loaded = Promise.resolve().then(() => hooks.load?.()).then(value => {
    if (value != null) {
      if (![1, 2].includes(value.version) || !Number.isSafeInteger(value.revision) || !value.connections || typeof value.connections !== 'object') {
        throw new Error('Saved team request journal is invalid; review previous insertions before resetting it');
      }
      if (value.version === 1) {
        for (const connection of Object.values(value.connections)) {
          connection.sessions = connection.session ? {[connection.session]: {jobs: connection.jobs || []}} : {};
          delete connection.jobs;
        }
        value.version = 2;
      }
      journal = value;
    }
  }).catch(error => { loadError = error; hooks.status(error.message, 'darkred'); });
  function serial(action) {
    const next = presentationChain.then(action);
    presentationChain = next.catch(() => {});
    return next;
  }
  function stateFor(context) {
    return {documentID: context.documentID, documentName: context.documentName, sourceDocumentID: context.sourceDocumentID, bounds: context.bounds, maskBase64: context.maskBase64, resultCount: context.resultCount,
      inserted: [...context.inserted], uncertain: [...context.uncertain]};
  }
  function persist() {
    const next = saveChain.then(async () => {
      if (loadError) throw loadError;
      if (origin && session) {
        const connection = journal.connections[origin] ||= {session, sessions: {}};
        connection.session = session;
        connection.sessions[session] = {jobs: [...jobs].map(([rid, context]) => [rid, stateFor(context)])};
      }
      journal.revision += 1;
      if (hooks.save) await hooks.save(JSON.parse(JSON.stringify(journal)));
    });
    saveChain = next.catch(() => {});
    return next;
  }
  function restore(saved) {
    return new Map((saved?.jobs || []).map(([rid, context]) => [rid, {...context,
      sourceDocumentID: context.sourceDocumentID ?? context.documentID, needsDocumentReview: true,
      results: new Map(), inserted: new Set(context.inserted || []), uncertain: new Set(context.uncertain || []), acknowledged: new Set()}]));
  }
  function same(owner) { return owner.epoch === epoch && owner.origin === origin && owner.session === session; }
  function owner() { return {epoch, origin, session}; }
  function send(type, values = {}, target = owner()) {
    if (!same(target) || !view || !origin) throw new Error('Web panel changed; reconnect to resume the saved request');
    view.postMessage({...values, protocol, panel, session_id: session, type}, origin);
  }
  async function selectNext() {
    if (active || !ready) return;
    for (const [rid, context] of jobs) for (const [index, image] of context.results) {
      if (context.quarantined || context.inserted.has(index) || context.uncertain.has(index)) continue;
      const target = owner();
      await hooks.preview(image);
      if (same(target) && jobs.get(rid) === context) active = {rid, index, context, owner: target};
      return;
    }
  }
  function enabled(url = hooks.url()) {
    try { return !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname); } catch { return true; }
  }
  function attachView(current) {
    if (current === view) return;
    view = current; ready = false; active = null; epoch++;
    if (current) current.addEventListener('loadstart', () => {
      if (view === current) { ready = false; epoch++; active = null; }
    });
  }
  async function connect(url) {
    ready = false; active = null; epoch++;
    const expected = epoch;
    const next = new URL(url.replace(/^ws/, 'http')).origin;
    await loaded;
    if (expected !== epoch) return;
    if (loadError) { hooks.status(loadError.message, 'darkred'); return; }
    await serial(async () => {
      if (expected !== epoch) return;
      if (origin !== next) {
        if (origin) await persist();
        origin = next;
        const saved = journal.connections[origin];
        session = saved?.session || null; jobs = restore(saved?.sessions?.[session]); active = null;
      }
      attachView(document.querySelector('webview'));
      if (view) send('hello', {session_ids: Object.keys(journal.connections[origin]?.sessions || {})});
      hooks.status('Open Web panel and sign in', 'orange');
    });
  }
  setInterval(() => {
    if (!enabled() || loadError) return;
    attachView(document.querySelector('webview'));
    if (view && origin && !ready) { try { send('hello', {session_ids: Object.keys(journal.connections[origin]?.sessions || {})}); } catch {} }
  }, 3000);
  window.addEventListener('message', async event => {
    const m = event.data;
    if (!view || event.source !== view || event.origin !== origin || !m || m.protocol !== protocol || m.panel !== panel) return;
    if (m.type !== 'ready' && m.session_id !== session) return;
    const target = owner();
    try {
      if (m.type === 'ready') {
        if (typeof m.session_id !== 'string' || !m.session_id) return;
        await serial(async () => {
          if (!same(target)) return;
          if (session && session !== m.session_id) {
            hooks.status('Login changed: previous requests remain bound to the old session', 'orange');
            await persist();
            jobs = restore(journal.connections[origin]?.sessions?.[m.session_id]); active = null; epoch++;
          }
          session = m.session_id;
          await persist();
          ready = true; hooks.status('Connected', 'green');
          send('resume', {requests: [...jobs.keys()]});
          for (const [rid, context] of jobs) {
            for (const index of context.inserted) send('ack', {request_id: rid, index});
            for (const index of context.results.keys()) send('received', {request_id: rid, index});
            if (context.uncertain.size) hooks.status('Previous insertion was interrupted. Review original document layers before resolving it', 'orange');
          }
          if (!busy) await selectNext();
        });
      } else if (m.type === 'unbound') { ready = false; epoch++; active = null; hooks.status('Sign in again', 'orange'); }
      else if (m.type === 'control') {
        if (m.payload && Object.keys(m.payload).every(k => ['Send_workflow', 'Send_rndrMode', 'alert'].includes(k))) hooks.control(m.payload);
      } else if (m.type === 'state' && jobs.has(m.request_id)) {
        const context = jobs.get(m.request_id);
        if (m.document_id != null && String(m.document_id) !== String(context.sourceDocumentID)) {
          context.quarantined = true; if (active?.rid === m.request_id) active = null;
          throw new Error('Request belongs to a different Photoshop document');
        }
        if (m.state === 'success' && Number.isInteger(m.result_count) && m.result_count > 0) {
          if (context.resultCount !== null && context.resultCount !== m.result_count) throw new Error('Result count changed unexpectedly');
          context.resultCount = m.result_count;
        }
        hooks.status(m.state, 'yellow');
        if (m.state === 'cancelled') await serial(async () => {
          if (!same(target)) return;
          jobs.delete(m.request_id); if (active?.rid === m.request_id) active = null;
          await persist(); if (!busy) await selectNext();
        });
      } else if (m.type === 'error') { hooks.status((m.stage || 'Session') + ': ' + m.error, 'darkred'); }
      else if (m.type === 'acknowledged' && jobs.has(m.request_id)) {
        await serial(async () => {
          if (!same(target)) return;
          const context = jobs.get(m.request_id);
          if (!context || !Number.isInteger(m.index) || m.index < 0 || (context.resultCount !== null && m.index >= context.resultCount)) return;
          context.inserted.add(m.index); context.uncertain.delete(m.index); context.acknowledged.add(m.index); context.results.delete(m.index);
          if (active?.rid === m.request_id && active.index === m.index) active = null;
          if (context.resultCount !== null && context.acknowledged.size === context.resultCount) jobs.delete(m.request_id);
          await persist(); if (!busy) await selectNext();
        });
      } else if (m.type === 'result' && jobs.has(m.request_id) && typeof m.image === 'string' && Number.isInteger(m.index)) {
        await serial(async () => {
          if (!same(target)) return;
          const context = jobs.get(m.request_id);
          if (!context || !Number.isInteger(m.result_count) || m.result_count <= 0 || m.index < 0 || m.index >= m.result_count) return;
          if (context.resultCount !== null && context.resultCount !== m.result_count) throw new Error('Result count changed unexpectedly');
          context.resultCount = m.result_count;
          if (context.inserted.has(m.index)) { send('ack', {request_id: m.request_id, index: m.index}); return; }
          context.results.set(m.index, m.image);
          await persist();
          // Bytes remain on the server until confirmed insertion. Receipt alone is not durable delivery.
          send('received', {request_id: m.request_id, index: m.index});
          if (!busy) await selectNext();
          hooks.status(context.uncertain.has(m.index) ? 'Interrupted insertion: review original document layers before retrying' : 'Result ready — use the existing insert action', 'green');
        });
      }
    } catch (error) { hooks.status('Result: ' + error.message, 'darkred'); }
  });
  async function capture(config) {
    if (busy) return;
    busy = true;
    const target = owner();
    try {
      await loaded;
      if (loadError) throw loadError;
      if (!ready) throw new Error('Web panel is not ready; open it and sign in');
      const doc = hooks.document();
      if (!doc) throw new Error('No open Photoshop document');
      const rid = randomID(), documentID = doc.id;
      const canvasBase64 = await hooks.canvas();
      const bounds = hooks.bounds();
      const capturedBounds = bounds ? {...bounds} : null;
      if (hooks.document()?.id !== documentID || !same(target)) throw new Error('Document or Web panel changed during export');
      const maskBase64 = await hooks.mask();
      const configdata = await config();
      if (hooks.document()?.id !== documentID || !same(target) || !ready || !canvasBase64 || !maskBase64
          || JSON.stringify(hooks.bounds()) !== JSON.stringify(capturedBounds)) throw new Error('Canvas/mask export failed, or document/selection changed');
      const context = {documentID, documentName: doc.title || doc.name || String(documentID), sourceDocumentID: documentID, needsDocumentReview: false, maskBase64, bounds: capturedBounds, resultCount: null, results: new Map(), inserted: new Set(), uncertain: new Set(), acknowledged: new Set()};
      await serial(async () => {
        if (!same(target) || !ready) throw new Error('Web panel changed during export');
        jobs.set(rid, context);
        try { await persist(); } catch (error) { jobs.delete(rid); throw error; }
        send('generate', {request_id: rid, payload: {canvasBase64, maskBase64, configdata, document_id: String(documentID), bounds: capturedBounds}}, target);
      });
      hooks.status('Uploading', 'yellow');
    } catch (error) { hooks.status('Upload: ' + error.message, 'darkred'); }
    finally { busy = false; await serial(() => selectNext()); }
  }
  async function ask(title, message, choices) {
    if (hooks.confirm) return hooks.confirm(title, message, choices);
    const dialog = document.createElement('dialog');
    const body = document.createElement('sp-body'); body.textContent = message;
    const footer = document.createElement('footer');
    for (const [value, label] of choices) {
      const button = document.createElement('sp-button'); button.textContent = label;
      button.addEventListener('click', () => dialog.close(value)); footer.appendChild(button);
    }
    dialog.appendChild(body); dialog.appendChild(footer); document.body.appendChild(dialog);
    try { return await dialog.uxpShowModal({title, resize: 'none', size: {width: 520, height: 300}}); }
    finally { dialog.remove(); }
  }
  async function beforeInsert() {
    if (!enabled()) return null;
    if (busy || preparingInsert) throw new Error('Canvas export/insertion is busy');
    preparingInsert = true;
    try {
      return await serial(async () => {
        if (busy) throw new Error('Canvas export/insertion is busy');
        busy = true;
        try {
          if (!ready) throw new Error('Reconnect the Web panel before inserting a team result');
          await selectNext();
          // Make uncertain results reachable from the existing Insert action.
          if (!active) {
            for (const [rid, context] of jobs) {
              const index = [...context.results.keys()].find(i => context.uncertain.has(i) && !context.quarantined);
              if (index === undefined) continue;
              const target = owner(); await hooks.preview(context.results.get(index));
              if (!same(target)) throw new Error('Web panel changed');
              active = {rid, index, context, owner: target}; break;
            }
          }
          if (!active) throw new Error('No team result is ready');
          const chosen = active;
          if (chosen.context.needsDocumentReview) {
            const doc = hooks.document();
            if (!doc) throw new Error('Open the original Photoshop document first');
            const answer = await ask('Reconnect original document',
              `This result came from "${chosen.context.documentName || chosen.context.sourceDocumentID}" before the panel reloaded. Is the currently selected document "${doc.title || doc.name || doc.id}" the original? Cancel to inspect or switch documents, then click Insert again.`,
              [['cancel', 'Cancel'], ['rebind', 'Use this original document']]);
            if (answer !== 'rebind') throw new Error('Recovery cancelled; select and explicitly rebind the original document to continue');
            if (!same(chosen.owner) || hooks.document()?.id !== doc.id) throw new Error('Document or Web panel changed during confirmation');
            chosen.context.documentID = doc.id; chosen.context.needsDocumentReview = false; await persist();
          }
          if (chosen.context.uncertain.has(chosen.index)) {
            await hooks.activate(chosen.context.documentID);
            const answer = await ask('Review interrupted insertion',
              'An earlier insertion may already have created a layer. Cancel to inspect the original document. Mark inserted only if this preview is already present. Retry only after removing any partial layer from that attempt.',
              [['cancel', 'Cancel'], ['inserted', 'Already inserted'], ['retry', 'Retry after review']]);
            if (!same(chosen.owner) || hooks.document()?.id !== chosen.context.documentID) throw new Error('Document or Web panel changed during confirmation');
            if (!['inserted', 'retry'].includes(answer)) throw new Error('Interrupted insertion needs manual layer review; request retained');
            chosen.context.uncertain.delete(chosen.index);
            if (answer === 'inserted') {
              chosen.context.inserted.add(chosen.index); active = null; await persist();
              send('ack', {request_id: chosen.rid, index: chosen.index}, chosen.owner);
              busy = false; await selectNext(); return {skip: true};
            }
            await persist();
          }
          if (chosen.context.inserted.has(chosen.index)) throw new Error('This result has already been inserted');
          insertion = chosen;
          await hooks.activate(insertion.context.documentID);
          if (!same(insertion.owner) || hooks.document()?.id !== insertion.context.documentID) throw new Error('Original document or Web panel changed');
          previousPlacement = hooks.setBounds(insertion.context.bounds);
          // fg/dg use Photoshop's real selection. Compare its complete exported mask,
          // including arbitrary shape, rather than trusting the captured bounds alone.
          const currentMask = await hooks.mask();
          if (!insertion.context.maskBase64 || currentMask !== insertion.context.maskBase64
              || JSON.stringify(hooks.bounds()) !== JSON.stringify(insertion.context.bounds)
              || hooks.document()?.id !== insertion.context.documentID || !same(insertion.owner)) {
            throw new Error('Original Photoshop selection/mask changed; restore it before inserting this result');
          }
          insertion.context.uncertain.add(insertion.index);
          await persist(); // Record intent before Photoshop mutates any layer.
          return insertion.context;
        } catch (error) {
          if (previousPlacement && hooks.restoreBounds) hooks.restoreBounds(previousPlacement);
          previousPlacement = null; insertion = null; busy = false; throw error;
        }
      });
    } finally { preparingInsert = false; }
  }
  async function afterInsert(success) {
    if (!enabled() && !insertion) return;
    return serial(async () => {
      if (!insertion) return;
      const finished = insertion; insertion = null;
      try {
        if (success) {
          finished.context.inserted.add(finished.index); finished.context.uncertain.delete(finished.index);
          if (active === finished) active = null;
        } else {
          // A failed Photoshop command can leave a partial layer. Never blindly insert it again.
          if (active === finished) active = null;
          hooks.status('Insertion interrupted: review the original document for partial layers before retrying', 'orange');
        }
        if (jobs.get(finished.rid) !== finished.context) {
          const saved = journal.connections[finished.owner.origin]?.sessions?.[finished.owner.session];
          if (saved) saved.jobs = saved.jobs.map(([rid, value]) => [rid, rid === finished.rid ? stateFor(finished.context) : value]);
        }
        await persist();
        if (success && same(finished.owner) && ready) send('ack', {request_id: finished.rid, index: finished.index}, finished.owner);
      } finally {
        if (previousPlacement && hooks.restoreBounds) hooks.restoreBounds(previousPlacement);
        previousPlacement = null; busy = false;
        if (success) await selectNext();
      }
    });
  }
  async function resolveInsertion(rid, index, wasInserted) {
    // Explicit operator recovery after checking Photoshop layers; never called automatically.
    return serial(async () => {
      if (busy) throw new Error('Canvas export/insertion is busy');
      const context = jobs.get(rid);
      if (!context?.uncertain.has(index) || typeof wasInserted !== 'boolean') throw new Error('No interrupted insertion to resolve');
      context.uncertain.delete(index);
      if (wasInserted) context.inserted.add(index);
      await persist();
      if (wasInserted && ready) send('ack', {request_id: rid, index});
      await selectNext();
    });
  }
  async function rebindDocument(rid, documentID) {
    // Operator must inspect the actual document after a panel/app restart. Numeric
    // Photoshop IDs alone are not persistent identities and can be reused by the host.
    return serial(async () => {
      if (busy || !ready) throw new Error('Reconnect and finish the current operation before rebinding');
      const context = jobs.get(rid), doc = hooks.document();
      if (!context || !doc || doc.id !== documentID) throw new Error('Select and verify the original Photoshop document first');
      context.documentID = documentID; context.needsDocumentReview = false;
      await persist();
    });
  }
  function control(payload) {
    if (!ready) { hooks.status('Web panel is not ready', 'orange'); return; }
    send('control', {payload});
  }
  function cancel(rid) {
    if (busy || !ready || !jobs.has(rid)) throw new Error('Request cannot be cancelled now');
    send('cancel', {request_id: rid});
  }
  return {enabled, connect, capture, control, beforeInsert, afterInsert, resolveInsertion, rebindDocument, cancel};
};
