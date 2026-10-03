const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.resolve(__dirname, '../ComfyUI Photoshop Team/dist/ps-team-bridge.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return {promise, resolve, reject};
}
function fixture(options = {}) {
  const statuses = [], messages = [], events = {}, timers = [], diagnostics = [];
  function makeView(src = 'http://comfyui.example.test') {
    const listeners = {};
    return {src, listeners,
      postMessage(data, origin) { messages.push({data, origin, view: this}); },
      addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
      emit(type, values = {}) { for (const listener of listeners[type] || []) listener({url: this.src, ...values}); }
    };
  }
  let current = makeView();
  let url = current.src;
  // Intentionally no URL or URLSearchParams globals: this is the compatibility
  // boundary missed by the protocol tests' injected Node URL implementation.
  const context = {setInterval(callback) { timers.push(callback); },
    document: {querySelector: () => current},
    window: {addEventListener(type, callback) { events[type] = callback; }}};
  vm.createContext(context);
  vm.runInContext(code, context);
  const bridge = context.createPSTeamBridge({url: () => url, status: (...value) => statuses.push(value),
    diagnostic: message => diagnostics.push(message),
    load: options.load, save: options.save, preview: options.preview || (async () => {}), document: () => ({id: 1}), control() {}});
  const receive = async (overrides = {}) => {
    const sent = messages.at(-1);
    await events.message({source: current, origin: sent?.origin, ...overrides,
      data: {protocol: 'ps-team-1', panel: sent?.data.panel, session_id: 'session', transport: sent?.data.transport, type: 'ready', ...overrides.data}});
  };
  return {bridge, statuses, messages, timers, diagnostics, makeView, receive,
    get view() { return current; }, setView(value) { current = value; }, setURL(value) { url = value; }};
}

test('connects without URL globals and keeps explicit HTTP company mode', async () => {
  const f = fixture();
  assert.equal(await f.bridge.connect('HTTP://ComfyUI.Example.Test:80/?token=private'), true);
  assert.equal(f.messages[0].origin, 'http://comfyui.example.test');
  assert.equal(f.messages[0].data.transport, 'company');
  await f.receive();
  assert.deepEqual(f.statuses.at(-1), ['Connected', 'green']);
});

test('one parser normalizes navigation, origins, query transport and conservative IPv6', async () => {
  const f = fixture();
  const cases = [
    ['comfyui.example.test:8188/path?ps_transport=standalone#flow', 'http://comfyui.example.test:8188/path?ps_transport=standalone#flow'],
    ['WSS://ComfyUI.Example.Test:443/?ps_transport=standalone', 'https://comfyui.example.test/?ps_transport=standalone'],
    ['http://[2001:0DB8:0:0:0:0:0:1]:80/path', 'http://[2001:db8::1]/path'],
    ['http://[2001:db8:1:2:3:4:5:6]:8188', 'http://[2001:db8:1:2:3:4:5:6]:8188'],
    ['127.0.0.1', 'http://127.0.0.1:8188'],
    ['127.0.0.1:8187', 'https://127.0.0.1:8187'],
    ['localhost', 'http://localhost:8188'],
    ['http://127.0.0.1:80/', 'http://127.0.0.1:80/'],
    ['https://[::1]:443/', 'https://[::1]:443/']
  ];
  for (const [input, expected] of cases) {
    const actual = f.bridge.normalizeURL(input);
    assert.equal(actual, expected);
    assert.equal(f.bridge.normalizeURL(actual), actual, 'normalization must be idempotent');
  }
  await f.bridge.connect('ws://ComfyUI.Example.Test:80/?ps%5ftransport=standalone');
  assert.equal(f.messages.at(-1).data.transport, 'standalone');
  assert.equal(f.messages.at(-1).origin, 'http://comfyui.example.test');
  for (const address of ['127.0.0.1', 'http://localhost', 'ws://[0:0:0:0:0:0:0:1]:8188']) assert.equal(f.bridge.enabled(address), false);
});

