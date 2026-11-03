import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripVTControlCharacters as plain } from 'node:util';
import { piRoot } from '../scripts/tooling.mjs';
import { loadTypeScript } from './model-pick-loader.mjs';

// Standalone workspace-port fixture, not the shared picker harness or demo engine.
// The loader refuses any runtime FS/network import by the component.
const tui = await import(pathToFileURL(path.join(piRoot(), 'node_modules/@earendil-works/pi-tui/dist/index.js')));
const { PickerComponent } = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/component.ts', import.meta.url)), { '@earendil-works/pi-tui': tui });
const { SecretInput } = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/secret-input.ts', import.meta.url)), { '@earendil-works/pi-tui': tui });
const K = { up:'\x1b[A', down:'\x1b[B', left:'\x1b[D', right:'\x1b[C', enter:'\r', tab:'\t', backTab:'\x1b[Z', esc:'\x1b', save:'\x13', cancel:'\x03', clear:'\x15', pgdn:'\x1b[6~', pgup:'\x1b[5~', menu:'\x1bm' };
const alt = key => '\x1b' + key;
const ref = (provider='p0', id='m0') => ({ provider,id });
const params = () => ({ name:'模型',contextWindow:128000,maxTokens:8192,reasoning:true,input:['text','image'],thinkingLevelMap:{xhigh:'xhigh',max:'max'} });
const action = (id, overrides={}) => ({ id,identity:id,label:id,disabled:false,...overrides });
const task = (kind, overrides={}) => ({ kind,viewId:kind+'-one',flowId:'flow-one',reviewToken:kind+'-review',title:'真实任务数据',actions:[action('back',{digit:'0'}),action('cancel-task')],...overrides });
const baseRoot = () => {
  const providers = Array.from({length:3},(_,i)=>({id:'p'+i,name:'供应商'+i,endpoint:'https://example.test/v1',api:'openai-responses',readonly:i===2,
    models:Array.from({length:i===0?5:i===1?2:1},(_,j)=>({ref:ref('p'+i,'m'+j),name:['第一模型','Second','Third','Fourth','Fifth'][j],parameters:params(),favorite:false,readonly:i===2,availability:'ready'}))}));
  const ids=['switch','favorite','edit-model','inspect','default','move-left','move-right','add-model','remove-model','new-provider','archives','undo','locate','fast','provider-up','provider-down','edit-provider','remove-provider','cycle-palette'];
  return {kind:'matrix',viewId:'home',reviewToken:null,providers,visible:providers.map(p=>({provider:p.id,modelIds:p.models.map(m=>m.ref.id)})),query:'',selected:{kind:'model',ref:ref()},current:ref(),default:ref('p1','m0'),defaultKnown:true,busy:false,configReadable:true,
    palette:{id:'sakura',name:'樱花',colors:Object.fromEntries(['current','default','favorite','selection','text','dim','accent','blue','success','warning','error'].map((k,i)=>[k,'#'+(0x998080+i*0x050606).toString(16)])),gradient:['#f2a7c6','#a7d7ee'],stepped:false},
    fast:{current:ref(),modelLabel:'p0/m0',tier:'off',supported:true,active:false,ultrafastEnabled:false},undo:null,locate:null,
    actions:ids.map(id=>action(id,{...(id==='switch'?{primary:true}:{}),...(['undo','locate'].includes(id)?{disabled:true}:{})}))};
};
const model = id => ({id,name:id,parameters:params(),needsReview:[],manual:false});
const connection = {provider:'draft',endpoint:'https://draft.example.test/very/long/full/path',api:'openai-responses'};
const plan = () => ({id:'plan-one',targets:[{connection,model:ref('draft','selected')}],items:[{id:'text',model:ref('draft','selected'),label:'文本检查'}],maxRequests:8,maxInputTokens:2048,maxOutputTokens:512,authTimeoutMs:10000,maxDurationMs:90000,retries:0,priceNote:'价格未知，可能计费',includeImage:false,capability:{available:true},reuse:{available:false,reason:'没有适用记录'}});
const report = (overrides={}) => task('report',{mode:'inspect',models:[{ref:ref(),parameters:params(),evidence:[{field:'contextWindow',provenance:{source:'generic',history:[{source:'provider',reason:'缺失，继续降级'}]},when:1700000000000,conditions:['仅精确同 ID 模板']}],needsReview:['contextWindow'],connection,applicable:true,reused:false}],diffs:[],cancelled:false,batchChecks:{available:false,reason:'批量检查尚未实现'},actions:[action('finish-inspect',{primary:true}),action('adjust'),action('recheck'),action('details'),action('apply-inspect',{disabled:true}),action('back'),action('cancel-task')],...overrides});
function fixture(t, {width=120,height=44,root=baseRoot(),view=null,fields=[],render=true}={}) {
  let state={matrix:root,task:view},disposed=0,closed=0,changes=0,onCommand;
  const listeners=new Set(),commands=[],fieldChanges=[];
  const port={viewId:view?.viewId,fields:()=>fields,changed(id){fieldChanges.push(id);changes++;}};
  const workspace={snapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},formFields(id){return id===port.viewId?port:undefined;},
    dispatch(command){command=structuredClone(command);commands.push(command);
      if(command.type==='matrix-select') state={...state,matrix:{...state.matrix,selected:command.selection}};
      if(command.type==='matrix-query') state={...state,matrix:{...state.matrix,query:command.query}};
      if(command.type==='basket-query') state={...state,task:{...state.task,query:command.query}};
      if(command.type==='basket-toggle') {const all=state.task.candidates,id=command.modelId,picked=state.task.selected;
        state={...state,task:{...state.task,selected:picked.some(m=>m.id===id)?picked.filter(m=>m.id!==id):[...picked,all.find(m=>m.id===id)??model(id)]}};}
      const result=onCommand?.(command);for(const fn of [...listeners])fn();return result;
    },dispose(){disposed++;listeners.clear();}};
  const terminal={columns:width,rows:height},theme={style:(text,style)=>tui.styleText(text,style,'truecolor'),appearance:'dark'};
  const c=new PickerComponent(workspace,{terminal,requestRender(){}},theme,()=>closed++);c.focused=true;t.after(()=>c.dispose());
  const h={c,workspace,terminal,commands,fieldChanges,disposed:()=>disposed,closed:()=>closed,changes:()=>changes,fields,
    state:()=>state,on(fn){onCommand=fn;},set(next){state=next;for(const fn of [...listeners])fn();},view(v){state={...state,task:v};port.viewId=v?.viewId;for(const fn of [...listeners])fn();},
    root(patch){this.set({...state,matrix:{...state.matrix,...patch}});},
    raw(){return c.render(terminal.columns);},screen(){return this.raw().map(plain).join('\n');},send(k){c.handleInput(K[k]??k);},key(k){this.send(k);return this.screen();},digit(n){return this.key(alt(n));},type(s){for(const ch of s)this.key(ch);},
    read(){for(let i=0;i<300&&c.debug().offset;i++)this.key('pgup');for(let i=0;i<300;i++){this.screen();const d=c.debug();if(d.offset+d.page>=d.total)return;this.key('pgdn');}assert.fail('cannot finish reading');},
    focus(id){this.screen();if(!c.debug().actionMode)this.key('menu');const slots=c.debug().actionSlots.filter(s=>s.actionIndex!==null);
      const index=slots.find(s=>this.action(s).id===id)?.actionIndex;assert.notEqual(index,undefined,'missing visible '+id);
      const start=slots.find(s=>this.action(s).identity===c.debug().selectedActionIdentity)?.actionIndex;
      const queue=[[start,[]]],seen=new Set([start]);
      for(const [at,path]of queue){if(at===index){for(const k of path)this.key(k);assert.equal(c.debug().selectedAction,id);return;}
        const r=slots.find(s=>s.actionIndex===at);if(!r)continue;
        for(const key of ['left','right','up','down']){let next;
          if(key==='left'||key==='right'){const row=slots.filter(s=>s.y===r.y);next=row[row.indexOf(r)+(key==='right'?1:-1)];}
          else{const ys=[...new Set(slots.map(s=>s.y))].sort((a,b)=>a-b),y=ys[ys.indexOf(r.y)+(key==='down'?1:-1)],center=r.x+r.width/2;
            next=slots.filter(s=>s.y===y).sort((a,b)=>Math.abs(a.x+a.width/2-center)-Math.abs(b.x+b.width/2-center)||a.actionIndex-b.actionIndex)[0];}
          if(next&&!seen.has(next.actionIndex)){seen.add(next.actionIndex);queue.push([next.actionIndex,[...path,key]]);}}
      }assert.fail('unreachable '+id);},
    action(slot){const actions=c.debug().view==='help'?[action('close-help',{identity:'local:close-help'})]:(state.task??state.matrix).actions.filter(a=>a.id!=='fast'||state.matrix.selected.kind==='model'&&JSON.stringify(state.matrix.selected.ref)===JSON.stringify(state.matrix.current)&&state.matrix.fast.supported);
      return actions[slot.actionIndex];},
    point(rect){const rule=this.raw().map(plain).findIndex(line=>/^\s*─+\s*$/.test(line));return {x:rect.x+1,y:rule+1+rect.y-c.debug().offset};},
    click(x,y){return c.handleMouse({type:'click',button:'left',x,y,shift:false,alt:false,ctrl:false});},
  };
  if(render)h.screen();return h;
}
const activations=h=>h.commands.filter(c=>c.type==='activate');
const shape=h=>{h.screen();const slots=h.c.debug().actionSlots,top=Math.min(...slots.map(s=>s.y));return slots.map(({key,x,y,width,height})=>({key,x,y:y-top,width,height}));};
const input=(value='',secret=false)=>{const x=secret?new SecretInput():new tui.Input({prompt:''});x.setValue(value);x.handleInput('\x1b[F');return x;};
const field=(id,value='',options={})=>({kind:'input',id,label:id,readonly:false,secret:false,input:input(value,options.secret),...options});

