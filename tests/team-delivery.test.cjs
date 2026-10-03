// No npm install/build and no Photoshop/GPU needed: run node --test tests/*.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function frontend(fetch, graph = async () => ({output: {node: {}}, workflow: {nodes: []}})) {
  const messages = [], listeners = [], timers = new Map(); let timerID = 0;
  const host = {postMessage: message => messages.push(clone(message))};
  const context = vm.createContext({location: {hostname: 'team.example'}, app: {graphToPrompt: graph},
    window: {uxpHost: host, addEventListener: (type, fn) => listeners.push(fn), dispatchEvent() {}},
    fetch, console, URLSearchParams, CustomEvent: class {}, setTimeout: fn => {timers.set(++timerID, fn); return timerID;}, clearTimeout: id => timers.delete(id),
    FileReader: class {readAsDataURL() {this.result = 'data:image/png;base64,IMAGE'; this.onload();}}});
  let source = fs.readFileSync(path.join(root, 'js/team.js'), 'utf8').replace(/^import .*\n/, '').replace(/export /g, '');
  vm.runInContext(source + '\nthis.start = startTeam;', context); context.start(() => {});
  const emit = async (message, extra = {}) => {
    const event = {source: host, origin: 'comfyui.photoshop.team', data: {protocol: 'ps-team-1', transport: 'company', panel: 'PANEL', session_id: 'SESSION', ...message}, ...extra};
    await Promise.all(listeners.map(fn => fn(event))); await settle();
  };
  return {messages, emit, context, timers, tick: async () => {const ready = [...timers.values()]; timers.clear(); ready.forEach(fn => fn()); await settle();}};
}
const response = (body, status = 200) => ({ok: status < 400, status, json: async () => body, blob: async () => ({})});
function server({resultCount = 2, saved = [], failAck = false} = {}) {
  const calls = []; const acknowledged = new Set(saved); let failed = false;
  return {calls, acknowledged, fetch: async (url, options = {}) => {
    calls.push({url, method: options.method || 'GET', body: options.body});
    if (url === '/ps/team/sessions' || /^\/ps\/team\/sessions\/[^/]+$/.test(url)) return response({session_id: url.split('/').pop() === 'sessions' ? 'SESSION' : url.split('/').pop()});
    const ack = url.match(/results\/(\d+)\/ack$/);
    if (ack) {if (failAck && !failed) {failed = true; throw new Error('ACK network interruption');} acknowledged.add(Number(ack[1])); return response({ok: true});}
    if (url.endsWith('/snapshot') || url.endsWith('/submit')) return response({ok: true});
    if (/results\/\d+$/.test(url)) return response({});
    if (options.method === 'DELETE') return response({state: 'cancelled'});
    return response({request_id: 'REQUEST', state: 'success', result_count: resultCount, acknowledged_results: [...acknowledged]});
  }};
}
async function generate(env) {
  await env.emit({type: 'hello'});
  await env.emit({type: 'generate', request_id: 'REQUEST', payload: {canvasBase64: 'CANVAS', maskBase64: 'MASK', configdata: {}}});
}
test('frontend persists insertion ACK, retries interrupted ACK without resubmitting generation', async () => {
  const s = server({failAck: true}); const e = frontend(s.fetch); await generate(e);
  assert.equal(e.messages.filter(m => m.type === 'result').length, 2);
  await e.emit({type: 'received', request_id: 'REQUEST', index: 0});
  await e.emit({type: 'received', request_id: 'REQUEST', index: 1});
  await e.emit({type: 'ack', request_id: 'REQUEST', index: 0});
  await e.tick();
  assert.ok(s.acknowledged.has(0));
  await e.emit({type: 'ack', request_id: 'REQUEST', index: 1});
  assert.equal(s.acknowledged.size, 2);
  assert.equal(s.calls.filter(c => c.url.endsWith('/submit')).length, 1);
  assert.equal(s.calls.filter(c => /results\/\d+$/.test(c.url)).length, 2);
  assert.equal(e.timers.size, 0);
});
test('frontend resume honors durable server ACKs and ignores forged session/origin messages', async () => {
  const s = server({saved: [0]}); const e = frontend(s.fetch);
  await e.emit({type: 'hello'});
  await e.emit({type: 'resume', requests: ['REQUEST']});
  assert.deepEqual(e.messages.filter(m => m.type === 'result').map(m => m.index), [1]);
  const count = s.calls.length;
  await e.emit({type: 'ack', request_id: 'REQUEST', index: 1, session_id: 'OTHER'});
  await e.emit({type: 'ack', request_id: 'REQUEST', index: 1}, {origin: 'evil-plugin'});
  assert.equal(s.calls.length, count);
});
test('frontend graph serialization cannot submit into a newer binding', async () => {
  const gate = defer(), s = server(), e = frontend(s.fetch, () => gate.promise);
  await e.emit({type: 'hello'});
  const running = e.emit({type: 'generate', request_id: 'REQUEST', payload: {canvasBase64: 'CANVAS', maskBase64: 'MASK'}});
  await settle();
  await e.emit({type: 'hello', panel: 'NEWPANEL', session_id: 'NEWSESSION'});
  gate.resolve({output: {}, workflow: {}}); await running;
  assert.equal(s.calls.filter(c => c.url.endsWith('/submit')).length, 0);
  assert.equal(e.messages.at(-1).session_id, 'NEWSESSION');
});
test('late old-session 401 cannot unbind a new panel', async () => {
  const gate = defer(), s = server();
  const e = frontend((url, options) => url.endsWith('/requests/REQUEST') ? gate.promise : s.fetch(url, options));
  await e.emit({type: 'hello'});
  await e.emit({type: 'resume', requests: ['REQUEST']});
  await e.emit({type: 'hello', panel: 'NEWPANEL', session_id: 'NEWSESSION'});
  gate.resolve(response({detail: 'expired'}, 401)); await settle();
  assert.equal(e.messages.filter(m => m.type === 'unbound' && m.panel === 'NEWPANEL').length, 0);
  await e.emit({type: 'control', panel: 'NEWPANEL', session_id: 'NEWSESSION', payload: {workflow: 'ok'}});
  assert.equal(e.messages.filter(m => m.type === 'ready').at(-1).session_id, 'NEWSESSION');
});
test('frontend re-login tries only owned archived sessions before creating another', async () => {
  const calls = [];
  const e = frontend(async url => {calls.push(url); return url.endsWith('/B') ? response({detail: 'other owner'}, 403) : response({session_id: 'A'});});
  await e.emit({type: 'hello', session_id: 'B', session_ids: ['B', 'A']});
  assert.deepEqual(calls, ['/ps/team/sessions/B', '/ps/team/sessions/A']);
  assert.equal(e.messages.at(-1).session_id, 'A');
});
test('frontend confirmed cancellation stops delivery and duplicate initialization adds no handler', async () => {
  const s = server(), e = frontend(s.fetch); e.context.start(() => {});
  await generate(e); await e.emit({type: 'cancel', request_id: 'REQUEST'});
  assert.equal(e.timers.size, 0);
  assert.equal(s.calls.filter(c => c.method === 'DELETE').length, 1);
});
function panelHarness(storage = {value: null}, custom = {}) {
  const messages = [], previews = [], statuses = [], viewEvents = {};
  let handler, doc = {id: 10}, bounds = {left: 1, top: 2, right: 40, bottom: 50};
  const view = {postMessage: (m, origin) => messages.push({...clone(m), origin}), addEventListener: (type, fn) => {viewEvents[type] = fn;}};
  const hooks = {url: () => 'https://team.example', document: () => doc,
    bounds: () => bounds, canvas: async () => 'CANVAS', mask: async () => 'MASK',
    confirm: async () => 'cancel', status: (...m) => statuses.push(m), preview: async image => previews.push(image),
    activate: async id => {doc = {id};}, setBounds: () => ({old: true}), restoreBounds() {}, control() {},
    load: async () => clone(storage.value), save: async value => {storage.value = clone(value);}, ...custom};
  const context = vm.createContext({console, URL, setInterval() {}, document: {querySelector: () => view}, window: {addEventListener: (type, fn) => {handler = fn;}}});
  vm.runInContext(fs.readFileSync(path.join(root, 'ComfyUI Photoshop Team/dist/ps-team-bridge.js'), 'utf8'), context);
  const bridge = context.createPSTeamBridge(hooks);
  const emit = async data => {await handler({source: view, origin: 'https://team.example', data: {protocol: 'ps-team-1', transport: 'company', panel: messages[0].panel, session_id: 'A', ...data}}); await settle();};
  return {bridge, storage, messages, previews, statuses, viewEvents, hooks, emit,
    setDoc: id => {doc = {id};}, setBounds: value => {bounds = value;},
    connect: async (session = 'A') => {await bridge.connect('https://team.example'); await emit({type: 'ready', session_id: session});},
    capture: async () => {await bridge.capture(async () => ({positive: '', negative: '', seed: '1', slider: 50})); return messages.filter(m => m.type === 'generate').at(-1)?.request_id;}};
}
async function result(p, rid, index = 0, count = 1, image = 'IMAGE') {await p.emit({type: 'result', request_id: rid, index, result_count: count, image});}
test('panel serializes previews/insertion, ACKs only inserted images, and ignores duplicates', async () => {
  const p = panelHarness(); await p.connect(); const rid = await p.capture();
  await result(p, rid, 0, 2, 'FIRST'); await result(p, rid, 0, 2, 'FIRST');
  assert.equal(p.messages.filter(m => m.type === 'ack').length, 0);
  assert.deepEqual(p.previews, ['FIRST']);
  await p.bridge.beforeInsert(); await result(p, rid, 1, 2, 'SECOND');
  assert.deepEqual(p.previews, ['FIRST']);
  await p.bridge.afterInsert(true);
  assert.deepEqual(p.previews, ['FIRST', 'SECOND']);
  assert.deepEqual(p.messages.filter(m => m.type === 'ack').map(m => m.index), [0]);
  await p.bridge.afterInsert(false); // A second failure callback cannot undo successful insertion.
  await p.bridge.beforeInsert(); await p.bridge.afterInsert(true);
  await p.emit({type: 'acknowledged', request_id: rid, index: 0}); await p.emit({type: 'acknowledged', request_id: rid, index: 1});
  assert.equal(p.storage.value.connections['https://team.example'].sessions.A.jobs.length, 0);
});
test('panel restart resumes original document and retries inserted ACK without another layer', async () => {
  const storage = {value: null}; const p = panelHarness(storage); await p.connect(); const rid = await p.capture();
  await result(p, rid); await p.bridge.beforeInsert(); await p.bridge.afterInsert(true);
  const restarted = panelHarness(storage); await restarted.connect();
  assert.deepEqual(restarted.messages.find(m => m.type === 'resume').requests, [rid]);
  assert.deepEqual(restarted.messages.filter(m => m.type === 'ack').map(m => m.index), [0]);
  await result(restarted, rid); await assert.rejects(restarted.bridge.beforeInsert(), /No team result/);
  assert.equal(restarted.previews.length, 0);
});
test('panel restart preserves uncertain insertion and requires explicit layer review', async () => {
  const storage = {value: null}, p = panelHarness(storage); await p.connect(); const rid = await p.capture();
  await result(p, rid); await p.bridge.beforeInsert();
  const restarted = panelHarness(storage); await restarted.connect(); await result(restarted, rid);
  await assert.rejects(restarted.bridge.beforeInsert(), /explicitly rebind/);
  assert.equal(restarted.messages.filter(m => m.type === 'ack').length, 0);
  await restarted.bridge.resolveInsertion(rid, 0, false);
  await restarted.bridge.rebindDocument(rid, 10);
  const context = await restarted.bridge.beforeInsert(); assert.equal(context.documentID, 10);
  await restarted.bridge.afterInsert(true);
  assert.equal(restarted.messages.filter(m => m.type === 'ack').length, 1);
});
test('account A→B→A preserves pending and uncertain jobs without displaying A to B', async () => {
  const p = panelHarness(); await p.connect(); const rid = await p.capture();
  await result(p, rid); await p.bridge.beforeInsert(); await p.bridge.afterInsert(false);
  await p.emit({type: 'ready', session_id: 'B'});
  assert.deepEqual(p.messages.filter(m => m.type === 'resume').at(-1).requests, []);
  await assert.rejects(p.bridge.beforeInsert(), /No team result/);
  const ridB = await p.capture();
  await p.emit({type: 'ready', session_id: 'A'});
  assert.deepEqual(p.messages.filter(m => m.type === 'resume').at(-1).requests, [rid]);
  assert.equal(p.storage.value.connections['https://team.example'].sessions.B.jobs[0][0], ridB);
  await result(p, rid); await assert.rejects(p.bridge.beforeInsert(), /explicitly rebind/);
});
test('capture aborts if document or selection changes between canvas and mask', async () => {
  const gate = defer(), p = panelHarness({value: null}, {canvas: () => gate.promise});
  await p.connect(); const capturing = p.capture(); await settle(); p.setDoc(11); gate.resolve('CANVAS'); await capturing;
  assert.equal(p.messages.filter(m => m.type === 'generate').length, 0);
  assert.match(p.statuses.at(-1)[0], /changed/);
  const q = panelHarness(); await q.connect(); q.hooks.mask = async () => {q.setBounds(null); return 'MASK';}; await q.capture();
  assert.equal(q.messages.filter(m => m.type === 'generate').length, 0);
});
test('navigation during insertion retains result without replacing preview and retries ACK on reconnect', async () => {
  const p = panelHarness(); await p.connect(); const rid = await p.capture(); await result(p, rid);
  await p.bridge.beforeInsert(); p.viewEvents.loadstart(); await p.bridge.afterInsert(true);
  assert.equal(p.messages.filter(m => m.type === 'ack').length, 0);
  await p.emit({type: 'ready'});
  assert.equal(p.messages.filter(m => m.type === 'ack').length, 1);
  await assert.rejects(p.bridge.beforeInsert(), /No team result/);
});
test('journal write failure blocks Photoshop insertion and unreadable journal blocks capture', async () => {
  let fail = false; const p = panelHarness({value: null}, {save: async () => {if (fail) throw new Error('disk full');}});
  await p.connect(); const rid = await p.capture(); await result(p, rid); fail = true;
  await assert.rejects(p.bridge.beforeInsert(), /disk full/);
  assert.equal(p.messages.filter(m => m.type === 'ack').length, 0);
  const q = panelHarness({value: {bad: true}}); await q.bridge.connect('https://team.example'); await q.capture();
  assert.equal(q.messages.filter(m => m.type === 'generate').length, 0);
});

