// Integration contract: run the real browser transport and durable UXP bridge in
// separate realms. Only Photoshop/UXP, browser APIs and HTTP responses are faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const root = path.resolve(__dirname, '..');
const ORIGIN = 'https://team.example';
const INPUT = '🔹Photoshop ComfyUI Plugin', OUTPUT = '🔹SendTo Photoshop Plugin';
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const response = (body, status = 200, bytes = 'result-image') => ({
  ok: status >= 200 && status < 300, status,
  json: async () => clone(body), blob: async () => new Blob([bytes], {type: 'image/png'}),
});

function httpFixture(options = {}) {
  const calls = [], submissions = [], uploads = [], acknowledged = new Set();
  const requests = new Map(), histories = new Map(), held = new Map();
  let metadata, username = 'alice';
  async function fetch(url, args = {}) {
    const method = args.method || 'GET';
    calls.push({url, method, body: args.body});
    if (held.has(url)) {const gate = held.get(url); held.delete(url); gate.started(); return gate.promise;}
    if (url === options.failNetworkAt) throw new TypeError('Network unavailable');
    if (url === '/auth/whoami') return response({authenticated: true, username});
    if (url === '/ps/team/capabilities') return response({protocol: 'ps-team-1', transport: 'company', durable: true}, options.capabilityStatus ?? (options.standalone ? 404 : 200));
    if (url === '/ps/team/sessions' || /^\/ps\/team\/sessions\/[^/]+$/.test(url)) {
      if (options.standalone && method === 'GET' && url === '/ps/team/sessions') return response({detail: 'No company adapter'}, options.legacyProbeStatus ?? 404);
      if (options.sessionStatus) return response({detail: 'Company adapter temporarily unavailable'}, options.sessionStatus);
      return response({session_id: 'company-session'});
    }
    const route = url.match(/^\/ps\/team\/sessions\/([^/]+)\/requests\/([^/]+)(.*)$/);
    if (route) {
      const [, session, rid, suffix] = route;
      assert.equal(session, 'company-session');
      if (suffix === '/snapshot') {
        assert.equal(method, 'PUT');
        requests.set(rid, {payload: JSON.parse(args.body)});
        return response({ok: true});
      }
      if (suffix === '/submit') {
        assert.equal(method, 'POST');
        assert.ok(requests.has(rid), 'Snapshot must be saved before submit');
        submissions.push({transport: 'company', rid, body: JSON.parse(args.body)});
        return response({ok: true});
      }
      if (suffix === '/results/0/ack') {
        assert.equal(method, 'POST');
        acknowledged.add(rid);
        return response({ok: true});
      }
      if (suffix === '/results/0') return response({});
      if (suffix === '') return response({request_id: rid, document_id: requests.get(rid)?.payload.document_id,
        state: 'success', result_count: 1, acknowledged_results: acknowledged.has(rid) ? [0] : []});
      throw new Error('Unexpected company route: ' + url);
    }
    if (url === '/upload/image') {
      assert.equal(method, 'POST');
      uploads.push(args.body);
      return response({name: uploads.length % 2 ? 'canvas-renamed.png' : 'mask-renamed.png',
        subfolder: args.body.get('subfolder'), type: 'input'});
    }
    if (url === '/prompt') {
      assert.equal(method, 'POST');
      const body = JSON.parse(args.body);
      metadata = body.extra_data.extra_pnginfo.ps_plugin;
      submissions.push({transport: 'standalone', rid: metadata.request_id, body});
      const promptID = 'prompt-id-' + submissions.length;
      histories.set(promptID, clone(metadata));
      return response({prompt_id: promptID, job_id: 'job-id-' + submissions.length});
    }
    const history = url.match(/^\/history\/(prompt-id-\d+)$/);
    if (history) {
      const promptID = history[1], savedMetadata = histories.get(promptID);
      assert.ok(savedMetadata, 'Only a submitted prompt can have history');
      return response({[promptID]: {
      prompt: [1, promptID, {}, {extra_pnginfo: {ps_plugin: savedMetadata}}],
      status: {completed: true, status_str: 'success'},
      outputs: {
        '2': {images: [{filename: 'result.png', subfolder: 'ps_plugin/' + savedMetadata.snapshot_id, type: 'output'}]},
        unrelated: {images: [{filename: 'other-user.png', subfolder: 'foreign', type: 'output'}]},
      },
    }});
    }
    if (/^\/jobs\/prompt-id-\d+$/.test(url)) return response({status: 'pending', scheduler_status: 'scheduler_queued'});
    if (url.startsWith('/view?')) return response({}, 200, url);
    throw new Error('Unexpected HTTP request: ' + method + ' ' + url);
  }
  return {fetch, calls, submissions, uploads, acknowledged, metadata: () => metadata, username: value => {username = value;},
    holdNext(url) {
      let release, started;
      const promise = new Promise(resolve => {release = resolve;});
      const observed = new Promise(resolve => {started = resolve;});
      held.set(url, {promise, started});
      return {release, started: observed};
    },
  };
}

