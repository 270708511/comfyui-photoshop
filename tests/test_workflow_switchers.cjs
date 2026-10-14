const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/workflow-switchers.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(source.replace('export function', 'function'), ctx);
function fixture() {
  let graph = {_nodes: []}; const sent = new Map();
  const controller = ctx.createWorkflowSwitchers({graph: () => graph, send: (type, items) => sent.set(type, items)});
  return {controller, sent, get graph(){return graph;}, switchGraph(value){graph=value;controller.invalidate();}};
}
function node(id, color, names = ['A','B']) {
  const n = {id, comfyClass:'Fast Groups Muter (rgthree)', color, properties:{}, widgets:[]};
  n.widgets = names.map((name,index)=>({name:'Enable '+name,groupKey:name,value:{toggled:index===0},doModeChange(force){
    const next=force === undefined ? !this.value.toggled : force;
    if(n.properties.exclusive&&next)n.widgets.forEach(w=>w.value.toggled=false);
    this.value.toggled=next;
  }}));
  return n;
}
test('both screenshot roles publish labels and independent checked states; use actual doModeChange',()=>{
  const f=fixture(),a=node(1,'#2b4557'),b=node(2,'#4e5e4e');f.graph._nodes=[a,b];f.controller.refresh();
  const rows=f.sent.get('Send_workflow');assert.equal(rows[0].name,'A');assert.equal(rows[0].selected,true);
  assert.equal(f.sent.get('Send_rndrMode')[0].name,'A');
  assert.equal(f.controller.toggle('workflow',rows[1].id),true);assert.equal(a.widgets[1].value.toggled,true);
  assert.equal(f.sent.get('Send_workflow')[1].selected,true);
});
test('single selection updates underlying muter state',()=>{
  const f=fixture(),a=node(1,'#2b4557');a.properties.exclusive=true;f.graph._nodes=[a];f.controller.refresh();
  f.controller.toggle('workflow',f.sent.get('Send_workflow')[1].id);
  assert.equal(a.widgets[0].value.toggled,false);assert.equal(a.widgets[1].value.toggled,true);
});
test('same graph object reloaded with reused IDs rejects old selection',()=>{
  const f=fixture(),a=node(1,'#2b4557');f.graph._nodes=[a];f.controller.refresh();const old=f.sent.get('Send_workflow')[0].id;
  const b=node(1,'#2b4557');f.graph._nodes=[b];f.controller.invalidate();assert.equal(f.controller.toggle('workflow',old),false);
  assert.equal(b.widgets[0].value.toggled,true);
});
test('dynamic widgets initialize, reorder and delete without targeting another group',()=>{
  const f=fixture(),a=node(1,'#2b4557',[]);f.graph._nodes=[a];f.controller.refresh();assert.match(f.sent.get('Send_workflow')[0].name,/初始化/);
  a.widgets=node(1,'#2b4557').widgets;f.controller.refresh();const old=f.sent.get('Send_workflow')[0].id;
  a.widgets.reverse();assert.equal(f.controller.toggle('workflow',old),false);
  f.graph._nodes=[];f.controller.refresh();assert.match(f.sent.get('Send_workflow')[0].name,/未配置/);
});
test('ambiguous colours report conflict and explicit role takes precedence',()=>{
  const f=fixture(),a=node(1,'#2b4557'),b=node(2,'#2b4557');f.graph._nodes=[a,b];f.controller.refresh();
  assert.equal(f.sent.get('Send_workflow')[0].disabled,true);assert.match(f.sent.get('Send_workflow')[0].name,/多个/);
  b.properties.psSwitcherRole='workflow';f.controller.invalidate();const rows=f.sent.get('Send_workflow');
  assert.equal(rows[0].disabled,undefined);f.controller.toggle('workflow',rows[0].id);assert.equal(b.widgets[0].value.toggled,true);assert.equal(a.widgets[0].value.toggled,true);
});
test('reconnect sends unchanged lists and legacy callback receives boolean toggle',()=>{
  const f=fixture(),a=node(1,'#2b4557');let next;a.widgets=[{name:'Enable old',value:false,callback(value){next=value;this.value=value;}}];
  f.graph._nodes=[a];f.controller.refresh();const id=f.sent.get('Send_workflow')[0].id;f.sent.clear();f.controller.refresh(true);
  assert.equal(f.sent.get('Send_workflow')[0].id,id);f.controller.toggle('workflow',id);assert.equal(next,true);
});

test('shipped Preset dropdown reads live option.selected, including no selected item',()=>{
  const bundle=fs.readFileSync(path.join(__dirname,'../ComfyUI Photoshop Team/dist/assets/index-B_-tWO9a.js'),'utf8');
  const start=bundle.indexOf('function jg('),end=bundle.indexOf('class qi',start);
  let mounted,observed,values;const queue=[];
  const context=vm.createContext({js:()=>()=>{},Q:queue,yt:fn=>mounted=fn,
    MutationObserver:class{constructor(fn){observed=fn}observe(){}disconnect(){}},
    document:{addEventListener(){},removeEventListener(){},querySelectorAll:()=>[]}});
  vm.runInContext(bundle.slice(start,end),context);
  values=context.jg({}, {}, (index,value)=>values[index]=value);
  let options=[{id:'one',textContent:'first',selected:false,hasAttribute:()=>false},
    {id:'two',textContent:'second',selected:true,hasAttribute:()=>false}];
  values[11]({querySelectorAll:()=>options});queue.forEach(fn=>fn());mounted();
  assert.equal(values[2],'two');assert.match(values[0],/second/);
  options=[];observed();assert.equal(values[2],null);assert.match(values[0],/未配置/);
});

test('single selection clears all initially enabled branches and repeat selection stays enabled',()=>{
 const f=fixture(),a=node(1290,'#2b4557',['图生图','文生图','TILE']),b=node(1292,'#353',['风格1','风格2']);
 a.widgets.forEach(widget=>widget.value.toggled=true);f.graph._nodes=[a,b];f.controller.refresh();
 const group=f.sent.get('Send_switcherGroups').groups[0],id=group.items[1].id;
 assert.equal(f.controller.toggle(group.id,id),true);
 assert.deepEqual(a.widgets.map(widget=>widget.value.toggled),[false,true,false]);
 assert.equal(b.widgets[0].value.toggled,true);assert.equal(f.controller.toggle(group.id,id),true);
 assert.deepEqual(a.widgets.map(widget=>widget.value.toggled),[false,true,false]);
});
test('single selection survives rgthree replacing widgets during a mode change',()=>{
 const f=fixture(),a=node(1,'#2b4557',['A','B','C']);
 function make(name,value){return {name:'Enable '+name,groupKey:name,value:{toggled:value},doModeChange(force,skip){
  assert.equal(skip,true);const current=a.widgets.find(widget=>widget.groupKey===name);current.value.toggled=force;
  a.widgets=a.widgets.map(widget=>make(widget.groupKey,widget.value.toggled));
 }}}
 a.widgets=['A','B','C'].map(name=>make(name,true));f.graph._nodes=[a];f.controller.refresh();
 const group=f.sent.get('Send_switcherGroups').groups[0];assert.equal(f.controller.toggle(group.id,group.items[1].id),true);
 assert.deepEqual(a.widgets.map(widget=>widget.value.toggled),[false,true,false]);
});
