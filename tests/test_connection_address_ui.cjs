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
const BUILD = 'connection-ui-20261014.1';
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

for(const saved of [undefined,preference(COMPANY),preference(LOCAL)])test('mounted startup '+(saved||'cold'),async()=>{
 const f=fixture({saved});await f.start();const s=f.snapshot();assert.equal(s.applied,saved?JSON.parse(saved).url:null);
 assert.equal(f.nativeCreations(),0);assert.equal(s.fetchURLs.length,0);
});
test('company settings Apply tears down local socket and navigates HTTPS WebView',async()=>{
 const f=fixture({saved:preference(LOCAL)});await f.start();const local=f.sockets[0];
 f.type('settings',COMPANY);await f.click('settings','apply');const s=f.snapshot();
 assert.equal(local.readyState,3);assert.equal(s.saved,COMPANY);assert.equal(s.src,COMPANY);
 assert.match(s.diagnostic,/company-web/);assert.equal(f.nativeCreations(),0);assert.equal(s.fetchURLs.length,0);
});
test('page load alone is not connected; real authenticated ready changes Settings to green',async()=>{
 const f=fixture({saved:preference(COMPANY)});await f.start();const view=f.ctx.document.querySelector('webview');
 view.dispatchEvent({type:'loadstop',url:COMPANY});await tick();f.flush();assert.notEqual(f.snapshot().status,'Connected');
 const hello=view.messages.find(x=>x.message.type==='hello').message;
 await f.ctx.window.listeners.get('message')({source:view,origin:COMPANY,data:{...hello,type:'ready',session_id:'owned-session'}});
 await tick();await tick();f.flush();assert.equal(f.snapshot().status,'Connected');assert.equal(f.run('Qe(ko).color'),'green');
});
test('forged ready cannot turn Settings green',async()=>{
 const f=fixture({saved:preference(COMPANY)});await f.start();const view=f.ctx.document.querySelector('webview');
 const hello=view.messages.find(x=>x.message.type==='hello').message;
 await f.ctx.window.listeners.get('message')({source:{},origin:COMPANY,data:{...hello,type:'ready',session_id:'forged'}});
 await tick();assert.notEqual(f.snapshot().status,'Connected');
});
test('plugin toolbar and status row are hidden, web content fills panel',()=>{
 const f=fixture();const toolbar=descendants(f.root,n=>n.attrs.class==='bg svelte-3elpbo')[0];
 assert.equal(toolbar.style.display,'none');assert.equal(descendants(f.root,n=>n.attrs.id==='ps_connection_editor_status')[0].style.display,'none');
 assert.equal(f.ctx.document.querySelector('webview').style.height,'100%');
 const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');assert(!html.includes('src="/ps-native-panel.js"'));assert(!html.includes('src="/ps-native-transport.js"'));
 assert(!bundle.includes('nativeRoot.id="ps-native-controls"'));
});
test('draft typing does not change applied connection and Reset still works',async()=>{
 const f=fixture({saved:preference(COMPANY)});await f.start();f.type('settings','https://draft.test');
 assert.equal(f.snapshot().applied,COMPANY);f.remount();assert.equal(f.snapshot().applied,COMPANY);
 await f.click('settings','reset');assert.equal(f.snapshot().applied,LOCAL);assert.equal(f.snapshot().src,LOCAL);
});
