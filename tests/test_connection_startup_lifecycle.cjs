// Exercise the shipped bundle's store initializer, controller, settings, WebView
// creation, native button wiring, bootstrap, connector and reconnect callbacks.
// All storage, clocks, Adobe host operations and network transports are simulated.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dist = path.join(__dirname, '../ComfyUI Photoshop Team/dist');
const bundle = fs.readFileSync(path.join(dist, 'assets/index-B_-tWO9a.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(dist, 'ps-team-bridge.js'), 'utf8');
const KEY = 'ps-team.connection.v1';
const tick = () => new Promise(resolve => setImmediate(resolve));
function segment(start, end) {
  const from = bundle.indexOf(start), to = bundle.indexOf(end, from);
  assert(from >= 0 && to > from, `compiled boundaries: ${start}`);
  return bundle.slice(from, to);
}
const lifecycle = segment('/* PS_CONNECTION_LIFECYCLE:', '/* PS_CONNECTION_LIFECYCLE_END */');
const connector = segment('let It=', ';let Hi=');
const controller = segment('function Hp(', 'class cn');
const settings = segment('function xm(', 'class Nm');
const webPanel = segment('function Um(', 'function jm(');
const nativeBootstrap = bundle.slice(bundle.indexOf('if(globalThis.createPSNativePanel&&globalThis.createPSNativeTransport)'));
const statusWriter = segment('function Nn(', 'window.addEventListener("beforeunload"');

function fixture({saved, storage, failRead = false, failWrite = false, rejectNetwork = false} = {}) {
  const events = [], sockets = [], timers = new Map(), intervals = new Map();
  const data = storage || new Map(saved === undefined ? [] : [[KEY, saved]]);
  let serial = 0, connectedURL = null, appliedTeam = null, canSwitch = true, localGate = null;
  const store = value => {
    const subscribers = new Set();
    return {value, subscribers,
      set(next) { this.value = next; for (const callback of subscribers) callback(next); },
      subscribe(callback) { subscribers.add(callback); callback(this.value); return () => subscribers.delete(callback); }
    };
  };
  const normalizerContext = {setInterval() {}, window: {addEventListener() {}}, createPSNativeTransport() {}};
  vm.createContext(normalizerContext); vm.runInContext(bridgeSource, normalizerContext);
  const normalizer = normalizerContext.createPSTeamBridge({url: () => '', status() {}});
  const listeners = {};
  const view = {addEventListener(name, fn) { listeners[name] = fn; },
    set src(value) { this.currentURL = value; events.push(['navigate', value]); listeners.loadstart?.({url: value}); },
    get src() { return this.currentURL; }};
  const bridge = {
    canSwitch: () => canSwitch,
    normalizeURL: value => normalizer.normalizeURL(value),
    nativeEnabled(value) { return normalizer.nativeEnabled(value === undefined ? connectedURL || '' : value); },
    enabled(value) { return arguments.length ? normalizer.enabled(value) : appliedTeam === true; },
    watchView() { events.push(['watch']); },
    getNativeTransport: () => ({}),
    async disconnectLocal(url) { events.push(['disconnectLocal', url]); if (localGate) await localGate; connectedURL = url; appliedTeam = false; },
    async connect(url) { connectedURL = url; appliedTeam = true; events.push(['connect', url]); if (rejectNetwork) throw Error('mock network failure'); return true; }
  };
  class Socket {
    static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); sockets.push(this); events.push(['socket', url]); Object.preventExtensions(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    close() { this.readyState = 3; events.push(['close', this.url]); }
  }
  const legacy = {style: {display: 'flex'}};
  const host = {style: {}, appendChild() {}, querySelector: () => legacy};
  class Component { constructor() { this.$$ = {fragment: {}}; } $on() {} }
  const ctx = {
    Ge: store, Qe: value => value.value, Y: (_component, value, callback) => value.subscribe(callback), Ve: (value, _ignored, next) => value.set(next),
    Q: [], Ts: {}, Fp: {}, he: {documents: []}, ss: 'test', Da() { events.push(['background']); },
    psTeam: () => bridge, psConnectionAttempt: 0, psPreviewEpoch: 0, psLegacyPreviewReady: false, psPreviewChain: Promise.resolve(),
    psNativePanel: null, WebSocket: Socket, Dp() {}, ne: {info() {}, warn() {}, error() { events.push(['error']); }},
    localStorage: {getItem(key) { events.push(['read', key]); if (failRead) throw Error('storage read failure'); return data.get(key) ?? null; },
      setItem(key, value) { events.push(['save', key]); if (failWrite) throw Error('storage write failure'); data.set(key, value); }},
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, {fn, ms}); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++serial; intervals.set(id, {fn, ms}); return id; }, clearInterval(id) { intervals.delete(id); },
    window: {location: {reload() { events.push(['reload']); }}},
    document: {querySelector: selector => selector === 'webview' ? view : host, createElement: () => ({style: {}})},
    createPSNativeTransport() {}, createPSNativePanel(options) { ctx.nativeOptions = options; return {mount() {}, show(value) { events.push(['nativePanel', value]); }}; },
    cn: Component, Oe: Component, Le: Component, Fe: Component,
    Fm() {}, Bm() {}, Vm() {}, Hm() {}, xa() {}, V() {}, N: () => ({}), K: value => value, te() {}, oe() {},
    L: tag => ({tag}), O(node, name, value) { if (node.tag === 'webview' && name === 'src') events.push(['createdSrc', value]); }
  };
  for (const name of ['Nt', 'Dt', 'Tn', 'On', 'Un', 'Xt', 'on', 'is', 'Pi', 'ki', 'Es', '_s', 'un', 'ko', 'bi', 'yi', 'wi', 'Ci', 'Is', 'Ls', '$i', 'Ln']) ctx[name] = store(false);
  ctx.ko.subscribe(value => { if (value) events.push(['status', value.status, value.color]); });
  vm.createContext(ctx);
  const initializer = /rt=Ge\("[^"\n]*"\)/.exec(bundle)?.[0]; assert(initializer);
  vm.runInContext('var ' + initializer + ';\n' + lifecycle + '\n' + connector + ';\n' + statusWriter + '\n' + controller + '\n' + settings + '\n' + webPanel, ctx);
  const evaluate = expression => vm.runInContext(expression, ctx);
  function makeController() { return ctx.Hp({}, {}, (_index, value) => value); }
  function runTimer(ms) { const entry = [...timers].find(([, timer]) => timer.ms === ms); if (!entry) return false; timers.delete(entry[0]); entry[1].fn(); return true; }
  return {ctx, events, sockets, timers, intervals, data, view, makeController, runTimer, evaluate,
    bootstrap() { vm.runInContext(nativeBootstrap, ctx); return evaluate('psConnectionStartupPromise'); },
    mountSettings() { return ctx.xm({}, {}, (_index, value) => value); },
    createWebPanel() { ctx.Um([false, null, ctx.rt.value, {t: value => value}, () => {}, () => {}, () => {}, () => {}]).c(); },
    setCanSwitch(value) { canSwitch = value; }, setWriteFailure(value) { failWrite = value; },
    holdLocal() { let release; localGate = new Promise(resolve => { release = resolve; }); return () => { localGate = null; release(); }; }
  };
}
const preference = url => JSON.stringify({version: 1, url});
const networkEvents = f => f.events.filter(event => ['connect', 'socket', 'navigate', 'createdSrc'].includes(event[0]));

