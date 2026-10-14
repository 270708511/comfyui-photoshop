const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../js/workflow-prompt.js'),'utf8').replace(/export /g,'');
function fixture(){const ctx=vm.createContext({});vm.runInContext(source,ctx);return ctx;}
const valid=()=>({output:{'1282':{class_type:'CLIPTextEncode',inputs:{clip:['loader',1]}},'782':{class_type:'KSampler',inputs:{model:['loader',0]}},'1017':{class_type:'VAEDecode',inputs:{vae:['loader',2]}}},workflow:{nodes:[]}});
test('UE API fills all screenshot inputs; raw graphToPrompt is never used',async()=>{
 const f=fixture();let raw=0,ue=0;const app={graph:{_nodes:[{type:'Anything Everywhere'}]},graphToPrompt:async()=>{raw++;return {output:{}};},ue_modified_prompt:async()=>{ue++;return valid();}};
 const result=await f.currentWorkflowPrompt(app);assert.deepEqual(result,valid());assert.equal(raw,0);assert.equal(ue,1);
});
test('missing UE initialization cannot fall back to incomplete raw prompt',async()=>{
 const f=fixture();let raw=0;await assert.rejects(f.currentWorkflowPrompt({graph:{_nodes:[{type:'Anything Everywhere'}]},graphToPrompt:async()=>{raw++;return valid();}}),/conversion is unavailable/);assert.equal(raw,0);
});
test('UE conversion with unresolved model inputs fails before any submission',async()=>{
 const f=fixture(),broken=valid();broken.output['1282'].inputs={};broken.output['782'].inputs={};broken.output['1017'].inputs={};
 await assert.rejects(f.currentWorkflowPrompt({graph:{_nodes:[{type:'Anything Everywhere'}]},ue_modified_prompt:async()=>broken}),error=>/1282.clip/.test(error.message)&&/782.model/.test(error.message)&&/1017.vae/.test(error.message));
});
test('web queue compatibility uses captured original once and cannot recurse or wrap twice',async()=>{
 const f=fixture();let raw=0;const original=async()=>{raw++;return valid();};
 const app={graphToPrompt:original,graph:{_nodes:[]}};assert.equal(f.installUEPromptCompatibility(app),false);
 app.ue_modified_prompt=async()=>original();assert.equal(f.installUEPromptCompatibility(app),true);const installed=app.graphToPrompt;
 assert.equal(f.installUEPromptCompatibility(app),false);assert.equal(app.graphToPrompt,installed);
 assert.deepEqual(await app.graphToPrompt(),valid());assert.equal(raw,1);
});
test('ordinary workflow converter retains application receiver',async()=>{
 const f=fixture(),app={graph:{_nodes:[]},graphToPrompt:async function(){assert.equal(this,app);return valid();}};assert.deepEqual(await f.currentWorkflowPrompt(app),valid());
});
