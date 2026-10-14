const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const root=require('node:path').resolve(__dirname, '..');
test('dynamic groups include any colour, skip empty and reject reloaded graph targets',()=>{
 const sent=new Map(); let graph={_nodes:[]}; const ctx=vm.createContext({});
 vm.runInContext(fs.readFileSync(root+'/js/workflow-switchers.js','utf8').replace('export function','function'),ctx);
 const control=ctx.createWorkflowSwitchers({graph:()=>graph,send:(key,data)=>sent.set(key,data)});
 const node=(id,empty=false)=>({id,title:'禁用多框',type:'Fast Groups Muter (rgthree)',color:'#353',widgets:empty?[]:[{name:'Enable A',groupKey:'A',value:{toggled:false},doModeChange(){this.value.toggled=true;}}]});
 graph._nodes=[node(1),node(2),node(3,true),node(4)];control.refresh();
 const groups=sent.get('Send_switcherGroups').groups;assert.equal(groups.length,3);
 assert.equal(control.toggle(groups[1].id,groups[1].items[0].id),true);assert.equal(graph._nodes[1].widgets[0].value.toggled,true);
 assert.equal(graph._nodes[0].widgets[0].value.toggled,false);
 graph={_nodes:[node(2)]};control.invalidate();assert.equal(control.toggle(groups[1].id,groups[1].items[0].id),false);
});
function ui() {
 class Element {constructor(tag){this.tag=tag;this.children=[];this.events={};this.style={};this.text='';}set textContent(value){this.text=value;this.children=[];}get textContent(){return this.text;}appendChild(child){this.children.push(child);}addEventListener(type,fn){this.events[type]=fn;}}
 const timers=new Map();let count=0;
 const ctx=vm.createContext({document:{createElement:tag=>new Element(tag)},setTimeout:fn=>{timers.set(++count,fn);return count;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(fs.readFileSync(root+'/ComfyUI Photoshop Team/dist/ps-workflow-controls.js','utf8'),ctx);
 const container=new Element('div'), sent=[], confirms=[];
 const controls=ctx.PSWorkflowControls;
 controls.mount(container,payload=>sent.push(payload),()=>confirms.push(true));
 return {controls,container,sent,confirms,timers};
}
test('shipped dynamic UI waits for confirmed state; renders three groups and no empty placeholder',()=>{
 const f=ui(); const groups=[1,2,3].map(id=>({id:'g'+id,name:'组'+id,items:[{id:'a'+id,name:'A',selected:true},{id:'b'+id,name:'B',selected:false}]}));
 f.controls.update({groups});assert.equal(f.container.children.length,3);
 f.container.children[0].children[0].events.click();f.container.children[0].children[2].events.click();
 assert.match(f.container.children[0].children[0].textContent,/✓ A/);assert.equal(f.sent.length,1);assert.equal(f.confirms.length,0);
 f.controls.result({request_id:'wrong',applied:true});assert.equal(f.confirms.length,0);
 groups[0].items[0].selected=false;groups[0].items[1].selected=true;f.controls.update({groups});
 f.controls.result({request_id:f.sent[0].request_id,applied:true});assert.equal(f.confirms.length,1);assert.match(f.container.children[0].children[0].textContent,/✓ B/);
 f.controls.update({groups:[],status:'未连接'});assert.equal(f.container.children.length,1);assert.equal(f.container.children[0].textContent,'未连接');
});
test('rejection and timeout never optimistically select another item',()=>{
 const f=ui();f.controls.update({groups:[{id:'g',name:'组',items:[{id:'a',name:'A',selected:true},{id:'b',name:'B',selected:false}]}]});
 f.container.children[0].children[0].events.click();f.container.children[0].children[2].events.click();
 f.controls.result({request_id:f.sent[0].request_id,applied:false});assert.match(f.container.children[0].children[0].textContent,/✓ A/);assert.match(f.container.children[1].textContent,/未生效/);
 f.container.children[0].children[2].events.click();for(const callback of f.timers.values())callback();
 assert.match(f.container.children[1].textContent,/未收到/);assert.equal(f.confirms.length,0);
});