test('rejects ambiguous authorities, credentials, controls, backslashes and invalid ports safely', async () => {
  const f = fixture();
  const invalid = ['', null, 'ftp://example.test', 'http://user:password@example.test',
    'http://example.test\\@evil.test', 'http://example.test\n', ' http://example.test',
    'http://%65xample.test', 'http://example.test:', 'http://example.test:65536',
    'http://example.test:1e3', 'http://example..test', 'http://example.test.',
    'http://-example.test', 'http://127.1', 'http://0x7f000001', 'http://2130706433',
    'http://0177.0.0.1', 'http://256.0.0.1', 'http://example.123',
    'http://[2001:::1]', 'http://[1:2:3:4:5:6:7]', 'http://[1:2:3:4:5:6:7:8:9]',
    'http://[::ffff:127.0.0.1]', 'http://[fe80::1%25eth0]',
    'http://example.test/?ps_transport=company&ps_transport=standalone',
    'http://example.test/?ps_transport=%FF', 'http://example.test/%xy'];
  for (const address of invalid) {
    assert.throws(() => f.bridge.normalizeURL(address), /valid HTTP/);
    assert.equal(await f.bridge.connect(address), false);
    assert.match(f.statuses.at(-1)[0], /^Connection: Enter a valid HTTP/);
  }
  assert.equal(f.messages.length, 0);
  assert.ok(!JSON.stringify(f.statuses).includes('password'));
});

test('invalid replacement blocks stale ready and periodic hello to previous origin', async () => {
  const f = fixture();
  await f.bridge.connect(f.view.src);
  await f.receive();
  assert.equal(await f.bridge.connect('http://user:secret@example.test'), false);
  const count = f.messages.length, status = f.statuses.at(-1);
  await f.receive();
  for (const tick of f.timers) tick();
  assert.equal(f.messages.length, count);
  assert.deepEqual(f.statuses.at(-1), status);
});

test('loaderror reports code, removes URL secrets and survives delayed connect completion', async () => {
  const wait = deferred(), f = fixture({load: () => wait.promise});
  f.bridge.watchView(f.view);
  const connecting = f.bridge.connect(f.view.src);
  f.view.emit('loadstart');
  f.view.emit('loaderror', {code: -105, url: 'http://comfyui.example.test/?token=secret',
    message: 'Cannot load http://comfyui.example.test/?token=secret or https://other.test/login?code=private\nERR_NAME_NOT_RESOLVED'});
  const status = f.statuses.at(-1);
  assert.match(status[0], /Web panel failed to load \(-105\)/);
  assert.ok(!status[0].includes('secret') && !status[0].includes('private') && !status[0].includes('\n'));
  wait.resolve(null);
  assert.equal(await connecting, true);
  for (const tick of f.timers) tick();
  f.view.emit('loadstop');
  assert.deepEqual(f.statuses.at(-1), status);
  assert.equal(f.messages.length, 0);
  f.view.emit('loadstart');
  f.view.emit('loadstop');
  assert.equal(f.messages.at(-1).data.type, 'hello');
});

test('stale view events do not overwrite current state and redirects never change trusted origin', async () => {
  const f = fixture();
  await f.bridge.connect(f.view.src);
  const old = f.view;
  f.setView(f.makeView());
  f.bridge.watchView(f.view);
  const count = f.statuses.length;
  old.emit('loadstart'); old.emit('loaderror', {code: -1}); old.emit('loadstop');
  assert.equal(f.statuses.length, count);
  f.view.emit('loadstart');
  f.view.emit('loadstop', {url: 'https://login.example.test/auth?token=secret'});
  assert.match(f.statuses.at(-1)[0], /redirected to another origin/);
  assert.ok(f.statuses.at(-1)[0].includes('https://login.example.test'));
  assert.ok(!f.statuses.at(-1)[0].includes('/auth'));
  assert.ok(!f.statuses.at(-1)[0].includes('secret'));
  await f.receive({origin: 'https://login.example.test'});
  assert.notEqual(f.statuses.at(-1)[0], 'Connected');
  for (const tick of f.timers) tick();
  assert.equal(f.messages.at(-1).origin, 'http://comfyui.example.test');
});

