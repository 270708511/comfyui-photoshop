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
    Ve:(_store,_value,value)=>events.push(['store',value]), rt:{}, n:'http://company.test',
    Vs:async()=>{events.push(['connect']);}};
  vm.createContext(ctx); vm.runInContext(bridgeCode,ctx);
  const bridge = ctx.createPSTeamBridge({url:()=>ctx.n,status:ctx.Nn});
  ctx.psTeam=()=>bridge;
  const start=bundle.indexOf('E=(w=n)=>');
  const end=bundle.indexOf('};return[_,y,v,k,P,S,A,H,j]',start);
  assert.ok(start>0 && end>start);
  vm.runInContext(bundle.slice(start,end+1),ctx);
  const hStart=bundle.indexOf('H=()=>{setTimeout(');
  const hEnd=bundle.indexOf(',j=()=>',hStart);
  vm.runInContext(bundle.slice(hStart,hEnd),ctx);
  return {ctx,events,statuses,listeners};
}
test('actual bundled navigation uses strict bridge parser without global URL',()=>{
  const f=fixture();
  assert.equal(f.ctx.E('HTTP://Company.Test:80/?ps_transport=standalone'),true);
  assert.deepEqual(f.events.at(-1),['src','http://company.test/?ps_transport=standalone']);
  assert.equal(typeof f.listeners.loaderror,'function');
});
test('actual Apply connects after navigation and rejects unsafe addresses before navigation',()=>{
  const f=fixture();f.ctx.H();
  assert.ok(f.events.findIndex(e=>e[0]==='src')<f.events.findIndex(e=>e[0]==='connect'));
  const count=f.events.length;
  assert.equal(f.ctx.E('http://user:password@company.test'),false);
  assert.equal(f.events.length,count);
  assert.match(f.statuses.at(-1)[0],/Invalid server address/);
});
test('manifest minimum matches official Photoshop panel-WebView support',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.host.minVersion,'24.1.0');
  assert.equal(manifest.requiredPermissions.webview.enableMessageBridge,'localAndRemote');
});
