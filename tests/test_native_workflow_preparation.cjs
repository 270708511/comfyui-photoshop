// No browser/Photoshop/GPU/network needed: node --test tests/test_native_workflow_preparation.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => JSON.parse(JSON.stringify(value));
const HASH = 'a'.repeat(64);
const CONTROL = Symbol('IS_CONTROL_WIDGET');
const OUT = '🔹SendTo Photoshop Plugin';
const IN = '🔹Photoshop ComfyUI Plugin';
const tick = async () => { for (let n = 0; n < 12; n++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; };

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.attributes = {}; this.listeners = {}; this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; }
  append(...nodes) { for (const node of nodes) {node.parent = this; this.children.push(node);} }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async emit(type) { if (type === 'click' && this.disabled) return; for (const listener of this.listeners[type] || []) await listener({preventDefault() {}}); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
  focus() { this.focused = true; }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
function documentMock() { return {body: new Element('body'), createElement: tag => new Element(tag)}; }
function moduleUnderTest(overrides = {}) {
  const registered = [];
  const document = documentMock();
  const context = vm.createContext({app: {registerExtension: extension => registered.push(extension)}, api: {user: 'team_a'}, comfyWidgets: {IS_CONTROL_WIDGET: CONTROL}, AbortController, URLSearchParams, setTimeout, clearTimeout, document, ...overrides});
  const source = fs.readFileSync(path.join(__dirname, '../js/native-workflow-preparation.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(source + '\nthis.exports = {PreparationError, workflowPath, savedWorkflows, workspaces, validatePrompt, inspectRuntime, parameterCandidates, validateParameters, createPreparationClient, createNativePreparationExtension};', context);
  return {...context.exports, registered, document};
}
function response(body, status = 200) { return {status, ok: status < 400, json: async () => clone(body)}; }
function fixtures({seed = true, linkedSeed = false, mode = 'fixed'} = {}) {
  // The existing server adapter tests use this PS input -> PS output class pair.
  // Expand it with an ordinary KSampler to exercise native literal/linked seeds.
  const prompt = {'1': {class_type: IN, inputs: {}}, '2': {class_type: OUT, inputs: {output: ['1', 0]}}};
  const nodes = [{id: 1, type: IN, comfyClass: IN, widgets: []}, {id: 2, type: OUT, comfyClass: OUT, widgets: []}];
  let hookCalls = 0;
  if (seed) {
    const control = {name: 'control_after_generate', value: mode, options: {serialize: false, values: ['fixed', 'increment', 'decrement', 'randomize']}, [CONTROL]: true,
      beforeQueued() { hookCalls++; }, afterQueued() { hookCalls++; }};
    const seedWidget = {name: 'seed', value: 12345, options: {min: 0, max: 18446744073709551615}, linkedWidgets: [control]};
    nodes.push({id: 3, type: 'KSampler', comfyClass: 'KSampler', widgets: [seedWidget, control, {name: 'sampler_name', value: 'euler', options: {values: ['euler', 'dpmpp_2m']}}], inputs: linkedSeed ? [{name: 'seed', widget: {name: 'seed'}, link: 7}] : []});
    prompt['3'] = {class_type: 'KSampler', inputs: {seed: linkedSeed ? ['1', 2] : 12345, steps: 20, cfg: 7.5, sampler_name: 'euler', positive: ['1', 3]}, _meta: {title: 'Sampler'}};
    prompt['2'].inputs.output = ['3', 0];
  }
  const workflow = {version: 0.4, nodes: nodes.map(node => ({id: node.id, type: node.type, widgets_values: node.widgets.map(widget => widget.value)})), links: [], extra: {keep: 'exact saved bytes as JSON data'}};
  return {prompt, nodes, workflow, graph: {computeExecutionOrder: () => nodes}, hookCalls: () => hookCalls};
}
function serverFixture(fixture, overrides = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({url, options});
    if (overrides[url]) return overrides[url](url, options);
    if (url === '/ps/team/capabilities') return response({protocol: 'ps-team-1', owner_bound: true, standalone_allowed: false});
    if (url === '/api/users') return response({storage: 'server', users: {team_a: 'Shared A', team_b: 'Shared B'}});
    if (url.startsWith('/api/userdata?')) return response([{path: 'demo.json'}, {path: 'folder/demo.json'}]);
    if (url.startsWith('/api/userdata/')) return response(fixture.workflow);
    if (url.startsWith('/ps/team/workflow-preparations?')) return options.method === 'PUT' ? response({status: 'prepared', current_source_hash: HASH, preparation: {preparation_id: 'PREP'}}) : response({status: 'unprepared', current_source_hash: HASH});
    throw new Error('Unexpected URL ' + url);
  };
  let loadCalls = 0, convertCalls = 0;
  const application = {rootGraph: fixture.graph,
    async loadGraphData(data) { loadCalls++; data.extra.frontendVersion = 'MUTATED'; return true; },
    async graphToPrompt() { convertCalls++; return {output: clone(fixture.prompt), workflow: {nodes: [], extra: {wrong: true}}}; }};
  return {calls, fetcher, application, counts: () => ({loadCalls, convertCalls})};
}

// Pure validation tests.
test('extension registers official command/menu only, with no requests or DOM changes on import', () => {
  let requests = 0;
  const m = moduleUnderTest({fetch: () => {requests++;}});
  assert.equal(m.registered.length, 1);
  assert.equal(m.registered[0].commands[0].label, 'Prepare saved workflow for Photoshop');
  assert.deepEqual(clone(m.registered[0].menuCommands), [{path: ['Photoshop'], commands: ['photoshop.prepareSavedWorkflow']}]);
  assert.equal(requests, 0); assert.equal(m.document.body.children.length, 0);
});
test('saved list is relative to workflows and rejects traversal, encoded paths, non-JSON and unsafe separators', () => {
  const m = moduleUnderTest();
  assert.deepEqual(clone(m.savedWorkflows([{path: 'a.json'}, {path: 'nested/猫.json'}, {path: 'a.json'}, {path: '../bad.json'}, {path: '%2e%2e/bad.json'}, {path: 'x\\bad.json'}, {path: 'notes.txt'}])).map(item => item.path), ['workflows/a.json', 'workflows/nested/猫.json']);
  for (const p of ['other/x.json', 'workflows//x.json', 'workflows/../x.json', 'workflows/%2f.json', '/workflows/a.json']) assert.throws(() => m.workflowPath(p));
});
test('profiles preserve real IDs, prefer current api.user and support single-user storage', () => {
  const m = moduleUnderTest();
  assert.equal(m.workspaces({storage: 'server', users: {one: 'One', two: 'Two'}}, 'two').selected, 'two');
  assert.equal(m.workspaces({storage: 'server'}, 'other').selected, 'default');
  assert.throws(() => m.workspaces({storage: 'browser'}, 'other'), /Server-side/);
});
test('API prompt requires nonempty graph, valid nodes and real Photoshop output', () => {
  const m = moduleUnderTest();
  assert.throws(() => m.validatePrompt({}), /empty/);
  assert.throws(() => m.validatePrompt({'1': {class_type: 'SaveImage', inputs: {}}}), /SendTo/);
  assert.throws(() => m.validatePrompt({'1': {class_type: '', inputs: {}}}), /missing node/);
  assert.doesNotThrow(() => m.validatePrompt(fixtures().prompt));
});
test('known fixed core seed control is inspected without invoking callbacks and requires explicit mapping', () => {
  const m = moduleUnderTest(), f = fixtures();
  const inspected = m.inspectRuntime(f.graph, f.workflow);
  assert.deepEqual(clone(inspected.requiredSeeds), [{node_id: '3', input: 'seed'}]);
  const candidates = m.parameterCandidates(f.prompt, inspected.nodes);
  const seed = candidates.find(p => p.input === 'seed');
  assert.equal(seed.type, 'integer'); assert.equal(seed.min, 0); assert.equal(seed.max, Number.MAX_SAFE_INTEGER);
  assert.throws(() => m.validateParameters([], f.prompt, inspected.requiredSeeds), /Map every fixed/);
  assert.doesNotThrow(() => m.validateParameters(candidates, f.prompt, inspected.requiredSeeds));
  assert.equal(f.hookCalls(), 0);
});
test('dynamic seed modes and custom hooks are rejected; legitimate linked seed never becomes a literal', () => {
  const m = moduleUnderTest();
  const dynamic = fixtures({mode: 'randomize'});
  assert.throws(() => m.inspectRuntime(dynamic.graph, dynamic.workflow), /Set each built-in seed control to fixed/);
  assert.equal(dynamic.hookCalls(), 0);
  const linked = fixtures({mode: 'randomize', linkedSeed: true});
  const inspected = m.inspectRuntime(linked.graph, linked.workflow);
  assert.equal(inspected.requiredSeeds.length, 0);
  assert.ok(!m.parameterCandidates(linked.prompt, inspected.nodes).some(p => p.input === 'seed'));
  assert.equal(linked.hookCalls(), 0);
  const custom = fixtures(); custom.nodes[2].widgets.push({name: 'custom', beforeQueued() {throw new Error('must not run');}});
  assert.throws(() => m.inspectRuntime(custom.graph, custom.workflow), /custom queue-time/);
});
test('name-only imitation and missing official core marker cannot bypass hook restrictions', () => {
  const m = moduleUnderTest(), f = fixtures();
  delete f.nodes[2].widgets[1][CONTROL];
  assert.throws(() => m.inspectRuntime(f.graph, f.workflow), /custom queue-time/);
  assert.throws(() => m.inspectRuntime(fixtures().graph, fixtures().workflow, null), /custom queue-time/);
});
test('subgraphs, wrong loaded nodes and unsafe seed integers fail closed', () => {
  const m = moduleUnderTest(), f = fixtures();
  assert.throws(() => m.inspectRuntime(f.graph, {...f.workflow, definitions: {subgraphs: [{}]}}), /Subgraphs/);
  assert.throws(() => m.inspectRuntime({computeExecutionOrder: () => f.nodes.slice(0, 1)}, f.workflow), /does not match/);
  f.nodes[2].widgets[0].value = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => m.inspectRuntime(f.graph, f.workflow), /safe integer/);
});
test('candidates use scalar values only, retain combo enums, bound numbers and leave connections untouched', () => {
  const m = moduleUnderTest(), f = fixtures();
  f.prompt['3'].inputs.flag = true;
  f.prompt['3'].inputs.object = {value: 1};
  f.prompt['3'].inputs.nonFinite = Infinity;
  const candidates = m.parameterCandidates(f.prompt, f.nodes);
  assert.ok(!candidates.some(p => ['positive', 'object', 'nonFinite', 'output'].includes(p.input)));
  assert.deepEqual(clone(candidates.find(p => p.input === 'sampler_name').options), ['euler', 'dpmpp_2m']);
  assert.equal(candidates.find(p => p.input === 'flag').type, 'boolean');
  assert.equal(candidates.find(p => p.input === 'steps').min, 20);
  assert.equal(candidates.find(p => p.input === 'steps').max, 20);
});
test('parameter validation rejects duplicate targets, connection mapping, unknown fields and bad bounds/types', () => {
  const m = moduleUnderTest(), f = fixtures();
  const valid = {id: 'seed', node_id: '3', input: 'seed', type: 'integer', default: 12345, min: 0, max: 100000};
  for (const list of [[valid, {...valid, id: 'other'}], [{...valid, input: 'positive'}], [{...valid, extra: true}], [{...valid, min: 20000}], [{...valid, type: 'number'}], [{...valid, default: 999}], [{...valid, max: Number.MAX_SAFE_INTEGER + 1}], [{...valid, id: '__proto__'}]]) assert.throws(() => m.validateParameters(list, f.prompt));
  assert.doesNotThrow(() => m.validateParameters([valid], f.prompt));
  const enumParam = {id: 'sampler', node_id: '3', input: 'sampler_name', type: 'enum', default: 'euler', options: ['euler', 'other']};
  assert.doesNotThrow(() => m.validateParameters([enumParam], f.prompt));
  assert.throws(() => m.validateParameters([{...enumParam, options: [{}]}], f.prompt), /Enum/);
});

// Mocked frontend/API integration tests, with no queue/execute endpoint calls.
test('read-only catalog discovers company support and uses cookie auth plus current profile', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  const client = m.createPreparationClient({application: s.application, frontendAPI: {user: 'team_b'}, fetcher: s.fetcher});
  assert.equal((await client.catalog()).selected, 'team_b');
  await client.workflows('team_a');
  assert.equal(s.calls.length, 3);
  assert.ok(s.calls.every(call => call.options.method === 'GET' && call.options.credentials === 'same-origin' && call.options.headers['X-PS-Team'] === 'ps-team-1' && call.options.redirect === 'error'));
  assert.equal(s.calls[1].options.headers['Comfy-User'], 'team_b');
  assert.equal(s.calls[2].options.headers['Comfy-User'], 'team_a');
});
test('no company capability or auth failure causes no legacy fallback and no graph load', async () => {
  const m = moduleUnderTest(), f = fixtures();
  for (const answer of [response({protocol: 'other', owner_bound: true}), response({}, 401), response({}, 404)]) {
    const s = serverFixture(f, {'/ps/team/capabilities': async () => answer});
    const client = m.createPreparationClient({application: s.application, fetcher: s.fetcher});
    await assert.rejects(client.catalog());
    assert.equal(s.calls.length, 1); assert.equal(s.counts().loadCalls, 0);
  }
});
test('inspect demands replacement consent; save demands separate review and exact raw source survives frontend mutations', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  const client = m.createPreparationClient({application: s.application, fetcher: s.fetcher});
  await assert.rejects(client.inspect('team_a', 'workflows/demo.json'), /Confirm/);
  assert.equal(s.calls.length, 0);
  const draft = await client.inspect('team_a', 'workflows/demo.json', {replaceConfirmed: true});
  assert.deepEqual(clone(draft.workflow), f.workflow);
  assert.equal(s.calls[0].url, '/api/userdata/workflows%2Fdemo.json');
  assert.ok(s.calls.every(call => call.options.method === 'GET'));
  await assert.rejects(client.save(draft, draft.candidates), /Review/);
  assert.equal(s.calls.length, 2);
  await client.save(draft, draft.candidates, {reviewConfirmed: true});
  const put = s.calls[2]; assert.equal(put.options.method, 'PUT');
  const body = JSON.parse(put.options.body);
  assert.deepEqual(body.workflow, f.workflow); assert.deepEqual(body.api_prompt, f.prompt);
  assert.equal(body.source_hash, HASH);
  assert.ok(!JSON.stringify(body).includes('MUTATED'));
  assert.equal(f.hookCalls(), 0);
  assert.deepEqual(s.counts(), {loadCalls: 1, convertCalls: 1});
});
test('existing server PS input/output fixture can be prepared without any browser seed control', async () => {
  const m = moduleUnderTest(), f = fixtures({seed: false}), s = serverFixture(f);
  const serverTests = fs.readFileSync(path.join(__dirname, '../../comfyui-server/tests/test_ps_team_api.py'), 'utf8');
  assert.ok(serverTests.includes(IN) && serverTests.includes(OUT));
  const client = m.createPreparationClient({application: s.application, fetcher: s.fetcher});
  const draft = await client.inspect('team_a', 'workflows/demo.json', {replaceConfirmed: true});
  await client.save(draft, [], {reviewConfirmed: true});
  assert.deepEqual(JSON.parse(s.calls.at(-1).options.body).api_prompt, f.prompt);
});
test('stale status can be re-prepared, while write-time source races fail and never queue work', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  const fetcher = async (url, options) => url.startsWith('/ps/team/workflow-preparations?') ? response(options.method === 'PUT' ? {} : {status: 'stale', current_source_hash: HASH}, options.method === 'PUT' ? 409 : 200) : s.fetcher(url, options);
  const client = m.createPreparationClient({application: s.application, fetcher});
  const draft = await client.inspect('team_a', 'workflows/demo.json', {replaceConfirmed: true});
  assert.equal(draft.previousStatus, 'stale');
  await assert.rejects(client.save(draft, draft.candidates, {reviewConfirmed: true}), /saved workflow changed/);
  assert.ok(s.calls.every(call => !/prompt|queue|submit/.test(call.url)));
});
test('conversion errors never expose raw secrets and never save or fall back', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  s.application.graphToPrompt = async () => {throw new Error('SECRET_TOKEN bad https://user:secret@server');};
  const client = m.createPreparationClient({application: s.application, fetcher: s.fetcher});
  await assert.rejects(client.inspect('team_a', 'workflows/demo.json', {replaceConfirmed: true}), error => !error.message.includes('SECRET') && /could not convert/.test(error.message));
  assert.equal(s.calls.length, 2);
});
test('unconfirmed graph loads cannot accidentally prepare the prior graph', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  s.application.loadGraphData = async () => undefined;
  const client = m.createPreparationClient({application: s.application, fetcher: s.fetcher});
  await assert.rejects(client.inspect('team_a', 'workflows/demo.json', {replaceConfirmed: true}), /could not confirm loading/);
  assert.equal(s.counts().convertCalls, 0);
});