test('initial manage focus uses the visible action strip and pre-paint Ctrl+S cannot use old slots',t=>{
  const h=fixture(t,{render:false});h.c.focusActions();h.screen();
  assert.equal(h.c.debug().view,'matrix');assert.equal(h.c.debug().actionMode,true);
  assert.equal(h.c.debug().selectedAction,'switch');assert.equal(h.commands.length,0);
  const next=task('edit',{target:{kind:'model',ref:ref()},readonly:false,actions:[action('save-form',{primary:true}),action('back')]});
  h.view(next);h.send('save');h.send('enter');
  assert.equal(activations(h).length,0,'stale home slot indices cannot activate a new task');
  h.screen();h.key('save');assert.equal(activations(h).at(-1).id,'save-form');
});

test('short basket pins one real clickable continuation row without duplicating it',t=>{
  const view=task('basket',{target:connection,query:'',candidates:[],selected:[model('a'),model('b')],listStatus:'idle',listMessage:'可手输',maxSelected:100,
    actions:[action('next-models',{primary:true}),action('read-list'),action('manual-id'),action('back'),action('cancel-task')]});
  const h=fixture(t,{width:32,height:10,view});const lines=h.raw().map(plain);
  assert.ok(lines.length<=10);assert.equal(lines.filter(line=>line.includes('继续（2）')).length,1);
  const y=lines.findIndex(line=>line.includes('继续（2）')),x=tui.visibleWidth(lines[y].slice(0,lines[y].indexOf('继续')));
  assert.equal(h.click(x,y)?.handled,true);assert.equal(activations(h).at(-1).id,'next-models');
});

