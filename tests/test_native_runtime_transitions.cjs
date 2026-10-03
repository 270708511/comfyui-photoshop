// Execute the real compiled connector and socket teardown, not a reimplementation.
// WebSocket, timers, stores and the bridge are simulated; no network or Adobe host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bundle = fs.readFileSync(path.join(__dirname, '../ComfyUI Photoshop Team/dist/assets/index-B_-tWO9a.js'), 'utf8');

function segment(start, end) {
  const from = bundle.indexOf(start), to = bundle.indexOf(end, from);
  assert(from >= 0 && to > from, 'compiled connector boundaries must remain identifiable');
  return bundle.slice(from, to);
}
const connector = segment('Vs=async(', ',Tp=');
const teardown = segment('Ta=async()=>', ';let Hi=');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

function fixture({holdTeardown = false, holdLocal = false} = {}) {
  const events = [], sockets = [], teardownGate = deferred(), localGate = deferred();
  let appliedTeam = false;
  const bridge = {
    canSwitch: () => true,
    normalizeURL: value => new URL(value).href.replace(/\/$/, ''),
    enabled(value) { return value === undefined ? appliedTeam : new URL(value).hostname !== '127.0.0.1'; },
    async disconnectLocal(url) {
      events.push(['disconnectLocal', url]);
      if (holdLocal) await localGate.promise;
      appliedTeam = false;
      return true;
    },
    async connect(url) { appliedTeam = true; events.push(['connect', url]); return true; }
  };
  class Socket {
    constructor(url) { this.url = url; this.closed = false; sockets.push(this); events.push(['socket', url]); }
    addEventListener(name) { events.push(['add', this.url, name]); }
    removeEventListener(name) { events.push(['remove', this.url, name]); }
    close() { this.closed = true; events.push(['close', this.url]); }
  }
  const ctx = {
    rt: {value: 'http://127.0.0.1:8188', set(value) { this.value = value; }}, Qe: store => store.value,
    psTeam: () => bridge, Nn() {}, ne: {info() {}, error() {}}, WebSocket: Socket,
    psConnectionAttempt: 0, psPreviewEpoch: 0, psLegacyPreviewReady: true, psPreviewChain: Promise.resolve(),
    hi: null, It: '', xn: false, Pe: null, Op: 'mock-client', Pa() {}, Aa() {}, Oa() {}, Tp() {},
    setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { if (holdTeardown) teardownGate.promise.then(fn); else queueMicrotask(fn); return 1; }
  };
  vm.createContext(ctx);
  vm.runInContext('var ' + teardown + '; var ' + connector + ';', ctx);
  function connectedSocket() {
    const socket = new Socket('ws://127.0.0.1:8188/ps/ws');
    ctx.Pe = socket; ctx.xn = true; events.length = 0; sockets.length = 0;
    return socket;
  }
  return {ctx, events, sockets, connectedSocket, releaseTeardown: teardownGate.resolve, releaseLocal: localGate.resolve};
}

test('compiled local connector freezes the applied URL while the editable field changes', async () => {
  const f = fixture({holdLocal: true});
  const pending = f.ctx.Vs('http://127.0.0.1:8188');
  f.ctx.rt.value = 'http://company.test';
  f.releaseLocal(); await pending;
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'ws://127.0.0.1:8188/ps/ws?clientId=mock-client&platform=ps');
  assert(!f.events.some(event => event[0] === 'connect'));
});

test('compiled company connection removes legacy listeners and closes the socket first', async () => {
  const f = fixture(), old = f.connectedSocket();
  assert.equal(await f.ctx.Vs('http://company.test'), true);
  assert(old.closed); assert.equal(f.ctx.Pe, null);
  for (const name of ['close', 'message', 'open']) assert(f.events.some(event => event[0] === 'remove' && event[2] === name));
  assert(f.events.findIndex(event => event[0] === 'close') < f.events.findIndex(event => event[0] === 'connect'));
  assert.equal(f.sockets.length, 0);
});

test('newer company Apply wins while older local Apply waits for socket teardown', async () => {
  const f = fixture({holdTeardown: true}); f.connectedSocket();
  const older = f.ctx.Vs('http://127.0.0.1:8188'); await tick();
  assert(f.events.some(event => event[0] === 'close'));
  assert.equal(await f.ctx.Vs('http://company.test'), true);
  f.releaseTeardown(); assert.equal(await older, false);
  assert.equal(f.sockets.length, 0);
  assert.equal(f.events.filter(event => event[0] === 'connect').length, 1);
});

test('newer local Apply wins while older company Apply waits for socket teardown', async () => {
  const f = fixture({holdTeardown: true}); f.connectedSocket();
  const older = f.ctx.Vs('http://company.test'); await tick();
  await f.ctx.Vs('http://127.0.0.1:8189');
  f.releaseTeardown(); assert.equal(await older, false);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'ws://127.0.0.1:8189/ps/ws?clientId=mock-client&platform=ps');
  assert(!f.events.some(event => event[0] === 'connect'));
});
