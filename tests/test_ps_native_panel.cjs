const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../ComfyUI Photoshop Team/dist/ps-native-panel.js'), 'utf8');

// Deliberately small UXP DOM: no browser select/options, innerHTML, URL, fetch,
// webview, querySelector, classList, replaceChildren, dataset or DOM libraries.
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.document = document; this.children = []; this.parentNode = null;
    this.attrs = {}; this.listeners = {}; this.style = {}; this._value = ''; this._text = '';
    this.disabled = false; this.checked = false; this.selectedIndex = -1;
  }
  set innerHTML(_) { throw new Error('Untrusted HTML must not be rendered'); }
  get innerHTML() { throw new Error('innerHTML is outside the supported subset'); }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  get value() {
    if (this.document.maskedReadBug && this.attrs.type === 'password') return undefined;
    if (this.attrs['data-field'] === 'password' && this.attrs.type === 'text') assert.equal(this.style.display, 'none', 'password fallback must be hidden');
    return this._value;
  }
  set value(value) { this._value = value; }
  setAttribute(name, value) {
    if (name === 'type' && value === 'text' && this.attrs['data-field'] === 'password') assert.equal(this.style.display, 'none');
    this.attrs[name] = String(value);
  }
  removeAttribute(name) { delete this.attrs[name]; }
  getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(value => value !== fn); }
  emit(type) { for (const listener of [...this.listeners[type] || []]) listener({target: this, type}); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; }