test('matrix target selection needs a fresh paint before a model effect can run',t=>{
  const h=fixture(t);h.send('right');h.send(alt('1'));
  assert.equal(activations(h).length,0,'new object has not yet been shown');
  h.screen();h.digit(1);assert.deepEqual(activations(h).at(-1).payload,ref('p0','m1'));
});

for(const width of [80,120,140,160])test(`V10 shared home slots and matrix columns at ${width}`,t=>{
  const h=fixture(t,{width}),base=shape(h),d=h.c.debug(),rows=new Set(d.actionSlots.map(s=>s.y));
  assert.equal(rows.size,width===80?3:2);
  const p0=d.matrixCells.filter(c=>c.pid==='p0'),p1=d.matrixCells.filter(c=>c.pid==='p1');
  for(let i=0;i<p1.length;i++)assert.equal(p1[i].x,p0[i].x);
  if(width===160)assert.equal(new Set(p0.map(c=>c.y)).size,1);
  const providers=h.state().matrix.providers.map(p=>({...p,models:p.models.map(m=>({...m,favorite:true}))}));h.root({providers,default:ref(),current:ref('p0','m1')});
  assert.deepEqual(shape(h),base,'badge/caption changes must not reflow slots');
  h.root({selected:{kind:'provider',provider:'p0'}});const provider=shape(h);assert.equal(provider.length,9);assert.equal(new Set(provider.map(s=>s.y)).size,width<140?2:1);
  assert.ok(!provider.some(s=>s.key==='favorite'||s.key==='fast'));assert.ok(h.raw().every(l=>tui.visibleWidth(l)<width));
});

test('action focus keeps only the selected object shaded without moving any grid columns',t=>{
  const h=fixture(t),cells=Array.from(h.c.debug().matrixCells,c=>({...c}));
  assert.ok(!h.raw().join('\n').includes('\x1b[48;2;58;58;58m'));
  h.key('tab');assert.ok(h.raw().join('\n').includes('\x1b[48;2;58;58;58m'));
  assert.deepEqual(Array.from(h.c.debug().matrixCells,c=>({...c})),cells);assert.equal(h.c.debug().actionMode,true);
  h.key('tab');assert.ok(!h.raw().join('\n').includes('\x1b[48;2;58;58;58m'));
});

test('home Tab/ShiftTab and action navigation do not mutate object/current/favorite',t=>{
  const h=fixture(t),before=structuredClone(h.state());h.key('tab');h.key('right');h.key('down');h.key('backTab');
  assert.deepEqual(h.state(),before);assert.equal(h.commands.length,0);assert.equal(h.c.debug().actionMode,false);
  h.digit(1);assert.equal(activations(h).at(-1).id,'favorite');assert.deepEqual(activations(h).at(-1).payload,ref());
  h.key('enter');assert.equal(activations(h).at(-1).id,'switch');assert.equal(h.closed(),0,'switch-close belongs to parent');
  assert.deepEqual(h.state().matrix.current,ref(),'view must never mock a switch');
});

test('digits have stable meanings in both model/provider templates, missing numbers never alias',t=>{
  const h=fixture(t);for(const [n,id]of Object.entries({1:'favorite',2:'edit-model',3:'inspect',4:'default',5:'move-left',6:'move-right',7:'add-model',8:'remove-model',9:'new-provider',0:'archives'})){h.digit(n);assert.equal(activations(h).at(-1).id,id);}
  h.root({selected:{kind:'provider',provider:'p1'}});h.screen();const count=activations(h).length;for(const n of ['1','3','4'])h.digit(n);assert.equal(activations(h).length,count);
  for(const [n,id]of Object.entries({2:'edit-provider',5:'provider-up',6:'provider-down',7:'add-model',8:'remove-provider',9:'new-provider',0:'archives'})){h.digit(n);assert.equal(activations(h).at(-1).id,id);assert.ok(!activations(h).at(-1).payload||activations(h).at(-1).payload.provider==='p1');}
});

