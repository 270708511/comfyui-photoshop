/* Company transport for UXP. This is a private bridge peer, never a window-message listener.
 * Authentication uses the existing login cookie only. No password or cookie is journaled.
 * The separate network journal contains immutable source images and must be stored privately.
 */
globalThis.createPSNativeTransport = function (hooks = {}) {
  const VERSION = 'ps-team-1', JOURNAL_VERSION = 1, MAX_RETRIES = 5, MAX_SUBMITS = 3;
  const REQUEST_TIMEOUT = Number.isFinite(hooks.requestTimeout) && hooks.requestTimeout > 0 ? hooks.requestTimeout : 30000;
  const fetcher = hooks.fetch || globalThis.fetch;
  const delay = hooks.setTimeout || globalThis.setTimeout, cancelDelay = hooks.clearTimeout || globalThis.clearTimeout;
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
  const ridValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  let journal = {version: JOURNAL_VERSION, revision: 0, sessions: []}, loadError = false;
  let origin = null, epoch = 0, workspaceEpoch = 0, selectionEpoch = 0, workspaceListEpoch = 0;
  let binding = null, helloMessage = null, handshake = null, disposed = false;
  let authChain = Promise.resolve(), saveChain = Promise.resolve(), jobs = new Map();
  const listeners = new Set(), authPending = new Set(), safeFaults = new WeakMap(), failureDetails = new WeakMap();
  let authUncertain = false;
  let state = {origin: null, authenticated: false, username: null, ready: false, session_id: null,
    workspace_id: null, workspaces: [], workflows: [], workflow_path: null, selectionVersion: 0,
    parameters: {}, parameter_schema: [], canGenerate: false, status: 'disconnected', error: null, diagnostic: null};
  let selectedPreparation = null, parameterError = false;
  function fault(message, status, code) {
    const error = new Error(message); error.status = status; safeFaults.set(error, {message, code}); return error;
  }
  // Only errors created here contain reviewed text. A host/library rejection may
  // itself carry `safe: true`; it must never authorize exposing its message.
  function safe(error) { return safeFaults.get(error)?.message || 'Connection failed. Check the company server and retry.'; }
  function errorState(error) { return {error: safe(error), diagnostic: failureDetails.get(error) || null}; }
  function requestStage(path) {
    if (path === '/auth/whoami') return 'check_session';
    if (path === '/api/users') return 'list_workspaces';
    if (/^\/ps\/team\/sessions(?:\/[^/?]+)?$/.test(path)) return 'bind_session';
    return 'request';
  }
  function failure(message, stage, code, status, expectedEpoch) {
    // These fields are controlled categories, never URLs, account identifiers,
    // headers, server bodies, or an underlying exception's text/stack.
    const http_status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const error = fault(message, http_status === null ? undefined : http_status, code);
    if (!disposed && expectedEpoch === epoch) failureDetails.set(error, {stage, code, http_status});
    return error;
  }
  function validOrigin(value) {
    // The bridge supplies its canonical origin. Reject credentials, paths and query strings here too.
    if (typeof value !== 'string' || !/^https?:\/\/(?:[a-z\d.-]+|\[[a-f\d:]+\])(?::\d{1,5})?$/i.test(value))
      throw fault('Use a valid company HTTP or HTTPS server origin.');
    return value;
  }
  function validPath(value) {
    return typeof value === 'string' && value.startsWith('workflows/') && /\.json$/i.test(value)
      && !/[\\\x00-\x1f\x7f?#]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
  }
  function getState() {
    return clone({...state, auth_pending: authUncertain && authPending.size > 0, pending: [...jobs].map(([request_id, item]) => ({request_id,
      workspace_id: item.record.workspace_id, document_id: item.record.document_id, workflow_path: item.record.path, state: item.record.state,
      paused: item.paused, result_count: item.record.resultCount, acknowledged: item.record.acknowledged}))});
  }
  function changed(values = {}) {
    Object.assign(state, values);
    state.canGenerate = !!(state.ready && state.workspace_id && selectedPreparation && state.workflow_path && !parameterError);
    const snapshot = getState();
    try { hooks.onState?.(snapshot); } catch {}
    for (const listener of listeners) { try { listener(clone(snapshot)); } catch {} }
  }
  function subscribe(listener) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); }
  function same(owner) { return !disposed && owner && owner === binding && owner.epoch === epoch && owner.origin === origin; }
  function current(item) { return same(item.owner) && jobs.get(item.record.request_id) === item; }
  function host(type, values = {}, owner = binding) {
    if (!same(owner)) return;
    try { const emitted = hooks.emit?.({...values, protocol: VERSION, panel: owner.panel, session_id: owner.session,
      transport: 'company', type}); if (emitted?.catch) emitted.catch(() => {}); } catch {}
  }
  function stopTimers() { for (const item of jobs.values()) if (item.timer != null) { cancelDelay(item.timer); item.timer = null; } }
  function detach(message, status = 'signed_out', diagnostic = null) {
    if (binding) host('unbound', {error: message});
    stopTimers(); epoch++; workspaceEpoch++; selectionEpoch++; workspaceListEpoch++;
    binding = null; handshake = null; jobs = new Map(); selectedPreparation = null; parameterError = false; state.selectionVersion++;
    changed({authenticated: false, username: null, ready: false, session_id: null, workspace_id: null,
      workspaces: [], workflows: [], workflow_path: null, parameters: {}, parameter_schema: [], status, error: message || null,
      diagnostic});
  }
  const loaded = Promise.resolve().then(() => hooks.load?.()).then(value => {
    if (value == null) return;
    if (!object(value) || value.version !== JOURNAL_VERSION || !Number.isSafeInteger(value.revision) || !Array.isArray(value.sessions))
      throw fault('Saved native request journal is invalid. Preserve it and review pending requests before resetting.');
    for (const saved of value.sessions) {
      validOrigin(saved.origin);
      if (typeof saved.account !== 'string' || !saved.account || !id(saved.session) || !Array.isArray(saved.jobs))
        throw fault('Saved native request journal is invalid. Preserve it and review pending requests before resetting.');
      const seen = new Set();
      for (const record of saved.jobs) {
        if (!object(record) || !ridValid(record.request_id) || seen.has(record.request_id)
            || !Array.isArray(record.acknowledged) || !Array.isArray(record.ackPending))
          throw fault('Saved native request journal is invalid. Preserve it and review pending requests before resetting.');
        seen.add(record.request_id);
      }
    }
    journal = clone(value);
  }).catch(() => { loadError = true; changed({error: 'Saved native request journal could not be read. Preserve it before resetting.', status: 'storage_error'}); });
  function persist() {
    const snapshot = clone({...journal, revision: ++journal.revision});
    const next = saveChain.then(async () => {
      if (loadError) throw fault('Saved native request journal could not be read. Preserve it before resetting.');
      if (typeof hooks.save !== 'function') throw fault('Private native request storage is unavailable. Reopen the panel before generating.');
      try { await hooks.save(snapshot); } catch { throw fault('Could not save the request safely. Free storage and reconnect before retrying.'); }
    });
    saveChain = next.catch(() => {}); return next;
  }
  function savedSession(owner, create = false) {
    let saved = journal.sessions.find(entry => entry.origin === owner.origin && entry.account === owner.account && entry.session === owner.session);
    if (!saved && create) { saved = {origin: owner.origin, account: owner.account, session: owner.session, jobs: []}; journal.sessions.push(saved); }
    return saved;
  }
  function deadline(operation, onTimeout) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const timer = delay(() => {
        if (finished) return; finished = true;
        try { onTimeout?.(); } catch {}
        reject(fault('Company request timed out. It may still complete; reconnect or use Resume, not Generate.', undefined, 'request_timeout'));
      }, REQUEST_TIMEOUT);
      Promise.resolve(operation).then(value => {
        if (finished) return; finished = true; cancelDelay(timer); resolve(value);
      }, error => { if (finished) return; finished = true; cancelDelay(timer); reject(error); });
    });
  }
  async function readBody(response, method, stage = 'request', expectedEpoch = epoch) {
    try { return await deadline(Promise.resolve().then(() => response[method]())); }
    catch (error) {
      const timedOut = safeFaults.get(error)?.code === 'request_timeout';
      throw failure(timedOut ? safe(error) : 'The company server returned an unexpected response. Check native cookie login.',
        stage, timedOut ? 'response_timeout' : 'response_invalid', response.status, expectedEpoch);
    }
  }
  function authBlocked() {
    if (!authUncertain || !authPending.size) { authUncertain = false; return false; }
    changed({error: 'An earlier sign-in or sign-out may still complete. Wait for it to finish or reload the panel before reconnecting.', status: 'auth_pending'});
    return true;
  }
  async function request(path, options = {}, owner = null, expectedEpoch = epoch, targetOrigin = origin, stage = requestStage(path)) {
    if (disposed || expectedEpoch !== epoch || (owner && !same(owner))) throw fault('Connection changed. Reconnect to resume saved requests.');
    if (!targetOrigin || !path.startsWith('/') || path.startsWith('//')) throw fault('Invalid company request path.');
    let response;
    const {allowUnauthorized, ...fetchOptions} = options;
    let abort = null;
    const cookieWrite = path === '/login' || path === '/logout';
    const operation = Promise.resolve().then(() => {
      abort = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
      return fetcher(targetOrigin + path, {credentials: 'include', cache: 'no-store', ...fetchOptions,
        ...(abort ? {signal: abort.signal} : {}), headers: {'X-PS-Team': VERSION, ...(options.headers || {})}});
    });
    if (cookieWrite) {
      authPending.add(operation);
      const settled = () => { authPending.delete(operation); if (!disposed) changed(); };
      operation.then(settled, settled);
    }
    try { response = await deadline(operation, () => {
      if (cookieWrite) authUncertain = true;
      if (abort) abort.abort();
    }); }
    catch (error) {
      const timedOut = safeFaults.get(error)?.code === 'request_timeout';
      const message = cookieWrite && authUncertain
        ? 'Sign-in or sign-out timed out and may still complete. Wait for it to finish or reload the panel before reconnecting.'
        : timedOut ? safe(error) : 'Network request failed. Saved requests can be resumed without generating again.';
      throw failure(message, stage, timedOut ? 'request_timeout' : 'network_error', null, expectedEpoch);
    }
    if (disposed || expectedEpoch !== epoch || (owner && !same(owner))) throw fault('Connection changed. Reconnect to resume saved requests.');
    if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status) || response.status < 0 || response.status > 599)
      throw failure('The company server returned an unexpected response. Check native cookie login.', stage, 'response_invalid', null, expectedEpoch);
    if (!response.ok) {
      if (response.status === 401 && allowUnauthorized) return response;
      const status = Number(response.status);
      // Never parse or expose an HTML login page or raw service response.
      const error = failure(status === 401 ? 'Sign in again. Native cookie authentication was not confirmed.' :
        status === 403 ? 'The company server denied this action.' : 'Company request failed (' + status + ').',
        stage, status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'http_error', status, expectedEpoch);
      if (status === 401) detach(safe(error), 'signed_out', failureDetails.get(error));
      throw error;
    }
    return response;
  }
  async function json(path, options = {}, owner = null, expectedEpoch = epoch, targetOrigin = origin, stage = requestStage(path)) {
    const response = await request(path, options, owner, expectedEpoch, targetOrigin, stage);
    const value = await readBody(response, 'json', stage, expectedEpoch);
    if (disposed || expectedEpoch !== epoch || (owner && !same(owner))) throw fault('Connection changed. Reconnect to resume saved requests.');
    return value;
  }
  const body = value => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
  async function whoami(expectedEpoch = epoch, owner = null, stage = 'check_session') {
    const result = await json('/auth/whoami', {}, owner, expectedEpoch, origin, stage);
    if (result?.authenticated !== true || typeof result.username !== 'string' || !result.username) {
      const error = failure('Native cookie login was not confirmed. Check the credentials and UXP cookie support.', stage, 'cookie_not_confirmed', null, expectedEpoch);
      if (expectedEpoch === epoch) detach(safe(error), 'signed_out', failureDetails.get(error));
      throw error;
    }
    if (owner && result.username !== owner.account) {
      const error = failure('The signed-in account changed. Sign in again to resume that account’s requests.', stage, 'account_mismatch', null, expectedEpoch);
      detach(safe(error), 'signed_out', failureDetails.get(error)); throw error;
    }
    return result.username;
  }
  async function authenticate(expectedEpoch, expectedUsername) {
    const stage = expectedUsername ? 'verify_login' : 'check_session';
    const username = await whoami(expectedEpoch, null, stage);
    if (expectedEpoch !== epoch) return false;
    if (expectedUsername && username !== expectedUsername) {
      const error = failure('Login did not establish the requested account. Check credentials and UXP cookie support.', stage, 'account_mismatch', null, expectedEpoch);
      detach(safe(error), 'signed_out', failureDetails.get(error)); return false;
    }
    changed({authenticated: true, username, status: 'authenticated', error: null, diagnostic: null});
    if (helloMessage) await bind(helloMessage);
    if (expectedEpoch === epoch) await refreshWorkspaces();
    return expectedEpoch === epoch && state.authenticated;
  }
  function queuedAuth(action) {
    const next = authChain.then(action); authChain = next.catch(() => {}); return next;
  }
  async function connect(value) {
    if (authBlocked()) return false;
    let next; try { next = validOrigin(value); } catch (error) { changed({error: safe(error), diagnostic: null}); return false; }
    const sameOrigin = next === origin;
    detach(null, 'connecting'); origin = next; state.origin = next;
    if (!sameOrigin) helloMessage = null;
    const token = epoch;
    return queuedAuth(async () => {
      await loaded; if (token !== epoch || disposed || authBlocked()) return false;
      if (loadError) { changed({status: 'storage_error', error: 'Saved native request journal could not be read. Preserve it before resetting.'}); return false; }
      try { return await authenticate(token); }
      catch (error) { if (token === epoch) changed({status: 'login_required', ...errorState(error)}); return false; }
    });
  }
  async function login(username, password) {
    if (authBlocked()) return false;
    if (!origin || typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
      changed({error: 'Enter the company server, username and password.'}); return false;
    }
    username = username.trim(); detach(null, 'signing_in'); const token = epoch, targetOrigin = origin;
    // Cookie-writing authentication operations are serialized, including logout.
    return queuedAuth(async () => {
      await loaded; if (token !== epoch || disposed || loadError || authBlocked()) return false;
      try {
        // A failed /login can be HTTP 200 while an old cookie remains valid. Prove
        // logout first, so whoami cannot mistake that old session for login success.
        await request('/logout', {}, null, token, targetOrigin, 'clear_session');
        const probe = await request('/auth/whoami', {allowUnauthorized: true}, null, token, targetOrigin, 'verify_signout');
        if (probe.status !== 401) {
          const prior = await readBody(probe, 'json', 'verify_signout', token);
          if (prior?.authenticated !== false) throw failure('Server logout did not clear the native cookie. Close the panel and verify UXP cookie support before signing in.',
            'verify_signout', 'cookie_not_cleared', probe.status, token);
        }
        if (token !== epoch || disposed) return false;
        await request('/login', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: 'username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password) + '&next=%2Fauth%2Fwhoami'}, null, token, targetOrigin, 'submit_login');
        password = null;
        return await authenticate(token, username);
      } catch (error) { if (token === epoch) changed({status: 'login_required', ...errorState(error)}); return false; }
      finally { password = null; }
    });
  }
  async function logout() {
    if (authBlocked()) { detach('Sign-out is waiting on an earlier authentication request.', 'auth_pending', state.diagnostic); return false; }
    const targetOrigin = origin; detach(null); const token = epoch;
    return queuedAuth(async () => {
      if (!targetOrigin || token !== epoch || disposed || authBlocked()) return false;
      try { await request('/logout', {}, null, token, targetOrigin, 'sign_out'); return true; }
      catch (error) { if (token === epoch) changed({...errorState(error), error: 'Local session closed. Server logout was not confirmed; reconnect to verify.'}); return false; }
    });
  }
  function itemFor(record, owner) { return {record, owner, buffered: new Set(), ackFlights: new Set(), timer: null, inFlight: false, paused: false, retries: 0, durable: true}; }
  async function bind(message) {
    if (!state.authenticated || !origin || disposed) return false;
    if (state.ready && binding && binding.panel === message.panel && same(binding)) {
      host('ready', {version: VERSION, account_id: binding.account}); return true;
    }
    if (handshake) return handshake;
    const token = epoch, account = state.username;
    handshake = (async () => {
      try {
        const candidates = [...new Set([message.session_id, ...(Array.isArray(message.session_ids) ? message.session_ids : []),
          ...journal.sessions.filter(entry => entry.origin === origin && entry.account === account).map(entry => entry.session)].filter(id))];
        let session;
        for (const candidate of candidates) {
          if (message.session_owners && own(message.session_owners, candidate) && message.session_owners[candidate] !== account) continue;
          try { session = await json('/ps/team/sessions/' + encodeURIComponent(candidate), {}, null, token); break; }
          catch (error) { if (![403, 404, 410].includes(error.status)) throw error; }
          if (token !== epoch) return false;
        }
        if (!session) session = await json('/ps/team/sessions', {method: 'POST'}, null, token);
        if (!id(session?.session_id)) throw fault('The company adapter returned an invalid session.');
        if (token !== epoch || account !== state.username) return false;
        stopTimers(); binding = {origin, epoch: token, account, panel: message.panel, session: session.session_id}; jobs = new Map();
        const saved = savedSession(binding, true);
        for (const record of saved.jobs) jobs.set(record.request_id, itemFor(record, binding));
        await persist(); if (token !== epoch) return false;
        changed({ready: true, session_id: session.session_id, status: 'connected', error: null, diagnostic: null});
        host('ready', {version: VERSION, account_id: account}); return true;
      } catch (error) {
        if (token === epoch) changed({ready: false, status: 'connection_error', ...errorState(error)});
        return false;
      } finally { if (token === epoch) handshake = null; }
    })();
    return handshake;
  }
  async function refreshWorkspaces() {
    if (!state.authenticated) return false;
    const token = epoch, listToken = ++workspaceListEpoch;
    try {
      const data = await json('/api/users', {}, binding, token);
      if (token !== epoch || listToken !== workspaceListEpoch) return false;
      if (!object(data) || (!object(data.users) && !(data.storage === 'server' && typeof data.migrated === 'boolean' && !own(data, 'users'))))
        throw fault('Workspace list is unavailable. Check the company userdata API.');
      const workspaces = object(data.users) ? Object.entries(data.users).filter(([key, value]) => key && typeof value === 'string').map(([key, name]) => ({id: key, name}))
        : [{id: 'default', name: 'Default'}];
      // Authentication can succeed while the adapter/session bind fails. A
      // successful catalog read must not erase the still-blocking bind error.
      changed({workspaces, ...(state.status === 'connection_error' && !state.ready ? {} : {error: null, diagnostic: null})});
      if (state.workspace_id && !workspaces.some(entry => entry.id === state.workspace_id)) await selectWorkspace(null);
      return true;
    } catch (error) { if (token === epoch && listToken === workspaceListEpoch) changed(errorState(error)); return false; }
  }
  async function selectWorkspace(value) {
    if (value !== null && !state.workspaces.some(workspace => workspace.id === value)) throw fault('Choose an available workspace.');
    workspaceEpoch++; selectionEpoch++; selectedPreparation = null; parameterError = false; state.selectionVersion++;
    changed({workspace_id: value, workflows: [], workflow_path: null, parameter_schema: [], parameters: {}, error: null});
    return value === null ? true : refreshWorkflows();
  }
  function preparationPath(workspace, path) { return '/ps/team/workflow-preparations?workspace_id=' + encodeURIComponent(workspace) + '&path=' + encodeURIComponent(path); }
  function validValue(spec, value) {
    if (spec.type === 'string' && typeof value !== 'string') return false;
    if (spec.type === 'boolean' && typeof value !== 'boolean') return false;
    if (['integer', 'number'].includes(spec.type) && (typeof value !== 'number' || !Number.isFinite(value)
        || (spec.type === 'integer' && !Number.isSafeInteger(value)) || (spec.min != null && value < spec.min) || (spec.max != null && value > spec.max))) return false;
    if (spec.type === 'enum' && !spec.options.some(option => option === value)) return false;
    return true;
  }
  function schemaFor(preparation) {
    const schema = preparation?.parameters;
    if (!Array.isArray(schema)) throw fault('Prepared workflow has an invalid parameter schema. Prepare it again in the editor.');
    const ids = new Set();
    for (const spec of schema) {
      if (!object(spec) || !id(spec.id) || ids.has(spec.id) || typeof spec.node_id !== 'string' || typeof spec.input !== 'string'
          || !['string', 'integer', 'number', 'boolean', 'enum'].includes(spec.type) || !own(spec, 'default')
          || (spec.type === 'enum' && (!Array.isArray(spec.options) || !spec.options.length || spec.options.some(option => option !== null && !['string', 'number', 'boolean'].includes(typeof option))))
          || (spec.min != null && !Number.isFinite(spec.min)) || (spec.max != null && !Number.isFinite(spec.max))
          || (spec.min != null && spec.max != null && spec.min > spec.max) || !validValue(spec, spec.default))
        throw fault('Prepared workflow has an invalid parameter schema. Prepare it again in the editor.');
      ids.add(spec.id);
    }
    return clone(schema);
  }
  function inspectPreparation(data, workspace, path) {
    if (!object(data) || data.workspace_id !== workspace || data.path !== path || !['prepared', 'unprepared', 'stale'].includes(data.status))
      throw fault('Workflow preparation response did not match the selected workspace and file.');
    if (data.status === 'prepared') {
      if (!object(data.preparation) || !id(data.preparation.preparation_id) || typeof data.preparation.source_hash !== 'string'
          || data.preparation.source_hash !== data.current_source_hash) throw fault('Workflow preparation needs to be refreshed.');
      schemaFor(data.preparation);
    }
    return data;
  }
  async function refreshWorkflows() {
    if (!state.authenticated || !state.workspace_id) return false;
    const token = epoch, listToken = ++workspaceEpoch, workspace = state.workspace_id;
    selectionEpoch++; selectedPreparation = null; parameterError = false; state.selectionVersion++;
    changed({workflows: [], workflow_path: null, parameter_schema: [], parameters: {}, status: 'loading_workflows', error: null});
    try {
      const data = await json('/api/userdata?dir=workflows&recurse=true&split=false&full_info=true', {headers: {'Comfy-User': workspace}}, binding, token);
      if (!Array.isArray(data)) throw fault('Workflow list is unavailable. Check the company userdata API.');
      const paths = [...new Set(data.map(entry => typeof entry === 'string' ? entry : object(entry) ? entry.path : null)
        .filter(value => typeof value === 'string').map(path => 'workflows/' + path).filter(validPath))];
      const workflows = paths.map(path => ({path, name: path.slice('workflows/'.length), status: 'unprepared', executable: false, parameters: []}));
      let cursor = 0;
      await Promise.all(Array.from({length: Math.min(2, workflows.length)}, async () => {
        while (cursor < workflows.length) {
          const row = workflows[cursor++];
          if (token !== epoch || listToken !== workspaceEpoch) return;
          try {
            const data = inspectPreparation(await json(preparationPath(workspace, row.path), {headers: {'Comfy-User': workspace}}, binding, token), workspace, row.path);
            row.status = data.status; row.reason = typeof data.reason === 'string' && /^[a-z_]{1,64}$/.test(data.reason) ? data.reason : null; row.executable = data.status === 'prepared';
            row.parameters = row.executable ? schemaFor(data.preparation) : [];
          } catch { row.status = 'unavailable'; }
        }
      }));
      if (token !== epoch || listToken !== workspaceEpoch || workspace !== state.workspace_id) return false;
      changed({workflows, status: 'connected', error: null}); return true;
    } catch (error) {
      if (token === epoch && listToken === workspaceEpoch) changed({status: 'workflow_error', ...errorState(error)});
      return false;
    }
  }
  async function selectWorkflow(path) {
    if (!state.workflows.some(workflow => workflow.path === path)) throw fault('Choose a workflow from the selected workspace.');
    const token = epoch, workspace = state.workspace_id, workToken = workspaceEpoch, selectToken = ++selectionEpoch;
    selectedPreparation = null; parameterError = false; state.selectionVersion++;
    changed({workflow_path: path, parameters: {}, parameter_schema: [], error: null});
    try {
      // Read the actual saved UI workflow. Execution uses only the separately prepared API prompt.
      const workflow = await json('/api/userdata/' + encodeURIComponent(path), {headers: {'Comfy-User': workspace}}, binding, token);
      if (!object(workflow)) throw fault('Saved workflow is not a valid JSON object.');
      const data = inspectPreparation(await json(preparationPath(workspace, path), {headers: {'Comfy-User': workspace}}, binding, token), workspace, path);
      if (token !== epoch || workToken !== workspaceEpoch || selectToken !== selectionEpoch) return false;
      const row = state.workflows.find(value => value.path === path); row.status = data.status; row.reason = typeof data.reason === 'string' && /^[a-z_]{1,64}$/.test(data.reason) ? data.reason : null; row.executable = data.status === 'prepared';
      if (data.status !== 'prepared') {
        changed({error: data.status === 'stale' ? 'Workflow changed. Prepare its execution version again in the editor.' : 'This workflow is not prepared for native execution. Prepare it in the editor.'}); return false;
      }
      const schema = schemaFor(data.preparation), values = Object.fromEntries(schema.map(spec => [spec.id, spec.default]));
      selectedPreparation = {workspace_id: workspace, path, source_hash: data.preparation.source_hash,
        preparation_id: data.preparation.preparation_id};
      changed({parameter_schema: schema, parameters: values, error: null}); return true;
    } catch (error) { if (token === epoch && workToken === workspaceEpoch && selectToken === selectionEpoch) changed(errorState(error)); return false; }
  }
  function setParameters(values) {
    if (!selectedPreparation || !object(values)) throw fault('Select a prepared workflow before editing parameters.');
    const schema = state.parameter_schema, merged = {...state.parameters};
    for (const [key, value] of Object.entries(values)) {
      const spec = schema.find(entry => entry.id === key);
      if (!spec || !validValue(spec, value)) {
        parameterError = true; state.selectionVersion++;
        changed({error: 'A workflow parameter is unknown or outside its allowed type or range.'});
        throw fault('A workflow parameter is unknown or outside its allowed type or range.');
      }
      merged[key] = value;
    }
    parameterError = false; state.selectionVersion++; changed({parameters: merged, error: null}); return getState();
  }
  function route(item) { return '/ps/team/sessions/' + encodeURIComponent(item.owner.session) + '/requests/' + item.record.request_id; }
  function retry(item) {
    if (!current(item) || item.timer != null || ['delivered', 'cancelled', 'error', 'failed', 'retry_exhausted'].includes(item.record.state)) return;
    if (item.retries >= MAX_RETRIES) {
      item.paused = true; changed(); host('error', {request_id: item.record.request_id, stage: 'result',
        error: 'Request retained. Use Resume to retry delivery; do not generate again.'}, item.owner); return;
    }
    const wait = item.retryNeeded ? Math.min(1000 * 2 ** item.retries++, 30000) : 2000;
    item.timer = delay(() => { item.timer = null; return pump(item); }, wait);
  }
  function base64(arrayBuffer) {
    if (hooks.encodeBase64) return hooks.encodeBase64(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer), chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', chunks = [];
    let chunk = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
      chunk += chars[a >> 2] + chars[((a & 3) << 4) | ((b || 0) >> 4)]
        + (i + 1 < bytes.length ? chars[((b & 15) << 2) | ((c || 0) >> 6)] : '=')
        + (i + 2 < bytes.length ? chars[c & 63] : '=');
      if (chunk.length >= 32768) { chunks.push(chunk); chunk = ''; }
    }
    chunks.push(chunk); return chunks.join('');
  }
  async function ack(item, index) {
    if (!current(item) || item.ackFlights.has(index)) return;
    item.ackFlights.add(index);
    try {
      if (!item.record.ackPending.includes(index)) { item.record.ackPending.push(index); await persist(); }
      if (!current(item)) return;
      await json(route(item) + '/results/' + index + '/ack', body({}), item.owner);
      if (!current(item)) return;
      item.record.ackPending = item.record.ackPending.filter(value => value !== index);
      if (!item.record.acknowledged.includes(index)) item.record.acknowledged.push(index);
      await persist(); if (!current(item)) return;
      host('acknowledged', {request_id: item.record.request_id, index}, item.owner);
    } finally { item.ackFlights.delete(index); }
  }
  async function pump(item) {
    if (!current(item) || item.inFlight || item.paused) return;
    if (item.timer != null) { cancelDelay(item.timer); item.timer = null; }
    if (['delivered', 'cancelled', 'error', 'failed', 'retry_exhausted'].includes(item.record.state)) return;
    item.inFlight = true; item.retryNeeded = false;
    const record = item.record, rid = record.request_id;
    try {
      if (!item.durable) { await persist(); item.durable = true; }
      if (!current(item)) return;
      await whoami(item.owner.epoch, item.owner);
      let result;
      try { result = await json(route(item), {}, item.owner); }
      catch (error) {
        if (error.status !== 404 || !record.payload || record.submitAttempted) throw error;
        if (record.cancelRequested) { record.state = 'cancelled'; await persist(); host('state', {request_id: rid, state: 'cancelled'}, item.owner); return; }
        record.uploadAttempted = true; await persist(); if (!current(item)) return;
        host('state', {request_id: rid, state: 'uploading'}, item.owner);
        result = await json(route(item) + '/snapshot', {...body(record.payload), method: 'PUT'}, item.owner);
      }
      if (!current(item)) return;
      if (record.cancelRequested && result.state !== 'cancelled') result = await json(route(item), {method: 'DELETE'}, item.owner);
      if (!object(result) || result.request_id !== rid || typeof result.state !== 'string') throw fault('The company adapter returned an invalid request state.');
      record.state = result.state;
      if (record.submitAttempted && !['uploaded', 'local', 'unknown'].includes(result.state)) record.payload = null;
      if (result.state === 'uploaded' && !record.cancelRequested) {
        if (!record.submission) throw fault('Saved workflow submission is unavailable. Preserve this request and review it in the company task history.');
        if ((record.submits || 0) >= MAX_SUBMITS) throw fault('Input is saved but submission needs review. Resume after checking the server.');
        record.submitAttempted = true; record.submits = (record.submits || 0) + 1; await persist(); if (!current(item)) return;
        host('state', {request_id: rid, state: 'submitting'}, item.owner);
        // A lost reply is reconciled by GET status on the next pump, before identical retry.
        await json(route(item) + '/submit', body(record.submission), item.owner);
        record.state = 'submitting'; await persist(); return;
      }
      host('state', {request_id: rid, state: result.state, ...(result.document_id != null ? {document_id: result.document_id} : {}),
        ...(Number.isInteger(result.result_count) ? {result_count: result.result_count} : {})}, item.owner);
      if (result.state === 'success') {
        if (!Number.isInteger(result.result_count) || result.result_count <= 0 || result.result_count > 10000
            || (record.resultCount !== null && record.resultCount !== result.result_count)) throw fault('Result count is invalid or changed. Preserve this request for review.');
        record.resultCount = result.result_count;
        for (const index of result.acknowledged_results || []) {
          if (!Number.isInteger(index) || index < 0 || index >= record.resultCount) throw fault('Invalid server result acknowledgement.');
          if (!record.acknowledged.includes(index)) record.acknowledged.push(index);
          record.ackPending = record.ackPending.filter(value => value !== index);
        }
        await persist(); if (!current(item)) return;
        for (const index of record.acknowledged) host('acknowledged', {request_id: rid, index}, item.owner);
        for (const index of [...record.ackPending]) await ack(item, index);
        if (!current(item)) return;
        if (record.acknowledged.length === record.resultCount) { record.state = 'delivered'; await persist(); changed(); return; }
        for (let index = 0; index < record.resultCount; index++) {
          if (record.acknowledged.includes(index) || item.buffered.has(index) || record.ackPending.includes(index)) continue;
          item.retryNeeded = true;
          const response = await request(route(item) + '/results/' + index, {}, item.owner);
          const data = await readBody(response, 'arrayBuffer', 'request', item.owner.epoch); if (!current(item)) return;
          if (!data.byteLength || data.byteLength > 24 * 1024 * 1024) throw fault('Result image size is invalid.');
          host('result', {request_id: rid, index, result_count: record.resultCount, image: base64(data)}, item.owner);
        }
      } else if (['error', 'failed', 'cancelled', 'retry_exhausted'].includes(result.state)) {
        if (result.state !== 'cancelled') host('error', {request_id: rid, stage: 'generation', error: 'Generation ended without a deliverable result. Check company task history.'}, item.owner);
      } else if (['dispatch_unknown', 'monitor_timeout'].includes(result.state)) {
        item.retryNeeded = true;
        host('error', {request_id: rid, stage: 'generation', error: 'GPU state is unknown. Request retained; do not generate again.'}, item.owner);
      }
      await persist(); changed();
    } catch (error) {
      if (current(item)) {
        item.retryNeeded = true;
        if ([403, 404, 409, 410, 422].includes(error.status)) item.retries = MAX_RETRIES;
        host('error', {request_id: rid, stage: 'result', error: safe(error)}, item.owner);
      }
    } finally { item.inFlight = false; if (current(item)) { changed(); retry(item); } }
  }
  async function generate(message) {
    const rid = message.request_id, owner = binding;
    if (!ridValid(rid)) throw fault('Invalid request identifier.');
    const existing = jobs.get(rid);
    if (existing) {
      if (existing.record.payload && JSON.stringify(existing.record.payload) !== JSON.stringify(message.payload)) throw fault('This request identifier already has different input. Resume the original request.');
      existing.paused = false; existing.retries = 0; await pump(existing); return;
    }
    if (message.selection_version != null && message.selection_version !== state.selectionVersion) throw fault('Workflow selection changed during capture. Capture again before generating.');
    if (!state.canGenerate || !selectedPreparation) throw fault('Choose a workspace and a prepared workflow before generating.');
    if (!object(message.payload) || typeof message.payload.canvasBase64 !== 'string' || !message.payload.canvasBase64
        || typeof message.payload.maskBase64 !== 'string' || !message.payload.maskBase64) throw fault('Canvas and mask are required.');
    const record = {request_id: rid, document_id: message.payload.document_id, workspace_id: selectedPreparation.workspace_id, path: selectedPreparation.path,
      payload: clone(message.payload), submission: {prepared_workflow: {...clone(selectedPreparation), parameters: clone(state.parameters)}},
      state: 'local', uploadAttempted: false, submitAttempted: false, submits: 0, cancelRequested: false,
      resultCount: null, acknowledged: [], ackPending: []};
    const item = itemFor(record, owner); item.durable = false; jobs.set(rid, item); savedSession(owner, true).jobs.push(record);
    try { await persist(); item.durable = true; } catch (error) { item.paused = true; changed(); throw error; }
    if (!current(item)) return;
    changed(); await pump(item);
  }
  async function receive(message) {
    if (disposed || !object(message) || message.protocol !== VERSION || message.transport !== 'company' || !id(message.panel)) return false;
    if (message.type === 'hello') {
      const panelChanged = helloMessage && helloMessage.panel !== message.panel;
      helloMessage = clone(message);
      if (panelChanged) {
        stopTimers(); epoch++; binding = null; handshake = null; jobs = new Map();
        changed({ready: false, session_id: null});
      }
      return bind(message);
    }
    const owner = binding;
    if (!same(owner) || message.panel !== owner.panel || message.session_id !== owner.session) return false;
    try {
      if (message.type === 'generate') await generate(message);
      else if (message.type === 'resume' && Array.isArray(message.requests)) {
        for (const rid of message.requests.filter(ridValid)) {
          let item = jobs.get(rid);
          if (!item) {
            const record = {request_id: rid, payload: null, submission: null, state: 'unknown', resultCount: null, acknowledged: [], ackPending: [], submitAttempted: true};
            item = itemFor(record, owner); jobs.set(rid, item); savedSession(owner, true).jobs.push(record); await persist();
          }
          item.paused = false; item.retries = 0; item.buffered.clear();
          if (item.record.state === 'uploaded') item.record.submits = 0;
          if (item.record.state === 'delivered') for (const index of item.record.acknowledged) host('acknowledged', {request_id: rid, index}, owner);
          else if (item.record.state === 'cancelled') host('state', {request_id: rid, state: 'cancelled'}, owner);
          else await pump(item);
        }
      } else if (['ack', 'received'].includes(message.type) && ridValid(message.request_id) && Number.isInteger(message.index) && message.index >= 0) {
        const item = jobs.get(message.request_id);
        if (!item || item.record.resultCount === null || message.index >= item.record.resultCount) return false;
        if (message.type === 'received') { item.buffered.add(message.index); item.retries = 0; }
        else {
          item.paused = false; item.retries = 0;
          try { await ack(item, message.index); }
          catch (error) { if (current(item)) { item.retryNeeded = true; retry(item); } throw error; }
          await pump(item);
        }
      } else if (message.type === 'cancel' && ridValid(message.request_id)) {
        const item = jobs.get(message.request_id); if (!item) return false;
        item.record.cancelRequested = true; item.paused = false; item.retries = 0; await persist(); await pump(item);
      } else if (message.type === 'control' && object(message.payload) && Object.keys(message.payload).every(key => ['workflow', 'rndrMode'].includes(key))) {
        if (typeof message.payload.workflow === 'string' && state.workflows.some(row => row.path === message.payload.workflow)) await selectWorkflow(message.payload.workflow);
        if (typeof message.payload.rndrMode === 'string') host('control', {payload: {Send_rndrMode: message.payload.rndrMode}}, owner);
      }
      return true;
    } catch (error) { host('error', {request_id: message.request_id, stage: 'session', error: safe(error)}, owner); return false; }
  }
  function disconnect() { if (disposed) return; detach(null, 'disconnected'); origin = null; helloMessage = null; changed({origin: null}); }
  function dispose() { if (disposed) return; stopTimers(); epoch++; binding = null; disposed = true; listeners.clear(); }
  return {connect, disconnect, login, logout, refreshWorkspaces, selectWorkspace, refreshWorkflows, selectWorkflow,
    setParameters, getState, receive, subscribe, dispose};
};