function fixture(options = {}) {
  const document = {maskedReadBug: !!options.maskedReadBug, created: [], createElement(tag) {
    assert.ok(['div', 'sp-textfield', 'sp-label', 'sp-button', 'sp-dropdown', 'sp-menu', 'sp-menu-item', 'sp-checkbox'].includes(tag), 'supported UXP tag: ' + tag);
    const element = new Element(tag, this); this.created.push(element); return element;
  }};
  const container = document.createElement('div');
  const listeners = new Set(), calls = [];
  let state = {origin: '', authenticated: false, ready: false, workspaces: [], workflows: [], parameters: {}, parameter_schema: [], pending: [], ...options.state};
  const transport = {
    getState() { return clone(state); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    connect(origin) { calls.push(['connect', origin]); set({origin}); return true; },
    login(username, password) {
      assert.equal(find('password')._value, '', 'password cleared before transport is called');
      assert.equal(find('password').getAttribute('type'), 'password');
      calls.push(['login', username, password]); set({authenticated: true, ready: true, username}); return true;
    },
    logout() { calls.push(['logout']); set({authenticated: false, ready: false, username: '', workspace_id: null, workflow_path: null, parameter_schema: [], parameters: {}, pending: []}); return true; },
    refreshWorkspaces() { calls.push(['refreshWorkspaces']); return true; },
    selectWorkspace(id) { calls.push(['selectWorkspace', id]); set({workspace_id: id, workflow_path: null, parameters: {}, parameter_schema: [], canGenerate: false}); return true; },
    refreshWorkflows() { calls.push(['refreshWorkflows']); return true; },
    selectWorkflow(id) { calls.push(['selectWorkflow', id]); set({workflow_path: id, canGenerate: true}); return true; },
    setParameters(values) { calls.push(['setParameters', clone(values)]); set({parameters: clone(values)}); return true; },
    ...options.transport
  };
  function set(patch) { state = {...state, ...patch}; for (const listener of listeners) listener(clone(state)); }
  function find(name, kind = 'data-field', from = container) {
    if (from.getAttribute(kind) === name) return from;
    for (const child of from.children) { const result = find(name, kind, child); if (result) return result; }
    return null;
  }
  const generated = [], cancelled = [];
  const context = {document}; vm.createContext(context); vm.runInContext(source, context);
  const panel = context.createPSNativePanel({transport, document, onGenerate: snapshot => generated.push(snapshot), onCancel: rid => cancelled.push(rid), ...options.hooks});
  const input = (name, value, type = 'input') => { const node = find(name); node.value = value; node.emit(type); return node; };
  const click = name => { find(name, 'data-action').emit('click'); };
  const select = (name, index) => { const node = find(name); node.selectedIndex = index; node.emit('change'); return node; };
  return {panel, transport, document, container, listeners, calls, generated, cancelled, set, find, input, click, select, get state() { return state; }};
}
function ready(options = {}) {
  return fixture({...options, state: {origin: 'http://comfy.example.test:8188', authenticated: true, ready: true, username: 'alice', session_id: 'session-a', workspace_id: 'team-a', workflow_path: 'paint.json', canGenerate: true,
    workspaces: [{id: 'team-a', name: 'Art'}, {id: 'team-b', name: 'Retouch'}], workflows: [{path: 'paint.json', name: 'Paint', prepared: true}], ...options.state}});
}

test('native UXP mount has no network, storage or WebView dependency and is idempotent', () => {
  const f = fixture();
  f.panel.mount(f.container).mount(f.container);
  assert.equal(f.calls.length, 0);
  assert.equal(f.listeners.size, 1);
  assert.equal(f.container.children.length, 1);
  assert.equal(f.find('signin', 'data-action').disabled, true);
  assert.equal(f.panel.validate(), false);
  assert.equal(f.find('workspace').tagName, 'sp-dropdown');
  assert.equal(f.find('workspace').children[0].getAttribute('slot'), 'options');
  assert.equal(f.find('workspace').style.width, '100%');
  assert.equal(f.find('password').getAttribute('type'), 'password');
  assert.ok(!/localStorage|sessionStorage|console\.|\bfetch\(|\.innerHTML|createElement\(['"]webview/.test(source));
});

test('manual connect preserves HTTP and requires connection before login', async () => {
  const f = fixture(); f.panel.mount(f.container);
  f.input('server', 'http://comfy.example.test:8188');
  assert.equal(f.find('signin', 'data-action').disabled, true);
  f.click('connect'); await flush();
  assert.deepEqual(f.calls, [['connect', 'http://comfy.example.test:8188']]);
  f.input('username', ' alice '); f.input('password', 'private password');
  f.click('signin'); await flush();
  assert.deepEqual(f.calls[1], ['login', 'alice', 'private password']);
  assert.equal(f.find('password')._value, '');
  assert.equal(f.find('password').getAttribute('value'), null);
  assert.ok(!f.container.textContent.includes('private password'));
  assert.match(f.container.textContent, /Signed in as alice/);
});

test('password-value macOS fallback remains hidden and clears before login', async () => {
  const f = fixture({maskedReadBug: true, state: {origin: 'https://comfy.example.test'}}); f.panel.mount(f.container);
  f.input('username', 'alice'); f.input('password', 'do-not-display'); f.click('signin'); await flush();
  assert.equal(f.calls[0][2], 'do-not-display');
  assert.equal(f.find('password')._value, '');
  assert.equal(f.find('password').getAttribute('type'), 'password');
  assert.ok(!f.container.textContent.includes('do-not-display'));
});

test('rejected login never echoes exception or server credential text and allows retry', async () => {
  const wait = deferred();
  const f = fixture({state: {origin: 'https://comfy.example.test'}, transport: {login() { return wait.promise; }}}); f.panel.mount(f.container);
  f.input('username', 'alice'); f.input('password', 'secret-word'); f.click('signin');
  assert.equal(f.find('password')._value, '');
  assert.equal(f.find('signin', 'data-action').disabled, true);
  f.set({error: {code: 'LOGIN_FAILED', message: 'server echoed secret-word'}});
  assert.ok(!f.container.textContent.includes('secret-word'));
  wait.reject(new Error('request secret-word https://server/?token=secret')); await flush();
  assert.equal(f.find('password')._value, '');
  assert.equal(f.find('signin', 'data-action').disabled, false);
  assert.match(f.container.textContent, /Sign-in failed/);
  assert.ok(!f.container.textContent.includes('secret-word'));
});

test('all full workspaces and unprepared/stale workflows appear with escaped text', () => {
  const f = ready({state: {workspaces: [{id: 'team-a', name: 'Full workspace'}, {id: 'team-b', name: '<script>alert(1)</script>'}, {id: 'extra', name: 'Another workspace'}], workflows: [
    {path: 'paint.json', prepared: true}, {path: 'raw.json', prepared: false}, {path: 'old.json', stale: true, stale_reason: 'Graph changed <b>prepare again</b>'}
  ]}}); f.panel.mount(f.container);
  assert.equal(f.find('workspace').children[0].children.length, 4);
  assert.equal(f.find('workflow').children[0].children.length, 4);
  assert.match(f.container.textContent, /Not prepared for Photoshop/);
  assert.ok(f.container.textContent.includes('<script>alert(1)</script>'));
  assert.ok(f.container.textContent.includes('Graph changed <b>prepare again</b>'));
  assert.ok(f.document.created.every(node => node.tagName !== 'script'));
});

test('workspace then workflow selection calls exact IDs and blocks repeated in-flight actions', async () => {
  const wait = deferred();
  const f = ready(); f.transport.selectWorkspace = id => { f.calls.push(['selectWorkspace', id]); f.set({workspace_id: id, workflow_path: null, parameter_schema: [], parameters: {}, canGenerate: false}); return wait.promise; };
  f.panel.mount(f.container);
  f.select('workspace', 2); f.select('workspace', 1); f.select('workflow', 1);
  assert.deepEqual(f.calls, [['selectWorkspace', 'team-b']]);
  assert.equal(f.find('workspace').disabled, true);
  assert.equal(f.find('workflow').disabled, true);
  assert.equal(f.find('generate', 'data-action').disabled, true);
  wait.resolve(true); await flush();
  f.select('workflow', 1); await flush();
  assert.deepEqual(f.calls[1], ['selectWorkflow', 'paint.json']);
  f.click('refresh-workspaces'); await flush(); f.click('refresh-workflows'); await flush();
  assert.deepEqual(f.calls.slice(-2), [['refreshWorkspaces'], ['refreshWorkflows']]);
});

const parameterState = {parameter_schema: [
  {key: 'seed', type: 'integer', default: 999999999},
  {key: 'strength', type: 'number', minimum: 0, maximum: 1, default: 0.5},
  {key: 'enabled', type: 'boolean', default: false},
  {key: 'mode', type: 'enum', options: [{label: 'Fast', value: 1}, {label: 'Quality', value: 2}], default: 1},
  {key: 'prompt', type: 'string', default: 'Landscape'}
], parameters: {seed: 999999999, strength: 0.5, enabled: false, mode: 1, prompt: 'Landscape'}};

test('typed parameters preserve booleans/enums and support large integer seeds without UXP number caps', async () => {
  const f = ready({state: parameterState}); f.panel.mount(f.container);
  assert.equal(f.find('parameter:seed').getAttribute('type'), 'text');
  f.input('parameter:seed', '1234567890');
  f.find('parameter:enabled').checked = true; f.find('parameter:enabled').emit('change');
  f.select('parameter:mode', 1);
  f.input('parameter:prompt', '<img src=x onerror=alert(1)>');
  assert.deepEqual(f.state.parameters, {seed: 1234567890, strength: 0.5, enabled: true, mode: 2, prompt: '<img src=x onerror=alert(1)>'});
  assert.equal(f.panel.validate(), true);
  f.click('generate'); await flush();
  assert.equal(f.generated.length, 1);
  assert.equal(f.generated[0].workspace_id, 'team-a');
  assert.deepEqual(f.generated[0].parameters, f.state.parameters);
});

test('invalid numeric drafts never reach transport or main Generate and survive state notifications', () => {
  const f = ready({state: parameterState}); f.panel.mount(f.container);
  for (const value of ['', 'NaN', 'Infinity', 'not a number', '1.1', '9007199254740992']) {
    const count = f.calls.length;
    f.input('parameter:seed', value);
    assert.equal(f.calls.length, count);
    assert.equal(f.panel.validate(), false);
    assert.equal(f.find('generate', 'data-action').disabled, true);
    f.set({status: 'polling'});
    assert.equal(f.find('parameter:seed').value, value);
  }
  f.input('parameter:seed', '42');
  f.input('parameter:strength', '2'); assert.equal(f.panel.validate(), false);
  f.input('parameter:strength', '0.25'); assert.equal(f.panel.validate(), true);
  assert.equal(f.state.parameters.seed, 42);
  assert.equal(f.state.parameters.strength, 0.25);
});

test('transport parameter rejection blocks shared validation until a corrected edit', () => {
  const f = ready({state: parameterState}); f.panel.mount(f.container);
  const normal = f.transport.setParameters;
  f.transport.setParameters = () => { throw new Error('private server body'); };
  f.input('parameter:seed', '43');
  assert.equal(f.panel.validate(), false);
  assert.equal(f.find('generate', 'data-action').disabled, true);
  assert.ok(!f.container.textContent.includes('private server body'));
  f.transport.setParameters = normal;
  f.input('parameter:seed', '44'); assert.equal(f.panel.validate(), true);
});

test('JSON schema field defaults work and unsupported scalar types fail closed', () => {
  const f = ready({state: {parameter_schema: {properties: {name: {type: 'string', default: ''}, unsafe: {type: 'object', default: {value: 1}}}, required: ['name']}, parameters: {}}}); f.panel.mount(f.container);
  assert.equal(f.panel.validate(), false);
  assert.match(f.container.textContent, /This value is required/);
  assert.match(f.container.textContent, /Unsupported parameter type/);
});

test('selection and account changes remove stale controls, errors and detached listeners', () => {
  const f = ready({state: parameterState}); f.panel.mount(f.container);
  const old = f.input('parameter:seed', 'invalid');
  assert.equal(f.panel.validate(), false);
  f.set({workspace_id: 'team-b', workflow_path: 'new.json', parameter_schema: [{key: 'other', type: 'string', default: 'new'}], parameters: {other: 'new'}});
  assert.equal(f.find('parameter:seed'), null);
  assert.equal(f.panel.validate(), true);
  const count = f.calls.length; old.value = '75'; old.emit('input'); assert.equal(f.calls.length, count);
  f.set({authenticated: false, ready: false, username: '', workflow_path: null});
  assert.equal(f.find('parameter:other'), null);
  assert.equal(f.find('username').value, '');
  assert.equal(f.panel.validate(), false);
});

test('pending jobs show original workspace/document and cancellation is pinned to request ID', async () => {
  const f = ready({state: {pending: [{rid: 'request-original', workspace_id: 'team-a', documentName: 'Original.psd', documentID: 17, workflow_path: 'paint.json', status: 'queued'}]}}); f.panel.mount(f.container);
  f.set({workspace_id: 'team-b'});
  assert.match(f.container.textContent, /team-a • Original.psd/);
  const cancel = f.find('cancel:request-original', 'data-action');
  f.click('cancel:request-original'); await flush();
  assert.deepEqual(f.cancelled, ['request-original']);
  f.set({pending: []}); cancel.emit('click'); await flush();
  assert.deepEqual(f.cancelled, ['request-original']);
  f.set({authenticated: false, pending: [{rid: 'stale', workspace_id: 'old-account'}]});
  assert.ok(!f.container.textContent.includes('old-account'));
});

test('host failures provide a manual recovery path without security bypasses or forced HTTPS', () => {
  const f = ready(); f.panel.mount(f.container);
  f.set({error: {code: 'HOST_NETWORK_FAILED', message: 'https://private/?token=secret'}, ready: false, canGenerate: false});
  assert.match(f.container.textContent, /certificate, VPN and Photoshop network access/);
  assert.ok(!f.container.textContent.includes('token=secret'));
  assert.equal(f.find('connect', 'data-action').disabled, false);
  assert.equal(f.find('generate', 'data-action').disabled, true);
});

test('Settings reconnect and optional editor hooks run only on explicit clicks', async () => {
  const calls = [];
  const f = ready({hooks: {onConnect: () => calls.push('settings-connect'), onOpenEditor: () => calls.push('editor')}}); f.panel.mount(f.container);
  assert.deepEqual(calls, []);
  assert.equal(f.find('server').style.display, 'none');
  f.click('connect'); await flush(); f.click('open-editor'); await flush();
  assert.deepEqual(calls, ['settings-connect', 'editor']);
  assert.equal(f.calls.length, 0);
  assert.match(f.container.textContent, /Native execution does not need it/);
});

test('edited server clears password and blocks stale-origin login/execution until reconnect', async () => {
  const f = ready(); f.panel.mount(f.container);
  f.input('password', 'never-retain'); f.input('server', 'https://other.example.test');
  assert.equal(f.find('password')._value, '');
  assert.equal(f.panel.validate(), false);
  assert.equal(f.find('generate', 'data-action').disabled, true);
  f.click('connect'); await flush();
  assert.equal(f.state.origin, 'https://other.example.test');
});

test('unmount and hide clear passwords; teardown is idempotent and late actions cannot update a new mount', async () => {
  const wait = deferred();
  const f = fixture({state: {origin: 'https://comfy.example.test'}, transport: {login() { return wait.promise; }}}); f.panel.mount(f.container);
  f.input('password', 'hidden'); f.panel.show(false); assert.equal(f.find('password')._value, '');
  f.panel.show(); f.input('username', 'alice'); f.input('password', 'hidden'); f.click('signin');
  const old = f.find('signin', 'data-action');
  f.panel.unmount().unmount();
  assert.equal(f.listeners.size, 0); assert.equal(f.container.children.length, 0);
  f.panel.mount(f.container); assert.equal(f.listeners.size, 1);
  old.emit('click');
  wait.reject(new Error('old stale failure')); await flush();
  assert.ok(!f.container.textContent.includes('Sign-in failed'));
  assert.equal(f.find('signin', 'data-action').disabled, false);
  f.panel.unmount(); assert.equal(f.listeners.size, 0);
});


test('main Generate validation flushes the final edit even without a native change event', () => {
  const f = ready({state: parameterState}); f.panel.mount(f.container);
  f.find('parameter:seed').value = '97';
  assert.equal(f.panel.validate(), true);
  assert.equal(f.state.parameters.seed, 97);
});

test('actual preparation statuses and reasons fail closed even with stale canGenerate state', () => {
  for (const status of ['unprepared', 'stale', 'unavailable']) {
    const f = ready({state: {workflows: [{path: 'paint.json', status, reason: 'source_changed'}]}}); f.panel.mount(f.container);
    assert.equal(f.panel.validate(), false);
    assert.equal(f.find('generate', 'data-action').disabled, true);
    assert.match(f.container.textContent, /Saved workflow changed; prepare it again/);
  }
});


test('first unauthenticated native connection enables login when connect returns login_required', async () => {
  const f = fixture(); f.transport.connect = address => { f.set({origin: address, status: 'login_required', error: 'Sign in again.'}); return false; };
  f.panel.mount(f.container); f.input('server', 'http://comfy.example.test:8188'); f.click('connect'); await flush();
  assert.equal(f.find('signin', 'data-action').disabled, false);
  f.input('username', 'alice'); f.input('password', 'secret'); f.click('signin'); await flush();
  assert.equal(f.state.authenticated, true);
});

test('transport-native pending state shows original document ID, pause and insertion counts', () => {
  const f = ready({state: {pending: [
    {request_id: 'original', workspace_id: 'team-old', workflow_path: 'workflows/a.json', document_id: 42, state: 'success', paused: true, result_count: 2, acknowledged: [0]},
    {request_id: 'delivered', state: 'delivered', workspace_id: 'finished-workspace'}
  ]}}); f.panel.mount(f.container);
  assert.match(f.container.textContent, /team-old • Document 42/);
  assert.match(f.container.textContent, /Paused; Reconnect to resume/);
  assert.match(f.container.textContent, /1\/2 results inserted/);
  assert.equal(f.find('cancel:original', 'data-action'), null);
  assert.ok(!f.container.textContent.includes('finished-workspace'));
});

test('actual native transport and panel complete login, workspace, prepared-workflow and typed execution flow', async () => {
  const network = [], deliveries = [], sourceHash = 'a'.repeat(64);
  let authenticated = false;
  const f = fixture();
  const context = {setTimeout() { return 1; }, clearTimeout() {}}; vm.createContext(context);
  const transportSource = fs.readFileSync(path.resolve(__dirname, '../ComfyUI Photoshop Team/dist/ps-native-transport.js'), 'utf8');
  vm.runInContext(transportSource, context);
  const real = context.createPSNativeTransport({save: async () => {}, emit: message => deliveries.push(message), fetch: async (url, options = {}) => {
    network.push({url, method: options.method || 'GET'});
    const route = new URL(url);
    let data;
    if (route.pathname === '/auth/whoami') data = {authenticated, username: authenticated ? 'alice' : null};
    else if (route.pathname === '/logout') { authenticated = false; data = {}; }
    else if (route.pathname === '/login') { assert.equal(f.find('password')._value, ''); authenticated = true; data = {}; }
    else if (route.pathname === '/api/users') data = {users: {'team-a': 'Art', 'team-b': 'Retouch'}};
    else if (route.pathname === '/ps/team/sessions') data = {session_id: 'native-session'};
    else if (route.pathname === '/api/userdata') data = [{path: 'paint.json'}, {path: 'raw.json'}];
    else if (route.pathname === '/api/userdata/workflows%2Fpaint.json') data = {nodes: []};
    else if (route.pathname === '/ps/team/workflow-preparations') {
      const path = route.searchParams.get('path');
      data = {workspace_id: 'team-a', path, status: path.endsWith('/raw.json') ? 'unprepared' : 'prepared', current_source_hash: sourceHash,
        preparation: path.endsWith('/raw.json') ? null : {preparation_id: 'prepared-id', source_hash: sourceHash, parameters: [{id: 'param_seed', node_id: '1', input: 'seed', type: 'integer', min: 0, max: 9999999999, default: 23, label: 'Sampler seed'}]}};
    } else throw new Error('Unexpected mocked route: ' + route.pathname);
    return {ok: true, status: 200, json: async () => clone(data)};
  }});
  Object.assign(f.transport, real);
  f.panel.mount(f.container);
  assert.equal(network.length, 0);
  f.input('server', 'http://comfy.example.test:8188'); f.click('connect'); await flush();
  await real.receive({protocol: 'ps-team-1', transport: 'company', type: 'hello', panel: 'native-panel'});
  f.input('username', 'alice'); f.input('password', 'one-use-password'); f.click('signin'); await flush();
  assert.equal(real.getState().authenticated, true, JSON.stringify({state: real.getState(), network, ui: f.container.textContent, loginDisabled: f.find('signin', 'data-action').disabled}));
  assert.equal(real.getState().ready, true);
  assert.equal(deliveries[0].type, 'ready');
  assert.equal(f.find('workspace').children[0].children.length, 3);
  f.select('workspace', 1); await flush();
  assert.match(f.container.textContent, /Not prepared for Photoshop/);
  f.select('workflow', 1); await flush();
  f.input('parameter:param_seed', '1234567890');
  assert.equal(f.panel.validate(), true);
  f.click('generate'); await flush();
  assert.equal(f.generated.length, 1);
  assert.equal(f.generated[0].workflow_path, 'workflows/paint.json');
  assert.equal(f.generated[0].parameters.param_seed, 1234567890);
  assert.ok(network.every(request => request.url.startsWith('http://comfy.example.test:8188/')));
  assert.ok(network.every(request => !/\/prompt(?:$|\?)/.test(request.url)));
  f.panel.unmount(); real.dispose();
});