test('root uses supplied fuzzy groups/order without replacing them with substring matching',t=>{
  const root=baseRoot();root.query='中文 fuzzy token';root.visible=[{provider:'p1',modelIds:['m1']},{provider:'p0',modelIds:['m4','m0']}];root.selected={kind:'model',ref:ref('p1','m1')};
  const h=fixture(t,{root}),cells=h.c.debug().matrixCells;assert.deepEqual(Array.from(cells,c=>[c.pid,c.mid]),[['p1','m1'],['p0','m4'],['p0','m0']]);
  h.key('up');assert.deepEqual(h.state().matrix.selected,{kind:'model',ref:ref('p0','m4')});h.key('down');assert.deepEqual(h.state().matrix.selected,{kind:'model',ref:ref('p1','m1')});
  const modelCells=baseRoot().providers;h.root({query:'no results',visible:[]});h.screen();assert.match(h.screen(),/没有匹配/);assert.equal(h.c.debug().actionSlots.length,14,'no result is not empty config');
  h.root({providers:[],visible:[],selected:{kind:'none'}});assert.equal(shape(h).length,2);
});

test('compact matrix cells are filter-stable, and provider double-left navigation is deliberate',t=>{
  const h=fixture(t,{width:80,height:24}),base=Array.from(h.c.debug().matrixCells.filter(c=>c.pid==='p0'),c=>c.width);
  h.root({visible:[{provider:'p1',modelIds:['m0','m1']}],selected:{kind:'model',ref:ref('p1','m0')}});h.screen();assert.deepEqual(Array.from(h.c.debug().matrixCells,c=>c.width),base.slice(0,2));
  h.root({visible:baseRoot().visible,selected:{kind:'model',ref:ref()}});h.screen();h.key('left');assert.equal(h.state().matrix.selected.kind,'model');h.key('left');assert.equal(h.state().matrix.selected.kind,'provider');h.key('right');assert.equal(h.state().matrix.selected.kind,'model');
  h.key('left');h.key('down');h.key('up');h.key('left');assert.equal(h.state().matrix.selected.kind,'model','other navigation resets double-left');
});

test('legacy provider ordering works even under model focus; palette dispatch remains available in tasks',t=>{
  const h=fixture(t);h.key('\x1b[1;3A');assert.equal(activations(h).at(-1).id,'provider-up');assert.deepEqual(activations(h).at(-1).payload,{provider:'p0'});
  h.key('\x1b[1;3B');assert.equal(activations(h).at(-1).id,'provider-down');h.view(task('info',{purpose:'auth'}));h.screen();h.key(alt('t'));
  assert.equal(activations(h).at(-1).id,'cycle-palette');assert.equal(activations(h).at(-1).viewId,'home');
});

test('form private controls, advanced map and ordinary task traversal preserve controller-owned values',t=>{
  const name=field('name','名字'),key=field('key','SYNTHETIC-PRIVATE-KEY',{secret:true}),max=field('thinking:max','=literal',{advanced:true}),xhigh=field('thinking:xhigh','-',{advanced:true});
  const h=fixture(t,{view:task('edit',{target:{kind:'model',ref:ref()},readonly:false,actions:[action('save-form',{primary:true}),action('back'),action('cancel-task')]}),fields:[name,key,max,xhigh]});
  h.key('tab');assert.equal(h.c.debug().fieldIndex,1);h.key('tab');assert.equal(h.c.debug().fieldIndex,2);h.key('enter');assert.equal(h.c.debug().advanced,true);
  h.key('down');h.key('down');h.key('down');assert.equal(h.c.debug().actionMode,true);h.key('up');assert.equal(h.c.debug().fieldIndex,4);
  h.key('save');assert.equal(activations(h).at(-1).id,'save-form');assert.equal(activations(h).at(-1).payload,undefined);
  assert.equal(max.input.getValue(),'=literal');assert.equal(xhigh.input.getValue(),'-');
  assert.ok(!h.screen().includes('SYNTHETIC-PRIVATE-KEY'));assert.ok(!JSON.stringify(h.c.debug()).includes('SYNTHETIC-PRIVATE-KEY'));assert.ok(!JSON.stringify(h.commands).includes('SYNTHETIC-PRIVATE-KEY'));
});

test('read-only form fields cannot change through typing, choices, paste or save',t=>{
  let choice=0;const f=field('name','preserved');const v=task('edit',{target:{kind:'model',ref:ref()},readonly:true,actions:[action('save-form',{primary:true}),action('back')]});
  const h=fixture(t,{view:v,fields:[f,{kind:'choice',id:'vision',label:'vision',readonly:false,choices:['否','是'],choice:()=>choice,setChoice:i=>choice=i}]});
  h.type('ignored');h.key('tab');h.key('right');h.send('\x1b[200~secret\x1b[201~');h.screen();h.digit('1');assert.equal(f.input.getValue(),'preserved');assert.equal(choice,0);assert.equal(activations(h).length,0);
});