test('cold bootstrap, repeated controller start and Settings/Web panel creation make no connection or implicit WebView load', async () => {
  const f = fixture(); assert.equal(f.ctx.rt.value, '');
  f.createWebPanel(); await f.bootstrap();
  const first = f.makeController(), second = f.makeController();
  await first[5](); await first[5](); await second[5](); f.mountSettings(); f.createWebPanel();
  assert.deepEqual(networkEvents(f), []);
  assert.equal(f.events.filter(event => event[0] === 'read').length, 1);
  assert.equal([...f.intervals.values()].filter(value => value.ms === 5000).length, 0);
  assert.equal(f.ctx.psNativeGenerate, second[3], 'remounted controller refreshes the original Generate callback');
  assert.equal(f.timers.size, 0);
});

for (const [name, url, native, socket] of [
  ['company', 'https://company.test/team', true, false],
  ['explicit local', 'http://127.0.0.1:8188', false, true],
  ['explicit standalone', 'https://company.test/?ps_transport=standalone', false, false]
]) {
  test(`warm ${name} bootstrap restores the selected address once`, async () => {
    const f = fixture({saved: preference(url)}); f.createWebPanel(); await f.bootstrap();
    await f.makeController()[5](); await f.makeController()[5](); f.mountSettings();
    assert.equal(f.ctx.rt.value, url); assert.equal(f.evaluate('psAppliedConnectionURL'), url);
    assert.equal(f.sockets.length, socket ? 1 : 0);
    assert.deepEqual(f.events.filter(event => event[0] === 'navigate').map(event => event[1]), native ? [] : [url]);
    assert.deepEqual(f.events.filter(event => event[0] === 'connect').map(event => event[1]), socket ? [] : [url]);
    assert.equal(f.events.filter(event => event[0] === 'read').length, 1);
    assert.equal(f.events.filter(event => event[0] === 'save').length, 0);
  });
}

