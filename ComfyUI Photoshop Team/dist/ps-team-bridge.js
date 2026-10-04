/* Runtime bridge for the restored v1.9.3 package. No UI replacement or rebuild. */
globalThis.createPSTeamBridge = function (hooks) {
  const protocol = 'ps-team-1';
  const randomID = () => Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const panel = randomID();
  let jobs = new Map(), journal = {version: 2, revision: 0, connections: {}};
  let transport = 'company', connectionKey = null, account = null;
  let ready = false, session = null, origin = null, busy = false, active = null;
  let view = null, epoch = 0, insertion = null, previousPlacement = null, loadError = null, preparingInsert = false;
  let connectionAttempt = 0, connectionBlocked = false, viewLoadFailed = false;
  const watchedViews = new WeakSet();
  let native = null, nativeMode = false, nativeState = null;
  let appliedTeamMode = null, appliedURL = null;
  let nativeSelectionVersion = 0;
  let nativeStatusKey = '';
  function updateNativeStatus(state) {
    if (!nativeMode) return;
    const diagnostic = state.diagnostic || {};
    const stage = ['check_session', 'clear_session', 'verify_signout', 'submit_login', 'verify_login', 'sign_out', 'bind_session', 'list_workspaces', 'request'].includes(diagnostic.stage) ? diagnostic.stage : '';
    const code = ['network_error', 'request_timeout', 'response_invalid', 'response_timeout', 'unauthorized', 'forbidden', 'http_error', 'cookie_not_cleared', 'cookie_not_confirmed', 'account_mismatch'].includes(diagnostic.code) ? diagnostic.code : '';
    const status = Number.isInteger(diagnostic.http_status) && diagnostic.http_status >= 100 && diagnostic.http_status <= 599 ? diagnostic.http_status : null;
    const key = JSON.stringify([state.status, !!state.authenticated, !!state.error, stage, code, status]);
    if (key === nativeStatusKey) return;
    nativeStatusKey = key;
    if (state.status === 'connecting') hooks.status('Checking native session', 'orange');
    else if (state.status === 'signing_in') hooks.status('Signing in through native connection', 'orange');
    else if (state.status === 'auth_pending') hooks.status('Earlier sign-in is still pending; wait before retrying', 'orange');
    else if (code === 'unauthorized' && stage === 'check_session') hooks.status('Sign in through the native panel', 'orange');
    else if (state.error) diagnosticStatus('Native connection failed' + (stage ? ' [' + stage + (code ? ': ' + code : '') + (status ? ', HTTP ' + status : '') + ']' : '; see Team workspace'), 'darkred');
    else if (!state.authenticated) hooks.status('Sign in through the native panel', 'orange');
    else if (state.ready) hooks.status('Connected', 'green');
    else hooks.status('Signed in; connecting Team session', 'orange');
  }
  function nativeEnabled(url = appliedURL || hooks.url()) {
    try { return typeof globalThis.createPSNativeTransport === 'function' && parseURL(url).transport === 'company' && enabled(url); } catch { return false; }
  }
  function nativeTransport() {
    if (!native && typeof globalThis.createPSNativeTransport === 'function') {
      native = globalThis.createPSNativeTransport({
        fetch: hooks.fetch || ((...args) => globalThis.fetch(...args)),
        load: hooks.loadNative, save: hooks.saveNative,
        emit: message => { if (nativeMode) Promise.resolve(receiveMessage(message, true)).catch(() => {}); },
        onState: state => {
          nativeState = state;
          if (state.selectionVersion !== nativeSelectionVersion) nativeSelectionVersion = state.selectionVersion;
          if (nativeMode && !state.authenticated) { ready = false; active = null; }
          updateNativeStatus(state);
          try { hooks.nativeState?.(state); } catch {}
        }
      });
    }
    return native;
  }
  let presentationChain = Promise.resolve(), saveChain = Promise.resolve();
  // UXP is not a browser: older supported hosts have no WHATWG URL constructor.
  // Use the same strict parser for navigation, transport selection and origin checks.
  function parseURL(value, loopbackDefaults = false) {
    const invalid = () => { throw new Error('Enter a valid HTTP or HTTPS server address without credentials'); };
    if (typeof value !== 'string' || !value || /[\s\u0000-\u001f\u007f-\u009f\\]/.test(value) || /%(?![a-f\d]{2})/i.test(value)) invalid();
    if (value === '127.0.0.1:8187') value = 'https://' + value;
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = 'http://' + value;
    const match = /^(https?|wss?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(value);
    if (!match) invalid();
    const scheme = match[1].toLowerCase().replace(/^ws/, 'http');
    const authority = match[2];
    let hostname, port = '';
    if (authority[0] === '[') {
      const ipv6 = /^\[([a-f\d:]+)\](?::(\d+))?$/i.exec(authority);
      if (!ipv6) invalid();
      const parts = ipv6[1].toLowerCase().split('::');
      if (parts.length > 2) invalid();
      const left = parts[0] ? parts[0].split(':') : [], right = parts[1] ? parts[1].split(':') : [];
      if (![...left, ...right].every(part => /^[a-f\d]{1,4}$/.test(part))) invalid();
      const missing = 8 - left.length - right.length;
      if ((parts.length === 1 && missing !== 0) || (parts.length === 2 && missing < 1)) invalid();
      const words = [...left, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...right].map(part => parseInt(part, 16).toString(16));
      let bestStart = -1, bestLength = 1;
      for (let start = 0; start < words.length;) {
        if (words[start] !== '0') { start++; continue; }
        let end = start; while (end < words.length && words[end] === '0') end++;
        if (end - start > bestLength) { bestStart = start; bestLength = end - start; }
        start = end;
      }
      hostname = '[' + (bestStart < 0 ? words.join(':') : words.slice(0, bestStart).join(':') + '::' + words.slice(bestStart + bestLength).join(':')) + ']';
      port = ipv6[2] || '';
    } else {
      const host = /^([a-z\d.-]+)(?::(\d+))?$/i.exec(authority);
      if (!host) invalid();
      hostname = host[1].toLowerCase(); port = host[2] || '';
      if (hostname.length > 253 || !hostname.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) invalid();
      // Reject browser-specific octal/hex/short IPv4 spellings rather than trust
      // an origin that the WebView may interpret as another host.
      if (/^(?:\d+|0x[a-f\d]+)$/i.test(hostname.split('.').pop())) {
        const octets = hostname.split('.');
        if (octets.length !== 4 || !octets.every(part => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) invalid();
      }
    }
    if (port && (port.length > 5 || Number(port) > 65535)) invalid();
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
    if (!port && loopback && loopbackDefaults) port = scheme === 'https' ? '8187' : '8188';
    if (port) port = String(Number(port));
    const navigationPort = port;
    if (port === (scheme === 'https' ? '443' : '80')) port = '';
    const origin = scheme + '://' + hostname + (port ? ':' + port : '');
    let selected = null;
    for (const item of (match[4] || '').slice(1).split('&')) {
      const split = item.indexOf('='), key = split < 0 ? item : item.slice(0, split), raw = split < 0 ? '' : item.slice(split + 1);
      let name; try { name = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { invalid(); }
      if (name !== 'ps_transport') continue;
      if (selected !== null) invalid();
      try { selected = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { invalid(); }
    }
    return {origin, hostname, loopback, transport: selected === 'standalone' ? 'standalone' : 'company',
      url: (loopback && navigationPort && !port ? scheme + '://' + hostname + ':' + navigationPort : origin) + (match[3] || '') + (match[4] || '') + (match[5] || '')};
  }
  function safeMessage(error, eventURL) {
    let message = String(error?.message || error || 'Unknown error');
    if (eventURL) message = message.split(String(eventURL)).join('[page]');
    return message.replace(/(?:https?|wss?):\/\/[^\s\"'<>]+/gi, '[address]')
      .replace(/\?[^\s\"'<>]*/g, '[query]')
      .replace(/\b(?:proxy-authorization|authorization|set-cookie|cookie)[\"']?\s*[:=]\s*[^\r\n]*/gi, '[credentials redacted]')
      .replace(/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|password|passwd|secret|session(?:[_-]?(?:id|key|token))?)[\"']?\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)/gi, '[credential redacted]')
      .replace(/\b(?:Bearer|Basic)\s+[a-z\d._~+/=-]+/gi, '[authorization redacted]')
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 240);
  }
  function diagnosticStatus(message, color) {
    hooks.status(message, color);
    // Diagnostics must never interrupt connection recovery. The status and log
    // receive the same pre-sanitized text, never the WebView event or raw URL.
    try { hooks.diagnostic?.(message); } catch {}
  }
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
        const connection = journal.connections[connectionKey] ||= {session, sessions: {}};
        connection.session = session;
        connection.sessions[session] = {account, jobs: [...jobs].map(([rid, context]) => [rid, stateFor(context)])};
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
  function same(owner) { return owner.epoch === epoch && owner.origin === origin && owner.session === session && owner.transport === transport; }
  function owner() { return {epoch, origin, session, transport, connectionKey}; }
  function send(type, values = {}, target = owner()) {
    if (!same(target) || !origin) throw new Error('Connection changed; reconnect to resume the saved request');
    const message = {...values, protocol, panel, session_id: session, transport, type};
    if (nativeMode) {
      Promise.resolve(nativeTransport().receive(message)).catch(error => { if (same(target)) diagnosticStatus('Native connection: ' + safeMessage(error), 'darkred'); });
      return;
    }
    if (!view) throw new Error('Web panel changed; reconnect to resume the saved request');
    view.postMessage(message, origin);
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
  function enabled(url) {
    if (arguments.length === 0 && appliedTeamMode !== null) return appliedTeamMode;
    try { return !parseURL(url === undefined ? hooks.url() : url).loopback; } catch { return true; }
  }
  async function disconnectLocal(url) {
    if (busy || insertion) throw new Error('Finish the current canvas export or insertion before switching connection');
    ready = false; active = null; epoch++; connectionBlocked = true;
    const expected = ++connectionAttempt;
    await loaded;
    if (expected !== connectionAttempt) return false;
    return await serial(async () => {
      if (expected !== connectionAttempt) return false;
      if (origin) await persist();
      if (expected !== connectionAttempt) return false;
      if (native) await native.disconnect();
      if (expected !== connectionAttempt) return false;
      nativeMode = false; nativeState = null; view = null;
      origin = null; session = null; account = null; connectionKey = null; jobs = new Map();
      appliedTeamMode = false; appliedURL = url;
      return true;
    });
  }
  function attachView(current) {
    if (nativeMode) return; // Optional editor load events do not own the native data channel.
    if (current === view) return;
    view = current; ready = false; active = null; viewLoadFailed = false; epoch++;
    if (!current || watchedViews.has(current)) return;
    watchedViews.add(current);
    current.addEventListener('loadstart', () => {
      if (nativeMode || view !== current) return;
      ready = false; epoch++; active = null; viewLoadFailed = false;
      if (enabled()) hooks.status('Loading Web panel', 'orange');
    });
    current.addEventListener('loaderror', event => {
      if (nativeMode || view !== current || !enabled()) return;
      ready = false; epoch++; active = null; viewLoadFailed = true;
      const code = typeof event.code === 'number' && Number.isFinite(event.code) ? ' (' + event.code + ')' : '';
      const message = event.code === -1022
        ? 'Web panel blocked (-1022): macOS ATS requires valid HTTPS'
        : 'Web panel failed to load' + code + ': ' + safeMessage(event.message || 'Check the server address and connection', event.url);
      diagnosticStatus(message, 'darkred');
    });
    current.addEventListener('loadstop', event => {
      if (nativeMode || view !== current || !enabled() || !origin || connectionBlocked || viewLoadFailed) return;
      let loadedOrigin;
      try { loadedOrigin = parseURL(event.url || current.src).origin; } catch {
        ready = false; epoch++; active = null;
        diagnosticStatus('Web panel loaded an unsupported address', 'darkred'); return;
      }
      if (loadedOrigin !== origin) {
        ready = false; epoch++; active = null;
        diagnosticStatus('Web panel redirected to another origin (' + loadedOrigin + '). Verify the address, then apply it explicitly', 'orange'); return;
      }
      if (!ready) {
        diagnosticStatus('Web page loaded; waiting for team connection', 'orange');
        try { send('hello', helloState()); } catch (error) { diagnosticStatus('Connection: ' + safeMessage(error), 'darkred'); }
      }
    });
  }
  function helloState() {
    const sessions = journal.connections[connectionKey]?.sessions || {};
    return {session_ids: Object.keys(sessions), session_owners: Object.fromEntries(Object.entries(sessions)
      .filter(([, saved]) => saved.jobs?.length && saved.account).map(([sid, saved]) => [sid, saved.account]))};
  }
  async function connect(url) {
    if (busy || insertion) { hooks.status('Finish canvas export or insertion before switching connection', 'orange'); return false; }
    ready = false; active = null; epoch++; connectionBlocked = true;
    const expected = ++connectionAttempt;
    viewLoadFailed = false;
    try {
      const parsed = parseURL(url, true);
      const next = parsed.origin;
      const nextTransport = parsed.transport;
      const useNative = nativeEnabled(url);
      const nextKey = nextTransport === 'standalone' ? next + '#ps_transport=standalone' : next;
      await loaded;
      if (expected !== connectionAttempt) return false;
      if (loadError) throw loadError;
      return await serial(async () => {
        if (expected !== connectionAttempt) return false;
        if (connectionKey !== nextKey) {
          if (origin) await persist();
          if (expected !== connectionAttempt) return false;
          origin = next; transport = nextTransport; connectionKey = nextKey;
          const saved = journal.connections[connectionKey];
          session = saved?.session || null; account = saved?.sessions?.[session]?.account || null; jobs = restore(saved?.sessions?.[session]); active = null;
        }
        if (nativeMode && !useNative && native) await native.disconnect();
        if (expected !== connectionAttempt) return false;
        if (nativeMode && !useNative) nativeState = null;
        nativeMode = useNative; if (nativeMode) viewLoadFailed = false;
        appliedTeamMode = true; appliedURL = parsed.url;
        connectionBlocked = false;
        if (nativeMode) {
          nativeStatusKey = '';
          hooks.status('Connecting native data channel', 'orange');
          const connected = await nativeTransport().connect(next);
          if (expected !== connectionAttempt) return false;
          updateNativeStatus(nativeTransport().getState());
          send('hello', helloState());
          return connected !== false;
        }
        attachView(document.querySelector('webview'));
        if (!viewLoadFailed) {
          hooks.status('Open Web panel and sign in', 'orange');
          // A WebView can exist before its messaging channel is usable. Keep a
          // valid initialized connection retryable on loadstop/the interval.
          if (view) {
            try { send('hello', helloState()); }
            catch (error) { diagnosticStatus('Connection: ' + safeMessage(error), 'darkred'); }
          }
        }
        return true;
      });
    } catch (error) {
      if (expected === connectionAttempt) {
        connectionBlocked = true; ready = false;
        diagnosticStatus('Connection: ' + safeMessage(error), 'darkred');
      }
      return false;
    }
  }
  setInterval(() => {
    if (!enabled() || loadError || nativeMode) return;
    attachView(document.querySelector('webview'));
    if (view && origin && !ready && !connectionBlocked && !viewLoadFailed) { try { send('hello', helloState()); } catch {} }
  }, 3000);
  window.addEventListener('message', event => {
    if (nativeMode || !view || event.source !== view || event.origin !== origin) return;
    return receiveMessage(event.data, false);
  });
  async function receiveMessage(m, nativeMessage = false) {
    if (nativeMessage !== nativeMode || connectionBlocked || (!nativeMode && viewLoadFailed) || !m || m.protocol !== protocol || m.panel !== panel || m.transport !== transport) return;
    if (m.type !== 'ready' && m.session_id !== session) return;
    const target = owner();
    let reportTarget = target;
    try {
      if (m.type === 'ready') {
        if (typeof m.session_id !== 'string' || !m.session_id || (transport === 'standalone' && (typeof m.account_id !== 'string' || !m.account_id))) return;
        await serial(async () => {
          if (!same(target)) return;
          if (session && session !== m.session_id) {
            hooks.status('Login changed: previous requests remain bound to the old session', 'orange');
            await persist();
            if (!same(target) || connectionBlocked || viewLoadFailed) return;
            jobs = restore(journal.connections[connectionKey]?.sessions?.[m.session_id]); active = null; epoch++;
          }
          session = m.session_id; account = m.account_id || null;
          const readyOwner = owner();
          reportTarget = readyOwner;
          await persist();
          if (!same(readyOwner) || connectionBlocked || viewLoadFailed) return;
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
          await persist();
          if (!same(target) || connectionBlocked || viewLoadFailed) return;
          if (!busy) await selectNext();
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
          await persist();
          if (!same(target) || connectionBlocked || viewLoadFailed) return;
          if (!busy) await selectNext();
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
          if (!same(target) || connectionBlocked || viewLoadFailed) return;
          // Bytes remain on the server until confirmed insertion. Receipt alone is not durable delivery.
          send('received', {request_id: m.request_id, index: m.index}, target);
          if (!busy) await selectNext();
          if (!same(target) || connectionBlocked || viewLoadFailed) return;
          hooks.status(context.uncertain.has(m.index) ? 'Interrupted insertion: review original document layers before retrying' : 'Result ready — use the existing insert action', 'green');
        });
      }
    } catch (error) {
      if (same(reportTarget) && !connectionBlocked && !viewLoadFailed) hooks.status('Result: ' + error.message, 'darkred');
    }
  }
  async function capture(config) {
    if (busy) return;
    busy = true;
    const target = owner();
    const captureSelection = nativeSelectionVersion;
    const selectionUnchanged = () => !nativeMode || (captureSelection === nativeSelectionVersion && nativeState?.canGenerate);
    try {
      await loaded;
      if (loadError) throw loadError;
      if (!ready) throw new Error(nativeMode ? 'Sign in through the native panel first' : 'Web panel is not ready; open it and sign in');
      if (!selectionUnchanged()) throw new Error('Choose a prepared workflow in the native panel first');
      const doc = hooks.document();
      if (!doc) throw new Error('No open Photoshop document');
      const rid = randomID(), documentID = doc.id;
      const canvasBase64 = await hooks.canvas();
      const bounds = hooks.bounds();
      const capturedBounds = bounds ? {...bounds} : null;
      if (hooks.document()?.id !== documentID || !same(target) || !selectionUnchanged()) throw new Error('Document or connection changed during export');
      const maskBase64 = await hooks.mask();
      const configdata = await config();
      if (hooks.document()?.id !== documentID || !same(target) || !selectionUnchanged() || !ready || !canvasBase64 || !maskBase64
          || JSON.stringify(hooks.bounds()) !== JSON.stringify(capturedBounds)) throw new Error('Canvas/mask export failed, or document/selection changed');
      const context = {documentID, documentName: doc.title || doc.name || String(documentID), sourceDocumentID: documentID, needsDocumentReview: false, maskBase64, bounds: capturedBounds, resultCount: null, results: new Map(), inserted: new Set(), uncertain: new Set(), acknowledged: new Set()};
      await serial(async () => {
        if (!same(target) || !ready || !selectionUnchanged()) throw new Error('Connection or workflow changed during export');
        jobs.set(rid, context);
        try { await persist(); } catch (error) { jobs.delete(rid); throw error; }
        if (!same(target) || !ready || !selectionUnchanged()) {
          jobs.delete(rid); await persist();
          throw new Error('Connection or workflow changed while saving the request');
        }
        send('generate', {request_id: rid, selection_version: captureSelection, payload: {canvasBase64, maskBase64, configdata, document_id: String(documentID), bounds: capturedBounds}}, target);
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
          if (!ready) throw new Error('Reconnect the data channel before inserting a team result');
          await selectNext();
          // Make uncertain results reachable from the existing Insert action.
          if (!active) {
            for (const [rid, context] of jobs) {
              const index = [...context.results.keys()].find(i => context.uncertain.has(i) && !context.quarantined);
              if (index === undefined) continue;
              const target = owner(); await hooks.preview(context.results.get(index));
              if (!same(target)) throw new Error('Connection changed');
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
            if (!same(chosen.owner) || hooks.document()?.id !== doc.id) throw new Error('Document or connection changed during confirmation');
            chosen.context.documentID = doc.id; chosen.context.needsDocumentReview = false; await persist();
          }
          if (chosen.context.uncertain.has(chosen.index)) {
            await hooks.activate(chosen.context.documentID);
            const answer = await ask('Review interrupted insertion',
              'An earlier insertion may already have created a layer. Cancel to inspect the original document. Mark inserted only if this preview is already present. Retry only after removing any partial layer from that attempt.',
              [['cancel', 'Cancel'], ['inserted', 'Already inserted'], ['retry', 'Retry after review']]);
            if (!same(chosen.owner) || hooks.document()?.id !== chosen.context.documentID) throw new Error('Document or connection changed during confirmation');
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
          if (!same(insertion.owner) || hooks.document()?.id !== insertion.context.documentID) throw new Error('Original document or connection changed');
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
          const saved = journal.connections[finished.owner.connectionKey]?.sessions?.[finished.owner.session];
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
    if (nativeMode) { hooks.status('Use native workflow and parameter controls; editor mode changes require a new prepared workflow', 'orange'); return; }
    if (!ready) { hooks.status('Data channel is not ready', 'orange'); return; }
    send('control', {payload});
  }
  function cancel(rid) {
    if (busy || !ready || !jobs.has(rid)) throw new Error('Request cannot be cancelled now');
    send('cancel', {request_id: rid});
  }
  return {enabled, canSwitch:()=>!busy&&!insertion&&!preparingInsert, nativeEnabled, getNativeTransport: nativeTransport, disconnectLocal, normalizeURL: url => parseURL(url, true).url, watchView: attachView, connect, capture, control, beforeInsert, afterInsert, resolveInsertion, rebindDocument, cancel};
};