test('delayed journal plus interval attachment and loadstart cannot cancel first connect', async () => {
  const wait = deferred(), f = fixture({load: () => wait.promise});
  const connecting = f.bridge.connect(f.view.src);
  for (const tick of f.timers) tick();
  f.view.emit('loadstart');
  wait.resolve(null);
  assert.equal(await connecting, true);
  assert.equal(f.messages.at(-1).data.type, 'hello');
  await f.receive();
  assert.equal(f.statuses.at(-1)[0], 'Connected');
});

test('newest requested address wins while journal load is pending', async () => {
  const wait = deferred(), f = fixture({load: () => wait.promise});
  const first = f.bridge.connect('http://first.example.test');
  const second = f.bridge.connect('https://second.example.test:443/?ps_transport=standalone');
  wait.resolve(null);
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].origin, 'https://second.example.test');
  assert.equal(f.messages[0].data.transport, 'standalone');
});

test('postMessage failures leave valid initialization retryable and report diagnostics without rejection', async () => {
  const f = fixture();
  f.view.postMessage = () => { throw new Error('WebView unavailable'); };
  assert.equal(await f.bridge.connect(f.view.src), true);
  assert.deepEqual(f.statuses.at(-1), ['Connection: WebView unavailable', 'darkred']);
});

test('transient first hello failure recovers automatically on loadstop or the periodic tick', async () => {
  for (const trigger of ['loadstop', 'tick']) {
    const f = fixture(), original = f.view.postMessage;
    let attempts = 0;
    f.view.postMessage = function (...args) {
      if (attempts++ === 0) throw new Error('WebView is still loading');
      return original.apply(this, args);
    };
    assert.equal(await f.bridge.connect(f.view.src), true);
    assert.equal(f.messages.length, 0);
    if (trigger === 'loadstop') f.view.emit('loadstop');
    else for (const tick of f.timers) tick();
    assert.equal(f.messages.at(-1).data.type, 'hello');
    await f.receive();
    assert.equal(f.statuses.at(-1)[0], 'Connected');
  }
});

test('loaderror cannot be overwritten by an in-flight ready journal save', async () => {
  const saving = deferred(), finish = deferred();
  const f = fixture({save: async () => { saving.resolve(); await finish.promise; }});
  await f.bridge.connect(f.view.src);
  const receiving = f.receive();
  await saving.promise;
  f.view.emit('loaderror', {code: -7, message: 'Navigation failed'});
  const failure = f.statuses.at(-1);
  finish.resolve();
  await receiving;
  assert.deepEqual(f.statuses.at(-1), failure);
  assert.equal(f.messages.filter(item => item.data.type === 'resume').length, 0);
});

function pendingJournal() {
  return {version: 2, revision: 1, connections: {'http://comfyui.example.test': {
    session: 'session', sessions: {session: {jobs: [['request', {documentID: 1, sourceDocumentID: 1,
      resultCount: null, inserted: [], uncertain: []}]]}}
  }}};
}
const resultMessage = {data: {type: 'result', request_id: 'request', index: 0, result_count: 1, image: 'image'}};

test('loaderror while persisting a result retains failure status and suppresses receipt', async () => {
  const saving = deferred(), finish = deferred();
  let hold = false;
  const f = fixture({load: () => pendingJournal(), save: async () => {
    if (hold) { saving.resolve(); await finish.promise; }
  }});
  await f.bridge.connect(f.view.src); await f.receive();
  hold = true;
  const receiving = f.receive(resultMessage);
  await saving.promise;
  f.view.emit('loaderror', {code: -7, message: 'Navigation failed'});
  const failure = f.statuses.at(-1);
  finish.resolve(); await receiving;
  assert.deepEqual(f.statuses.at(-1), failure);
  assert.equal(f.messages.filter(item => item.data.type === 'received').length, 0);
});

test('loaderror while previewing a result is not overwritten by stale success or preview errors', async () => {
  for (const fails of [false, true]) {
    const previewing = deferred(), finish = deferred();
    const f = fixture({load: () => pendingJournal(), preview: async () => {
      previewing.resolve(); await finish.promise;
      if (fails) throw new Error('Preview failed after navigation');
    }});
    await f.bridge.connect(f.view.src); await f.receive();
    const receiving = f.receive(resultMessage);
    await previewing.promise;
    f.view.emit('loaderror', {code: -7, message: 'Navigation failed'});
    const failure = f.statuses.at(-1);
    finish.resolve(); await receiving;
    assert.deepEqual(f.statuses.at(-1), failure);
  }
});