for (const saved of ['', '{broken', 'null', '[]', JSON.stringify('https://company.test'), '{}', preference(''), preference('http://user:password@company.test'), preference('javascript:alert(1)'), preference('http://company.test:99999'), JSON.stringify({version: 2, url: 'https://company.test'}), JSON.stringify({version: 1, url: 'https://company.test', password: 'private'})]) {
  test(`invalid persisted preference ${JSON.stringify(saved)} does not guess a server`, async () => {
    const f = fixture({saved}); await f.bootstrap(); await f.makeController()[5]();
    assert.deepEqual(networkEvents(f), []); assert.equal(f.ctx.rt.value, '');
    assert.equal(f.evaluate('psAppliedConnectionURL'), null);
    assert(f.events.some(event => event[0] === 'status' && event[1].includes('Saved address is invalid')));
  });
}

test('unavailable storage has a visible status, no implicit connection and permits later explicit Apply', async () => {
  const f = fixture({failRead: true}); await f.bootstrap(); assert.deepEqual(networkEvents(f), []);
  assert(f.events.some(event => event[0] === 'status' && event[1].includes('Saved address is unavailable')));
  f.ctx.rt.set('HTTPS://Company.Test:443'); await f.makeController()[7]();
  assert.equal(f.evaluate('psAppliedConnectionURL'), 'https://company.test'); assert.equal(f.sockets.length, 0);
  assert.equal(f.data.get(KEY), preference('https://company.test'));
});

test('Apply snapshots and persists the normalized address before a failing connection; reload retries the same company endpoint', async () => {
  const f = fixture({rejectNetwork: true}); await f.bootstrap();
  f.ctx.rt.set('HTTPS://Company.Test:443/team'); const applied = f.makeController()[7]();
  f.ctx.rt.set('http://127.0.0.1:8190'); await applied;
  assert.equal(f.data.get(KEY), preference('https://company.test/team'));
  assert(f.events.findIndex(event => event[0] === 'save') < f.events.findIndex(event => event[0] === 'connect'));
  assert.equal(f.sockets.length, 0); assert.equal(f.timers.size, 0);
  const reloaded = fixture({storage: f.data}); await reloaded.bootstrap();
  assert.equal(reloaded.ctx.rt.value, 'https://company.test/team');
  assert.deepEqual(networkEvents(reloaded), [['connect', 'https://company.test/team']]);
});

test('draft edits, opening Settings and reopening controllers do not apply or persist until Apply', async () => {
  const f = fixture({saved: preference('https://company.test')}); await f.bootstrap();
  const count = networkEvents(f).length, settings = f.mountSettings(); settings[25]('http://127.0.0.1:8190');
  await f.makeController()[5](); f.mountSettings();
  assert.equal(f.ctx.rt.value, 'http://127.0.0.1:8190'); assert.equal(networkEvents(f).length, count);
  assert.equal(f.data.get(KEY), preference('https://company.test'));
  const reloaded = fixture({storage: f.data}); await reloaded.bootstrap(); assert.equal(reloaded.ctx.rt.value, 'https://company.test');
});