test('connection connect requires readable full target/API/scope and fresh review, manual bypass stays independent',t=>{
  const view=task('connection',{target:connection,isNew:true,actions:[action('connect',{primary:true}),action('manual-connection'),action('cancel-task')]}),h=fixture(t,{width:44,height:18,view,fields:[field('name','draft'),field('endpoint',connection.endpoint),field('api','openai-responses'),field('key','SYNTHETIC-PRIVATE',{secret:true})]});
  h.digit('1');assert.equal(activations(h).length,0);h.read();h.digit('1');assert.equal(activations(h).at(-1).id,'connect');assert.equal(activations(h).at(-1).review.reviewToken,view.reviewToken);
  h.view({...view,reviewToken:'changed-connection'});h.send(alt('1'));assert.equal(activations(h).length,1);h.screen();h.digit('2');assert.equal(activations(h).at(-1).id,'manual-connection');
});

test('bracketed paste is pinned to a private field; command-looking chunks never activate',t=>{
  const key=field('key','',{secret:true});const h=fixture(t,{view:task('edit',{target:{kind:'provider',provider:'p0'},readonly:false,actions:[action('save-form',{primary:true}),action('back'),action('cancel-task')]}),fields:[key]});
  h.send('\x1b[200~');h.send('synthetic-pasted');h.send(alt('1'));h.send('cancel');h.send('\x1b[201~');h.screen();
  assert.equal(activations(h).length,0);assert.ok(h.changes()>0);assert.ok(!h.screen().includes('synthetic-pasted'));assert.ok(!JSON.stringify(h.c.debug()).includes('synthetic-pasted'));
  h.c.focused=false;h.send('x');h.c.focused=true;h.screen();h.key('save');assert.equal(activations(h).at(-1).id,'save-form');
});

test('basket arrows cross all controls, retain two cursors, and adjust uses selected model ID',t=>{
  const h=fixture(t,{view:task('basket',{target:connection,query:'',candidates:[model('a'),model('b'),model('c')],selected:[],listStatus:'loaded',listMessage:'本家清单',maxSelected:100,
    actions:[action('next-models',{primary:true}),action('read-list'),action('manual-id'),action('adjust'),action('back'),action('cancel-task')]})});
  h.key('down');h.key('enter');h.key('down');h.key('enter');assert.deepEqual(h.state().task.selected.map(m=>m.id),['a','b']);
  h.key('right');h.key('down');h.key('enter');assert.equal(activations(h).at(-1).id,'adjust');assert.deepEqual(activations(h).at(-1).payload,{modelId:'b'});
  h.key('left');assert.equal(h.c.debug().candidateIndex,1);h.key('down');h.key('down');assert.equal(h.c.debug().actionMode,true);h.key('up');assert.equal(h.c.debug().zone,'candidates');
  h.key('right');h.key('\x7f');assert.deepEqual(h.state().task.selected.map(m=>m.id),['a']);
  h.send('\x1b[200~typed-id\x1b[201~');h.screen();assert.equal(h.c.debug().zone,'query');assert.equal(h.state().task.query,'typed-id');
});

test('review gates apply identically to digit, Ctrl+S, focused Enter and mouse',t=>{
  const view=task('preflight',{plan:plan(),content:{stage:'范围',title:'检查',sections:[{lines:Array.from({length:45},(_,i)=>'必须读取的授权条件 '+i)}]},actions:[action('run',{primary:true}),action('skip'),action('image'),action('reuse',{disabled:true}),action('back'),action('cancel-task')]});
  const h=fixture(t,{width:48,height:18,view,render:false});h.send(alt('1'));assert.equal(activations(h).length,0);h.screen();h.key('save');assert.equal(activations(h).length,0);
  h.focus('run');h.key('enter');assert.equal(activations(h).length,0);const rect=h.c.debug().actionRects.find(r=>h.action({actionIndex:r.index}).id==='run'),point=h.point(rect);h.click(point.x+2,point.y);assert.equal(activations(h).length,0);
  h.read();h.send(alt('1'));const cmd=activations(h).at(-1);assert.equal(cmd.id,'run');assert.deepEqual(cmd.payload,{planId:'plan-one'});assert.equal(cmd.review.complete,true);
  h.send(alt('1'));assert.equal(activations(h).length,1,'second confirmation before render blocked');
  h.terminal.columns=64;h.send(alt('1'));assert.equal(activations(h).length,1);h.screen();h.digit('1');assert.equal(activations(h).length,1,'resize requires fresh reading');h.read();h.key('save');assert.equal(activations(h).length,2);
});

test('report uses actual suite statuses/provenance/diffs and chosen adjustment target',t=>{
  const checks={text:{status:'passed'},stream:{status:'inconclusive',code:'auth'},tools:{status:'not-tested'},image:{status:'not-tested'},thinking:Object.fromEntries(['low','medium','high','xhigh','max'].map(l=>[l,{status:'not-tested'}]))};
  const v=report();v.models=[{...v.models[0],suite:{startedAt:1700000000000,finishedAt:1700000001000,cancelled:true,timedOut:false,checks}},{...v.models[0],ref:ref('p1','second')}];
  v.diffs=[{ref:ref(),fields:[{field:'thinkingLevelMap',before:{present:false},after:{present:true,value:{max:'',xhigh:null}}}]}];
  const h=fixture(t,{view:v,width:80,height:44});h.read();assert.match(h.screen(),/不支持|未测试|未决/);h.digit('4');h.read();h.key('pgup');assert.match(h.screen(),/接口接受|窗口/);
  h.key('down');h.digit('2');assert.deepEqual(activations(h).at(-1).payload,{modelId:'second'});
  assert.ok(!h.raw().join('').includes('0 请求'));assert.ok(!h.raw().join('').includes('开始模拟'));
});

