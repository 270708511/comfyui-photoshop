const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {webcrypto} = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/team.js'), 'utf8').replace(/^import.*\n/, '').replace(/export /g, '');
const INPUT='🔹Photoshop ComfyUI Plugin', OUTPUT='🔹SendTo Photoshop Plugin';
function fixture(options={}) {
  const handlers={},messages=[],calls=[],timers=[],posts=[],uploads=[];
  const storage=options.storage || new Map(); let username=options.username || 'alice';
  const graph={output:{'1':{class_type:INPUT,inputs:{}},'2':{class_type:OUTPUT,inputs:{output:['1',0]}}},workflow:{}};
  let meta, resultCount=options.results || 1, failView=options.failView || 0;
  const response=(status,data,blob)=>({ok:status>=200&&status<300,status,json:async()=>data,blob:async()=>new Blob([blob || 'image'])});
  const host={postMessage:m=>{messages.push(m);options.onHost?.(m)}};
  const fetch=async(url,args={})=>{
    calls.push({url,args});
    if(url==='/auth/whoami')return response(200,{authenticated:true,username});
    if(url==='/upload/image') {
      uploads.push(args.body);if(options.secondFails && uploads.length===2)return response(502,{});
      return response(200,{name:uploads.length%2===1?'canvas (renamed).png':'mask (renamed).png',subfolder:args.body.get('subfolder'),type:'input'});
    }
    if(url==='/prompt') {
      const body=JSON.parse(args.body);posts.push(body);meta=body.extra_data.extra_pnginfo.ps_plugin;
      if(options.submitUnknown)throw new TypeError('connection lost');
      return response(200,{prompt_id:'prompt-id',job_id:'job-id'});
    }
    if(url==='/history/prompt-id') {
      if(options.historyMissing)return response(options.historyMissing===404?404:200,{});
      meta ||= options.metadata;
      const entry={prompt:[1,'prompt-id',{}, {extra_pnginfo:{ps_plugin:meta}}],status:options.historyError?{completed:false,status_str:'error',messages:[['execution_error',{exception_message:'test node failed'}]]}:{completed:true,status_str:'success'},
        outputs:{'2':{images:Array.from({length:resultCount},(_,i)=>({filename:'output'+i+'.png',subfolder:options.outputFolder?options.outputFolder(meta.snapshot_id):'ps_plugin/'+meta.snapshot_id,type:'output',unused:'never-forward'}))},'unrelated':{images:[{filename:'foreign.png',subfolder:'other',type:'output'}]}}};
      return response(200,{'prompt-id':entry});
    }
    if(url==='/jobs/prompt-id')return response(options.jobHTTP || 200, options.job || {status:'pending',scheduler_status:'scheduler_queued'});
    if(url.startsWith('/view?')) {if(failView-->0)return response(502,{});return response(200,{},url);}
    throw new Error('Unexpected URL '+url);
  };
  class Reader {readAsDataURL(blob){blob.arrayBuffer().then(b=>{this.result='data:image/png;base64,'+Buffer.from(b).toString('base64');this.onload()})}}
  const context={app:{graphToPrompt:async()=>graph},location:{origin:'https://same.test',hostname:options.hostname || 'same.test'},window:{uxpHost:options.noHost?null:host,
      addEventListener:(n,cb)=>{handlers[n]=cb},dispatchEvent(){}},crypto:webcrypto,Uint8Array,Blob,FormData,URL,URLSearchParams,atob,
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},fetch,FileReader:Reader,
    CustomEvent:class {constructor(type){this.type=type}},setTimeout:(cb,ms)=>{const t={cb,ms,active:true};timers.push(t);return t},clearTimeout:t=>{if(t)t.active=false},Set,Map,Promise,JSON};
  vm.createContext(context);vm.runInContext(source+'\nstartTeam(()=>{});',context);
  const panel='a'.repeat(32),rid='b'.repeat(32);
  const receive=(m,extra={})=>handlers.message({source:host,origin:'comfyui.photoshop.team',data:{protocol:'ps-team-1',panel,...m},...extra});
  const hello=()=>receive({type:'hello'});
  const generate=(requestID=rid)=>receive({type:'generate',request_id:requestID,payload:{canvasBase64:'iVBORw==',maskBase64:'iVBORw==',configdata:{positive:'red',negative:'',seed:'1',slider:50}}});
  return {context,storage,receive,hello,generate,messages,calls,posts,uploads,timers,rid,graph,username:x=>username=x,metadata:()=>meta,
    tick:async()=>{const t=timers.findLast(x=>x.active);assert.ok(t);t.active=false;await t.cb();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));}};
}
test('normal browser and spoofed bridge do not create bindings or submit',async()=>{
 const f=fixture({noHost:true});await f.hello();await f.generate();assert.equal(f.calls.length,0);assert.equal(vm.runInContext('teamMode',f.context),false);
 const g=fixture();await g.receive({type:'hello'},{source:{}});assert.equal(g.calls.length,0);
});
test('standard multipart uploads trust returned names; submit only after both and filter own SendTo output',async()=>{
 const f=fixture();await f.hello();await f.generate();assert.equal(f.posts.length,1);assert.equal(f.uploads.length,2);
 for(const form of f.uploads){assert.equal(form.get('type'),'input');assert.equal(form.get('overwrite'),'false');assert.match(form.get('subfolder'),/^ps_plugin\/[a-f0-9]{32}$/);}
 const m=f.metadata();assert.equal(m.canvas.name,'canvas (renamed).png');assert.equal(m.mask.name,'mask (renamed).png');assert.equal(m.canvas.subfolder,m.mask.subfolder);
 assert.equal(f.messages.filter(x=>x.type==='result').length,1);assert.ok(f.calls.filter(x=>x.url.startsWith('/view?')).every(x=>!x.url.includes('foreign')));
 assert.ok(f.calls.every(x=>!x.url.startsWith('/ps/team')));
});
test('second image upload failure never queues',async()=>{
 const f=fixture({secondFails:true});await f.hello();await f.generate();assert.equal(f.uploads.length,2);assert.equal(f.posts.length,0);assert.ok(f.messages.some(x=>x.type==='error'));
});
test('unknown submit response never retries generation, including duplicate generate and reload',async()=>{
 const f=fixture({submitUnknown:true});await f.hello();await f.generate();await f.generate();assert.equal(f.posts.length,1);assert.ok(f.messages.some(x=>x.error?.includes('unknown')));
 const g=fixture({storage:f.storage});await g.hello();await g.generate();assert.equal(g.posts.length,0);assert.ok(g.messages.some(x=>x.error?.includes('unknown')));
});
test('history terminal error is visible and never retried',async()=>{
 const f=fixture({historyError:true});await f.hello();await f.generate();assert.ok(f.messages.some(x=>x.error?.includes('test node failed')));assert.equal(f.timers.filter(x=>x.active).length,0);assert.equal(f.posts.length,1);
});
test('per-image ACK and 502 retry resume only unacknowledged results without generation',async()=>{
 const f=fixture({results:2});await f.hello();await f.generate();assert.equal(f.messages.filter(x=>x.type==='result').length,2);
 await f.receive({type:'ack',request_id:f.rid,index:0});const before=f.messages.length;await f.tick();assert.deepEqual(f.messages.slice(before).filter(x=>x.type==='result').map(x=>x.index),[1]);
 await f.receive({type:'ack',request_id:f.rid,index:1});assert.equal(f.timers.filter(x=>x.active).length,0);assert.equal(f.posts.length,1);
 const g=fixture({failView:1});await g.hello();await g.generate();assert.equal(g.messages.filter(x=>x.type==='result').length,0);await g.tick();assert.equal(g.messages.filter(x=>x.type==='result').length,1);assert.equal(g.posts.length,1);
});
test('page reload restores request-to-prompt mapping and never reposts',async()=>{
 const f=fixture({results:2});await f.hello();await f.generate();await f.receive({type:'ack',request_id:f.rid,index:0});
 const g=fixture({storage:f.storage,metadata:f.metadata(),results:2});await g.hello();await g.generate();assert.equal(g.posts.length,0);assert.deepEqual(g.messages.filter(x=>x.type==='result').map(x=>x.index),[1]);
});
test('account change clears binding and blocks result retrieval',async()=>{
 const f=fixture();await f.hello();await f.generate();const previous=f.calls.filter(x=>x.url.startsWith('/view?')).length;
 f.username('bob');await f.tick();assert.ok(f.messages.some(x=>x.type==='unbound'));assert.equal(f.calls.filter(x=>x.url.startsWith('/view?')).length,previous);assert.equal(f.storage.size,0);
});

