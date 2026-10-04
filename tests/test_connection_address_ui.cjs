// Run the shipped Svelte binding/scheduling runtime, Dg/Lg input, Settings xm/Sm,
// Web jm/Um, Hp controller, connection lifecycle and Vs connector together.
// The real bridge and native transport use an in-memory DOM/Adobe/network host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dist = path.join(__dirname, '../ComfyUI Photoshop Team/dist');
const bundle = fs.readFileSync(path.join(dist, 'assets/index-B_-tWO9a.js'), 'utf8');
const bridgeCode = fs.readFileSync(path.join(dist, 'ps-team-bridge.js'), 'utf8');
const nativeCode = fs.readFileSync(path.join(dist, 'ps-native-transport.js'), 'utf8');
const KEY = 'ps-team.connection.v1';
const BUILD = 'connection-ui-20261004.1';
const LOCAL = 'http://127.0.0.1:8188';
const COMPANY = 'https://company.test';
const tick = () => new Promise(resolve => setImmediate(resolve));
function segment(start, end) {
  const from = bundle.indexOf(start), to = bundle.indexOf(end, from);
  assert(from >= 0 && to > from, `compiled boundaries: ${start}`);
  return bundle.slice(from, to);
}
class Element {
  constructor(tag, data = '') {
    this.tag = tag; this.nodeName = tag.toUpperCase(); this.data = String(data);
    this.children = []; this.attrs = {}; this.parentNode = null; this.listeners = new Map();
    this.style = {setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; }};
    this.classList = {toggle() {}}; this._value = ''; this.valueWrites = 0; this.dispatched = []; this.messages = [];
  }
  get childNodes() { return this.children; }
  get value() { return this._value; }
  set value(value) { this._value = value; this.valueWrites++; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  appendChild(child) { this.insertBefore(child, null); }
  insertBefore(child, anchor) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = anchor ? this.children.indexOf(anchor) : -1;
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    child.parentNode = this;
  }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  dispatchEvent(event) {
    event.target = this; this.dispatched.push(event.type);
    for (const callback of this.listeners.get(event.type) || []) callback.call(this, event);
  }
  postMessage(message, origin) { this.messages.push({message, origin}); }
}
function descendants(root, predicate) {
  return root.children.flatMap(child => [...(predicate(child) ? [child] : []), ...descendants(child, predicate)]);
}
function text(root) { return root.tag === '#text' ? root.data : root.children.map(text).join(''); }
function preference(url) { return JSON.stringify({version: 1, url}); }
function fixture({saved, nativeFailure = false} = {}) {
  const root = new Element('root'), logs = [], events = [], sockets = [], fetches = [], storage = new Map();
  const timers = new Map(), intervals = new Map(); let serial = 0, nativeCreations = 0, bridgeCreations = 0;
  if (saved !== undefined) storage.set(KEY, saved);
  function timer(fn, ms) {
    const id = ++serial;
    if (ms === 100) queueMicrotask(fn); else timers.set(id, {fn, ms});
    return id;
  }
  const ctx = {
    require: name => { assert.equal(name, 'photoshop'); return {}; },
    window: {listeners: new Map(), addEventListener(name, callback) { this.listeners.set(name, callback); }, location: {reload() {}}},
    document: {createElement: tag => {
      const element = new Element(tag);
      if (tag === 'webview') Object.defineProperty(element, 'src', {get() { return this._src; }, set(value) { this._src = value; events.push(['navigate', value]); this.dispatchEvent({type: 'loadstart', url: value}); }});
      return element;
    }, createTextNode: value => new Element('#text', value), addEventListener() {},
    querySelector: selector => descendants(root, node => node.tag === selector)[0] || null,
    getElementById: id => descendants(root, node => node.attrs.id === id)[0] || null},
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    setTimeout: timer, clearTimeout: id => timers.delete(id),
    setInterval(fn, ms) { const id = ++serial; intervals.set(id, {fn, ms}); return id; }, clearInterval: id => intervals.delete(id),
    localStorage: {getItem(key) { events.push(['read', key]); return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); events.push(['save', key, value]); }},
    ne: {info(...values) { logs.push(values.join(' ')); }, warn(...values) { logs.push(values.join(' ')); }, error() {}},
    he: {documents: []}, Ts: {}, Fp: {}, ss: 'test', Da() {}, Dp() {}, xa() {},
    psNativePanel: null, psConnectionAttempt: 0, psPreviewEpoch: 0, psLegacyPreviewReady: false, psPreviewChain: Promise.resolve(),
    fetch: async (url, options = {}) => {
      fetches.push({url, options});
      if (nativeFailure) throw Error('mock native network failure');
      const pathname = new URL(url).pathname;
      const value = pathname === '/auth/whoami' ? {authenticated: true, username: 'fixture-user'} :
        pathname === '/api/users' ? {users: {'fixture-space': 'Fixture workspace'}} :
        pathname === '/ps/team/sessions' ? {session_id: 'fixture-session'} : {session_id: 'fixture-session'};
      return {ok: true, status: 200, json: async () => value};
    }
  };
  class Socket {
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); sockets.push(this); events.push(['socket', url]); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
    close() { this.readyState = 3; events.push(['close', this.url]); }
    emit(name) { this.readyState = name === 'open' ? 1 : 3; return this.listeners.get(name)?.({target: this}); }
  }
  ctx.WebSocket = Socket;
  vm.createContext(ctx);
  const run = source => vm.runInContext(source, ctx);
  run(segment('"use strict";', 'const vo='));
  run(`var rt=Ge('');var ko=Ge({status:'',color:''});var un=Ge({t:value=>value});
    var ${['Nt', 'Dt', 'Tn', 'On', 'Un', 'Xt', 'on', 'is', 'Pi', 'ki', 'Es', '_s', 'bi', 'yi', 'wi', 'Ci', 'Is', 'Ls', '$i', 'Ln'].map(name => name + '=Ge(false)').join(',')};`);
  run(nativeCode + '\n' + bridgeCode);
  const nativeFactory = ctx.createPSNativeTransport;
  ctx.createPSNativeTransport = hooks => { nativeCreations++; return nativeFactory(hooks); };
  let bridge;
  ctx.psTeam = () => {
    if (!bridge) {
      bridgeCreations++;
      bridge = ctx.createPSTeamBridge({url: () => run('psAppliedConnectionURL||""'), optionalEditor: () => run('psConnectionDiagnostic().mode==="company-native"'), status: (...args) => ctx.Nn(...args),
        diagnostic: value => logs.push(value), fetch: ctx.fetch, load: async () => null, save: async () => {}, loadNative: async () => null, saveNative: async () => {}});
    }
    return bridge;
  };
  run(segment('/* PS_CONNECTION_LIFECYCLE:', '/* PS_CONNECTION_LIFECYCLE_END */') + '\n' +
    segment('let It=', ';let Hi=') + ';\n' + segment('function Nn(', 'window.addEventListener("beforeunload"') + '\n' +
    segment('function Hp(', 'const Up=') + '\n' + segment('function Tg(', 'const Mg=') + '\n' +
    segment('function Jr(', 'function Cg(') + '\n' + segment('function $m(', 'function km(') + '\n' +
    segment('function xm(', 'class Nm') + '\n' + segment('function Um(', 'function Wm('));
  // Decorative button/slot markup and unrelated Settings controls are omitted.
  // Click callbacks, both address parent fragments and their binding logic are real.
  run(`class Le extends $e{constructor(options){super();let node;we(this,options,null,()=>({
    c(){node=L('button')},m(parent,anchor){R(parent,node,anchor)},p(){},d(){M(node)}}),be,{});
    this.$$.on_mount.push(()=>ie(node,'click',event=>{for(const fn of this.$$.callbacks.click||[])fn.call(this,event)}));}}
    function Fm(){}function Bm(){}function Vm(){}function Hm(){}
    class Settings extends $e{constructor(options){super();we(this,options,(component,props,invalidate)=>{const values=xm(component,props,invalidate);values[0]=new cn({});return values},Sm,be,{},null,[-1,-1]);}}
    globalThis.mountSettings=target=>new Settings({target});
    globalThis.mountWeb=target=>new qm({target});
    globalThis.mountOther=(target,props)=>new Oe({target,props});
  `);
  const settingsRoot = new Element('settings'), webRoot = new Element('web'); root.appendChild(settingsRoot); root.appendChild(webRoot);
  let settings = ctx.mountSettings(settingsRoot), web = ctx.mountWeb(webRoot);
  function flush() { run('_o()'); }
  function fields() {
    const settingsField = descendants(settingsRoot, node => node.attrs.id === 's_ip')[0];
    const webField = descendants(webRoot, node => node.attrs.id === 'ps_connection_web_address')[0];
    assert(settingsField && webField);
    return {settings: settingsField, web: webField};
  }
  function snapshot() {
    flush(); const values = fields();
    return {settings: values.settings.value, web: values.web.value, draft: run('Qe(rt)'), applied: run('psAppliedConnectionURL'),
      saved: storage.has(KEY) ? JSON.parse(storage.get(KEY)).url : null, src: ctx.document.querySelector('webview')?.src,
      status: run('Qe(ko).status'), editorStatus: text(descendants(webRoot, node => node.attrs.id === 'ps_connection_editor_status')[0]), diagnostic: text(descendants(settingsRoot, node => node.attrs.id === 'ps_connection_diagnostic')[0]), socketURLs: sockets.map(socket => socket.url), fetchURLs: fetches.map(call => call.url)};
  }
  function type(panel, value) { const field = fields()[panel]; field.value = value; field.dispatchEvent({type: 'input'}); flush(); }
  async function click(panel, action) {
    const buttons = descendants(panel === 'settings' ? settingsRoot : webRoot, node => node.tag === 'button');
    const index = panel === 'settings' ? action === 'apply' ? 1 : 0 : action === 'apply' ? 0 : 1;
    buttons[index].dispatchEvent({type: 'click'});
    await run('psConnectionStartupPromise'); await tick(); flush();
  }
  return {ctx, run, root, logs, events, sockets, fetches, timers, intervals, storage, fields, snapshot, type, click, flush,
    async start() { await ctx.psStartConnection(); await tick(); flush(); },
    setDraft(value) { ctx.rt.set(value); flush(); },
    remount() { settings.$destroy(); web.$destroy(); settings = ctx.mountSettings(settingsRoot); web = ctx.mountWeb(webRoot); flush(); },
    diagnosticRow: () => descendants(settingsRoot, node => node.attrs.id === 'ps_connection_diagnostic')[0],
    statusText: () => text(settingsRoot), nativeCreations: () => nativeCreations, bridgeCreations: () => bridgeCreations,
    mountOther(props) { const container = new Element('other'); root.appendChild(container); const component = ctx.mountOther(container, props); return {component, node: descendants(container, n => ['sp-textfield', 'sp-textarea', 'sp-checkbox'].includes(n.tag))[0]}; }
  };
}