function integrated(options = {}) {
  const transport = options.standalone ? 'standalone' : 'company';
  const url = ORIGIN + (options.standalone ? '/?ps_transport=standalone' : '/');
  const http = httpFixture(options), storage = new Map(), journal = {value: null};
  const outbound = [], inbound = [], previews = [], statuses = [], errors = [], operations = new Set();
  const viewEvents = {}, timers = new Map();
  let frontHandlers, panelHandler, host, browser, timerID = 0;
  let document = {id: 10, title: 'Original.psd'}, suppressAcknowledged = false;
  const bounds = {left: 1, top: 2, right: 40, bottom: 50};
  const schedule = action => {
    const operation = Promise.resolve().then(action);
    operations.add(operation);
    operation.then(() => operations.delete(operation), error => {errors.push(error); operations.delete(operation);});
  };
  const toFrontend = message => schedule(() => Promise.all((frontHandlers.message || []).map(handler => handler({
    source: host, origin: 'comfyui.photoshop.team', data: clone(message),
  }))));
  const toPanel = message => schedule(() => panelHandler({source: view, origin: ORIGIN, data: clone(message)}));
  const view = {
    postMessage(message, origin) {
      assert.equal(origin, ORIGIN);
      outbound.push(clone(message));
      toFrontend(message);
    },
    addEventListener(type, handler) {viewEvents[type] = handler;},
  };
  class Reader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(data => {
        this.result = 'data:image/png;base64,' + Buffer.from(data).toString('base64');
        this.onload();
      }, error => this.onerror(error));
    }
  }
  function loadFrontend() {
    timers.clear();
    frontHandlers = {};
    host = {postMessage(message) {
      inbound.push(clone(message));
      if (!(suppressAcknowledged && message.type === 'acknowledged')) toPanel(message);
    }};
    const location = new URL(url);
    browser = vm.createContext({console, location, URL, URLSearchParams, Blob, FormData, Uint8Array,
      crypto: webcrypto, atob, fetch: http.fetch, FileReader: Reader,
      app: {graphToPrompt: async () => ({output: {
        '1': {class_type: INPUT, inputs: {}}, '2': {class_type: OUTPUT, inputs: {output: ['1', 0]}},
      }, workflow: {nodes: []}})},
      window: {uxpHost: host, location, addEventListener(type, handler) {(frontHandlers[type] ||= []).push(handler);}, dispatchEvent() {}},
      CustomEvent: class {constructor(type) {this.type = type;}},
      sessionStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
      setTimeout: handler => {timers.set(++timerID, handler); return timerID;}, clearTimeout: id => timers.delete(id),
    });
    const source = fs.readFileSync(path.join(root, 'js/team.js'), 'utf8')
      .replace(/^import\s.*?;?\s*$/gm, '').replace(/\bexport\s+/g, '');
    vm.runInContext(source + '\nstartTeam(() => {});', browser, {filename: 'js/team.js'});
  }
  loadFrontend();
  const hooks = {
    url: () => url, document: () => document, bounds: () => clone(bounds),
    canvas: async () => 'iVBORw==', mask: async () => 'iVBORw==',
    activate: async id => {document = {...document, id};},
    preview: async image => previews.push(image), status: (...args) => statuses.push(args),
    confirm: async () => 'cancel', setBounds: () => ({old: true}), restoreBounds() {}, control() {},
    load: async () => clone(journal.value), save: async value => {journal.value = clone(value);},
  };
  const panel = vm.createContext({console, URL, setInterval() {},
    document: {querySelector: () => view}, window: {addEventListener(type, handler) {if (type === 'message') panelHandler = handler;}},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'ComfyUI Photoshop Team/dist/ps-team-bridge.js'), 'utf8'), panel,
    {filename: 'ps-team-bridge.js'});
  const bridge = panel.createPSTeamBridge(hooks);
  async function settle() {
    for (let turn = 0, quiet = 0; turn < 100; turn++) {
      await new Promise(setImmediate);
      if (errors.length) throw errors.shift();
      quiet = operations.size ? 0 : quiet + 1;
      if (quiet === 2) return;
    }
    throw new Error('Bridge message exchange did not settle');
  }
  const jobs = () => Object.values(journal.value?.connections || {})
    .flatMap(connection => Object.values(connection.sessions || {})).flatMap(session => session.jobs || []);
  return {bridge, http, storage, journal, outbound, inbound, previews, statuses, transport, jobs, settle,
    connect: async () => {await bridge.connect(url); await settle();},
    capture: async () => {
      await bridge.capture(async () => ({positive: 'red', negative: '', seed: '1', slider: 50})); await settle();
      return outbound.filter(message => message.type === 'generate').at(-1)?.request_id;
    },
    insert: async () => {await bridge.beforeInsert(); await bridge.afterInsert(true); await settle();},
    toFrontend: async message => {toFrontend(message); await settle();},
    toPanel: async message => {toPanel(message); await settle();},
    suppressAcknowledged: value => {suppressAcknowledged = value;},
    reload: async () => {viewEvents.loadstart?.(); loadFrontend(); await bridge.connect(url); await settle();},
    tick: async () => {const waiting = [...timers.values()]; timers.clear(); for (const handler of waiting) schedule(handler); await settle();},
  };
}