test('more than 64 completed requests remain deduplicated and allow new work after reload',async()=>{
 const f=fixture();await f.hello();
 for(let i=1;i<=70;i++){const rid=i.toString(16).padStart(32,'0');await f.generate(rid);await f.receive({type:'ack',request_id:rid,index:0});}
 assert.equal(f.posts.length,70);assert.equal(f.timers.filter(x=>x.active).length,0);
 await f.generate('1'.padStart(32,'0'));assert.equal(f.posts.length,70);
 const g=fixture({storage:f.storage});await g.hello();await g.generate('1'.padStart(32,'0'));assert.equal(g.posts.length,0);
 await g.generate();assert.equal(g.posts.length,1);
});
test('64 unfinished requests retain the limit across reload without losing unknown submissions',async()=>{
 const f=fixture({submitUnknown:true});await f.hello();
 for(let i=1;i<=65;i++)await f.generate(i.toString(16).padStart(32,'0'));
 assert.equal(f.posts.length,64);
 const g=fixture({storage:f.storage});await g.hello();await g.generate();assert.equal(g.posts.length,0);
 assert.ok(g.messages.some(x=>x.error?.includes('unfinished')));
});
for(const status of ['error','cancelled','retry_exhausted'])test('missing history stops polling for scheduler '+status,async()=>{
 const f=fixture({historyMissing:404,job:{status:status==='cancelled'?'cancelled':'failed',scheduler_status:status,error:'dispatch failed'}});
 await f.hello();await f.generate();assert.equal(f.timers.filter(x=>x.active).length,0);assert.ok(f.messages.some(x=>x.error?.includes(status)));
 await f.generate();assert.equal(f.posts.length,1);assert.equal(f.calls.filter(x=>x.url==='/jobs/prompt-id').length,1);
});
test('monitor timeout remains unknown and resumes reads without resubmission',async()=>{
 const f=fixture({historyMissing:404,job:{status:'failed',scheduler_status:'monitor_timeout'}});await f.hello();await f.generate();
 assert.ok(f.messages.some(x=>x.error?.includes('status is unknown')));assert.equal(f.timers.filter(x=>x.active).length,0);
 const g=fixture({storage:f.storage,metadata:f.metadata()});await g.hello();await g.generate();
 assert.equal(g.posts.length,0);assert.equal(g.messages.filter(x=>x.type==='result').length,1);
});
for(const opts of [{historyMissing:404},{historyMissing:200},{historyMissing:404,jobHTTP:404}])test('queued or temporarily absent history keeps polling without repost',async()=>{
 const f=fixture(opts);await f.hello();await f.generate();assert.equal(f.timers.filter(x=>x.active).length,1);await f.tick();assert.equal(f.posts.length,1);
});
test('malformed persisted mapping blocks binding instead of silently risking a duplicate submit',async()=>{
 const f=fixture({submitUnknown:true});await f.hello();await f.generate();
 const key=[...f.storage.keys()][0],saved=JSON.parse(f.storage.get(key));saved.records[0].state='bogus';f.storage.set(key,JSON.stringify(saved));
 const g=fixture({storage:f.storage});await g.hello();await g.generate();assert.equal(g.posts.length,0);assert.equal(vm.runInContext('teamMode',g.context),false);
 assert.ok(g.messages.some(x=>x.error?.includes('mapping is invalid')));
});
test('unbind revokes both preview object URLs',async()=>{
 const f=fixture();const revoked=[];f.context.URL=class extends URL {static revokeObjectURL(url){revoked.push(url);URL.revokeObjectURL(url)}};
 await f.hello();await f.generate();const urls=vm.runInContext('[teamPreview.canvas,teamPreview.mask]',f.context);
 await f.receive({type:'unbind'});assert.deepEqual(revoked,Array.from(urls));
});
test('local UXP keeps legacy websocket, reconnect and preview for every loopback host',async()=>{
 const connection=fs.readFileSync(path.join(root,'js/connection.js'),'utf8').replace(/^import.*\n/,'').replace(/export \{[^}]+\};/g,'');
 const nodeStyle=fs.readFileSync(path.join(root,'js/nodestyle.js'),'utf8');
 const preview=nodeStyle.slice(nodeStyle.indexOf('async function previewonthenode'),nodeStyle.indexOf('function drawUpdateText'));
 for(const hostname of ['localhost','127.0.0.1','[::1]','same.test']){
  const f=fixture({hostname}),sockets=[],previews=[];
  class Socket {constructor(url){this.url=url;this.events={};sockets.push(this)}addEventListener(n,cb){this.events[n]=cb}close(){this.events.close?.({})}}
  Object.assign(f.context,{WebSocket:Socket,console:{log(){},warn(){},error(){}},setBackgroundImageContain:(...args)=>previews.push(args)});
  f.context.window.location={protocol:'http:',host:hostname+':8188'};
  vm.runInContext(connection+'\nconnect();'+preview,f.context);
  await f.hello();await vm.runInContext('previewonthenode({})',f.context);
  const local=hostname!=='same.test';assert.equal(sockets.length,local?1:0,hostname);
  if(local){assert.match(sockets[0].url,/\/ps\/ws\?platform=cm/);assert.match(previews[0][1],/^\/ps\/inputs\/PS_canvas/);
   assert.equal(f.calls.length,0);sockets[0].close();await f.tick();assert.equal(sockets.length,2);}
  else assert.equal(previews[0][1],null);
 }
});

