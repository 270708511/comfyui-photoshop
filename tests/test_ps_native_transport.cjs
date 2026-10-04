const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(require('node:path').resolve(__dirname, '../ComfyUI Photoshop Team/dist/ps-native-transport.js'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const RID = 'a'.repeat(32), RID2 = 'b'.repeat(32), ORIGIN = 'https://company.test';
function response(value, status = 200) {
  return {ok: status >= 200 && status < 300, status, json: async () => copy(value),
    arrayBuffer: async () => Uint8Array.from([0, 1, 2, 253, 254, 255, 12]).buffer};
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; }
async function fixture(options = {}) {
  const calls = [], emitted = [], states = [], saves = [], timers = new Map(); let timerID = 0;
  const server = {account: options.account === undefined ? 'alice' : options.account, sessions: new Map(), requests: new Map(),
    counter: 0, submits: 0, uploads: 0, deletes: 0, acks: [], overrides: [], wrongLogin: false, logoutBroken: false,
    users: {users: {'work-a': 'Alice Workspace', 'work-b': 'Bob Workspace', '__special': 'Other'}},
    files: {'work-a': [{path: 'one.json'}, {path: 'folder/unprepared.json'}, {path: 'stale.json'}], 'work-b': [{path: 'two.json'}]},
    preparation(workspace, path) { const status = path.includes('unprepared') ? 'unprepared' : path.includes('stale') ? 'stale' : 'prepared';
      return {status, workspace_id: workspace, path, reason: status === 'stale' ? 'source_changed' : null,
        current_source_hash: 'a'.repeat(64), preparation: status === 'unprepared' ? null : {preparation_id: 'prep_1', source_hash: 'a'.repeat(64),
          parameters: [{id: 'seed', node_id: '2', input: 'seed', type: 'integer', default: 1, min: 0, max: 100},
            {id: 'text', node_id: '3', input: 'text', type: 'string', default: 'hello'},
            {id: 'enabled', node_id: '4', input: 'enabled', type: 'boolean', default: true},
            {id: 'mode', node_id: '5', input: 'mode', type: 'enum', default: 'x', options: ['x', 'y']}]}}; }
  };
  const fetch = async (url, opts = {}) => {
    const parsed = new URL(url), path = parsed.pathname, method = opts.method || 'GET';
    calls.push({url, path, method, options: copy(opts)});
    for (const override of [...server.overrides]) { const result = await override({url, path, method, opts, parsed}); if (result !== undefined) return result; }
    if (path === '/logout') { if (!server.logoutBroken) server.account = null; return response({}); }
    if (path === '/login') {
      const form = new URLSearchParams(opts.body);
      if (!server.wrongLogin && form.get('password') === 'correct') server.account = form.get('username');
      return response('<html>Password error or redirect page with password=SECRET</html>');
    }
    if (!server.account) return response({detail: 'Cookie SECRET'}, 401);
    if (path === '/auth/whoami') return response({authenticated: true, username: server.account});
    if (path === '/api/users') return response(server.users);
    if (path === '/api/userdata') return response(server.files[opts.headers['Comfy-User']] || []);
    if (path.startsWith('/api/userdata/')) return response({nodes: [], workspace: opts.headers['Comfy-User']});
    if (path === '/ps/team/workflow-preparations') return response(server.preparation(parsed.searchParams.get('workspace_id'), parsed.searchParams.get('path')));
    if (path === '/ps/team/sessions' && method === 'POST') {
      const sid = 'session_' + ++server.counter; server.sessions.set(sid, server.account); return response({session_id: sid});
    }
    const parts = /^\/ps\/team\/sessions\/([^/]+)(?:\/requests\/([^/]+)(.*))?$/.exec(path);
    if (!parts || server.sessions.get(parts[1]) !== server.account) return response({}, 404);
    const [, sid, rid, suffix] = parts;
    if (!rid) return response({session_id: sid});
    const key = sid + '/' + rid;
    let item = server.requests.get(key);
    if (suffix === '/snapshot' && method === 'PUT') {
      const value = JSON.parse(opts.body); server.uploads++;
      if (item && JSON.stringify(item.payload) !== JSON.stringify(value)) return response({}, 409);
      if (!item) { item = {request_id: rid, document_id: value.document_id, state: 'uploaded', payload: value, acknowledged_results: []}; server.requests.set(key, item); }
      return response(item);
    }
    if (!item) return response({}, 404);
    if (suffix === '/submit') { server.submits++; item.submission = JSON.parse(opts.body); item.state = 'scheduler_queued'; return response(item); }
    if (method === 'DELETE') { server.deletes++; item.state = 'cancelled'; return response(item); }
    if (/^\/results\/\d+\/ack$/.test(suffix)) {
      const index = Number(suffix.split('/')[2]); server.acks.push(index); item.acknowledged_results = [...new Set([...item.acknowledged_results, index])]; return response(item);
    }
    if (/^\/results\/\d+$/.test(suffix)) return response(null);
    return response(item);
  };
  const context = {Promise, Map, Set, Math, Uint8Array, console: {log() { throw new Error('No raw logging'); }, error() { throw new Error('No raw logging'); }} };
  vm.createContext(context); vm.runInContext(code, context);
  let persisted = options.journal || null;
  const controller = context.createPSNativeTransport({fetch, emit(message) { emitted.push(copy(message)); options.onEmit?.(message); },
    onState: state => states.push(copy(state)), load: async () => copy(persisted),
    save: async journal => { if (options.save) await options.save(journal); persisted = copy(journal); saves.push(persisted); },
    setTimeout(callback, ms) { const id = ++timerID; timers.set(id, {callback, ms}); return id; }, clearTimeout: id => timers.delete(id)});
  const hello = {protocol: 'ps-team-1', transport: 'company', panel: 'panel', session_id: null, type: 'hello'};
  const send = message => controller.receive({...hello, session_id: controller.getState().session_id, ...message});
  const tick = async () => { const entry = [...timers.entries()][0]; if (!entry) return; timers.delete(entry[0]); await entry[1].callback(); for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const prepare = async () => { await controller.connect(ORIGIN); await send({type: 'hello'}); await controller.selectWorkspace('work-a'); await controller.selectWorkflow('workflows/one.json'); };
  const generate = (rid = RID, additions = {}) => send({type: 'generate', request_id: rid,
    payload: {canvasBase64: 'canvas', maskBase64: 'mask', document_id: '42', configdata: {mode: 'fg'}, bounds: {left: 0, top: 0, right: 10, bottom: 10}}, ...additions});
  return {controller, server, calls, emitted, states, saves, timers, send, tick, prepare, generate, journal: () => copy(persisted)};
}
test('native factory is inert, has no browser/crypto requirements, and isolates validated company origins', async () => {
  const f = await fixture(); assert.equal(f.calls.length, 0);
  assert.equal(await f.controller.connect('https://user:secret@company.test'), false);
  assert.equal(await f.controller.connect('https://company.test/path?q=secret'), false);
  assert.equal(f.calls.length, 0); await f.prepare();
  assert.equal(f.controller.getState().ready, true);
  assert.ok(f.calls.every(call => call.options.credentials === 'include'));
  assert.equal(f.emitted.find(m => m.type === 'ready').account_id, 'alice');
  f.controller.dispose();
});
test('cookie login proves cleared old cookie then authenticated requested account; credentials never persisted or emitted', async () => {
  const f = await fixture({account: null}); await f.controller.connect(ORIGIN); await f.send({type: 'hello'});
  assert.equal(await f.controller.login('alice', 'correct'), true);
  assert.equal(f.controller.getState().ready, true);
  const login = f.calls.find(call => call.path === '/login'); assert.equal(login.options.body, 'username=alice&password=correct&next=%2Fauth%2Fwhoami');
  assert.equal(f.calls.filter(call => call.path === '/auth/whoami').length, 3);
  assert.ok(!JSON.stringify([f.saves, f.emitted, f.states]).includes('correct'));
  assert.ok(!JSON.stringify([f.saves, f.emitted, f.states]).includes('SECRET'));
  f.controller.dispose();
});
test('HTML 200 failed login cannot reuse prior valid same-account cookie', async () => {
  const f = await fixture(); await f.prepare(); f.server.wrongLogin = true;
  assert.equal(await f.controller.login('alice', 'wrong'), false);
  assert.equal(f.controller.getState().authenticated, false);
  assert.equal(f.controller.getState().ready, false);
  assert.ok(f.emitted.some(m => m.type === 'unbound'));
  const broken = await fixture(); await broken.prepare(); broken.server.logoutBroken = true;
  assert.equal(await broken.controller.login('bob', 'correct'), false);
  assert.equal(broken.calls.filter(call => call.path === '/login').length, 0);
  assert.match(broken.controller.getState().error, /did not clear/);
});
test('login requests are serialized and stale response never binds old account', async () => {
  const f = await fixture({account: null}); await f.controller.connect(ORIGIN); await f.send({type: 'hello'});
  const waiting = deferred(), started = deferred();
  f.server.overrides.push(async ({path, opts}) => { if (path === '/login' && opts.body.includes('username=alice')) { started.resolve(); await waiting.promise; f.server.account = 'alice'; return response({}); } });
  const first = f.controller.login('alice', 'correct'); await started.promise;
  const second = f.controller.login('bob', 'correct'); waiting.resolve();
  assert.equal(await first, false); assert.equal(await second, true);
  assert.equal(f.controller.getState().username, 'bob');
  assert.deepEqual(f.emitted.filter(m => m.type === 'ready').map(m => m.account_id), ['bob']);
});
test('full workspaces preserve IDs, userdata headers, unprepared and stale rows are never executable', async () => {
  const f = await fixture(); await f.prepare();
  assert.equal(f.controller.getState().workspaces.length, 3);
  assert.ok(f.calls.filter(call => call.path.startsWith('/api/userdata')).every(call => call.options.headers['Comfy-User'] === 'work-a'));
  const state = f.controller.getState(); assert.equal(state.workflows.length, 3);
  assert.equal(state.workflows.find(row => row.path.includes('unprepared')).executable, false);
  assert.equal(state.workflows.find(row => row.path.includes('stale')).reason, 'source_changed');
  assert.equal(await f.controller.selectWorkflow('workflows/folder/unprepared.json'), false);
  assert.equal(f.controller.getState().canGenerate, false); await f.generate(); assert.equal(f.server.uploads, 0);
});
test('strict parameters block invalid drafts, unknown ids, coercion and stale captured selection', async () => {
  const f = await fixture(); await f.prepare(); const before = f.controller.getState().selectionVersion;
  assert.throws(() => f.controller.setParameters({seed: '2'}), /parameter/);
  assert.equal(f.controller.getState().canGenerate, false);
  assert.throws(() => f.controller.setParameters({seed: 101}), /parameter/);
  assert.throws(() => f.controller.setParameters({mode: 'bad'}), /parameter/);
  assert.throws(() => f.controller.setParameters({unknown: 1}), /parameter/);
  f.controller.setParameters({seed: 7}); assert.equal(f.controller.getState().canGenerate, true);
  assert.ok(f.controller.getState().selectionVersion > before);
  await f.generate(RID, {selection_version: before}); assert.equal(f.server.uploads, 0);
});
test('workspace and workflow response races cannot overwrite newer selection', async () => {
  const f = await fixture(); await f.prepare(); const wait = deferred(), started = deferred();
  f.server.overrides.push(async ({path, opts}) => { if (path === '/api/userdata' && opts.headers['Comfy-User'] === 'work-a') { started.resolve(); await wait.promise; return response([{path: 'late.json'}]); } });
  const old = f.controller.selectWorkspace('work-a'); await started.promise;
  await f.controller.selectWorkspace('work-b'); await f.controller.selectWorkflow('workflows/two.json'); wait.resolve(); await old;
  assert.equal(f.controller.getState().workspace_id, 'work-b'); assert.equal(f.controller.getState().workflow_path, 'workflows/two.json');
  assert.equal(f.controller.getState().workflows[0].path, 'workflows/two.json');
});
test('pre-network journal freezes images selection params and original workspace across changes', async () => {
  const f = await fixture(); await f.prepare(); f.controller.setParameters({seed: 7});
  const sid = f.controller.getState().session_id, wait = deferred(), started = deferred();
  f.server.overrides.push(async ({path, method}) => {
    if (path.endsWith('/snapshot') && method === 'PUT') { assert.ok(f.saves.at(-1).sessions[0].jobs[0].payload.canvasBase64); started.resolve(); await wait.promise; }
  });
  const generation = f.generate(); await started.promise;
  await f.controller.selectWorkspace('work-b'); await f.controller.selectWorkflow('workflows/two.json'); f.controller.setParameters({seed: 9});
  wait.resolve(); await generation;
  assert.equal(f.controller.getState().session_id, sid);
  const job = f.server.requests.get(sid + '/' + RID);
  assert.equal(job.submission.prepared_workflow.workspace_id, 'work-a'); assert.equal(job.submission.prepared_workflow.path, 'workflows/one.json');
  assert.equal(job.submission.prepared_workflow.parameters.seed, 7); assert.equal(f.controller.getState().pending[0].document_id, '42');
  await f.tick(); assert.equal(f.journal().sessions[0].jobs[0].payload, null);
});
test('duplicate request never uploads twice and mutated duplicate is refused before confirmation', async () => {
  const f = await fixture(); await f.prepare(); await f.generate();
  await f.generate(RID, {payload: {canvasBase64: 'changed', maskBase64: 'mask'}});
  assert.equal(f.server.uploads, 1); assert.equal(f.server.submits, 1);
  await f.generate(); assert.equal(f.server.uploads, 1); assert.equal(f.server.submits, 1);
});
test('lost submit reply reconciles status before any retry; same immutable payload is retried only if uploaded', async () => {
  const f = await fixture(); await f.prepare(); let failed = false;
  f.server.overrides.push(({path, opts}) => { if (path.endsWith('/submit') && !failed) { failed = true; const job = [...f.server.requests.values()][0]; job.submission = JSON.parse(opts.body); job.state = 'scheduler_queued'; f.server.submits++; throw new Error('Authorization: Bearer SECRET'); } });
  await f.generate(); await f.tick(); assert.equal(f.server.submits, 1);
  assert.ok(!JSON.stringify(f.emitted).includes('SECRET'));
  const retry = await fixture(); await retry.prepare(); let fail = true;
  retry.server.overrides.push(({path}) => { if (path.endsWith('/submit') && fail) { fail = false; throw new Error('lost'); } });
  await retry.generate(); const first = retry.calls.findIndex(call => call.path.endsWith('/submit')); await retry.tick();
  const second = retry.calls.findIndex((call, index) => index > first && call.path.endsWith('/submit'));
  assert.ok(second > first); assert.ok(retry.calls.slice(first + 1, second).some(call => call.path.endsWith(RID) && call.method === 'GET'));
  assert.equal(retry.calls[first].options.body, retry.calls[second].options.body); assert.equal(retry.server.uploads, 1);
});
test('multiple result images are buffered only until insertion ACK; binary encoder has no FileReader/Buffer dependency', async () => {
  const f = await fixture(); await f.prepare(); await f.generate(); const job = [...f.server.requests.values()][0]; job.state = 'success'; job.result_count = 2;
  await f.tick(); assert.equal(f.emitted.filter(message => message.type === 'result').length, 2);
  assert.equal(f.emitted.find(message => message.type === 'result').image, Buffer.from([0, 1, 2, 253, 254, 255, 12]).toString('base64'));
  assert.equal(f.server.acks.length, 0);
  await f.send({type: 'received', request_id: RID, index: 0}); await f.send({type: 'received', request_id: RID, index: 1});
  await f.tick(); assert.equal(f.emitted.filter(message => message.type === 'result').length, 2); assert.equal(f.server.acks.length, 0);
  await f.send({type: 'ack', request_id: RID, index: 0}); await f.send({type: 'ack', request_id: RID, index: 1});
  assert.deepEqual(f.server.acks, [0, 1]); assert.equal(f.controller.getState().pending[0].state, 'delivered');
});
test('lost ACK retries and reconciles server acknowledged indexes without duplicate insertion or durable buffered flags', async () => {
  const f = await fixture(); await f.prepare(); await f.generate(); const job = [...f.server.requests.values()][0]; job.state = 'success'; job.result_count = 1; await f.tick();
  let failed = false; f.server.overrides.push(({path}) => { if (path.endsWith('/ack') && !failed) { failed = true; job.acknowledged_results = [0]; throw new Error('lost ack'); } });
  await f.send({type: 'received', request_id: RID, index: 0}); await f.send({type: 'ack', request_id: RID, index: 0});
  assert.deepEqual(f.journal().sessions[0].jobs[0].ackPending, [0]); assert.ok(!JSON.stringify(f.journal()).includes('buffered'));
  await f.tick(); assert.equal(f.controller.getState().pending[0].state, 'delivered');
  assert.equal(f.emitted.filter(message => message.type === 'result').length, 1);
  assert.ok(f.emitted.some(message => message.type === 'acknowledged'));
});
test('logout stops timers and late images, preserving server sessions and local network journal', async () => {
  const f = await fixture(); await f.prepare(); await f.generate(); const job = [...f.server.requests.values()][0]; job.state = 'success'; job.result_count = 1;
  const started = deferred(), wait = deferred(); f.server.overrides.push(async ({path}) => { if (path.endsWith('/results/0')) { started.resolve(); await wait.promise; return response(null); } });
  const polling = f.send({type: 'resume', requests: [RID]}); await started.promise; await f.controller.logout(); wait.resolve(); await polling;
  assert.equal(f.emitted.filter(message => message.type === 'result').length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.server.sessions.size, 1); assert.equal(f.server.deletes, 0); assert.equal(f.journal().sessions[0].jobs.length, 1);
});
test('401 on result download unbinds; 403 pauses without bypass or fallback routes', async () => {
  const f = await fixture(); await f.prepare(); await f.generate(); const job = [...f.server.requests.values()][0]; job.state = 'success'; job.result_count = 1;
  f.server.overrides.push(({path}) => path.endsWith('/results/0') ? response({}, 401) : undefined); await f.tick();
  assert.equal(f.controller.getState().ready, false); assert.equal(f.timers.size, 0);
  assert.ok(f.emitted.some(message => message.type === 'unbound'));
  assert.ok(!f.calls.some(call => ['/upload/image', '/prompt', '/history'].includes(call.path)));
});
test('cancel during upload cancels saved request and never submits or deletes session', async () => {
  const f = await fixture(); await f.prepare(); const started = deferred(), wait = deferred();
  f.server.overrides.push(async ({path}) => { if (path.endsWith('/snapshot')) { started.resolve(); await wait.promise; } });
  const generation = f.generate(); await started.promise; await f.send({type: 'cancel', request_id: RID}); wait.resolve(); await generation;
  assert.equal(f.server.submits, 0); assert.equal(f.server.deletes, 1); assert.equal(f.server.sessions.size, 1);
  assert.equal(f.controller.getState().pending[0].state, 'cancelled');
});
test('bounded network retry pauses until manual resume; cancellation and restart retain original request ID', async () => {
  const f = await fixture(); await f.prepare(); await f.generate();
  f.server.overrides.push(({path}) => { if (path.endsWith(RID)) throw new Error('offline password=SECRET'); });
  for (let i = 0; i < 7; i++) await f.tick();
  assert.equal(f.timers.size, 0); assert.equal(f.controller.getState().pending[0].paused, true);
  f.server.overrides.length = 0; await f.send({type: 'resume', requests: [RID]}); assert.ok(f.timers.size > 0);
  const journal = f.journal(); f.controller.dispose();
  const restored = await fixture({journal}); const saved = journal.sessions[0]; restored.server.sessions.set(saved.session, 'alice'); restored.server.counter = 1;
  restored.server.requests.set(saved.session + '/' + RID, {...copy([...f.server.requests.values()][0]), state: 'success', result_count: 1});
  await restored.controller.connect(ORIGIN); await restored.send({type: 'hello', session_ids: [saved.session], session_owners: {[saved.session]: 'alice'}});
  await restored.send({type: 'resume', requests: [RID]});
  assert.equal(restored.server.uploads, 0); assert.equal(restored.server.submits, 0);
  assert.ok(restored.emitted.some(message => message.type === 'result' && message.request_id === RID));
});
test('different account cannot recover old session; pre-network storage failure cannot be bypassed by duplicate generate', async () => {
  const f = await fixture(); await f.prepare(); await f.generate(); const journal = f.journal();
  const other = await fixture({account: 'bob', journal}); other.server.sessions.set(journal.sessions[0].session, 'alice'); other.server.counter = 1;
  await other.controller.connect(ORIGIN); await other.send({type: 'hello', session_ids: [journal.sessions[0].session], session_owners: {[journal.sessions[0].session]: 'alice'}});
  assert.equal(other.controller.getState().pending.length, 0); assert.notEqual(other.controller.getState().session_id, journal.sessions[0].session);
  let fail = false; const blocked = await fixture({save: () => { if (fail) throw new Error('storage'); }}); await blocked.prepare(); fail = true;
  await blocked.generate(); await blocked.generate(); assert.equal(blocked.server.uploads, 0); assert.equal(blocked.server.submits, 0);
});
test('disconnect is local-only and same reusable controller recovers its owner session', async () => {
  const f = await fixture(); await f.prepare(); await f.generate(); const before = f.calls.length, sid = f.controller.getState().session_id;
  f.controller.disconnect(); assert.equal(f.calls.length, before); assert.equal(f.timers.size, 0); assert.equal(f.controller.getState().ready, false);
  await f.controller.connect(ORIGIN); await f.send({type: 'hello'});
  assert.equal(f.controller.getState().session_id, sid); assert.equal(f.controller.getState().pending.length, 1); assert.equal(f.server.sessions.size, 1);
});
test('single-user catalog requires the exact valid shape, never fallback on malformed catalog', async () => {
  const f = await fixture(); f.server.users = {storage: 'server', migrated: true}; await f.controller.connect(ORIGIN);
  assert.equal(f.controller.getState().workspaces[0].id, 'default');
  f.server.users = {storage: 'server'}; await f.controller.refreshWorkspaces(); assert.match(f.controller.getState().error, /Workspace list/);
});
test('userdata paths are always relative, including a nested directory literally named workflows', async () => {
  const f = await fixture(); f.server.files['work-a'] = [{path: 'foo.json'}, {path: 'workflows/foo.json'}];
  await f.controller.connect(ORIGIN); await f.send({type: 'hello'}); await f.controller.selectWorkspace('work-a');
  assert.deepEqual(copy(f.controller.getState().workflows.map(row => row.path)), ['workflows/foo.json', 'workflows/workflows/foo.json']);
});
test('hanging login times out without AbortController, blocks cookie races until original operation settles', async () => {
  const f = await fixture({account: null}); await f.controller.connect(ORIGIN); await f.send({type: 'hello'});
  const started = deferred(), wait = deferred();
  f.server.overrides.push(async ({path, opts}) => { if (path === '/login' && opts.body.includes('username=alice')) { started.resolve(); await wait.promise; f.server.account = 'alice'; return response({}); } });
  const login = f.controller.login('alice', 'correct'); await started.promise;
  const timeout = [...f.timers.values()].find(timer => timer.ms === 30000); assert.ok(timeout); timeout.callback();
  assert.equal(await login, false); assert.equal(f.controller.getState().auth_pending, true);
  assert.deepEqual(copy(f.controller.getState().diagnostic), {stage: 'submit_login', code: 'request_timeout', http_status: null});
  const before = f.calls.length; assert.equal(await f.controller.login('bob', 'correct'), false); assert.equal(await f.controller.connect(ORIGIN), false);
  assert.equal(f.calls.length, before); wait.resolve(); for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(f.controller.getState().ready, false); assert.equal(await f.controller.login('bob', 'correct'), true);
  assert.equal(f.controller.getState().username, 'bob');
});
test('hanging JSON and result body reads time out with recoverable request retained', async () => {
  const f = await fixture(); const wait = deferred(), started = deferred();
  f.server.overrides.push(({path}) => path === '/auth/whoami' ? {ok: true, status: 200, json() { started.resolve(); return wait.promise; }} : undefined);
  const connecting = f.controller.connect(ORIGIN); await started.promise; [...f.timers.values()].find(timer => timer.ms === 30000).callback();
  assert.equal(await connecting, false); assert.match(f.controller.getState().error, /timed out/); wait.resolve({authenticated: true, username: 'alice'});
  assert.deepEqual(copy(f.controller.getState().diagnostic), {stage: 'check_session', code: 'response_timeout', http_status: 200});
  const result = await fixture(); await result.prepare(); await result.generate(); const job = [...result.server.requests.values()][0]; job.state = 'success'; job.result_count = 1;
  const downloading = deferred(), imageWait = deferred(); result.server.overrides.push(({path}) => path.endsWith('/results/0') ? {ok: true, status: 200, arrayBuffer() { downloading.resolve(); return imageWait.promise; }} : undefined);
  const resume = result.send({type: 'resume', requests: [RID]}); await downloading.promise; [...result.timers.values()].find(timer => timer.ms === 30000).callback(); await resume;
  assert.equal(result.controller.getState().pending.length, 1); assert.equal(result.emitted.filter(message => message.type === 'result').length, 0);
  assert.ok(result.emitted.some(message => message.type === 'error' && message.error.includes('timed out')));
  imageWait.resolve(new Uint8Array([1]).buffer);
});
test('queued replacement login cannot bypass an older cookie-write timeout lock', async () => {
  const f = await fixture({account: null}); await f.controller.connect(ORIGIN); await f.send({type: 'hello'});
  const started = deferred(), wait = deferred();
  f.server.overrides.push(async ({path, opts}) => { if (path === '/login' && opts.body.includes('username=alice')) { started.resolve(); await wait.promise; f.server.account = 'alice'; return response({}); } });
  const first = f.controller.login('alice', 'correct'); await started.promise;
  const replacement = f.controller.login('bob', 'correct');
  [...f.timers.values()].find(timer => timer.ms === 30000).callback();
  assert.equal(await first, false); assert.equal(await replacement, false);
  assert.equal(f.calls.filter(call => call.path === '/login').length, 1);
  wait.resolve(); for (let i = 0; i < 20; i++) await Promise.resolve(); assert.equal(f.controller.getState().ready, false);
});
test('failed session journal write cannot emit ready on repeated hello', async () => {
  const f = await fixture({save: async () => { throw new Error('disk full'); }}); await f.controller.connect(ORIGIN);
  await f.send({type: 'hello'}); await f.send({type: 'hello'});
  assert.equal(f.controller.getState().ready, false); assert.equal(f.emitted.filter(message => message.type === 'ready').length, 0);
});
test('uppercase JSON workflow suffix is listed and selectable without changing its actual userdata path', async () => {
  const f = await fixture(); f.server.files['work-a'] = [{path: 'folder/UPPER.JSON'}];
  await f.controller.connect(ORIGIN); await f.send({type: 'hello'}); await f.controller.selectWorkspace('work-a');
  assert.equal(f.controller.getState().workflows[0].path, 'workflows/folder/UPPER.JSON');
  assert.equal(await f.controller.selectWorkflow('workflows/folder/UPPER.JSON'), true);
  assert.equal(f.controller.getState().canGenerate, true);
  assert.ok(f.calls.some(call => call.path === '/api/userdata/workflows%2Ffolder%2FUPPER.JSON'));
});

test('native fetch and body errors cannot self-declare raw service text safe', async () => {
  for (const bodyFailure of [false, true]) {
    const f = await fixture();
    const error = Object.assign(new Error('password=SECRET https://service.test/?token=SECRET'), {safe: true});
    f.server.overrides.push(({path}) => {
      if (path !== '/auth/whoami') return;
      if (bodyFailure) return {ok: true, status: 200, json: async () => { throw error; }};
      throw error;
    });
    assert.equal(await f.controller.connect(ORIGIN), false);
    assert.ok(!JSON.stringify([f.states, f.emitted, f.saves]).includes('SECRET'));
  }
});

test('native diagnostics distinguish connect, logout, logout verification, login, and cookie verification failures', async () => {
  const cases = [
    {stage: 'check_session', path: '/auth/whoami', connect: true},
    {stage: 'clear_session', path: '/logout'},
    {stage: 'verify_signout', path: '/auth/whoami'},
    {stage: 'submit_login', path: '/login'},
    {stage: 'verify_login', path: '/auth/whoami', afterLogin: true}
  ];
  for (const item of cases) {
    const f = await fixture({account: null});
    if (!item.connect) await f.controller.connect(ORIGIN);
    f.server.overrides.push(({path}) => {
      if (path === item.path && (!item.afterLogin || f.server.account)) throw new TypeError('Network failed password=SECRET');
    });
    assert.equal(await (item.connect ? f.controller.connect(ORIGIN) : f.controller.login('alice', 'correct')), false);
    assert.deepEqual(copy(f.controller.getState().diagnostic), {stage: item.stage, code: 'network_error', http_status: null});
    assert.ok(!JSON.stringify([f.states, f.emitted, f.saves]).includes('SECRET'));
    assert.ok(!JSON.stringify([f.states, f.emitted, f.saves]).includes('correct'));
  }
});

test('native diagnostics separate HTTP status, invalid JSON, and missing cookie without echoing response details', async () => {
  const http = await fixture();
  http.server.overrides.push(({path}) => path === '/auth/whoami' ? response({password: 'SECRET'}, 503) : undefined);
  assert.equal(await http.controller.connect(ORIGIN), false);
  assert.deepEqual(copy(http.controller.getState().diagnostic), {stage: 'check_session', code: 'http_error', http_status: 503});
  const invalid = await fixture();
  invalid.server.overrides.push(({path}) => path === '/auth/whoami' ? {ok: true, status: 200, json: async () => { throw new SyntaxError('<html>password=SECRET</html>'); }} : undefined);
  assert.equal(await invalid.controller.connect(ORIGIN), false);
  assert.deepEqual(copy(invalid.controller.getState().diagnostic), {stage: 'check_session', code: 'response_invalid', http_status: 200});
  const missing = await fixture({account: null}); await missing.controller.connect(ORIGIN); missing.server.wrongLogin = true;
  assert.equal(await missing.controller.login('alice', 'wrong'), false);
  assert.deepEqual(copy(missing.controller.getState().diagnostic), {stage: 'verify_login', code: 'unauthorized', http_status: 401});
  assert.ok(!JSON.stringify([http.states, invalid.states, missing.states]).includes('SECRET'));
});

test('late native failures cannot replace the current connection diagnostic and successful retry clears it', async () => {
  const f = await fixture(); const wait = deferred(), started = deferred(); let intercepted = false;
  f.server.overrides.push(({path}) => {
    if (path === '/auth/whoami' && !intercepted) { intercepted = true; started.resolve(); return wait.promise; }
  });
  const first = f.controller.connect(ORIGIN); await started.promise;
  const second = f.controller.connect(ORIGIN);
  wait.reject(new Error('offline password=SECRET'));
  assert.equal(await first, false); assert.equal(await second, true);
  assert.equal(f.controller.getState().authenticated, true);
  assert.equal(f.controller.getState().diagnostic, null);
  assert.ok(!f.states.some(state => state.diagnostic?.code === 'network_error'));
});

test('workspace list success preserves a failed adapter bind, while recovered session lookups stay silent', async () => {
  const f = await fixture({account: null}); await f.controller.connect(ORIGIN); await f.send({type: 'hello'});
  f.server.overrides.push(({path}) => path === '/ps/team/sessions' ? response({token: 'SECRET'}, 503) : undefined);
  assert.equal(await f.controller.login('alice', 'correct'), true);
  const state = f.controller.getState();
  assert.equal(state.authenticated, true); assert.equal(state.ready, false); assert.equal(state.status, 'connection_error');
  assert.equal(state.workspaces.length, 3); assert.match(state.error, /503/);
  assert.deepEqual(copy(state.diagnostic), {stage: 'bind_session', code: 'http_error', http_status: 503});
  assert.ok(!JSON.stringify(f.states).includes('SECRET'));
  const recovered = await fixture(); await recovered.controller.connect(ORIGIN);
  await recovered.send({type: 'hello', session_ids: ['expired_session']});
  assert.equal(recovered.controller.getState().ready, true);
  assert.ok(!recovered.states.some(value => value.diagnostic?.http_status === 404));
});

test('cookie checks report explicit safe reasons and diagnostics clear after corrected login', async () => {
  const f = await fixture(); await f.prepare(); f.server.logoutBroken = true;
  assert.equal(await f.controller.login('alice', 'correct'), false);
  assert.deepEqual(copy(f.controller.getState().diagnostic), {stage: 'verify_signout', code: 'cookie_not_cleared', http_status: 200});
  f.server.logoutBroken = false;
  assert.equal(await f.controller.login('alice', 'correct'), true);
  assert.equal(f.controller.getState().diagnostic, null);
  assert.equal(f.controller.getState().error, null);
  const noCookie = await fixture();
  noCookie.server.overrides.push(({path}) => path === '/auth/whoami' ? response({authenticated: false}) : undefined);
  assert.equal(await noCookie.controller.connect(ORIGIN), false);
  assert.deepEqual(copy(noCookie.controller.getState().diagnostic), {stage: 'check_session', code: 'cookie_not_confirmed', http_status: null});
});