test('restored numeric document ID is not trusted until explicit operator rebind', async () => {
  const storage = {value: null}, p = panelHarness(storage); await p.connect(); const rid = await p.capture();
  await result(p, rid);
  const restarted = panelHarness(storage); await restarted.connect(); await result(restarted, rid);
  await assert.rejects(restarted.bridge.beforeInsert(), /explicitly rebind/);
  await restarted.bridge.rebindDocument(rid, 10);
  await restarted.bridge.beforeInsert(); await restarted.bridge.afterInsert(true);
});
test('insertion fails closed when actual selection mask changed despite identical bounds', async () => {
  const p = panelHarness(); await p.connect(); const rid = await p.capture(); await result(p, rid);
  p.hooks.mask = async () => 'DIFFERENT_SELECTION_SHAPE';
  await assert.rejects(p.bridge.beforeInsert(), /selection\/mask changed/);
  assert.equal(p.messages.filter(m => m.type === 'ack').length, 0);
  p.hooks.mask = async () => 'MASK';
  await p.bridge.beforeInsert(); await p.bridge.afterInsert(true);
});

test('existing Insert action offers reachable rebind and interrupted-insertion recovery dialogs', async () => {
  const storage = {value: null}, p = panelHarness(storage); await p.connect(); const rid = await p.capture();
  await result(p, rid); await p.bridge.beforeInsert();
  const answers = ['rebind', 'inserted'], prompts = [];
  const restarted = panelHarness(storage, {confirm: async (title) => {prompts.push(title); return answers.shift();}});
  await restarted.connect(); await result(restarted, rid);
  assert.equal((await restarted.bridge.beforeInsert()).skip, true);
  assert.deepEqual(prompts, ['Reconnect original document', 'Review interrupted insertion']);
  assert.equal(restarted.messages.filter(m => m.type === 'ack').length, 1);
  await assert.rejects(restarted.bridge.beforeInsert(), /No team result/);
});
test('cancelled recovery retains request and repeated Insert clicks cannot stack dialogs', async () => {
  const storage = {value: null}, p = panelHarness(storage); await p.connect(); const rid = await p.capture(); await result(p, rid);
  const gate = defer(); let dialogs = 0;
  const restarted = panelHarness(storage, {confirm: async () => {dialogs++; return gate.promise;}});
  await restarted.connect(); await result(restarted, rid);
  const first = restarted.bridge.beforeInsert(); await settle();
  await assert.rejects(restarted.bridge.beforeInsert(), /busy/);
  gate.resolve('cancel'); await assert.rejects(first, /Recovery cancelled/);
  assert.equal(dialogs, 1); assert.equal(restarted.messages.filter(m => m.type === 'ack').length, 0);
  assert.equal(storage.value.connections['https://team.example'].sessions.A.jobs.length, 1);
});
test('new binding can upload while abandoned old graph serialization is still pending', async () => {
  const gate = defer(), s = server(); let n = 0;
  const e = frontend(s.fetch, () => ++n === 1 ? gate.promise : Promise.resolve({output: {}, workflow: {}}));
  await e.emit({type: 'hello'});
  const old = e.emit({type: 'generate', request_id: 'REQUEST', payload: {canvasBase64: 'CANVAS', maskBase64: 'MASK'}});
  await settle(); await e.emit({type: 'hello', panel: 'NEWPANEL', session_id: 'NEWSESSION'});
  await e.emit({type: 'generate', panel: 'NEWPANEL', session_id: 'NEWSESSION', request_id: 'NEWREQUEST', payload: {canvasBase64: 'NEW', maskBase64: 'MASK'}});
  assert.equal(s.calls.filter(c => c.url.endsWith('/submit')).length, 1);
  assert.ok(s.calls.some(c => c.url === '/ps/team/sessions/NEWSESSION/requests/NEWREQUEST/submit'));
  gate.resolve({output: {}, workflow: {}}); await old;
});
