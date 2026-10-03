// Real loopback HTTP + Python adapter/auth; mocked ComfyUI/GPU and Node cookie jar.
// This is NOT evidence of UXP/macOS cookies, Photoshop insertion, or actual GPU execution.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),server=process.env.PS_NATIVE_SERVER_ROOT||path.join(root,'comfyui-server');
const code=fs.readFileSync(path.join(__dirname,'../ComfyUI Photoshop Team/dist/ps-native-transport.js'),'utf8');
async function start(){const child=spawn('python3',[path.join(server,'tests/native_http_fixture.py')],{cwd:server,env:{...process.env,PYTHONPATH:server+path.delimiter+path.join(root,'test-deps')},stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',x=>logs+=x);const origin=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('fixture startup timed out')),10000);child.stdout.on('data',x=>{out+=x;const line=out.split('\n')[0];try{const v=JSON.parse(line);clearTimeout(timer);resolve(v.origin)}catch{}});child.on('exit',()=>{clearTimeout(timer);reject(Error('fixture failed: '+logs))})});return{child,origin};}
function jarFetch(){let cookies={};return async function request(url,options={}){for(let n=0;n<5;n++){const headers=new Headers(options.headers||{});const cookie=Object.entries(cookies).map(([k,v])=>k+'='+v).join('; ');if(cookie)headers.set('Cookie',cookie);const res=await fetch(url,{...options,headers,redirect:'manual'});for(const line of res.headers.getSetCookie()){const pair=line.split(';')[0],i=pair.indexOf('=');cookies[pair.slice(0,i)]=pair.slice(i+1);if(!pair.slice(i+1)||/max-age=0/i.test(line))delete cookies[pair.slice(0,i)];}if([301,302,303].includes(res.status)){const next=new URL(res.headers.get('Location'),url);assert.equal(next.origin,new URL(url).origin);url=next.href;options={method:'GET'};continue;}return res;}throw Error('redirect limit');};}
async function until(fn,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('condition timed out');}
test('native controller uses real adapter login/workspace/preparation/immutable submit/results/ACK over loopback',{timeout:30000,skip:!fs.existsSync(path.join(server,'tests/native_http_fixture.py'))},async t=>{
 const fixture=await start();t.after(()=>fixture.child.kill('SIGTERM'));const request=jarFetch();
 await until(async()=>{try{await fetch(fixture.origin+'/health');return true}catch{return false}});
 const ctx={setTimeout,clearTimeout,Uint8Array,ArrayBuffer};vm.createContext(ctx);vm.runInContext(code,ctx);let saved=null;const emitted=[];
 const controller=ctx.createPSNativeTransport({fetch:request,load:async()=>saved,save:async s=>saved=JSON.parse(JSON.stringify(s)),emit:m=>emitted.push(m)});t.after(()=>controller.dispose());
 assert.equal(await controller.connect(fixture.origin),false);
 const hello={protocol:'ps-team-1',transport:'company',panel:'panel-http',type:'hello',session_ids:[]};await controller.receive(hello);
 assert.equal(await controller.login('alice','dummy-only-password'),true);
 assert.equal(controller.getState().workspaces.length,2);
 await until(()=>controller.getState().ready);const sid=controller.getState().session_id;
 const url=fixture.origin+'/ps/team/workflow-preparations?workspace_id=workspace-a&path=workflows%2Fnested%2Fsample.json';
 let prep=await(await request(url)).json();assert.equal(prep.status,'unprepared');
 const graph={nodes:[{id:1,type:'Sampler'}],links:[],revision:1};const prompt={'1':{class_type:'🔹Photoshop ComfyUI Plugin',inputs:{}},'2':{class_type:'🔹SendTo Photoshop Plugin',inputs:{output:['1',0]}}};
 const prepared=await request(url,{method:'PUT',headers:{'Content-Type':'application/json','X-PS-Team':'ps-team-1'},body:JSON.stringify({source_hash:prep.current_source_hash,api_prompt:prompt,workflow:graph,parameters:[]})});assert.equal(prepared.status,200);
 await controller.selectWorkspace('workspace-a');await controller.selectWorkflow('workflows/nested/sample.json');assert.equal(controller.getState().canGenerate,true,JSON.stringify(controller.getState()));
 const payload=await(await request(fixture.origin+'/__fixture/input')).json();const rid='e'.repeat(32);const message={...hello,type:'generate',session_id:sid,request_id:rid,selection_version:controller.getState().selectionVersion,payload};
 assert.equal(await controller.receive(message),true);await controller.receive(message);
 const complete=await(await request(fixture.origin+'/__fixture/complete',{method:'POST'})).json();assert.equal(complete.dispatches,1);
 await controller.receive({...hello,type:'resume',session_id:sid,requests:[rid]});await until(()=>emitted.filter(x=>x.type==='result').length>=2);
 for(const i of [0,1]){await controller.receive({...hello,type:'received',session_id:sid,request_id:rid,index:i});await controller.receive({...hello,type:'ack',session_id:sid,request_id:rid,index:i});}
 await until(()=>emitted.filter(x=>x.type==='acknowledged').length>=2);
 assert(!JSON.stringify(saved).includes('dummy-only-password'));assert.equal(saved.sessions[0].account,'alice');
 const bob=jarFetch();await bob(fixture.origin+'/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'username=bob&password=dummy-only-password&next=%2Fauth%2Fwhoami'});const forbidden=await bob(fixture.origin+'/ps/team/sessions/'+sid+'/requests/'+rid);assert.equal(forbidden.status,404);
});
