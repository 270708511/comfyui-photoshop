const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync(require('node:path').resolve(__dirname, '../ComfyUI Photoshop Team/dist/ps-team-bridge.js'), 'utf8');
async function fixture() {
  let doc = {id: 42};
  const events = {}, messages = [], previews = [], activated = [], statuses = [];
  const view = {postMessage: m => messages.push(m), addEventListener() {}};
  const context = {URL, Math, Map, Set, Promise, setInterval() {},
    document: {querySelector: () => view}, window: {addEventListener: (t, cb) => events[t] = cb}};
  vm.createContext(context); vm.runInContext(code, context);
  const hooks = {url: () => 'https://comfyui.ct108.org', status: (...a) => statuses.push(a),
    control() {}, document: () => doc, canvas: async () => 'canvas', mask: async () => 'mask',
    bounds: () => ({left: 1, top: 2, right: 3, bottom: 4}), setBounds() {},
    preview: async image => previews.push(image), activate: async id => {activated.push(id); doc = {id};}};
  const bridge = context.createPSTeamBridge(hooks); await bridge.connect(hooks.url());
  const panel = messages[0].panel;
  let session = null;
  const receive = (m, source = view, origin = hooks.url()) => {
    if (m.type === 'ready' && source === view && origin === hooks.url()) session = m.session_id;
    return events.message({source, origin, data: {protocol: 'ps-team-1', transport: 'company', panel, session_id: session, result_count: 1, ...m}});
  };
  return {bridge, receive, messages, previews, activated, statuses, hooks, setDocument: id => {doc = {id};}};
}
test('spoofed source/origin cannot bind or trigger capture', async () => {
  const f = await fixture();
  await f.receive({type: 'ready', session_id: 'a'}, {}, 'https://evil.test');
  await f.bridge.capture(async () => ({}));
  assert.equal(f.messages.filter(m => m.type === 'generate').length, 0);
});
test('full canvas and mask each generation, stable original document, duplicate result/insert protection', async () => {
  const f = await fixture(); await f.receive({type: 'ready', session_id: 'session'});
  await f.bridge.capture(async () => ({seed: 1}));
  const request = f.messages.find(m => m.type === 'generate');
  assert.equal(request.payload.canvasBase64, 'canvas'); assert.equal(request.payload.maskBase64, 'mask');
  await Promise.all([f.receive({type: 'result', request_id: request.request_id, index: 0, image: 'red'}),
    f.receive({type: 'result', request_id: request.request_id, index: 0, image: 'red'})]);
  assert.deepEqual(f.previews, ['red']);
  assert.equal((await f.bridge.beforeInsert()).documentID, 42); await f.bridge.afterInsert(true);
  await assert.rejects(f.bridge.beforeInsert(), /No team result/);
  assert.deepEqual(f.activated, [42]);
});
test('panel reconnect resumes request IDs without duplicate generation', async () => {
  const f = await fixture(); await f.receive({type: 'ready', session_id: 'session'});
  await f.bridge.capture(async () => ({}));
  await f.bridge.connect(f.hooks.url()); await f.receive({type: 'ready', session_id: 'session'});
  assert.equal(f.messages.filter(m => m.type === 'generate').length, 1);
  assert.equal(f.messages.filter(m => m.type === 'resume').at(-1).requests.length, 1);
});
test('different panels never accept each others result', async () => {
  const a = await fixture(), b = await fixture();
  await a.receive({type: 'ready', session_id: 'a'}); await b.receive({type: 'ready', session_id: 'b'});
  await a.bridge.capture(async () => ({}));
  const req = a.messages.find(m => m.type === 'generate');
  await b.receive({type: 'result', request_id: req.request_id, index: 0, image: 'alice'});
  assert.equal(b.previews.length, 0);
});
test('closed original document keeps result available for retry', async () => {
  const f = await fixture(); await f.receive({type: 'ready', session_id: 's'}); await f.bridge.capture(async () => ({}));
  const req = f.messages.find(m => m.type === 'generate');
  await f.receive({type: 'result', request_id: req.request_id, index: 0, image: 'red'});
  f.hooks.activate = async () => { throw new Error('Original document is closed'); };
  await assert.rejects(f.bridge.beforeInsert(), /closed/);
  f.hooks.activate = async id => f.setDocument(id);
  assert.equal((await f.bridge.beforeInsert()).documentID, 42);
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {resolve = a; reject = b;});
  return {promise, resolve, reject};
};
async function threeDocuments(f) {
  await f.receive({type:'ready', session_id:'session'});
  for (const id of [1, 2, 3]) {
    f.setDocument(id);
    await f.bridge.capture(async () => ({}));
  }
  return f.messages.filter(m => m.type === 'generate');
}
test('three documents: delayed next preview cannot race a new result into the wrong document', async () => {
  const f = await fixture(); const requests = await threeDocuments(f);
  const startedB = deferred(), finishB = deferred(); let previewFile;
  f.hooks.preview = async image => {
    previewFile = image;
    if (image === 'B') {startedB.resolve(); await finishB.promise;}
  };
  const result = (n, image) => f.receive({type:'result', request_id:requests[n].request_id, index:0, image});
  await result(0, 'A'); await result(1, 'B');
  assert.equal((await f.bridge.beforeInsert()).documentID, 1);
  const next = f.bridge.afterInsert(true); await startedB.promise;
  const newResult = result(2, 'C');
  await Promise.resolve(); assert.equal(previewFile, 'B');
  finishB.resolve(); await Promise.all([next, newResult]);
  assert.equal(previewFile, 'B');
  assert.equal((await f.bridge.beforeInsert()).documentID, 2);
  await f.bridge.afterInsert(true);
  assert.equal(previewFile, 'C');
  assert.equal((await f.bridge.beforeInsert()).documentID, 3);
});
test('insertion failure and closed original document keep image/context together while new results arrive', async () => {
  const f = await fixture(); const requests = await threeDocuments(f); let previewFile;
  f.hooks.preview = async image => {previewFile = image;};
  const result = (n, image) => f.receive({type:'result',request_id:requests[n].request_id,index:0,image});
  await result(0, 'A'); assert.equal((await f.bridge.beforeInsert()).documentID, 1);
  await result(1, 'B'); await f.bridge.afterInsert(false);
  await f.bridge.resolveInsertion(requests[0].request_id, 0, false);
  assert.equal(previewFile, 'A');
  f.hooks.activate = async () => {throw new Error('Original document is closed');};
  await assert.rejects(f.bridge.beforeInsert(), /closed/);
  await result(2, 'C'); assert.equal(previewFile, 'A');
  f.hooks.activate = async id => f.setDocument(id);
  assert.equal((await f.bridge.beforeInsert()).documentID, 1);
  await f.bridge.afterInsert(true);
  assert.equal(previewFile, 'B'); assert.equal((await f.bridge.beforeInsert()).documentID, 2);
});
test('failed next preview is retried before insertion and never re-inserts its completed predecessor', async () => {
  const f = await fixture(); const requests = await threeDocuments(f); let previewFile, attempts = 0;
  f.hooks.preview = async image => {
    previewFile = image;
    if (image === 'B' && attempts++ === 0) throw new Error('Preview refresh failed');
  };
  for (const [n, image] of [[0,'A'],[1,'B']]) await f.receive({type:'result',request_id:requests[n].request_id,index:0,image});
  assert.equal((await f.bridge.beforeInsert()).documentID, 1);
  await assert.rejects(f.bridge.afterInsert(true), /Preview refresh failed/);
  await f.bridge.afterInsert(false);
  assert.equal((await f.bridge.beforeInsert()).documentID, 2);
  assert.equal(previewFile, 'B');
});
// Connect the actual WebView and UXP bridge implementations in separate realms.
// Only Adobe/browser hosting and HTTP responses are simulated; protocol messages flow both ways.