test('preview toggle uses current URLs in local and remote UXP without removed globals',async()=>{
 const source=fs.readFileSync(path.join(root,'js/nodestyle.js'),'utf8');
 const preview=source.slice(source.indexOf('async function previewonthenode'),source.indexOf('function drawUpdateText'));
 const props=source.slice(source.indexOf('function createWatchedObject'),source.indexOf('function addRemoveButtons'));
 for(const hostname of ['localhost','same.test']){
  const f=fixture({hostname}),calls=[];f.context.setBackgroundImageContain=(...args)=>calls.push(args);f.context.console={log(){}};
  vm.runInContext(preview+props+';globalThis.node={};addBooleanProperty(node);',f.context);
  await f.hello();if(hostname==='same.test')await f.generate();
  vm.runInContext('node.properties["Disable Preview"]=true',f.context);await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,1);assert.match(calls[0][1],hostname==='localhost'?/^\/ps\/inputs\//:/^blob:/);
 }
});

test('Windows SaveImage history downloads canonical paths and acknowledges each image',async()=>{
 const f=fixture({results:2,outputFolder:sid=>'ps_plugin\\'+sid});await f.hello();await f.generate();
 const results=f.messages.filter(x=>x.type==='result');assert.equal(results.length,2);
 for(const call of f.calls.filter(x=>x.url.startsWith('/view?'))){
  const q=new URL(call.url,'https://same.test').searchParams;
  assert.deepEqual([...q.keys()].sort(),['filename','subfolder','type']);
  assert.equal(q.get('subfolder'),'ps_plugin/'+f.metadata().snapshot_id);
 }
 for(const result of results)await f.receive({type:'ack',request_id:f.rid,index:result.index});
 assert.equal(f.timers.filter(x=>x.active).length,0);await f.generate();assert.equal(f.posts.length,1);
});
for(const folder of [sid=>'../ps_plugin/'+sid,sid=>'ps_plugin\\..\\ps_plugin/'+sid,
 sid=>'/ps_plugin/'+sid,sid=>'C:\\ps_plugin\\'+sid,sid=>'\\\\server\\ps_plugin\\'+sid,
 sid=>'ps_plugin/'+sid+'/../'+sid,sid=>'ps_plugin\\'+'0'.repeat(32),sid=>'ps_plugin//'+sid]){
 test('history rejects absolute, traversal, UNC or different snapshot paths after separator normalization',async()=>{
  const f=fixture({outputFolder:folder});await f.hello();await f.generate();assert.equal(f.messages.filter(x=>x.type==='result').length,0);
  assert.equal(f.calls.filter(x=>x.url.startsWith('/view?')).length,0);assert.ok(f.messages.some(x=>x.error?.includes('Unexpected output path')));
 });
}