test('replacement/remove are separate view-bound confirmations; progress cancel is real command only',t=>{
  const v=task('confirm',{purpose:'replacement',affectedModels:[ref()],replacements:[{ref:ref('p1','m1'),label:'替代模型'}],affectsCurrent:true,affectsDefault:false,replacementApplied:false,
    actions:[action('replacement',{primary:true}),action('cancel-confirm'),action('cancel-task')]});const h=fixture(t,{view:v});h.read();h.digit('1');assert.deepEqual(activations(h).at(-1).payload,ref('p1','m1'));
  h.view({...v,viewId:'remove-two',reviewToken:'remove-new',purpose:'remove',replacementApplied:true,replacements:[],actions:[action('confirm-remove',{primary:true}),action('cancel-confirm'),action('cancel-task')]});h.send(alt('1'));assert.equal(activations(h).length,1);h.read();h.digit('1');assert.equal(activations(h).at(-1).id,'confirm-remove');
  h.view(task('progress',{operation:'checks',items:[{id:'text',label:'文本',status:'passed'},{id:'tools',label:'工具',status:'inconclusive',detail:'限流，无法判断'},{id:'max',label:'max',status:'running'}],cancellation:'stop-to-report',cancelling:false,actions:[action('cancel-checks',{primary:true}),action('cancel-task')]}));
  assert.match(h.screen(),/未确认/);h.key('esc');assert.equal(activations(h).at(-1).id,'cancel-checks');h.key('cancel');assert.equal(activations(h).at(-1).id,'cancel-task');
});

test('archives bind dynamic identities, Fast/recovery/info are native component task surfaces',t=>{
  const h=fixture(t,{view:task('archives',{entries:[{id:'a-one',kind:'model',provider:'p0',modelId:'m0',label:'被移除模型',createdAt:1,restore:{available:true}}],hasLegacy:true,actions:[action('back'),action('restore',{identity:'restore:a-one',label:'恢复 被移除模型'}),action('cancel-task')]})});
  h.focus('restore');h.key('enter');assert.deepEqual(activations(h).at(-1).payload,{archiveId:'a-one'});
  h.view(task('fast',{session:{...h.state().matrix.fast,ultrafastEnabled:true},observations:['上游未回显；不证明计费'],actions:[action('fast-off'),action('fast-priority'),action('fast-ultrafast'),action('fast-observations'),action('back'),action('cancel-task')]}));
  h.screen();h.digit('3');assert.equal(activations(h).at(-1).id,'fast-ultrafast');assert.match(h.screen(),/当前会话模型/);
  h.view(task('recovery',{pendingId:'pending-one',operation:'完成上次修改，不覆盖外部变化',canRecover:{available:true},actions:[action('confirm-recover',{primary:true}),action('back'),action('cancel-task')]}));h.read();h.digit('1');assert.equal(activations(h).at(-1).id,'confirm-recover');
  h.view(task('info',{purpose:'auth',content:{stage:'鉴权',title:'说明',sections:[{lines:['auth.json 为 0600 明文；保留 OAuth。']} ]}}));h.screen();assert.match(h.screen(),/保留 OAuth/);
});

test('home Fast is current-only and disabled text/padding/gutters cannot trigger actions',t=>{
  const h=fixture(t,{width:120});assert.ok(h.c.debug().actionSlots.some(s=>s.key==='fast'&&s.actionIndex!==null));
  h.root({selected:{kind:'model',ref:ref('p1','m0')}});h.screen();assert.ok(h.c.debug().actionSlots.find(s=>s.key==='fast').actionIndex===null);
  h.root({selected:{kind:'model',ref:ref()}});h.screen();h.focus('undo');const d=h.c.debug(),disabled=d.actionRects.find(r=>h.action({actionIndex:r.index}).id==='undo'),point=h.point(disabled);
  h.click(point.x+2,point.y);h.key('enter');assert.equal(activations(h).length,0);
  const slot=d.actionSlots.find(s=>s.key==='favorite'),rect=d.actionRects.find(r=>r.index===slot.actionIndex);
  if(rect.width<slot.width){const p=h.point(slot);assert.equal(h.click(p.x+slot.width-1,p.y),undefined);}
});

test('help and subpage returns retain action/focus/viewport, and resize retains semantic action',t=>{
  const h=fixture(t,{width:80,height:24});h.focus('edit-model');const before=h.c.debug();h.key('\x1bh');h.read();h.digit('1');assert.equal(activations(h).length,0);h.digit('0');assert.equal(h.c.debug().selectedActionIdentity,before.selectedActionIdentity);assert.equal(h.c.debug().offset,before.offset);
  const edit=task('edit',{target:{kind:'model',ref:ref()},readonly:false,actions:[action('save-form',{primary:true}),action('back'),action('cancel-task')]});h.view(edit);h.screen();h.view(null);h.screen();assert.equal(h.c.debug().selectedActionIdentity,before.selectedActionIdentity);assert.equal(h.c.debug().actionMode,true);
  for(const width of [42,160,120,80]){h.terminal.columns=width;h.screen();assert.equal(h.c.debug().selectedAction,'edit-model');}
});