for (const saved of [undefined, preference(COMPANY), preference(LOCAL)]) {
  test(`actual mounted address controls display startup restoration: ${saved || 'cold'}`, async () => {
    const f = fixture({saved}); assert.equal(f.snapshot().settings, ''); assert.equal(f.snapshot().web, '');
    await f.start(); const state = f.snapshot(); const expected = saved ? JSON.parse(saved).url : '';
    assert.equal(state.settings, expected); assert.equal(state.web, expected); assert.equal(state.draft, expected);
    assert.equal(state.applied, expected || null);
    assert(f.statusText().includes(BUILD));
    assert.match(state.diagnostic, new RegExp('Applied: ' + (expected || 'none').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const diagnosticRow = f.diagnosticRow();
    assert.equal(diagnosticRow.style.height, 'auto'); assert.equal(diagnosticRow.style['white-space'], 'pre-wrap');
    assert.equal(diagnosticRow.style['overflow-wrap'], 'break-word');
    assert.equal(diagnosticRow.parentNode.children.indexOf(diagnosticRow), 1, 'Diagnostic occupies normal flow below the address row');
    assert(!descendants(diagnosticRow.parentNode, node => node.attrs.class === 'header svelte-7o6noh').length);
    assert(state.diagnostic.includes('\nBuild: ' + BUILD)); assert(!state.status.includes(BUILD));
    assert(f.logs.some(line => line.includes('Applied: none (unselected)') && line.includes(BUILD)));
    if (!saved) { assert.equal(f.bridgeCreations(), 0); assert.equal(f.nativeCreations(), 0); assert.deepEqual(state.socketURLs, []); assert.deepEqual(state.fetchURLs, []); }
  });
}

for (const panel of ['settings', 'web']) {
  for (const localState of ['open', 'closed']) {
    for (const nativeFailure of [false, true]) {
     for (const deferredInput of [false, true]) {
      test(`${deferredInput ? 'host-deferred' : 'typed'} ${panel} company Apply owns the target after local ${localState}, native ${nativeFailure ? 'failure' : 'success'}`, async () => {
        const f = fixture({saved: preference(LOCAL), nativeFailure}); await f.start();
        const local = f.sockets[0]; await local.emit(localState === 'open' ? 'open' : 'close'); f.flush();
        const oldInterval = [...f.intervals.values()].find(timer => timer.ms === 5000)?.fn;
        const oldRetry = [...f.timers.values()].find(timer => timer.ms === 5000)?.fn;
        const staleOpen = f.run('Pa');
        const before = f.snapshot();
        if (deferredInput) f.fields()[panel].value = COMPANY; else f.type(panel, COMPANY);
        const draft = f.snapshot();
        assert.equal(draft[panel], COMPANY);
        assert.equal(draft[panel === 'settings' ? 'web' : 'settings'], deferredInput ? LOCAL : COMPANY);
        assert.equal(draft.draft, deferredInput ? LOCAL : COMPANY);
        assert.equal(draft.applied, LOCAL); assert.equal(draft.saved, LOCAL); assert.equal(draft.src, LOCAL);
        assert.deepEqual(draft.socketURLs, before.socketURLs); assert.deepEqual(draft.fetchURLs, before.fetchURLs);
        await f.click(panel, 'apply');
        const applied = f.snapshot();
        assert.equal(applied.settings, COMPANY); assert.equal(applied.web, COMPANY); assert.equal(applied.draft, COMPANY);
        assert.equal(applied.applied, COMPANY); assert.equal(applied.saved, COMPANY);
        assert.equal(applied.socketURLs.length, 1); assert(local.readyState === 3);
        assert(applied.fetchURLs.includes(COMPANY + '/auth/whoami'));
        assert(applied.fetchURLs.every(url => new URL(url).origin === COMPANY));
        assert.equal(applied.src, panel === 'web' ? COMPANY : LOCAL, 'Web Connect opens its visible target; Settings retains the optional editor page');
        assert.match(applied.diagnostic, /Applied: https:\/\/company\.test \(company-native\)/);
        assert(f.statusText().includes('Applied: https://company.test (company-native)'));
        assert(!applied.status.includes('Applied:')); assert(!applied.status.includes(BUILD));
        if (nativeFailure) assert.match(applied.status, /Native connection failed.*check_session: network_error/);
        else assert.match(applied.status, /^Connected/);
        oldRetry?.(); oldInterval?.(); staleOpen({target: local}); await tick(); f.flush();
        assert.deepEqual(f.snapshot(), applied, 'Stale local callbacks must not relabel or reconnect the applied company target');
      });
     }
    }
  }
}

test('actual Reset updates both already mounted controls, draft, persistence and local socket; next typed Apply uses its visible company value', async () => {
  const f = fixture({saved: preference(COMPANY)}); await f.start();
  await f.click('settings', 'reset'); const reset = f.snapshot();
  assert.equal(reset.settings, LOCAL); assert.equal(reset.web, LOCAL); assert.equal(reset.draft, LOCAL); assert.equal(reset.applied, LOCAL); assert.equal(reset.saved, LOCAL);
  assert.match(reset.diagnostic, /Applied: http:\/\/127\.0\.0\.1:8188 \(local\)/);
  assert.equal(reset.src, LOCAL); assert.equal(reset.socketURLs.length, 1); assert(reset.socketURLs[0].startsWith('ws://127.0.0.1:8188/ps/ws?'));
  f.type('web', 'HTTPS://Other.Test:443/team'); await f.click('web', 'apply');
  const applied = f.snapshot();
  for (const key of ['settings', 'web', 'draft', 'applied', 'saved']) assert.equal(applied[key], 'https://other.test/team');
  assert(applied.fetchURLs.includes('https://other.test/auth/whoami'));
});

test('typing stays a draft across both views, unrelated status updates and remount; equal-value renders do not reset the field or emit input', async () => {
  const f = fixture({saved: preference(COMPANY)}); await f.start();
  const diagnosticRow = f.diagnosticRow();
  f.type('settings', 'http://127.0.0.1:8199'); const before = f.snapshot();
  assert.match(before.diagnostic, /Applied: https:\/\/company\.test \(company-native\)/);
  const fields = f.fields(), writes = [fields.settings.valueWrites, fields.web.valueWrites];
  f.ctx.Nn('Status refreshed', 'orange'); f.flush(); f.setDraft(before.draft); f.flush();
  assert.equal(f.diagnosticRow(), diagnosticRow, 'Status refresh retains the same diagnostic row');
  assert.equal(f.snapshot().diagnostic, before.diagnostic);
  assert.equal(fields.settings.valueWrites, writes[0]); assert.equal(fields.web.valueWrites, writes[1]);
  assert.deepEqual(fields.settings.dispatched, ['input']); assert.deepEqual(fields.web.dispatched, []);
  assert.equal(f.snapshot().applied, COMPANY); assert.equal(f.snapshot().saved, COMPANY);
  f.remount(); const remounted = f.snapshot();
  assert.equal(remounted.settings, before.draft); assert.equal(remounted.web, before.draft); assert.equal(remounted.draft, before.draft);
  assert.equal(remounted.applied, COMPANY); assert.equal(remounted.saved, COMPANY);
  assert.deepEqual(remounted.fetchURLs, before.fetchURLs); assert.deepEqual(remounted.socketURLs, before.socketURLs);
});

test('address-only render synchronization leaves unrelated textfields and numeric typing behavior unchanged', () => {
  const f = fixture();
  const other = f.mountOther({type: 'textfield', id: 's_seed', value: '42', numeric: true});
  let inputs = 0; other.component.$on('input', () => inputs++);
  assert.equal(other.node.value, '42');
  other.component.$set({value: '57'}); f.flush();
  assert.equal(other.node.value, '42', 'Do not change legacy non-address programmatic updates in this focused fix');
  other.node.value = '19abc'; other.node.dispatchEvent({type: 'input'}); f.flush();
  assert.equal(other.node.value, '19'); assert.equal(inputs, 1);
  assert.deepEqual(other.node.dispatched, ['input']);
});

test('diagnostic reads are inert, expose only applied origin/mode/build, and never an unapplied draft or credential-bearing URL', async () => {
  const f = fixture(); await f.start();
  for (let count = 0; count < 5; count++) { f.run('psConnectionDiagnostic()'); f.run('psConnectionDiagnosticLabel()'); f.run('psLogConnectionDiagnostic()'); }
  assert.equal(f.bridgeCreations(), 0); assert.equal(f.nativeCreations(), 0); assert.equal(f.fetches.length, 0);
  assert.equal(f.logs.filter(line => line.startsWith('PS Team connection |')).length, 1);
  const cases = [
    [null, 'none', 'unselected'],
    ['https://company.test/private/path?plain=private-query', COMPANY, 'company-native'],
    ['https://company.test/?ps_%74ransport=standalone&plain=private-query', COMPANY, 'standalone-web'],
    ['http://127.0.0.1:8188/private', LOCAL, 'local'],
    ['http://[::1]:8188/private', 'http://[::1]:8188', 'local'],
    ['https://company.test:443/private', COMPANY, 'company-native'],
    ['https://user:password@company.test/?cookie=private', 'invalid', 'invalid']
  ];
  for (const [url, origin, mode] of cases) {
    f.run(`psAppliedConnectionURL=${JSON.stringify(url)}`);
    const diagnostic = JSON.parse(f.run('JSON.stringify(psConnectionDiagnostic())'));
    assert.deepEqual(diagnostic, {build: BUILD, origin, mode});
    f.ctx.Nn('Read-only status', 'orange'); f.flush(); f.run('psLogConnectionDiagnostic()');
    const output = f.statusText() + f.logs.filter(line => line.startsWith('PS Team connection |')).join('\n');
    assert(!/private|password|cookie|ps_transport|user:/.test(output));
  }
  assert.equal(f.bridgeCreations(), 0); assert.equal(f.nativeCreations(), 0); assert.equal(f.fetches.length, 0);
});

for (const code of [-105, -1022]) {
  test(`explicit company Web Connect navigates once and reports editor error ${code} independently from native data`, async () => {
    const f = fixture({saved: preference(LOCAL)}); await f.start();
    const target = COMPANY + '/editor?plain=private-query';
    f.type('web', target); const before = f.events.filter(event => event[0] === 'navigate').length;
    await f.click('web', 'apply');
    const connected = f.snapshot(), view = f.ctx.document.querySelector('webview');
    assert.equal(connected.src, target); assert.equal(connected.applied, target); assert.equal(connected.saved, target);
    assert.equal(f.events.filter(event => event[0] === 'navigate').length, before + 1);
    assert.equal(connected.status, 'Connected'); assert.equal(connected.editorStatus, 'Editor loading: ' + COMPANY);
    view.dispatchEvent({type: 'loaderror', url: target, code, message: 'password=private-cookie https://old.test/?token=private'}); f.flush();
    const failed = f.snapshot();
    assert.equal(failed.status, connected.status); assert.equal(failed.diagnostic, connected.diagnostic);
    assert.match(failed.editorStatus, code === -1022 ? /Editor blocked.*macOS ATS requires valid HTTPS/ : /Editor failed to load \(-105\)/);
    assert(!/private|password|cookie|token|\?/.test(failed.editorStatus));
    for (const url of [undefined, LOCAL, COMPANY + '/old-page', target]) {
      view.dispatchEvent({type: 'loadstop', ...(url === undefined ? {} : {url})}); f.flush();
      assert.equal(f.snapshot().editorStatus, failed.editorStatus, 'Missing, old or post-failure loadstop cannot claim success');
    }
    assert.equal(f.snapshot().src, target, 'ATS and network failures never change the selected URL');
    await f.click('web', 'apply');
    view.dispatchEvent({type: 'loadstop', url: target}); f.flush();
    assert.equal(f.snapshot().editorStatus, 'Editor loaded: ' + COMPANY);
    assert.equal(f.events.filter(event => event[0] === 'navigate').length, before + 2, 'Each explicit retry makes one navigation request');
  });
}

test('editor requests reject old-page and URL-less events even before a load failure', async () => {
  const f = fixture({saved: preference(COMPANY)}); await f.start();
  assert.equal(f.snapshot().src, undefined, 'Company-native startup does not open the editor');
  f.type('settings', 'https://second.test'); await f.click('settings', 'apply');
  assert.equal(f.snapshot().src, undefined, 'Company-native Settings Apply does not open the editor');
  f.type('web', COMPANY + '/new-page'); await f.click('web', 'apply');
  const view = f.ctx.document.querySelector('webview'), requested = f.snapshot();
  for (const event of [
    {type: 'loadstop'}, {type: 'loadstop', url: LOCAL}, {type: 'loadstop', url: COMPANY + '/old-page'},
    {type: 'loaderror', url: COMPANY + '/old-page', code: -105}, {type: 'loadstart', url: LOCAL}
  ]) {
    view.dispatchEvent(event); f.flush(); assert.deepEqual(f.snapshot(), requested);
  }
  view.dispatchEvent({type: 'loadstop', url: COMPANY + '/new-page'}); f.flush();
  assert.equal(f.snapshot().editorStatus, 'Editor loaded: ' + COMPANY);
  view.dispatchEvent({type: 'loaderror', message: 'private raw error'}); f.flush();
  assert.match(f.snapshot().editorStatus, /Editor reported a load failure; target unconfirmed/);
  assert.equal(f.snapshot().status, requested.status);
  assert(!f.snapshot().editorStatus.includes('private'));
});

test('immediate standalone-to-native optional editor events cannot overwrite data status before bridge.connect starts', async () => {
  const standalone = COMPANY + '/?ps_transport=standalone';
  const f = fixture({saved: preference(standalone)}); await f.start();
  const view = f.ctx.document.querySelector('webview'), before = f.snapshot();
  assert.equal(before.src, standalone); assert.equal(f.fetches.length, 0);
  f.type('web', 'https://next-company.test');
  const hello = view.messages.find(item => item.message.type === 'hello').message;
  const connecting = f.click('web', 'apply');
  f.ctx.window.listeners.get('message')({source: view, origin: COMPANY, data: {...hello, type: 'error', error: 'old standalone error'}});
  assert.equal(f.snapshot().status, before.status, 'Synchronous loadstart must not replace the old data status before the new native attempt begins');
  view.dispatchEvent({type: 'loaderror', url: 'https://next-company.test', code: -105}); f.flush();
  assert.equal(f.snapshot().status, before.status, 'Early optional editor failure does not own the data channel');
  await connecting;
  const after = f.snapshot(); assert.equal(after.status, 'Connected');
  assert.match(after.editorStatus, /Editor failed to load \(-105\)/);
  assert(after.fetchURLs.includes('https://next-company.test/auth/whoami'));
  assert.equal(after.src, 'https://next-company.test');
});

test('explicit standalone Web Connect preserves its required data view and requests exactly one navigation', async () => {
  const f = fixture(); await f.start();
  const target = COMPANY + '/?ps_transport=standalone'; f.type('web', target); await f.click('web', 'apply');
  const state = f.snapshot();
  assert.equal(state.src, target); assert.equal(state.applied, target); assert.equal(state.saved, target);
  assert.equal(f.events.filter(event => event[0] === 'navigate').length, 1);
  assert.equal(state.fetchURLs.length, 0); assert.equal(state.socketURLs.length, 0);
  assert.match(state.diagnostic, /standalone-web/);
  const view = f.ctx.document.querySelector('webview');
  view.dispatchEvent({type: 'loaderror', url: target, code: -105}); f.flush();
  assert.match(f.snapshot().status, /Web panel failed to load \(-105\)/, 'A required standalone view still controls its data-channel failure status');
  assert.match(f.snapshot().editorStatus, /Editor failed to load \(-105\)/);
});

for (const rejection of ['invalid', 'missing field', 'busy']) {
  test(`Web Connect fails closed for ${rejection} without changing data selection or editor target`, async () => {
    const f = fixture({saved: preference(LOCAL)}); await f.start();
    const before = f.snapshot(), field = f.fields().web;
    f.type('web', rejection === 'invalid' ? 'https://user:password@company.test' : COMPANY);
    if (rejection === 'missing field') field.attrs.id = 'temporarily-absent';
    if (rejection === 'busy') f.ctx.psTeam().canSwitch = () => false;
    const navigationCount = f.events.filter(event => event[0] === 'navigate').length;
    await f.click('web', 'apply');
    if (rejection === 'missing field') field.attrs.id = 'ps_connection_web_address';
    const after = f.snapshot();
    for (const key of ['applied', 'saved', 'src', 'editorStatus']) assert.equal(after[key], before[key]);
    assert.deepEqual(after.fetchURLs, before.fetchURLs); assert.deepEqual(after.socketURLs, before.socketURLs);
    assert.equal(f.events.filter(event => event[0] === 'navigate').length, navigationCount);
    assert.match(after.status, rejection === 'busy' ? /Finish export or insertion/ : /Invalid server address/);
  });
}