// Dialog repeated/interrupted flows, including no graph replacement on dismissal.
function controls(dialog) {
  const all = dialog.all();
  const buttons = all.filter(el => el.tagName === 'button');
  const selects = all.filter(el => el.tagName === 'select');
  const checks = all.filter(el => el.tagName === 'input');
  return {profile: selects[0], workflow: selects[1], replace: checks[0], review: checks[1], load: buttons[0], save: buttons[1], close: buttons[2], mapping: all.find(el => el.tagName === 'textarea'), status: all.find(el => el.attributes.role === 'status')};
}
test('dialog stays singleton; close/reopen and changing selection cannot reuse a stale draft', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  const extension = m.createNativePreparationExtension({application: s.application, frontendAPI: {user: 'team_a'}, documentObject: m.document, fetcher: s.fetcher});
  const open = extension.commands[0].function;
  const dialog = open(); assert.equal(open(), dialog); await tick();
  let c = controls(dialog); assert.equal(c.load.disabled, true);
  await c.close.emit('click'); assert.equal(s.counts().loadCalls, 0); assert.equal(m.document.body.children.length, 0);
  const second = open(); await tick(); c = controls(second);
  c.replace.checked = true; await c.replace.emit('change'); assert.equal(c.load.disabled, false);
  await c.load.emit('click'); assert.equal(c.save.disabled, true); assert.ok(c.mapping.value.includes('seed'));
  c.review.checked = true; await c.review.emit('change'); assert.equal(c.save.disabled, false);
  c.workflow.value = 'workflows/folder/demo.json'; await c.workflow.emit('change');
  assert.equal(c.save.disabled, true); assert.equal(c.mapping.value, '[]'); assert.equal(c.replace.checked, false);
  await second.emit('cancel'); assert.equal(m.document.body.children.length, 0);
});
test('mapping edits reset review; explicit save writes once and disables repeat save', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  const ext = m.createNativePreparationExtension({application: s.application, documentObject: m.document, fetcher: s.fetcher});
  const dialog = ext.commands[0].function(); await tick(); const c = controls(dialog);
  c.replace.checked = true; await c.replace.emit('change'); await c.load.emit('click');
  c.review.checked = true; await c.review.emit('change'); await c.mapping.emit('input');
  assert.equal(c.review.checked, false); assert.equal(c.save.disabled, true);
  c.review.checked = true; await c.review.emit('change'); await c.save.emit('click'); await c.save.emit('click');
  assert.equal(s.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.match(c.status.textContent, /Preparation saved/); assert.equal(c.save.disabled, true);
  await c.close.emit('click');
});
test('busy preparation blocks repeat load, close and escape; async completion cannot become a hidden save', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f), wait = deferred();
  s.application.loadGraphData = async () => {await wait.promise; return true;};
  const ext = m.createNativePreparationExtension({application: s.application, documentObject: m.document, fetcher: s.fetcher});
  const dialog = ext.commands[0].function(); await tick(); const c = controls(dialog);
  c.replace.checked = true; await c.replace.emit('change'); const loading = c.load.emit('click'); await tick();
  assert.equal(c.load.disabled, true); assert.equal(c.close.disabled, true);
  await c.load.emit('click'); await dialog.emit('cancel'); assert.equal(m.document.body.children.length, 1);
  wait.resolve(); await loading;
  assert.equal(c.save.disabled, true); assert.equal(s.calls.filter(call => call.url.startsWith('/api/userdata/')).length, 1);
  assert.equal(s.calls.filter(call => call.options.method === 'PUT').length, 0);
  await c.close.emit('click');
});
test('dialog survives authentication failure with actionable text and allows dismissal/retry', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f, {'/ps/team/capabilities': async () => response({}, 401)});
  const ext = m.createNativePreparationExtension({application: s.application, documentObject: m.document, fetcher: s.fetcher});
  const dialog = ext.commands[0].function(); await tick(); const c = controls(dialog);
  assert.match(c.status.textContent, /Sign in/); assert.equal(c.load.disabled, true); assert.equal(c.close.disabled, false);
  await c.close.emit('click'); assert.equal(m.document.body.children.length, 0);
});

