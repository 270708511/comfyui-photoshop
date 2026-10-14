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
 class Element {constructor(){this.children=[];this.textContent='';}get firstChild(){return this.children[0]||null;}appendChild(el){el.remove();this.children.push(el);el.parent=this;}insertBefore(el,anchor){el.remove();const index=this.children.indexOf(anchor);this.children.splice(index<0?this.children.length:index,0,el);el.parent=this;}remove(){if(this.parent){this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}}}
 const timers=new Map();let counter=0;const widgets=[],sent=[],confirmed=[];
 const ctx=vm.createContext({document:{createElement:()=>new Element()},setTimeout:fn=>{timers.set(++counter,fn);return counter;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(fs.readFileSync(root+'/ComfyUI Photoshop Team/dist/ps-workflow-controls.js','utf8'),ctx);
 const controls=ctx.PSWorkflowControls,container=new Element();
 controls.mount(container,payload=>sent.push(payload),()=>confirmed.push(true),(host,prefix,items,change)=>{
  const header=new Element();host.appendChild(header);const widget={host,header,prefix,items,change,destroyed:false,update(rows){this.items=rows;},destroy(){this.destroyed=true;header.remove();}};widgets.push(widget);return widget;
 });
 return {controls,container,widgets,sent,confirmed,timers};
}
test('dynamic groups use original dropdown adapter with folder and gear icons, no added node titles',()=>{
 const f=ui(),groups=[1,2,3].map(id=>({id:'g'+id,name:'禁用多框 #'+id,items:[{id:'a'+id,name:'A',selected:true},{id:'b'+id,name:'B',selected:false}]}));
 f.controls.update({groups});assert.equal(f.widgets.length,3);assert.equal(f.widgets[0].prefix,'📂');assert.equal(f.widgets[1].prefix,'⚙️');assert.equal(f.container.children.length,3);assert.ok(f.widgets.every(widget=>widget.host===f.container && widget.header.parent===f.container));
 f.widgets[0].change('b1');assert.equal(f.sent.length,1);assert.equal(f.widgets[0].items[0].selected,true);assert.equal(f.confirmed.length,0);
 f.controls.result({request_id:'wrong',applied:true});assert.equal(f.confirmed.length,0);
 groups[0].items[0].selected=false;groups[0].items[1].selected=true;f.controls.update({groups});f.controls.result({request_id:f.sent[0].request_id,applied:true});assert.equal(f.confirmed.length,1);
 f.controls.update({groups:[],status:'未连接'});assert.ok(f.widgets.every(widget=>widget.destroyed));assert.equal(f.container.children.length,1);assert.equal(f.container.children[0].textContent,'未连接');
});
test('rejection and timeout preserve acknowledged selection',()=>{
 const f=ui();f.controls.update({groups:[{id:'g',items:[{id:'a',name:'A',selected:true},{id:'b',name:'B',selected:false}]}]});f.widgets[0].change('b');
 f.controls.result({request_id:f.sent[0].request_id,applied:false});assert.equal(f.widgets[0].items[0].selected,true);assert.match(f.container.children[0].textContent,/未生效/);
 f.widgets[0].change('b');for(const callback of f.timers.values())callback();assert.match(f.container.children[0].textContent,/未收到/);assert.equal(f.confirmed.length,0);
});
test('Preset stays open when host emits mouseleave',()=>{
 const bundle=fs.readFileSync(root+'/ComfyUI Photoshop Team/dist/assets/index-B_-tWO9a.js','utf8');
 const start=bundle.indexOf('function Yg('),end=bundle.indexOf('class Jg',start);let opened=true;const events={};
 const panel={addEventListener:(type,fn)=>events[type]=fn};
 const ctx=vm.createContext({Y:()=>{},Yn:{set(value){opened=value;}},yt:fn=>fn(),kn:()=>{},Q:[],document:{querySelector:()=>panel}});
 vm.runInContext(bundle.slice(start,end),ctx);ctx.Yg({}, {}, ()=>{});events.mouseleave?.();assert.equal(opened,true);
});
test('original dropdown defers selected label to returned widget state',()=>{
 const bundle=fs.readFileSync(root+'/ComfyUI Photoshop Team/dist/assets/index-B_-tWO9a.js','utf8'),start=bundle.indexOf('function jg('),end=bundle.indexOf('class qi',start);
 let mounted,values;const queued=[],events=[];const ctx=vm.createContext({js:()=> (type,value)=>events.push({type,value}),Q:queued,yt:fn=>mounted=fn,MutationObserver:class{observe(){}disconnect(){}},document:{addEventListener(){},removeEventListener(){},querySelectorAll:()=>[]}});
 vm.runInContext(bundle.slice(start,end),ctx);values=ctx.jg({}, {deferSelection:true,prefix:'📂'},(index,value)=>values[index]=value);
 values[11]({querySelectorAll:()=>[{id:'a',textContent:'✓ A',selected:true,hasAttribute:()=>false}]});queued.forEach(fn=>fn());mounted();
 values[10]('B','b');assert.equal(values[2],'a');assert.match(values[0],/A/);assert.equal(events.find(event=>event.type==='change').value.id,'b');
});
