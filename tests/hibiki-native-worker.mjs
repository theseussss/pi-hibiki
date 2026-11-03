// Real installed loader/runner/SessionManager/formal component/services.
// Synthetic isolated file-backed SDK binding; no Agent, PTY, provider or real profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { piRoot, variantRoots } from '../scripts/tooling.mjs';
import { driveAction, readComponentContent } from './model-pick-ui-harness.mjs';
const home=process.env.HOME;
assert.match(home,/^\/tmp\/model-pick-[^/]+$/);
assert.equal(process.env.PI_CODING_AGENT_DIR,path.join(home,'sdk-profile'));
const agent=process.env.PI_CODING_AGENT_DIR;
fs.mkdirSync(agent,{recursive:true,mode:0o700});
fs.writeFileSync(path.join(agent,'pi-hibiki.json'),'{"fast":{"enableUltrafast":true}}',{mode:0o600});
const a={provider:'clf-responses',api:'openai-responses',id:'gpt-6-astra',name:'星河 · 当前',baseUrl:'https://fixture.invalid/v1',contextWindow:128000,maxTokens:8192,reasoning:true,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const b={...a,id:'gpt-4.1',name:'future · 候选'};
const modelConfig=JSON.stringify({futureRoot:{keep:true},providers:{'clf-responses':{name:'星河',api:a.api,baseUrl:a.baseUrl,apiKey:'SYNTHETIC-NOT-A-CREDENTIAL',models:[a,b].map(({provider,api,baseUrl,cost,...m})=>m)}}});
const settings=JSON.stringify({defaultProvider:a.provider,defaultModel:a.id,futurePreference:{keep:true}});
fs.writeFileSync(path.join(agent,'models.json'),modelConfig,{mode:0o600});
fs.writeFileSync(path.join(agent,'settings.json'),settings,{mode:0o600});
const host=piRoot(), hostImport=rel=>import(pathToFileURL(path.join(host,rel)));
const sdk=await hostImport('dist/index.js');
const tuiModule=await hostImport('node_modules/@earendil-works/pi-tui/dist/index.js');
const {loadExtensions,createExtensionRuntime}=await hostImport('dist/core/extensions/loader.js');
const {ExtensionRunner}=await hostImport('dist/core/extensions/runner.js');
const theme=await hostImport('dist/modes/interactive/theme/theme.js');
theme.initTheme('dark',false);
const source=path.join(variantRoots().productionRoot,'extensions/hibiki-models.ts');
const runtime=createExtensionRuntime();
const loaded=await loadExtensions([source],home,undefined,runtime);
assert.deepEqual(loaded.errors,[]); assert.equal(loaded.extensions.length,1);
const extension=loaded.extensions[0];
assert.deepEqual([...extension.commands.keys()].sort(),['fast','hibiki','models']);
assert.deepEqual([...extension.shortcuts.keys()],['ctrl+l']);
assert.equal(extension.handlers.get('before_provider_request').length,1);
assert.equal(extension.handlers.get('provider_stream_event').length,1);
const manager=sdk.SessionManager.inMemory(home);
manager.appendCustomEntry('gpt-fast-mode-state',{enabled:true});
const notices=[],statuses=new Map(),errors=[],refreshes=[],selections=[],frames=[],overlays=[];
let current=a, panel, redraws=0, customCalls=0, authCalls=0, mountedOverlays=0, closedOverlays=0;
const terminal={columns:120,rows:30,write(){},hideCursor(){},showCursor(){},setTitle(){}};
const NativeTui=tuiModule.TuiMainScreen??tuiModule.TUI;
const tui=new NativeTui(terminal); tui.requestRender=()=>{redraws++;};
const plain=s=>stripVTControlCharacters(s).replace(/\x1b_pi:[^\x07]*\x07/g,'');
const render=()=>panel.render(terminal.columns);
const lines=(width=terminal.columns)=>{terminal.columns=width;return render().map(plain);};
const screen=(width=terminal.columns)=>lines(width).join('\n');
const press=data=>{panel.handleInput(data);render();};
const type=text=>{for(const c of text)press(c);};
const choose=id=>driveAction(panel,id,render);
const flush=async()=>{await new Promise(setImmediate);render();};
const ui={theme:theme.theme,notify:(message,type)=>notices.push({message,type}),setStatus:(key,value)=>value===undefined?statuses.delete(key):statuses.set(key,value),custom(factory,options){
  customCalls++; overlays.push(options); return new Promise(resolve=>{
    let handle,closed=false;
    // Host-side ctx.ui.custom lifecycle, matching installed showExtensionCustom:
    // the host (never the extension component) owns native overlay cleanup.
    const done=result=>{if(closed)return;closed=true;handle?.hide();closedOverlays++;resolve(result);panel?.dispose();};
    panel=factory(tui,theme.theme,{},done);
    handle=tui.showOverlay(panel,options.overlayOptions);mountedOverlays++;
    assert.equal(handle.isFocused(),true);assert.equal(panel.focused,true);
  });
}};
const forbidden=()=>{throw new Error('Model/auth/tool/network action forbidden in native Hibiki test');};
// Exact file paths match host storage. This shape is a synthetic SDK file-backed
// registry assertion, not a HOME fallback. The native-auth adapter itself is real.
const registry={runtime:{modelsPath:path.join(agent,'models.json'),credentials:{store:{authPath:path.join(agent,'auth.json')}}},refresh:async options=>{assert.equal(options.allowNetwork,false);refreshes.push(options);},getAvailable:()=>[a,b],getAll:()=>[a,b],getRegisteredProviderIds:()=>[],find:(provider,id)=>[a,b].find(m=>m.provider===provider&&m.id===id),getProviderAuthStatus:()=>({configured:true}),getApiKeyAndHeaders(){authCalls++;return forbidden();}};
const runner=new ExtensionRunner(loaded.extensions,runtime,home,manager,registry);
runner.onError(error=>errors.push(error));
runner.bindCore({sendMessage:forbidden,sendUserMessage:forbidden,appendEntry:(kind,data)=>manager.appendCustomEntry(kind,data),getSessionName:()=>manager.getSessionName(),setSessionName:forbidden,setLabel:forbidden,getActiveTools:()=>[],getAllTools:()=>[],getSettings:()=>({}),setActiveTools:forbidden,refreshTools(){},getCommands:()=>[],setModel:async model=>{selections.push(model);current=model;return true;},getThinkingLevel:()=> 'high',setThinkingLevel:forbidden},
 {getModel:()=>current,getScopedModels:()=>[],isIdle:()=>true,isProjectTrusted:()=>false,getSignal:()=>undefined,abort:forbidden,hasPendingMessages:()=>false,shutdown:forbidden,getContextUsage:()=>undefined,compact:forbidden,getSystemPrompt:()=>'',executeTool:forbidden});
runner.setUIContext(ui,'tui');
const emit=async(type,extra={})=>{await runner.emit({type,...extra});assert.deepEqual(errors,[]);};
const command=(name,args='')=>extension.commands.get(name).handler(args,runner.createCommandContext());
const raw=async(data)=>emit('provider_stream_event',{provider:current.provider,api:current.api,model:current.id,data});
const request=()=>runner.emitBeforeProviderRequest({model:current.id,input:'synthetic only'});
async function open(name,args='') {panel=undefined;const pending=command(name,args);for(let i=0;i<100&&!panel;i++)await new Promise(setImmediate);assert.ok(panel,'native formal component was not constructed');assert.equal(typeof panel.debug,'function');render();assert.deepEqual(overlays.at(-1),{overlay:true,overlayOptions:{anchor:'bottom-center',width:'100%',maxHeight:'100%',margin:0}});return {pending};}
function checkWidths(){for(const width of [1,2,4,8,20,30,40,64,80,120,160]){terminal.columns=width;const rendered=render();assert.ok(rendered.every(line=>tuiModule.visibleWidth(line)<=width),`oversize width ${width}`);assert.ok(!rendered.join('').includes('SYNTHETIC-NOT-A-CREDENTIAL'));}terminal.columns=120;render();}
const unchanged=()=>{assert.equal(fs.readFileSync(path.join(agent,'settings.json'),'utf8'),settings);assert.equal(fs.readFileSync(path.join(agent,'models.json'),'utf8'),modelConfig);};
async function close(opened){for(let i=0;i<8&&panel.debug().view!=='matrix';i++)press('\x1b');if(panel.debug().actionMode)press('\x1b');press('\x1b');await opened.pending;}

await emit('session_start',{reason:'startup'});
assert.equal(statuses.get('gpt-fast-mode'),'⚡ FAST↑');
await command('hibiki','status');assert.match(notices.at(-1).message,/Hibiki · 模型工作台/);
assert.equal((await request()).service_tier,'priority');
await raw({type:'response.created',response:{id:'synthetic-response',service_tier:'auto'}});
await command('fast','check');assert.match(notices.at(-1).message,/上游未回显/);
await raw({type:'response.completed',response:{id:'synthetic-response',service_tier:'default'}});
await command('fast','status');assert.match(notices.at(-1).message,/上游service_tier=default/);assert.match(notices.at(-1).message,/不作为实际加速或计费的证明/);
const matrix=await open('models');checkWidths();frames.push({name:'matrix',lines:lines(80)});
assert.equal(theme.theme.appearance,'dark');assert.equal(typeof theme.theme.style,'function');
const dark=render().join('\n');
assert.equal(theme.setTheme('light',false).success,true);panel.invalidate();render();
assert.equal(theme.theme.appearance,'light');const light=render().join('\n');
frames.push({name:'matrix-light',lines:lines(80)});
assert.equal(theme.setTheme('dark',false).success,true);panel.invalidate();render();
assert.match(screen(),/Hibiki · 模型工作台/);
type('future');assert.match(screen(),/future/);assert.equal(current,a);
assert.equal(panel.debug().actionSlots.find(s=>s.key==='fast')?.actionIndex,null,'candidate is not the current-session Fast target');
press('\x1bm');assert.match(screen(),/操作 模型 clf-responses\/gpt-4\.1/);assert.doesNotMatch(screen(),/更多…/);press('\x1b');assert.match(screen(),/future/);await close(matrix);
const fast=await open('hibiki','fast');checkWidths();frames.push({name:'fast',lines:lines(80)});
assert.match(readComponentContent(panel,render),/clf-responses\/gpt-6-astra/);assert.doesNotMatch(screen(),/当前模型：clf-responses\/gpt-4\.1/);
choose('fast-off');assert.equal((await request()).service_tier,undefined);
choose('fast-priority');assert.equal((await request()).service_tier,'priority');
choose('fast-ultrafast');assert.equal((await request()).service_tier,'ultrafast');
assert.equal(selections.length,0);assert.equal(current,a);unchanged();
current=b;await emit('model_select',{model:b,previousModel:a,source:'synthetic'});
assert.match(readComponentContent(panel,render),/clf-responses\/gpt-4\.1/);assert.equal(statuses.has('gpt-fast-mode'),false);
choose('fast-off');current=a;await emit('model_select',{model:a,previousModel:b,source:'synthetic'});assert.equal((await request()).service_tier,undefined);await close(fast);
// Formal services, not a demo engine: inspect a synthetic add-model plan/report,
// cancel without resolving auth, sending requests, or committing model metadata.
const wizard=await open('models');press('\x1bn');choose('manual-id');type('synthetic-new-model');choose('add-ids');choose('next-models');
assert.equal(panel.debug().view,'preflight');assert.match(readComponentContent(panel,render),/synthetic-new-model/);checkWidths();frames.push({name:'wizard-preflight',lines:lines(80)});
// Fresh-layout guard: changing dimensions and sending a raw consent key before
// rendering the new geometry cannot start an auth/request operation.
terminal.columns=64;panel.handleInput('\x1b1');assert.equal(authCalls,0);render();
choose('skip');assert.equal(panel.debug().view,'report');checkWidths();frames.push({name:'wizard-report',lines:lines(80)});
choose('details');assert.match(readComponentContent(panel,render),/来源|参考|待确认|人工/);checkWidths();frames.push({name:'wizard-detail',lines:lines(80)});
assert.equal(authCalls,0);unchanged();await close(wizard);
const direct=await open('hibiki','fast');assert.equal(panel.debug().view,'fast');press('\x1b');assert.equal(panel.debug().view,'matrix');press('\x1b');await direct.pending;
const anchor=manager.appendCustomEntry('gpt-fast-mode-state',{version:2,tier:'priority'});
manager.appendCustomEntry('gpt-fast-mode-state',{version:2,tier:'off'});await emit('session_tree',{});assert.equal((await request()).service_tier,undefined);
manager.branch(anchor);await emit('session_tree',{});assert.equal((await request()).service_tier,'priority');
manager.appendCustomEntry('gpt-fast-mode-state',{version:2,tier:'ultrafast'});await emit('session_start',{reason:'resume'});
assert.equal((await request()).service_tier,'ultrafast','verified profile opt-in must load before Fast restores its branch');
const customBefore=customCalls;runner.setUIContext(ui,'rpc');await command('models');assert.equal(customCalls,customBefore);assert.match(notices.at(-1).message,/需要交互模式/);
await command('fast','off');assert.equal((await request()).service_tier,undefined);
runner.setUIContext(ui,'tui');await emit('session_shutdown',{reason:'quit'});
const untouched={model:a.id,input:'synthetic only',service_tier:'auto'};assert.equal(await runner.emitBeforeProviderRequest(untouched),untouched);assert.equal(statuses.size,0);
runner.invalidate('native fixture complete');
assert.deepEqual(errors,[]);assert.equal(mountedOverlays,customCalls);assert.equal(closedOverlays,customCalls);assert.equal(tui.hasOverlay(),false);assert.equal(authCalls,0);assert.equal(selections.length,0);assert.ok(refreshes.length>=2);assert.ok(redraws>0);unchanged();
assert.notEqual(light,dark,'open picker must refresh appearance-dependent palette on native theme invalidation');
console.log(JSON.stringify({native:'PASS',entry:path.basename(source),commands:3,policyHooks:1,observerHooks:1,widths:[1,2,4,8,20,30,40,64,80,120,160],nativeOverlayMounted:true,nondefaultProfile:true,themeAppearances:['dark','light'],overlay:{anchor:'bottom-center',width:'100%',maxHeight:'100%',margin:0},currentDefaultUnchanged:true,branchRestore:true,headlessFast:true,authCalls,selections:selections.length,realNetworkRequests:0,frames}));