test('a rejected result save preserves navigation diagnostics and retains the request for recovery', async () => {
  for (const navigated of [false, true]) {
    const saving = deferred(), finish = deferred();
    let hold = false;
    const f = fixture({load: () => pendingJournal(), save: async () => {
      if (hold) { saving.resolve(); await finish.promise; }
    }});
    await f.bridge.connect(f.view.src); await f.receive();
    hold = true;
    const receiving = f.receive(resultMessage);
    await saving.promise;
    if (navigated) f.view.emit('loaderror', {code: -7, message: 'Navigation failed'});
    const failure = f.statuses.at(-1);
    finish.reject(new Error('Journal write failed')); await receiving;
    if (navigated) assert.deepEqual(f.statuses.at(-1), failure);
    else assert.deepEqual(f.statuses.at(-1), ['Result: Journal write failed', 'darkred']);
    assert.equal(f.messages.filter(item => item.data.type === 'received').length, 0);
    hold = false; f.view.emit('loadstart');
    await f.bridge.connect(f.view.src); await f.receive();
    const resumed = f.messages.filter(item => item.data.type === 'resume').at(-1);
    assert.deepEqual(Array.from(resumed.data.requests), ['request']);
  }
});

test('reattaching an earlier WebView does not duplicate its lifecycle listeners', async () => {
  const f = fixture(), first = f.view;
  f.bridge.watchView(first);
  f.bridge.watchView(f.makeView());
  f.bridge.watchView(first);
  assert.equal(first.listeners.loadstart.length, 1);
  assert.equal(first.listeners.loaderror.length, 1);
  assert.equal(first.listeners.loadstop.length, 1);
});

test('local legacy WebView load events do not replace socket status', async () => {
  const f = fixture();
  f.setURL('http://127.0.0.1:8188');
  f.bridge.watchView(f.view);
  f.view.emit('loadstart'); f.view.emit('loaderror', {code: -1}); f.view.emit('loadstop');
  assert.equal(f.statuses.length, 0);
});

test('diagnostics mirror safe statuses and redact standalone credentials and URL queries', async () => {
  const f = fixture();
  await f.bridge.connect(f.view.src);
  f.view.emit('loadstop');
  assert.equal(f.diagnostics.at(-1), 'Web page loaded; waiting for team connection');
  f.view.emit('loaderror', {code: -105, url: 'http://comfyui.example.test/?token=urlsecret',
    message: 'ERR_FAILED token=tokensecret; api_key=keysecret\nCookie: session=cookiesecret\nAuthorization: Bearer authsecret\n' +
      'https://other.test/path?code=codesecret\n?query=querysecret\n"access_token":"jsonsecret"\nBasic basicsecret'});
  assert.equal(f.diagnostics.at(-1), f.statuses.at(-1)[0]);
  assert.match(f.diagnostics.at(-1), /failed to load \(-105\).*ERR_FAILED/);
  for (const secret of ['urlsecret', 'tokensecret', 'keysecret', 'cookiesecret', 'authsecret', 'codesecret', 'querysecret', 'jsonsecret', 'basicsecret']) {
    assert.ok(!f.diagnostics.at(-1).includes(secret), secret);
  }
  assert.ok(!f.diagnostics.at(-1).includes('https://'));
  f.view.emit('loadstart');
  f.view.emit('loadstop', {url: 'https://other.test/?token=hidden'});
  assert.match(f.diagnostics.at(-1), /redirected to another origin/);
  f.view.emit('loadstop', {url: 'file:///private?token=hidden'});
  assert.equal(f.diagnostics.at(-1), 'Web panel loaded an unsupported address');
  await f.bridge.connect('http://user:private@example.test');
  assert.match(f.diagnostics.at(-1), /^Connection:/);
  assert.ok(!f.diagnostics.at(-1).includes('private'));
});