test('native Connect uses the same persistent Apply path; optional editor uses the applied address, never an unapplied draft', async () => {
  const f = fixture(); await f.bootstrap(); f.ctx.rt.set('HTTPS://Company.Test:443'); await f.ctx.nativeOptions.onConnect();
  assert.equal(f.data.get(KEY), preference('https://company.test')); assert.equal(f.sockets.length, 0);
  assert(!f.events.some(event => event[0] === 'navigate'));
  f.ctx.rt.set('https://unapplied.test'); f.ctx.nativeOptions.onOpenEditor();
  assert.deepEqual(f.events.filter(event => event[0] === 'navigate'), [['navigate', 'https://company.test']]);
});

test('Reset explicitly applies and saves one local address without an intermediate 0.0.0.0 navigation or delayed draft read', async () => {
  const f = fixture({saved: preference('https://company.test')}); await f.bootstrap();
  const reset = f.makeController()[8](); f.ctx.rt.set('https://unapplied.test'); await reset;
  assert.equal(f.data.get(KEY), preference('http://127.0.0.1:8188'));
  assert.deepEqual(f.events.filter(event => event[0] === 'navigate'), [['navigate', 'http://127.0.0.1:8188']]);
  assert(f.sockets[0].url.startsWith('ws://127.0.0.1:8188/ps/ws?')); assert.equal(f.timers.size, 0);
});

test('write failure remains visible through subsequent statuses while preserving runtime choice and all recovery journal keys', async () => {
  const data = new Map([['ps-team-journal-0.json', 'request recovery'], ['ps-native-state', 'native recovery'], [KEY, preference('https://previous.test')]]);
  const f = fixture({storage: data, failWrite: true}); await f.bootstrap();
  f.ctx.rt.set('https://company.test'); await f.makeController()[7](); f.ctx.Nn('Connected', 'green');
  assert.equal(f.evaluate('psAppliedConnectionURL'), 'https://company.test');
  assert.equal(f.ctx.rt.value, 'https://company.test');
  assert.match(f.ctx.ko.value.status, /Connected.*could not be saved.*current connection is kept/);
  assert.equal(data.get('ps-team-journal-0.json'), 'request recovery'); assert.equal(data.get('ps-native-state'), 'native recovery');
  assert.equal(data.get(KEY), preference('https://previous.test'));
  f.setWriteFailure(false); await f.makeController()[7](); f.ctx.Nn('Connected', 'green');
  assert.equal(data.get(KEY), preference('https://company.test')); assert.equal(f.ctx.ko.value.status, 'Connected');
});

for (const url of ['http://user:password@company.test', 'https://company.test?password=private', 'https://company.test?%63ookie=private', 'https://company.test?access_token=private', 'https://company.test#private']) {
  test(`unsafe credential-bearing address never reaches persistence, transport or editor: ${url.split(/[?#@]/)[0]}`, async () => {
    const f = fixture(); await f.bootstrap(); f.ctx.rt.set(url); assert.equal(await f.makeController()[7](), false);
    assert.deepEqual(networkEvents(f), []); assert.equal(f.data.size, 0);
  });
}

test('busy connection blocks Apply and Reset before persistent or runtime selection changes', async () => {
  const f = fixture({saved: preference('https://company.test')}); await f.bootstrap(); f.setCanSwitch(false);
  const count = networkEvents(f).length; f.ctx.rt.set('https://other.test');
  assert.equal(await f.makeController()[7](), false); assert.equal(await f.makeController()[8](), false);
  assert.equal(f.evaluate('psAppliedConnectionURL'), 'https://company.test'); assert.equal(f.data.get(KEY), preference('https://company.test'));
  assert.equal(networkEvents(f).length, count);
});

