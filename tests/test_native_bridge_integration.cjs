const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../ComfyUI Photoshop Team/dist');
const source=fs.readFileSync(path.join(root,'ps-team-bridge.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
async function fixture(){
 const events={},sent=[],statuses=[],previews=[],saved=[],viewEvents={};let url='http://company.test', creations=0;let hooks,peer,state={authenticated:true,username:'a',canGenerate:true,selectionVersion:1},doc={id:7};
 const view={addEventListener:(n,cb)=>viewEvents[n]=cb,postMessage:()=>{throw Error('native must not post to WebView')}};
 const ctx={setInterval(){},window:{addEventListener:(n,cb)=>events[n]=cb},document:{querySelector:()=>null},createPSNativeTransport:h=>{creations++;hooks=h;peer={connect:async()=>h.onState(state),receive:async m=>{sent.push(m);if(m.type==='hello')h.emit({...m,type:'ready',session_id:'s',account_id:'a'});},dispose(){},disconnect(){state={...state,authenticated:false,canGenerate:false};h.onState(state);},getState:()=>state};return peer;}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 const bridge=ctx.createPSTeamBridge({url:()=>url,status:(...a)=>statuses.push(a),control(){},document:()=>doc,canvas:async()=> 'canvas',mask:async()=> 'mask',bounds:()=>null,setBounds(){},activate:async id=>doc={id},preview:async s=>previews.push(s),save:async s=>saved.push(s)});
 await bridge.connect('http://company.test');await tick();await tick();
 function emit(m){const hello=sent.find(m=>m.type==='hello');hooks.emit({...hello,session_id:'s',...m});}
 return{bridge,sent,statuses,previews,saved,view,events,emit,setState:s=>{state={...state,...s};hooks.onState(state)},hooks:()=>hooks,setURL:value=>{url=value},creations:()=>creations};
}
test('native company capture and original result insertion work without any WebView',async()=>{
 const f=await fixture();assert(f.statuses.some(x=>x[0]==='Connected'));await f.bridge.capture(async()=>({seed:4}));
 const req=f.sent.find(m=>m.type==='generate');assert(req);assert.equal(req.payload.document_id,'7');
 f.emit({type:'result',request_id:req.request_id,index:0,result_count:1,image:'base64'});await tick();await tick();assert.deepEqual(f.previews,['base64']);
 assert.equal((await f.bridge.beforeInsert()).documentID,7);await f.bridge.afterInsert(true);assert(f.sent.some(m=>m.type==='ack'&&m.request_id===req.request_id));
});
test('window postMessage cannot impersonate the private native transport',async()=>{
 const f=await fixture();const hello=f.sent[0];await f.events.message({source:f.view,origin:'http://company.test',data:{...hello,type:'unbound'}});
 await f.bridge.capture(async()=>({seed:1}));assert(f.sent.some(m=>m.type==='generate'));
});
test('workflow selection changed during export prevents a native request',async()=>{
 const f=await fixture();await f.bridge.capture(async()=>{f.setState({selectionVersion:2});return{seed:1}});
 assert.equal(f.sent.filter(m=>m.type==='generate').length,0);assert(f.statuses.some(x=>x[0].includes('changed')));
});
test('unprepared native workflow blocks image capture and generation',async()=>{
 const f=await fixture();f.setState({canGenerate:false});await f.bridge.capture(async()=>({}));assert.equal(f.sent.filter(m=>m.type==='generate').length,0);assert(f.statuses.some(x=>x[0].includes('prepared workflow')));
});
test('native optional editor watch cannot become the data channel',async()=>{
 const f=await fixture();f.bridge.watchView(f.view);await f.bridge.capture(async()=>({}));assert(f.sent.some(m=>m.type==='generate'));
});
test('runtime declares native scripts before bridge and preserves optional standalone navigation',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');assert(html.indexOf('/ps-native-transport.js')<html.indexOf('/ps-team-bridge.js'));assert(html.indexOf('/ps-native-panel.js')<html.indexOf('/assets/index-'));
 const bundle=fs.readFileSync(path.join(root,'assets/index-B_-tWO9a.js'),'utf8');assert(bundle.includes('if(!explicit&&psTeam().nativeEnabled(w))return false;'));assert(bundle.includes('psNativePanel.validate()'));assert(bundle.includes('globalThis.psNativeGenerate=k'));
});

test('unapplied server text cannot bypass native insertion ownership',async()=>{
 const f=await fixture();await f.bridge.capture(async()=>({seed:1}));const req=f.sent.find(m=>m.type==='generate');
 f.emit({type:'result',request_id:req.request_id,index:0,result_count:1,image:'native'});await tick();await tick();
 f.setURL('http://127.0.0.1:8188');assert.equal(f.bridge.enabled(),true);assert.equal((await f.bridge.beforeInsert()).documentID,7);await f.bridge.afterInsert(false);
});
test('switching company to explicit standalone and back keeps the mounted controller instance',async()=>{
 const f=await fixture(),peer=f.bridge.getNativeTransport();await f.bridge.connect('http://company.test/?ps_transport=standalone');
 assert.equal(f.bridge.getNativeTransport(),peer);f.setState({authenticated:true,canGenerate:true,selectionVersion:2});
 await f.bridge.connect('http://company.test');await tick();await tick();assert.equal(f.bridge.getNativeTransport(),peer);assert.equal(f.creations(),1);
});
test('applied local switch detaches company state and does not send new native requests',async()=>{
 const f=await fixture();await f.bridge.disconnectLocal('http://127.0.0.1:8188');assert.equal(f.bridge.enabled(),false);assert.equal(await f.bridge.beforeInsert(),null);
 assert.equal(f.bridge.getNativeTransport(),f.bridge.getNativeTransport());
});
test('compiled transition funnels native Connect through socket teardown and guards preview provenance',()=>{
 const bundle=fs.readFileSync(path.join(root,'assets/index-B_-tWO9a.js'),'utf8');
 assert(bundle.includes('onConnect:()=>psApplyConnection(Qe(rt))'));assert(bundle.includes('await psTeam().disconnectLocal(i);if(transition!==psConnectionAttempt)return false;await Ta();'));
 assert(bundle.includes('if(psTeam().enabled()||i.target&&i.target!==Pe)return'));
 assert(bundle.includes('!psTeam().enabled()&&!psLegacyPreviewReady'));
 assert(!bundle.includes('O(P, "src", "http://127.0.0.1:8188")'));assert(bundle.includes('onOpenEditor:()=>psOpenConnectionEditor()'));
});

test('new company connection wins over older pending local disconnect',async()=>{
 const f=await fixture();const old=f.bridge.disconnectLocal('http://127.0.0.1:8188');const current=f.bridge.connect('http://company.test');await Promise.all([old,current]);await tick();await tick();assert.equal(f.bridge.enabled(),true);assert.equal(f.bridge.nativeEnabled(),true);
});
test('new local disconnect wins over older pending company connection',async()=>{
 const f=await fixture();const old=f.bridge.connect('http://other.test');const current=f.bridge.disconnectLocal('http://127.0.0.1:8188');await Promise.all([old,current]);assert.equal(f.bridge.enabled(),false);assert.equal(f.bridge.nativeEnabled(),false);
});

test('native connection status leaves Connecting after failure and shows only safe diagnostic fields',async()=>{
 const f=await fixture();
 f.setState({authenticated:false,ready:false,status:'login_required',error:'password=private https://bad.test/?token=secret',diagnostic:{stage:'check_session',code:'network_error',http_status:null}});
 assert.deepEqual(f.statuses.at(-1),['Native connection failed [check_session: network_error]','darkred']);
 f.setState({status:'signing_in',error:null,diagnostic:null});
 assert.deepEqual(f.statuses.at(-1),['Signing in through native connection','orange']);
 f.setState({status:'login_required',error:'not signed in',diagnostic:{stage:'check_session',code:'unauthorized',http_status:401}});
 assert.deepEqual(f.statuses.at(-1),['Sign in through the native panel','orange']);
 assert(!JSON.stringify(f.statuses).includes('private'));
});
