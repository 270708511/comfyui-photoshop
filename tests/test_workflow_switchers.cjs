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
  n.widgets = names.map((name,index)=>({name:'Enable '+name,groupKey:name,value:{toggled:index===0},doModeChange(){
    const next=!this.value.toggled;
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
test('node exclusivity is enforced by the node, not duplicated in plugin',()=>{
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
  assert.equal(rows[0].disabled,undefined);f.controller.toggle('workflow',rows[0].id);assert.equal(b.widgets[0].value.toggled,false);assert.equal(a.widgets[0].value.toggled,true);
});
test('reconnect sends unchanged lists and legacy callback receives boolean toggle',()=>{
  const f=fixture(),a=node(1,'#2b4557');let next;a.widgets=[{name:'Enable old',value:false,callback(value){next=value;this.value=value;}}];
  f.graph._nodes=[a];f.controller.refresh();const id=f.sent.get('Send_workflow')[0].id;f.sent.clear();f.controller.refresh(true);
  assert.equal(f.sent.get('Send_workflow')[0].id,id);f.controller.toggle('workflow',id);assert.equal(next,true);
});
