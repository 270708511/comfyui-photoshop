const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../ComfyUI Photoshop Team/dist');
const bundle = fs.readFileSync(path.join(root, 'assets/index-B_-tWO9a.js'), 'utf8');
const bridgeCode = fs.readFileSync(path.join(root, 'ps-team-bridge.js'), 'utf8');
function fixture() {
  const statuses = [], events = [], listeners = {};
  const view = {addEventListener(t, cb) {listeners[t] = cb;}, postMessage() {},
    set src(value) {events.push(['src', value]); listeners.loadstart?.({url:value});}};
  const ctx = {setInterval() {}, setTimeout(fn) {fn();},
    document:{querySelector:()=>view}, window:{addEventListener() {}},
    Nn:(...v)=>statuses.push(v), ne:{info() {}, error() {}},
    rt:{value:'http://company.test',set(value){this.value=value;}}, Qe:store=>store.value,
    localStorage:{setItem() {}}, psConnectionAttempt:0,
    Vs:async()=>{ctx.psConnectionAttempt++;await Promise.resolve();events.push(['connect']);}};
  vm.createContext(ctx); vm.runInContext(bridgeCode,ctx);
  const bridge = ctx.createPSTeamBridge({url:()=>ctx.rt.value,status:ctx.Nn});
  ctx.psTeam=()=>bridge;
  const start=bundle.indexOf('/* PS_CONNECTION_LIFECYCLE:');
  const end=bundle.indexOf('/* PS_CONNECTION_LIFECYCLE_END */',start);
  assert.ok(start>0 && end>start);
  vm.runInContext(bundle.slice(start,end),ctx);
  return {ctx,events,statuses,listeners};
}
test('actual bundled navigation uses strict bridge parser without global URL',async()=>{
  const f=fixture();
  assert.equal(await f.ctx.psApplyConnection('HTTP://Company.Test:80/?ps_transport=standalone'),undefined);
  assert.deepEqual(f.events.find(event=>event[0]==='src'),['src','http://company.test/?ps_transport=standalone']);
  assert.equal(typeof f.listeners.loaderror,'function');
});
test('actual Apply connects after navigation and rejects unsafe addresses before navigation',async()=>{
  const f=fixture();await f.ctx.psApplyConnection();
  assert.ok(f.events.findIndex(e=>e[0]==='src')<f.events.findIndex(e=>e[0]==='connect'));
  const count=f.events.length;
  assert.equal(await f.ctx.psApplyConnection('http://user:password@company.test'),false);
  assert.equal(f.events.length,count);
  assert.match(f.statuses.at(-1)[0],/Invalid server address/);
});
test('manifest minimum matches official Photoshop panel-WebView support',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.host.minVersion,'24.1.0');
  assert.equal(manifest.requiredPermissions.webview.enableMessageBridge,'localAndRemote');
});