test('new Apply supersedes pending startup and an older Apply while teardown is waiting', async () => {
  const f = fixture({saved: preference('http://127.0.0.1:8188')});
  const release = f.holdLocal(); const startup = f.bootstrap();
  f.ctx.rt.set('https://company.test'); await f.makeController()[7](); release(); await startup;
  assert.equal(f.sockets.length, 0); assert.equal(f.evaluate('psAppliedConnectionURL'), 'https://company.test');
  assert.equal(f.data.get(KEY), preference('https://company.test'));
  assert.deepEqual(f.events.filter(event => event[0] === 'connect'), [['connect', 'https://company.test']]);
});

test('Apply before first controller startup is never overwritten by the previously saved address', async () => {
  const f = fixture({saved: preference('http://127.0.0.1:8188')}); f.ctx.rt.set('https://company.test'); await f.makeController()[7]();
  await f.bootstrap(); await f.makeController()[5]();
  assert.equal(f.events.filter(event => event[0] === 'read').length, 0);
  assert.deepEqual(networkEvents(f), [['connect', 'https://company.test']]);
});

test('stale close timer and interval cannot overwrite a newer persisted company Apply or a later draft', async () => {
  const f = fixture({saved: preference('http://127.0.0.1:8188')}); await f.bootstrap();
  const oldInterval = [...f.intervals.values()].find(timer => timer.ms === 5000).fn;
  const old = f.sockets[0]; old.readyState = 3; const closing = f.evaluate('Oa')({target: old});
  assert(f.runTimer(100)); await closing;
  const oldTimer = [...f.timers.values()].find(timer => timer.ms === 5000).fn;
  f.ctx.rt.set('https://company.test'); await f.makeController()[7](); f.ctx.rt.set('http://127.0.0.1:8199');
  const count = networkEvents(f).length; oldTimer(); oldInterval(); await tick();
  assert.equal(networkEvents(f).length, count); assert.equal(f.sockets.length, 1);
  assert.equal(f.data.get(KEY), preference('https://company.test')); assert.equal(f.evaluate('psAppliedConnectionURL'), 'https://company.test');
});

test('a newer explicit Apply persists its own snapshot and supersedes an older Apply waiting for local teardown', async () => {
  const f = fixture(); await f.bootstrap(); const release = f.holdLocal();
  f.ctx.rt.set('http://127.0.0.1:8188'); const older = f.makeController()[7]();
  f.ctx.rt.set('https://company.test'); const newer = f.makeController()[7]();
  f.ctx.rt.set('https://unapplied.test'); await newer; release(); assert.equal(await older, false);
  assert.equal(f.sockets.length, 0); assert.equal(f.evaluate('psAppliedConnectionURL'), 'https://company.test');
  assert.equal(f.data.get(KEY), preference('https://company.test'));
  assert.deepEqual(f.events.filter(event => event[0] === 'connect'), [['connect', 'https://company.test']]);
  await f.makeController()[5](); assert.equal(f.ctx.rt.value, 'https://unapplied.test');
});

test('upgrade with recovery journals but no explicit connection preference never guesses a journal origin', async () => {
  const data = new Map([['ps-team-journal-0.json', JSON.stringify({connections: {'https://company.test': {session: 'saved'}}})], ['ps-native-state', 'native recovery']]);
  const before = [...data]; const f = fixture({storage: data}); await f.bootstrap(); await f.makeController()[5]();
  assert.deepEqual(networkEvents(f), []); assert.equal(f.ctx.rt.value, ''); assert.deepEqual([...data], before);
});

test('an absent localStorage API is reported without interrupting explicit session-only connection', async () => {
  const f = fixture(); delete f.ctx.localStorage; await f.bootstrap(); assert.deepEqual(networkEvents(f), []);
  f.ctx.rt.set('https://company.test'); await f.makeController()[7]();
  assert.equal(f.evaluate('psAppliedConnectionURL'), 'https://company.test'); assert.equal(f.sockets.length, 0);
  f.ctx.Nn('Connected', 'green'); assert.match(f.ctx.ko.value.status, /Connected.*could not be saved/);
});