function assertEnvelope(fixture) {
  for (const message of [...fixture.outbound, ...fixture.inbound]) {
    assert.equal(message.protocol, 'ps-team-1');
    assert.equal(message.transport, fixture.transport, message.type + ' must carry transport identity');
    assert.equal(typeof message.panel, 'string');
    assert.ok(Object.hasOwn(message, 'session_id'), message.type + ' must carry a session identity');
    if (!['hello', 'error', 'unbound'].includes(message.type)) assert.ok(message.session_id);
  }
}

test('merged company bridge retains server results until real insertion ACK and never posts ordinary /prompt', async () => {
  const f = integrated(); await f.connect(); const rid = await f.capture();
  assert.ok(rid); assert.equal(f.previews.length, 1);
  assert.equal(f.http.submissions.length, 1); assert.equal(f.http.submissions[0].transport, 'company');
  assert.ok(f.outbound.some(message => message.type === 'received' && message.request_id === rid));
  assert.equal(f.outbound.filter(message => message.type === 'ack').length, 0);
  assert.equal(f.http.acknowledged.size, 0); assert.equal(f.jobs().length, 1);
  await f.tick();
  assert.equal(f.previews.length, 1, 'Soft receipt suppresses repeated preview delivery');
  assert.equal(f.http.calls.filter(call => /\/results\/0$/.test(call.url)).length, 1);
  const insertion = await f.bridge.beforeInsert();
  assert.equal(insertion.documentID, 10);
  assert.deepEqual(f.jobs()[0][1].uncertain, [0]);
  assert.equal(f.http.acknowledged.size, 0, 'Insertion intent alone is not an ACK');
  await f.bridge.afterInsert(true); await f.settle();
  assert.ok(f.http.acknowledged.has(rid)); assert.equal(f.jobs().length, 0);
  assert.ok(f.inbound.some(message => message.type === 'acknowledged' && message.request_id === rid));
  assert.equal(f.http.calls.filter(call => ['/prompt', '/upload/image'].includes(call.url)).length, 0);
  assertEnvelope(f);
});