test('empty workflow-directory 404 is an empty list while missing selected-file 404 remains an error', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  const fetcher = async (url, options) => url.startsWith('/api/userdata') ? response({}, 404) : s.fetcher(url, options);
  const client = m.createPreparationClient({application: s.application, fetcher});
  await client.catalog();
  assert.deepEqual(clone(await client.workflows('team_a')), []);
  await assert.rejects(client.inspect('team_a', 'workflows/missing.json', {replaceConfirmed: true}), /unavailable/);
  assert.equal(s.counts().loadCalls, 0);
});
test('all serialized literal seeds require bounded mapping even without browser hooks; unsafe seed serialization fails', async () => {
  const m = moduleUnderTest(), f = fixtures(), s = serverFixture(f);
  f.nodes[2].widgets = f.nodes[2].widgets.filter(widget => !widget.beforeQueued);
  const client = m.createPreparationClient({application: s.application, fetcher: s.fetcher});
  const draft = await client.inspect('team_a', 'workflows/demo.json', {replaceConfirmed: true});
  await assert.rejects(client.save(draft, draft.candidates.filter(p => p.input !== 'seed'), {reviewConfirmed: true}), /Map every fixed/);
  f.prompt['3'].inputs.seed = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(client.inspect('team_a', 'workflows/demo.json', {replaceConfirmed: true}), /literal seed inputs/);
  assert.ok(!s.calls.some(call => call.options.method === 'PUT'));
});
test('parameter defaults are immutable snapshots rather than silent API prompt rewrites', () => {
  const m = moduleUnderTest(), f = fixtures();
  const parameter = {id: 'sampler', node_id: '3', input: 'sampler_name', type: 'string', default: 'other'};
  assert.throws(() => m.validateParameters([parameter], f.prompt), /exactly match/);
});
