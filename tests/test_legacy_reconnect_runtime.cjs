// Run the shipped connector/reconnect functions with fake sockets and timers.
// No Adobe host or network requests are used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dist = path.join(__dirname, '../ComfyUI Photoshop Team/dist');
const bundle = fs.readFileSync(path.join(dist, 'assets/index-B_-tWO9a.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(dist, 'ps-team-bridge.js'), 'utf8');
const start = bundle.indexOf('Vs=async('), end = bundle.indexOf(';let Hi=', start);
assert(start >= 0 && end > start, 'compiled connector boundaries must remain identifiable');
const connector = bundle.slice(start, end);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const events = [], sockets = [], timeouts = new Map(), intervals = new Map();
  let serial = 0, appliedURL = null, appliedTeam = false, switchingAllowed = true, localGate = null;
  const normalizerContext = {console, createPSNativeTransport() {}, setInterval() { return 1; }, window: {addEventListener() {}}};
  vm.createContext(normalizerContext);
  vm.runInContext(bridgeSource, normalizerContext);
  const normalizer = normalizerContext.createPSTeamBridge({url: () => 'http://127.0.0.1:8188', status() {}});
  const bridge = {
    canSwitch: () => switchingAllowed,
    nativeEnabled: value => normalizer.nativeEnabled(value),
    normalizeURL: value => normalizer.normalizeURL(value),
    enabled(value) { return arguments.length ? normalizer.enabled(value) : appliedTeam; },
    async disconnectLocal(url) { if (localGate) await localGate; appliedTeam = false; appliedURL = url; events.push(['disconnectLocal', url]); return true; },
    async connect(url) { appliedTeam = true; appliedURL = url; events.push(['connect', url]); return true; }
  };
  class Socket {
    static CLOSED = 3;
    constructor(url) {
      new URL(url); // Reject malformed socket URLs such as duplicated ports.
      this.url = url; this.readyState = 0; this.listeners = new Map();
      sockets.push(this); events.push(['socket', url]);
      Object.preventExtensions(this); // Native UXP host sockets may reject custom properties.
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    close() { this.readyState = Socket.CLOSED; events.push(['close', this.url]); }
  }
  const ctx = {
    rt: {value: 'http://127.0.0.1:8188', set(value) { this.value = value; }}, Qe: store => store.value,
    psTeam: () => bridge,
    Nn(...args) { events.push(['status', ...args]); },
    ne: {info(...args) { events.push(['info', ...args]); }, error(...args) { events.push(['error', ...args]); }},
    WebSocket: Socket,
    psNativePanel: {show(value) { events.push(['panel', value]); }}, psConnectionAttempt: 0, psPreviewEpoch: 0, psLegacyPreviewReady: true, psPreviewChain: Promise.resolve(),
    hi: null, psLegacyRetryTimer: null, psLegacySocketState: new WeakMap(), It: '', xn: false, Pe: null, ws: false, Op: 'mock-client', Dp(value) { events.push(['message', value]); },
    setTimeout(fn, ms) { const id = ++serial; timeouts.set(id, {fn, ms}); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++serial; intervals.set(id, {fn, ms}); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  vm.createContext(ctx);
  vm.runInContext('var ' + connector + ';', ctx);
  function runTimeout(ms) {
    const entry = [...timeouts].find(([, timer]) => timer.ms === ms);
    if (!entry) return false;
    timeouts.delete(entry[0]); entry[1].fn(); return true;
  }
  async function disconnect() {
    const socket = ctx.Pe;
    socket.readyState = Socket.CLOSED;
    const closed = ctx.Oa({target: socket});
    assert(runTimeout(100), 'socket teardown is pending');
    await closed;
  }
  return {ctx, events, sockets, timeouts, intervals, runTimeout, disconnect, appliedURL: () => appliedURL,
    setCanSwitch(value) { switchingAllowed = value; },
    holdLocal() { let release; localGate = new Promise(resolve => { release = resolve; }); return () => { localGate = null; release(); }; }
  };
}

test('real normalization and compiled connector use one loopback port', async () => {
  for (const [input, expected] of [
    ['127.0.0.1', 'ws://127.0.0.1:8188'],
    ['http://127.0.0.1:8188', 'ws://127.0.0.1:8188'],
    ['ws://127.0.0.1:8188/', 'ws://127.0.0.1:8188'],
    ['127.0.0.1:8187', 'wss://127.0.0.1:8187'],
    ['wss://127.0.0.1:8187', 'wss://127.0.0.1:8187']
  ]) {
    const f = fixture();
    await f.ctx.Vs(input);
    assert.equal(f.sockets.length, 1, input);
    assert.equal(f.sockets[0].url, `${expected}/ps/ws?clientId=mock-client&platform=ps`, input);
  }
});

test('close diagnostics show the same socket origin without duplicating the port', async () => {
  const f = fixture(); await f.ctx.Vs(); await f.disconnect();
  const closeLog = f.events.find(event => event[0] === 'error' && event[1].includes('Disconnected from'));
  assert.equal(closeLog[1], '❌ Disconnected from ws://127.0.0.1:8188');
});

test('queued local close retry does not reapply company connection after Apply', async () => {
  const f = fixture(); await f.ctx.Vs(); await f.disconnect();
  f.ctx.rt.value = 'https://company.test';
  await f.ctx.Vs(f.ctx.rt.value);
  assert.equal(f.events.filter(event => event[0] === 'connect').length, 1);
  f.runTimeout(5000); await tick();
  assert.equal(f.events.filter(event => event[0] === 'connect').length, 1, 'old local timeout must not reconnect the company transport');
});

test('queued local close retry cannot replace an applied company connection with an unapplied field edit', async () => {
  const f = fixture(); await f.ctx.Vs(); await f.disconnect();
  f.ctx.rt.value = 'https://company.test';
  await f.ctx.Vs(f.ctx.rt.value);
  f.ctx.rt.value = 'http://127.0.0.1:8190';
  f.runTimeout(5000); await tick();
  assert.equal(f.appliedURL(), 'https://company.test');
  assert.equal(f.sockets.length, 1, 'a stale local timer must not create another local socket');
});

test('legacy interval reconnect uses the applied local URL rather than an unapplied company field edit', async () => {
  const f = fixture(); await f.ctx.Vs();
  f.ctx.Pe.readyState = 3;
  f.ctx.rt.value = 'https://company.test';
  [...f.intervals.values()][0].fn();
  await tick(); f.runTimeout(100); await tick();
  assert(!f.events.some(event => event[0] === 'connect'), 'editing an address must not apply it via the reconnect interval');
  assert.equal(f.sockets.at(-1).url, 'ws://127.0.0.1:8188/ps/ws?clientId=mock-client&platform=ps');
});


test('close retry retains the applied local URL and logs its actual socket origin', async () => {
  const f = fixture(); await f.ctx.Vs(); await f.disconnect();
  f.ctx.rt.value = 'https://company.test';
  assert(f.runTimeout(5000)); await tick();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.appliedURL(), 'http://127.0.0.1:8188');
  assert.equal(f.sockets[1].url, f.sockets[0].url);
  const log = f.events.find(event => event[0] === 'info' && event[1].startsWith('🔄 Reconnecting to'));
  assert.equal(log[1], '🔄 Reconnecting to ws://127.0.0.1:8188');
});

for (const [mode, url, native] of [
  ['native company', 'https://company.test', true],
  ['explicit standalone', 'https://company.test/?ps_transport=standalone', false],
  ['new local', 'http://127.0.0.1:8190', false]
]) {
  test(`${mode} Apply cancels pending legacy work and guards already queued callbacks`, async () => {
    const f = fixture(); await f.ctx.Vs();
    const oldInterval = [...f.intervals.values()][0].fn;
    await f.disconnect();
    const oldTimer = [...f.timeouts.values()].find(timer => timer.ms === 5000).fn;
    await f.ctx.Vs(url);
    assert.equal([...f.timeouts.values()].filter(timer => timer.ms === 5000).length, 0, 'cancel the old close timer');
    assert.equal(f.events.filter(event => event[0] === 'panel').at(-1)[1], native);
    assert.equal(f.intervals.size, mode === 'new local' ? 1 : 0, 'only the applied local socket may retain an interval');
    const eventsBefore = f.events.length, socketsBefore = f.sockets.length;
    f.ctx.rt.value = 'http://127.0.0.1:8191';
    oldTimer(); oldInterval(); await tick();
    assert.equal(f.events.length, eventsBefore, 'stale queued callbacks must have no effects');
    assert.equal(f.sockets.length, socketsBefore);
    assert.equal(f.appliedURL(), url);
  });
}

for (const url of ['https://company.test', 'http://127.0.0.1:8190']) {
  test(`close handler awaiting teardown cannot schedule after newer Apply to ${url}`, async () => {
    const f = fixture(); await f.ctx.Vs();
    const old = f.ctx.Pe; old.readyState = 3;
    const closing = f.ctx.Oa({target: old});
    assert.equal(f.ctx.Pe, null);
    await f.ctx.Vs(url);
    assert(f.runTimeout(100)); await closing;
    assert.equal([...f.timeouts.values()].filter(timer => timer.ms === 5000).length, 0);
    assert.equal(f.appliedURL(), url);
  });
}

test('stale socket open, close and message events cannot alter a newer local socket', async () => {
  const f = fixture(); await f.ctx.Vs();
  const old = f.ctx.Pe, oldOpen = old.listeners.get('open'), oldClose = old.listeners.get('close'), oldMessage = old.listeners.get('message');
  const changing = f.ctx.Vs('http://127.0.0.1:8190');
  await tick(); assert(f.runTimeout(100)); await changing;
  const current = f.ctx.Pe, eventsBefore = f.events.length;
  oldOpen({target: old}); await oldClose({target: old}); oldMessage({target: old, data: '{"event":"old"}'});
  assert.equal(f.ctx.Pe, current);
  assert.equal(f.ctx.xn, false, 'an old socket must not report the current socket as connected');
  assert.equal(f.events.length, eventsBefore);
  current.listeners.get('open')({target: current});
  assert.equal(f.ctx.xn, true, 'the current socket still reports Connected');
});

test('older socket events are ignored as soon as a newer Apply begins, before teardown', async () => {
  const f = fixture(); await f.ctx.Vs();
  const old = f.ctx.Pe, release = f.holdLocal();
  const changing = f.ctx.Vs('http://127.0.0.1:8190');
  const eventsBefore = f.events.length;
  old.listeners.get('open')({target: old});
  await old.listeners.get('close')({target: old});
  old.listeners.get('message')({target: old, data: '{"event":"old"}'});
  assert.equal(f.ctx.Pe, old, 'the new attempt is still waiting before teardown');
  assert.equal(f.ctx.xn, false);
  assert.equal(f.events.length, eventsBefore);
  assert.equal(f.timeouts.size, 0);
  release(); await tick(); assert(f.runTimeout(100)); await changing;
  assert.equal(f.sockets.length, 2);
});

test('close handler claims reconnect before teardown so interval and timer create one socket', async () => {
  const f = fixture(); await f.ctx.Vs();
  const oldInterval = [...f.intervals.values()][0].fn, old = f.ctx.Pe;
  old.readyState = 3;
  const closing = f.ctx.Oa({target: old});
  oldInterval(); await tick();
  assert.equal(f.events.filter(event => event[0] === 'disconnectLocal').length, 1);
  assert(f.runTimeout(100)); await closing;
  oldInterval(); assert(f.runTimeout(5000)); oldInterval(); await tick();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.events.filter(event => event[0] === 'disconnectLocal').length, 2);
  assert.equal([...f.timeouts.values()].filter(timer => timer.ms === 5000).length, 0);
});

test('interval reconnect invalidates a simultaneous old close callback', async () => {
  const f = fixture(); await f.ctx.Vs();
  const oldInterval = [...f.intervals.values()][0].fn, old = f.ctx.Pe, oldClose = old.listeners.get('close');
  old.readyState = 3;
  oldInterval(); await oldClose({target: old}); oldInterval();
  await tick(); assert(f.runTimeout(100)); await tick();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.events.filter(event => event[0] === 'disconnectLocal').length, 2);
  assert.equal([...f.timeouts.values()].filter(timer => timer.ms === 5000).length, 0);
});

test('cancelled old timeout cannot release a newer close handler or discard its timer', async () => {
  const f = fixture(); await f.ctx.Vs(); await f.disconnect();
  const oldTimer = [...f.timeouts.values()].find(timer => timer.ms === 5000).fn;
  await f.ctx.Vs('http://127.0.0.1:8190'); await f.disconnect();
  const currentTimer = f.ctx.psLegacyRetryTimer;
  oldTimer(); await tick();
  assert.equal(f.ctx.psLegacyRetryTimer, currentTimer);
  assert.equal(f.ctx.ws, true);
  assert(f.timeouts.has(currentTimer));
  assert(f.runTimeout(5000)); await tick();
  assert.equal(f.sockets.length, 3);
  assert.equal(f.sockets.at(-1).url, 'ws://127.0.0.1:8190/ps/ws?clientId=mock-client&platform=ps');
});

test('temporarily blocked automatic retry releases its lock and retries the applied URL later', async () => {
  const f = fixture(); await f.ctx.Vs();
  const interval = [...f.intervals.values()][0].fn;
  await f.disconnect(); f.setCanSwitch(false);
  assert(f.runTimeout(5000)); await tick();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.ctx.ws, false);
  f.setCanSwitch(true); f.ctx.rt.value = 'https://company.test';
  interval(); await tick();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.appliedURL(), 'http://127.0.0.1:8188');
});