test('merged standalone bridge uses explicit opt-in and real insertion ACK clears its durable journal', async () => {
  const f = integrated({standalone: true}); await f.connect(); const rid = await f.capture();
  assert.ok(rid); assert.equal(f.previews.length, 1);
  assert.equal(f.http.calls.filter(call => call.url === '/ps/team/capabilities').length, 1);
  assert.ok(f.http.calls.some(call => call.url === '/auth/whoami'));
  assert.deepEqual(f.http.calls.filter(call => call.url.startsWith('/ps/team/sessions')).map(call => ({url: call.url, method: call.method})),
    [{url: '/ps/team/sessions', method: 'GET'}]);
  assert.equal(f.http.uploads.length, 2); assert.equal(f.http.submissions.length, 1);
  const metadata = f.http.metadata();
  assert.equal(metadata.version, 'ps-plugin-1'); assert.equal(metadata.request_id, rid);
  assert.equal(metadata.canvas.name, 'canvas-renamed.png'); assert.equal(metadata.mask.name, 'mask-renamed.png');
  for (const form of f.http.uploads) {
    assert.equal(form.get('subfolder'), 'ps_plugin/' + metadata.snapshot_id);
    assert.equal(form.get('type'), 'input'); assert.equal(form.get('overwrite'), 'false');
  }
  assert.equal(f.outbound.filter(message => message.type === 'ack').length, 0);
  assert.equal(f.jobs().length, 1);
  await f.tick();
  assert.equal(f.previews.length, 1, 'Soft receipt suppresses repeated preview delivery');
  assert.equal(f.http.calls.filter(call => call.url.startsWith('/view?')).length, 1);
  await f.insert();
  assert.equal(f.jobs().length, 0, 'Frontend durable acknowledgement must reach the real UXP bridge');
  assert.ok(f.inbound.some(message => message.type === 'acknowledged' && message.request_id === rid && message.index === 0));
  assert.equal(f.http.calls.filter(call => call.url === '/prompt').length, 1);
  assert.ok(f.http.calls.filter(call => call.url.startsWith('/view?')).every(call => !call.url.includes('other-user')));
  assertEnvelope(f);
});

for (const standalone of [false, true]) {
  const transport = standalone ? 'standalone' : 'company';
  test('merged ' + transport + ' bridge rejects forged session and transport identities in both directions', async () => {
    const f = integrated({standalone}); await f.connect(); const rid = await f.capture();
    const generate = f.outbound.find(message => message.type === 'generate');
    const result = f.inbound.find(message => message.type === 'result');
    assert.ok(generate); assert.ok(result);
    const count = f.http.calls.length, previews = f.previews.length;
    await f.toFrontend({...generate, request_id: 'f'.repeat(32), session_id: 'forged-session'});
    await f.toFrontend({...generate, type: 'ack', request_id: rid, index: 0, session_id: 'forged-session'});
    await f.toFrontend({...generate, type: 'ack', request_id: rid, index: 0, transport: standalone ? 'company' : 'standalone'});
    await f.toPanel({...result, image: 'forged-image', session_id: 'forged-session'});
    await f.toPanel({...result, type: 'acknowledged', session_id: 'forged-session'});
    await f.toPanel({...result, type: 'acknowledged', transport: standalone ? 'company' : 'standalone'});
    assert.equal(f.http.calls.length, count); assert.equal(f.previews.length, previews);
    assert.equal(f.jobs().length, 1); assert.equal(f.outbound.filter(message => message.type === 'ack').length, 0);
    await f.insert(); assert.equal(f.jobs().length, 0); assertEnvelope(f);
  });

  test('merged ' + transport + ' reload reconciles a lost acknowledgement without generating or inserting twice', async () => {
    const f = integrated({standalone}); await f.connect(); const rid = await f.capture();
    f.suppressAcknowledged(true); await f.insert();
    assert.equal(f.jobs().length, 1); assert.deepEqual(f.jobs()[0][1].inserted, [0]);
    assert.equal(f.previews.length, 1); assert.equal(f.http.submissions.length, 1);
    f.suppressAcknowledged(false); await f.reload();
    assert.equal(f.http.submissions.length, 1, 'Reconnect must never generate another request');
    assert.equal(f.previews.length, 1, 'Inserted result must never be presented for a second insertion');
    assert.equal(f.jobs().length, 0, 'Reconnect must complete the durable ACK handshake');
    assert.ok(f.outbound.some(message => message.type === 'resume' && message.requests.includes(rid)));
    await assert.rejects(f.bridge.beforeInsert(), /No team result/);
    assertEnvelope(f);
  });
}