test('ordinary digits/repeated editing/paste are text, repeats/releases cannot activate',t=>{
  const h=fixture(t);h.type('1230');assert.equal(h.state().matrix.query,'1230');assert.equal(activations(h).length,0);
  h.key('clear');h.send('\x1b[120;1:2u');h.screen();assert.equal(h.state().matrix.query,'x');h.send('\x1b[49;3:2u');h.send('\x1b[49;3:3u');assert.equal(activations(h).length,0);
  h.send('\x1b[200~987\x1b1\x1b[201~');h.screen();assert.equal(activations(h).length,0);
});

test('narrow widths bound all lines; focus loss and disposal are idempotent and late errors cannot leak',async t=>{
  const h=fixture(t);for(const width of [1,2,8,20,28,32,42,64,160]){h.terminal.columns=width;assert.ok(h.raw().every(l=>tui.visibleWidth(l)<width));}
  h.terminal.columns=120;h.screen();h.c.focused=false;h.send(alt('1'));assert.equal(activations(h).length,0);h.c.focused=true;h.screen();
  let reject;h.on(()=>new Promise((_,r)=>reject=r));h.digit('1');h.c.dispose();reject(new Error('SYNTHETIC-MUST-NOT-LEAK'));await new Promise(setImmediate);
  assert.equal(h.disposed(),1);h.c.dispose();assert.equal(h.disposed(),1);assert.equal(h.raw().length,0);
});

for(const width of [28,42,80,120,160])test(`basket count/optional controls keep fixed geometry at ${width}`,t=>{
  const view=task('basket',{target:connection,query:'',candidates:[],selected:[],listStatus:'idle',listMessage:'',maxSelected:100,
    actions:[action('next-models',{primary:true,disabled:true}),action('read-list'),action('back'),action('cancel-task')]});
  const h=fixture(t,{width,view}),before=shape(h);
  for(const count of [9,10,100]){
    h.view({...view,selected:Array.from({length:count},(_,i)=>model('picked-'+i)),query:'manual-id',listStatus:'loading',actions:[action('next-models',{primary:true}),action('read-list',{disabled:true}),action('manual-id'),action('stop-read'),action('back'),action('cancel-task')]});
    assert.deepEqual(shape(h),before);assert.ok(h.raw().every(line=>tui.visibleWidth(line)<width));
  }
});

test('all task actions are sequential Tab stops, with no hidden compatibility stops',t=>{
  const h=fixture(t,{view:task('edit',{target:{kind:'model',ref:ref()},readonly:false,actions:[action('save-form',{primary:true}),action('back'),action('cancel-task')]}),fields:[field('name'),field('context')]});
  h.key('tab');assert.equal(h.c.debug().fieldIndex,1);h.key('tab');assert.equal(h.c.debug().selectedAction,'save-form');h.key('tab');assert.equal(h.c.debug().selectedAction,'back');
  h.key('tab');assert.equal(h.c.debug().actionMode,false);assert.equal(h.c.debug().fieldIndex,0);h.key('backTab');assert.equal(h.c.debug().selectedAction,'back');h.key('backTab');h.key('backTab');assert.equal(h.c.debug().fieldIndex,1);
  h.key('cancel');assert.equal(activations(h).at(-1).id,'cancel-task');
});

test('field arrows remain caret editing, and choices notify the controller without copying values',t=>{
  let choice=0;const f=field('name','abc');const h=fixture(t,{view:task('edit',{target:{kind:'provider',provider:'p0'},readonly:false}),fields:[f,{kind:'choice',id:'api',label:'接口',readonly:false,choices:['openai-completions','openai-responses'],choice:()=>choice,setChoice:i=>choice=i}]});
  h.key('left');h.type('X');assert.equal(f.input.getValue(),'abXc');h.key('down');h.key('right');assert.equal(choice,1);assert.ok(h.fieldChanges.includes('api'));assert.equal(h.commands.length,0);
});

test('discovery consent info has a stable numeric entry and full controller-supplied scope',t=>{
  const v=task('info',{purpose:'discovery-consent',content:{stage:'读取授权',title:'读取这个上游清单',sections:[{lines:[connection.endpoint,'openai-responses','一次 HTTPS GET，无重试，不运行模型']} ]},actions:[action('connect',{primary:true,requiresReview:true}),action('back'),action('cancel-task')]});
  const h=fixture(t,{view:v,width:120});h.read();h.digit('1');assert.equal(activations(h).at(-1).id,'connect');assert.equal(activations(h).at(-1).review.complete,true);assert.match(h.screen(),/一次 HTTPS GET/);
});