for (const sessionStatus of [404, 503]) test('company HTTP ' + sessionStatus + ' cannot silently downgrade to standalone generation', async () => {
  const f = integrated({sessionStatus, capabilityStatus: sessionStatus}); await f.connect(); await f.capture();
  assert.equal(f.inbound.filter(message => message.type === 'ready').length, 0);
  assert.equal(f.http.submissions.length, 0); assert.equal(f.http.uploads.length, 0);
  assert.equal(f.http.calls.filter(call => ['/prompt', '/upload/image'].includes(call.url)).length, 0);
  assert.ok(f.http.calls.some(call => call.url.startsWith('/ps/team/')));
});

for (const capabilityStatus of [200, 503, 401, 403]) {
  test('standalone opt-in is blocked unless company capability probe returns 404 (HTTP ' + capabilityStatus + ')', async () => {
    const f = integrated({standalone: true, capabilityStatus}); await f.connect(); await f.capture();
    assert.ok(f.http.calls.some(call => call.url === '/ps/team/capabilities'));
    assert.equal(f.inbound.filter(message => message.type === 'ready').length, 0);
    assert.equal(f.http.submissions.length, 0); assert.equal(f.http.uploads.length, 0);
    assert.equal(f.http.calls.filter(call => call.url.startsWith('/ps/team/sessions')).length, 0);
  });
}

test('standalone opt-in rejects older company adapters when capability is absent but sessions exists', async () => {
  const f = integrated({standalone: true, capabilityStatus: 404, legacyProbeStatus: 405});
  await f.connect(); await f.capture();
  assert.deepEqual(f.http.calls.filter(call => call.url.startsWith('/ps/team/')).map(call => ({url: call.url, method: call.method})),
    [{url: '/ps/team/capabilities', method: 'GET'}, {url: '/ps/team/sessions', method: 'GET'}]);
  assert.equal(f.inbound.filter(message => message.type === 'ready').length, 0);
  assert.equal(f.http.submissions.length, 0); assert.equal(f.http.uploads.length, 0);
});

for (const failNetworkAt of ['/ps/team/capabilities', '/ps/team/sessions']) {
  test('standalone opt-in fails closed on network error probing ' + failNetworkAt, async () => {
    const f = integrated({standalone: true, failNetworkAt}); await f.connect(); await f.capture();
    assert.ok(f.http.calls.some(call => call.url === failNetworkAt));
    assert.equal(f.inbound.filter(message => message.type === 'ready').length, 0);
    assert.equal(f.http.submissions.length, 0); assert.equal(f.http.uploads.length, 0);
  });
}

for (const standalone of [false, true]) {
  test('merged ' + (standalone ? 'standalone' : 'company') + ' insertion failure stays uncertain until explicit recovery', async () => {
    const f = integrated({standalone}); await f.connect(); const rid = await f.capture();
    await f.bridge.beforeInsert(); await f.bridge.afterInsert(false); await f.settle();
    assert.equal(f.jobs().length, 1); assert.deepEqual(f.jobs()[0][1].uncertain, [0]);
    assert.equal(f.outbound.filter(message => message.type === 'ack').length, 0);
    assert.equal(f.inbound.filter(message => message.type === 'acknowledged').length, 0);
    await f.bridge.resolveInsertion(rid, 0, true); await f.settle();
    assert.equal(f.jobs().length, 0); assert.equal(f.http.submissions.length, 1);
    assert.equal(f.outbound.filter(message => message.type === 'ack').length, 1);
    assertEnvelope(f);
  });
}

test('standalone A to B to A preserves both accounts and restores the original pending session', async () => {
  const f = integrated({standalone: true}); await f.connect(); const aliceRID = await f.capture();
  const aliceReady = f.inbound.filter(message => message.type === 'ready').at(-1);
  assert.equal(aliceReady.account_id, 'alice');
  const aliceSession = aliceReady.session_id;
  const savedConnection = () => f.journal.value.connections[ORIGIN + '#ps_transport=standalone'];
  assert.equal(savedConnection().sessions[aliceSession].account, 'alice');
  f.http.username('bob'); await f.reload();
  const bobReady = f.inbound.filter(message => message.type === 'ready').at(-1);
  assert.equal(bobReady.account_id, 'bob'); assert.notEqual(bobReady.session_id, aliceSession);
  assert.equal(f.jobs().length, 1); assert.equal(f.jobs()[0][0], aliceRID);
  const bobRID = await f.capture();
  assert.equal(savedConnection().sessions[bobReady.session_id].account, 'bob');
  assert.equal(f.jobs().length, 2); assert.equal(f.http.submissions.length, 2);
  const beforeReturn = f.inbound.length;
  f.http.username('alice'); await f.reload();
  const restored = f.inbound.filter(message => message.type === 'ready').at(-1);
  assert.equal(restored.account_id, 'alice'); assert.equal(restored.session_id, aliceSession);
  const returnedResults = f.inbound.slice(beforeReturn).filter(message => message.type === 'result');
  assert.equal(returnedResults.length, 1); assert.equal(returnedResults[0].request_id, aliceRID);
  assert.equal(f.http.submissions.length, 2, 'Changing accounts must never regenerate archived work');
  await f.bridge.rebindDocument(aliceRID, 10); await f.insert();
  assert.equal(f.jobs().length, 1); assert.equal(f.jobs()[0][0], bobRID);
  assert.equal(savedConnection().sessions[aliceSession].jobs.length, 0);
  assert.equal(savedConnection().sessions[bobReady.session_id].jobs.length, 1);
  assertEnvelope(f);
});

test('standalone missing browser mapping blocks readiness and keeps the pending durable journal', async () => {
  const f = integrated({standalone: true}); await f.connect(); const rid = await f.capture();
  const previousReady = f.inbound.filter(message => message.type === 'ready').length;
  const beforeJobs = clone(f.jobs());
  f.storage.clear(); await f.reload(); await f.capture();
  assert.equal(f.inbound.filter(message => message.type === 'ready').length, previousReady);
  assert.equal(f.http.submissions.length, 1); assert.equal(f.http.uploads.length, 2);
  assert.deepEqual(f.jobs(), beforeJobs); assert.equal(f.jobs()[0][0], rid);
  const error = f.inbound.filter(message => message.type === 'error').at(-1);
  assert.ok(error); assert.match(error.error, /mapping is unavailable/i);
  assert.match(error.error, /retained/i); assert.match(error.error, /do not generate/i);
});

test('late standalone old-session 401 cannot unbind the new account', async () => {
  const f = integrated({standalone: true}); await f.connect(); const aliceRID = await f.capture();
  const gate = f.http.holdNext('/history/prompt-id-1');
  const ticking = f.tick(); await gate.started;
  f.http.username('bob'); const connecting = f.connect();
  for (let turn = 0; turn < 30 && !f.inbound.some(message => message.type === 'ready' && message.account_id === 'bob'); turn++) {
    await new Promise(setImmediate);
  }
  const bob = f.inbound.filter(message => message.type === 'ready' && message.account_id === 'bob').at(-1);
  gate.release(response({detail: 'Previous account session expired'}, 401));
  await Promise.all([ticking, connecting]);
  assert.ok(bob, 'Bob must have established a new binding while Alice fetch was pending');
  assert.equal(f.inbound.filter(message => message.type === 'unbound' && message.session_id === bob.session_id).length, 0);
  assert.equal(f.inbound.filter(message => message.type === 'error' && message.session_id === bob.session_id).length, 0);
  const bobRID = await f.capture(); assert.ok(bobRID); assert.notEqual(bobRID, aliceRID);
  assert.equal(f.http.submissions.length, 2); assert.equal(f.jobs().length, 2);
  assert.ok(f.jobs().some(([rid]) => rid === aliceRID));
  assert.ok(f.jobs().some(([rid]) => rid === bobRID));
  assertEnvelope(f);
});