test('same-view review-token changes and render-width-only changes invalidate reading',t=>{
  const v=task('confirm',{purpose:'remove',affectedModels:[ref()],replacements:[],affectsCurrent:false,affectsDefault:false,replacementApplied:false,content:{stage:'确认范围',title:'移除范围',sections:[{lines:Array.from({length:30},(_,i)=>'需重新阅读的完整范围 '+i)}]},actions:[action('confirm-remove',{primary:true}),action('cancel-confirm')]});
  const h=fixture(t,{view:v,width:80,render:false});h.send(alt('1'));assert.equal(activations(h).length,0);h.read();h.send(alt('1'));assert.equal(activations(h).length,1);
  h.view({...v,reviewToken:'different-scope'});h.send(alt('1'));assert.equal(activations(h).length,1);h.screen();h.c.render(42);assert.equal(h.c.debug().reviewComplete,false);h.screen();h.read();h.digit('1');assert.equal(activations(h).length,2);
});

test('provider action focus skips invisible model/compatibility slots and stays keyboard reachable',t=>{
  const h=fixture(t);h.key('left');h.key('left');h.key('tab');assert.equal(h.c.debug().selectedAction,'edit-provider');h.key('right');assert.equal(h.c.debug().selectedAction,'provider-up');
  h.key('enter');assert.equal(activations(h).at(-1).id,'provider-up');h.key('esc');h.key('right');h.key('tab');assert.equal(h.c.debug().actionMode,true);assert.ok(h.c.debug().actionSlots.some(s=>s.actionIndex!==null&&h.action(s).identity===h.c.debug().selectedActionIdentity));
});

test('disabled checks/Fast capabilities are disclosed and cannot be bypassed with digits',t=>{
  const v=task('preflight',{plan:{...plan(),capability:{available:false,reason:'此协议尚未实现'},reuse:{available:false}},actions:[action('run',{primary:true}),action('skip'),action('image',{disabled:true}),action('reuse'),action('back'),action('cancel-task')]});
  const h=fixture(t,{view:v});h.read();h.digit('1');h.digit('4');assert.equal(activations(h).length,0);assert.match(h.screen(),/尚未实现/);h.digit('2');assert.equal(activations(h).at(-1).id,'skip');
  h.view(task('fast',{session:{...h.state().matrix.fast,ultrafastEnabled:false},observations:[],actions:[action('fast-off'),action('fast-priority'),action('fast-ultrafast'),action('back')]}));h.screen();h.digit('3');assert.equal(activations(h).at(-1).id,'skip');
});

test('physical mouse confirmation and keys carry identical review proof and identity',t=>{
  const v=task('confirm',{purpose:'restore',affectedModels:[],replacements:[],affectsCurrent:false,affectsDefault:false,replacementApplied:false,actions:[action('confirm-restore',{primary:true}),action('cancel-confirm')]});
  const h=fixture(t,{view:v});h.read();h.focus('confirm-restore');const r=h.c.debug().actionRects.find(r=>h.action({actionIndex:r.index}).id==='confirm-restore'),p=h.point(r);h.click(p.x+2,p.y);
  const cmd=activations(h).at(-1);assert.equal(cmd.id,'confirm-restore');assert.equal(cmd.identity,'confirm-restore');assert.equal(cmd.review.reviewToken,v.reviewToken);
  h.view({...v,reviewToken:'new-target'});h.click(p.x+2,p.y);assert.equal(activations(h).length,1,'stale mouse hits cannot confirm new content');
});

test('report model identity and edit return frame survive reordering without index-target drift',t=>{
  const v=report();v.models=[v.models[0],{...v.models[0],ref:ref('p1','second')}];const h=fixture(t,{view:v});h.key('down');h.digit('2');assert.equal(activations(h).at(-1).payload.modelId,'second');
  const before=h.c.debug();h.view(task('edit',{viewId:'edit-selected',target:{kind:'model',ref:ref('p1','second')},readonly:false}));h.screen();h.view(v);h.screen();assert.equal(h.c.debug().selectedIndex,before.selectedIndex);
  h.view({...v,models:[v.models[1],v.models[0]]});h.screen();h.digit('2');assert.equal(activations(h).at(-1).payload.modelId,'second');
});

test('unknown scene keys do nothing and palette colors come only from the injected palette',t=>{
  const h=fixture(t);h.key('\x1bOQ');h.key('\x1bOR');h.key('\x1bOS');assert.equal(h.commands.length,0);
  const before=h.raw().join('');const palette={...h.state().matrix.palette,colors:Object.fromEntries(Object.keys(h.state().matrix.palette.colors).map(k=>[k,'#112233']))};h.root({palette});const after=h.raw().join('');assert.notEqual(after,before);assert.ok(after.includes('17;34;51'));
});


test('final commit keeps the controller-authored consequence, not a misleading add label',t=>{
  const v=task('confirm',{purpose:'apply-inspect',affectedModels:[ref()],replacements:[],affectsCurrent:false,affectsDefault:false,replacementApplied:false,actions:[action('commit',{label:'确认应用差异',primary:true,requiresReview:true}),action('back'),action('cancel-task')]});
  const h=fixture(t,{view:v});h.read();assert.match(h.screen(),/确认应用差异/);assert.doesNotMatch(h.screen(),/确认添加/);h.digit('1');assert.equal(activations(h).at(-1).id,'commit');
});

test('hidden legacy provider ordering does not replace the selected visible toolbar action',t=>{
  const h=fixture(t);h.focus('edit-model');h.key('\x1b[1;3A');assert.equal(h.c.debug().selectedAction,'edit-model');assert.equal(activations(h).at(-1).id,'provider-up');
});
