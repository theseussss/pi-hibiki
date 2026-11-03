import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
import { createSyntheticProtection } from './model-pick-synthetic-protection.mjs';
import { piRoot } from '../scripts/tooling.mjs';

// Actual installed Input/SecretInput; real store, resolver, records and network executors.
// Only host effects, fixture protection and fetch are synthetic. No user files/network.
const tui = await import(pathToFileURL(path.join(piRoot(),'node_modules/@earendil-works/pi-tui/dist/index.js')));
const source = fileURLToPath(new URL('../lib/model-pick/', import.meta.url));
const SECRET = 'SYNTHETIC-CONTROLLER-KEY';
const clone = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(resolve => setImmediate(resolve));
const model = (id,extra={}) => ({ id, name: id, contextWindow: 128000, maxTokens: 8192, reasoning: true, input: ['text'], ...extra });
const config = () => ({ rootUnknown: { keep: 1 }, providers: { p: { name:'Saved', baseUrl:'https://saved.invalid/v1',api:'openai-completions', providerUnknown:{keep:2}, models:[model('m',{unknown:{keep:3}})] } } });
function response(options) {
  if (options.method === 'GET') return Response.json({data:[{id:'a'},{id:'b'}]});
  const body = JSON.parse(options.body);
  if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"HIBIKI_PROBE_OK"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  const content = Array.isArray(body.messages?.[0]?.content) ? 'RED' : 'HIBIKI_PROBE_OK';
  return Response.json({ choices:[{message: body.tools ? { tool_calls:[{id:'call',type:'function',function:{name:'hibiki_probe',arguments:'{}'}}] } : {content},finish_reason:body.tools?'tool_calls':'stop'}] });
}
async function fixture(t, {initial=config(),fetcher=response,backend=true,authWait,commitOutcome,refreshFailure=false,catalogExtra=[],readonly=false,fast,clock}={}) {
  const root = fs.mkdtempSync('/tmp/model-pick-controller-'); t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'models.json'),JSON.stringify(initial),{mode:0o600});
  // A single loader realm avoids test-only cross-realm plain-object validators.
  const entry = path.join(root,'entry.ts');
  const ref = name => './' + path.relative(root,path.join(source,name)).replaceAll(path.sep,'/');
  fs.writeFileSync(entry,`export { PickerActions } from '${ref('panel.ts')}';\nexport { PickerStore } from '${ref('store.ts')}';\nexport { PickerRecords } from '${ref('records.ts')}';\n`);
  const calls=[], authCalls=[], commits=[], changes=[], notices=[], leaks=[], saves=[]; let renders=0;
  const boundedFs = new Proxy(fs,{get(target,key) {
    const original=target[key]; if(typeof original!=='function') return original;
    return (...args) => {
      if(typeof args[0]==='string') {
        const p=path.resolve(args[0]);
        assert.ok(p===root || p.startsWith(root+'/') || key==='lstatSync' && root.startsWith(p==='/'?'/':p+'/'),`fixture fs escaped: ${key}`);
      }
      if(key==='renameSync') assert.ok(path.resolve(args[1]).startsWith(root+'/'));
      return original(...args);
    };
  }});
  const api = loadTypeScript(entry,{'node:fs':boundedFs,'@earendil-works/pi-tui':tui},{
    fetch: async(url,options)=> { calls.push({url,options}); return fetcher(options,url); },
    ...(clock ? { Date: class extends Date { static now(){return clock.now;} } } : {}),
  });
  const protection=createSyntheticProtection();
  const adapter={seal:(v,p)=>api.__json(protection.seal(v,p)),open:(v,p)=>api.__json(protection.open(v,p)),clear:()=>{}};
  const store=new api.PickerStore(root,readonly?['p']:[],adapter), records=new api.PickerRecords(root,adapter);
  let guard={};
  let key=SECRET;
  const host={store,records,paint:(_kind,v)=>v,guard:()=>guard,
    catalog:()=>api.__json([...Object.entries(JSON.parse(fs.readFileSync(path.join(root,'models.json'),'utf8')).providers??{}).flatMap(([provider,p])=>(p.models??[]).map(m=>({...m,provider,baseUrl:m.baseUrl??p.baseUrl,api:m.api??p.api}))),...catalogExtra]),
    requestRender:()=>{renders++;},viewport:()=>({width:120,height:40}),
    changed:async target=>{changes.push(target);if(refreshFailure)throw Error('synthetic refresh');},feedback:(...args)=>notices.push(args),isProtected:p=>readonly&&p==='p',
    saveKey:(...args)=>saves.push(args), fast,
    authDraft:async(p,id,k)=>{authCalls.push({draft:true,p:clone(p),id,key:k});await authWait?.();return api.__json({scope:{provider:p.id,modelId:id,endpoint:p.endpoint,api:p.api,credentialVersion:'not-trusted-host-version'},headers:k?{authorization:`Bearer ${k}`}:{}});},
    auth:async(p,id='catalog')=>{authCalls.push({draft:false,p,id});await authWait?.();const row=host.catalog().find(m=>m.provider===p&&m.id===id);const saved=store.snapshot().providers.find(x=>x.id===p);return api.__json({scope:{provider:p,modelId:id,endpoint:row?.baseUrl??saved.endpoint,api:row?.api??saved.api,credentialVersion:'not-trusted-host-version'},headers:{authorization:`Bearer ${key}`}});},
  };
  if(backend) host.providerCommit={
    snapshotCredential:async()=>({revision:'fixture-credential-CAS',kind:'absent'}),pending:async()=>null,recover:async()=>({status:'unchanged',code:'NO_PENDING'}),
    commit:async request=>{commits.push(clone(request));if(commitOutcome)return commitOutcome;
      assert.equal(request.expectedCredentialRevision,'fixture-credential-CAS');
      const c=request.change;
      if(c.kind==='add')store.addProviderWithModels(c.provider,c.models,request.expectedModelsRevision,guard);
      else store.editProvider(c.providerId,c.patch,request.expectedModelsRevision,guard);
      return {status:'committed',transactionId:'fixture-tx',modelsRevision:store.snapshot().revision,refreshRequired:true};},
  };
  const controller=new api.PickerActions(host); t.after(()=>controller.dispose());
  controller.subscribe(()=>{const s=JSON.stringify(controller.taskSnapshot());for(const value of [SECRET,'Bearer '+SECRET,'credentialVersion','not-trusted-host-version']) if(s.includes(value))leaks.push(value);});
  return {controller,api,host,store,records,calls,authCalls,commits,changes,notices,leaks,saves,root,setGuard:g=>{guard=g;},setKey:k=>{key=k;},get renders(){return renders;},disk:()=>JSON.parse(fs.readFileSync(path.join(root,'models.json'),'utf8'))};
}
function snap(f,kind){const raw=f.controller.taskSnapshot();const s=raw?clone(raw):null;if(kind)assert.equal(s?.kind,kind,JSON.stringify(s));return s;}
function field(f,id,value){const s=snap(f);const port=f.controller.formFields(s.viewId);assert.ok(port);const found=port.fields().find(x=>x.id===id);assert.ok(found,id);if(found.kind==='choice')found.setChoice(typeof value==='number'?value:found.choices.indexOf(value));else found.input.setValue(value);port.changed(id);return found;}
function activation(f,id,payload,{proof=true,identity}={}) {
  const s=snap(f);const action=s.actions.find(a=>a.id===id && (!identity || a.identity===identity));assert.ok(action,`no action ${id} in ${s.kind}`);
  return {type:'activate',viewId:s.viewId,id,identity:action.identity,...(payload===undefined?{}:{payload}),...(proof?{review:{reviewToken:s.reviewToken,layoutId:'synthetic-reviewed-layout',renderEpoch:1,width:120,height:40,complete:true}}:{})};
}
async function act(f,id,payload,options){await f.controller.dispatch(activation(f,id,payload,options));}
async function draft(f,{endpoint='https://draft.invalid/v1',key=SECRET,api}={}) {
  f.controller.open({},'new-provider');field(f,'name','New');field(f,'endpoint',endpoint);if(api)field(f,'api',api);const secret=field(f,'key',key);return secret;
}
async function select(f,ids=['a','b']){for(const modelId of ids){const s=snap(f,'basket');await f.controller.dispatch({type:'basket-toggle',viewId:s.viewId,modelId});}}
async function manual(f,ids=['new']){await act(f,'manual-id');const s=snap(f,'edit');assert.match(s.title,/手动输入模型ID/);const fields=f.controller.formFields(s.viewId).fields();assert.equal(fields.length,1);field(f,fields[0].id,ids.join(','));await act(f,'add-ids');snap(f,'basket');}
async function report(f){await act(f,'next-models');snap(f,'preflight');await act(f,'skip');snap(f,'report');}
async function finalCommit(f){await act(f,'commit');snap(f,'confirm');await act(f,'commit');}

test('unsaved draft uses reviewed own connection: one GET, two picks, references and independent single final commit',async t=>{
  const f=await fixture(t,{initial:{}});const secret=await draft(f);
  assert.equal(f.calls.length,0);assert.equal(f.authCalls.length,0);
  const s=snap(f,'connection');assert.equal(s.actions.find(a=>a.id==='connect').requiresReview,true);
  await act(f,'connect',undefined,{proof:false});assert.equal(f.calls.length,0);
  await act(f,'connect');snap(f,'basket');assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://draft.invalid/v1/models');assert.equal(f.authCalls[0].id,'catalog');assert.equal(f.authCalls[0].key,SECRET);
  assert.deepEqual(f.disk(),{});assert.equal(f.commits.length,0);
  await select(f);await act(f,'next-models');const p=snap(f,'preflight');assert.equal(p.plan.maxRequests,16);assert.equal(p.plan.maxOutputTokens,1024);assert.equal(p.plan.maxInputTokens,null);assert.equal(p.plan.authTimeoutMs,10000);
  await act(f,'skip');const r=snap(f,'report');assert.equal(r.models.length,2);assert.ok(r.models.every(m=>m.evidence.length===6&&!m.suite));
  await act(f,'commit');snap(f,'confirm');assert.equal(f.commits.length,0);assert.deepEqual(f.disk(),{});
  await act(f,'commit',undefined,{proof:false});assert.equal(f.commits.length,0);
  await act(f,'commit');assert.equal(f.commits.length,1);assert.equal(f.commits[0].change.credential.value,SECRET);assert.equal(f.disk().providers.new.models.length,2);assert.equal(f.changes.length,1);assert.equal(f.controller.active,false);assert.equal(secret.input.getValue(),'');assert.equal(f.saves.length,0);assert.deepEqual(f.leaks,[]);
});

test('full >512-character connection endpoint is available for review and mismatched layout/old tokens cannot authorize GET',async t=>{
  const f=await fixture(t);const endpoint='https://draft.invalid/'+ 'path/'.repeat(180);await draft(f,{endpoint});
  const s=snap(f,'connection');assert.equal(s.target.endpoint,endpoint);assert.ok(JSON.stringify(s.content).includes(endpoint));
  const old=activation(f,'connect');field(f,'key','SYNTHETIC-ROTATED-KEY');await f.controller.dispatch(old);assert.equal(f.calls.length,0);
  const bad=activation(f,'connect');bad.review.width=80;await f.controller.dispatch(bad);assert.equal(f.calls.length,0);
  await act(f,'connect');assert.equal(f.calls[0].url,endpoint+'models');assert.equal(f.authCalls[0].key,'SYNTHETIC-ROTATED-KEY');
});

test('missing coordinated provider backend refuses provider writes and never falls back to optional saveKey',async t=>{
  const f=await fixture(t,{initial:{},backend:false});await draft(f);await act(f,'manual-connection');await manual(f);await report(f);await act(f,'commit');const c=snap(f,'confirm');assert.equal(c.actions.find(a=>a.id==='commit').disabled,true);await act(f,'commit');assert.deepEqual(f.disk(),{});assert.equal(f.saves.length,0);assert.equal(f.changes.length,0);
});

test('back/connection edits invalidate old list, selected references and reports; clearing draft key withdraws it',async t=>{
  const f=await fixture(t,{initial:{}});await draft(f);await act(f,'connect');await select(f);await act(f,'back');snap(f,'connection');field(f,'endpoint','https://other.invalid/api');field(f,'key','');await act(f,'manual-connection');const b=snap(f,'basket');assert.deepEqual(b.candidates,[]);assert.deepEqual(b.selected,[]);assert.equal(b.listStatus,'idle');
  await act(f,'read-list');await act(f,'connect');assert.equal(f.authCalls.at(-1).key,undefined);assert.equal(f.calls.at(-1).url,'https://other.invalid/api/models');await select(f,['a']);await report(f);await finalCommit(f);assert.deepEqual(f.commits.at(-1).change.credential,{kind:'none'});
});

test('returning through an unchanged or name-only draft connection preserves picks/query/list and flow return identities',async t=>{
  const f=await fixture(t,{initial:{}});await draft(f);await act(f,'connect');await select(f,['a']);const before=snap(f,'basket');await f.controller.dispatch({type:'basket-query',viewId:before.viewId,query:'a'});await act(f,'back');field(f,'name','Renamed draft');await act(f,'manual-connection');const after=snap(f,'basket');assert.equal(after.viewId,before.viewId);assert.equal(after.flowId,before.flowId);assert.equal(after.query,'a');assert.deepEqual(after.selected.map(m=>m.id),['a']);assert.equal(after.listStatus,'loaded');assert.equal(f.calls.length,1);assert.equal(f.commits.length,0);
});

test('connection invalidation independently detects raw private-control changes even without changed notification',async t=>{
  const f=await fixture(t,{initial:{}});await draft(f);await act(f,'connect');await select(f,['a']);await act(f,'back');const port=f.controller.formFields(snap(f,'connection').viewId);port.fields().find(x=>x.id==='key').input.setValue('SYNTHETIC-RAW-EDIT');await act(f,'manual-connection');snap(f,'connection');await act(f,'manual-connection');const basket=snap(f,'basket');assert.deepEqual(basket.selected,[]);assert.deepEqual(basket.candidates,[]);assert.equal(f.calls.length,1);
});

test('basket query/navigation uses only cached task data, not files or authentication',async t=>{
  const f=await fixture(t,{catalogExtra:[{provider:'p',id:'candidate'}]});f.controller.open({provider:'p'},'add');const s=snap(f,'basket');const original=f.store.snapshot.bind(f.store);let reads=0;f.store.snapshot=()=>{reads++;return original();};await f.controller.dispatch({type:'basket-query',viewId:s.viewId,query:'can'});assert.equal(reads,0);assert.equal(f.authCalls.length,0);assert.equal(snap(f,'basket').candidates[0].id,'candidate');
});

test('unknown/read-only storage binding cannot write records or start auth/probes through stale enabled actions',async t=>{
  const f=await fixture(t,{initial:{}});await draft(f);f.host.storageWritable=false;await act(f,'connect');assert.equal(f.authCalls.length,0);assert.equal(f.calls.length,0);assert.equal(f.records.hasData(),false);await act(f,'manual-connection');await manual(f);await act(f,'next-models');const p=snap(f,'preflight');assert.equal(p.plan.capability.available,false);await act(f,'run',{planId:p.plan.id});assert.equal(f.records.hasData(),false);
});

test('invalid credential-bearing endpoint text never enters public snapshots or authorizes auth/network',async t=>{
  const f=await fixture(t,{initial:{}});f.controller.open({},'new-provider');field(f,'name','Private draft');field(f,'endpoint','https://name:URL-PRIVATE-PASSWORD@invalid.test/v1?api_key=URL-PRIVATE-TOKEN');const s=snap(f,'connection');assert.ok(!JSON.stringify(s).includes('URL-PRIVATE'));assert.equal(s.actions.find(a=>a.id==='connect').disabled,true);await act(f,'connect');assert.equal(f.authCalls.length,0);assert.equal(f.calls.length,0);
});

test('legacy HTTP and unknown protocol configurations remain editable without weakening probe HTTPS checks',async t=>{
  const initial=config();initial.providers.p.baseUrl='http://localhost:9999/v1';initial.providers.p.api='legacy-unknown';const f=await fixture(t,{initial});f.controller.open({provider:'p',modelId:'m'},'edit');field(f,'name','Edited legacy');await act(f,'save-form');await act(f,'apply-inspect');assert.equal(f.disk().providers.p.baseUrl,'http://localhost:9999/v1');assert.equal(f.disk().providers.p.api,'legacy-unknown');assert.equal(f.disk().providers.p.models[0].name,'Edited legacy');f.controller.open({provider:'p',modelId:'m'},'inspect');const p=snap(f,'preflight');assert.equal(p.plan.capability.available,false);await act(f,'run',{planId:p.plan.id});assert.equal(f.authCalls.length,0);assert.equal(f.calls.length,0);await act(f,'cancel-task');f.controller.open({provider:'p',kind:'provider'},'edit');await tick();field(f,'name','Legacy renamed');await act(f,'save-form');assert.deepEqual(f.commits.at(-1).change.patch,{name:'Legacy renamed'});
});

test('terminal cancel clears privately retained inputs and stale ports/commands cannot revive flows',async t=>{
  const f=await fixture(t);const secret=await draft(f);const s=snap(f);const port=f.controller.formFields(s.viewId);const stale=activation(f,'connect');await act(f,'cancel-task');assert.equal(secret.input.getValue(),'');assert.equal(f.controller.formFields(s.viewId),undefined);port.changed('key');await f.controller.dispatch(stale);assert.equal(f.controller.active,false);assert.equal(f.authCalls.length,0);
});

test('no late auth result can issue discovery GET after Ctrl+C abandonment',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const f=await fixture(t,{initial:{},authWait:()=>gate});await draft(f);const request=act(f,'connect');await tick();snap(f,'progress');await act(f,'cancel-task');release();await request;await tick();assert.equal(f.calls.length,0);assert.equal(f.controller.active,false);assert.equal(f.commits.length,0);
});

test('Esc-like stop during discovery returns to basket without later GET or task revival',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const f=await fixture(t,{initial:{},authWait:()=>gate});await draft(f);const request=act(f,'connect');await tick();await act(f,'stop-read');await request;const b=snap(f,'basket');assert.equal(b.listStatus,'cancelled');release();await tick();assert.equal(f.calls.length,0);assert.equal(snap(f).viewId,b.viewId);
});

test('saved config revision change while draft auth resolves prevents GET',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const f=await fixture(t,{initial:{},authWait:()=>gate});await draft(f);const request=act(f,'connect');await tick();fs.writeFileSync(path.join(f.root,'models.json'),JSON.stringify({external:true}),{mode:0o600});release();await request;assert.equal(f.calls.length,0);assert.equal(f.commits.length,0);assert.equal(snap(f).kind,'info');
});

test('real bounded batch performs 27 real synthetic executor requests, actual progress, complete reports and untested remainder',async t=>{
  const f=await fixture(t,{initial:{}});await draft(f);await act(f,'manual-connection');await manual(f,['a','b','c','d','e']);await act(f,'next-models');await act(f,'image',{include:true});const plan=snap(f,'preflight').plan;
  assert.equal(plan.targets.length,3);assert.equal(plan.maxRequests,27);assert.equal(plan.maxOutputTokens,1728);assert.equal(plan.maxDurationMs,270000);assert.equal(plan.items.length,27);
  const progress=[];const unsubscribe=f.controller.subscribe(()=>{const s=snap(f);if(s?.kind==='progress'&&s.progress)progress.push(clone(s));});
  assert.equal(f.calls.length,0);await act(f,'run',{planId:plan.id}, {proof:false});assert.equal(f.calls.length,0);
  await act(f,'run',{planId:plan.id});unsubscribe();const r=snap(f,'report');assert.equal(f.calls.length,27);assert.ok(progress.length>15);assert.ok(progress.some(p=>p.items.some(i=>i.status==='running')));assert.ok(progress.some(p=>p.items.some(i=>i.status==='passed')));
  assert.equal(r.models.filter(m=>m.suite).length,3);assert.equal(r.models.filter(m=>!m.suite).length,2);assert.ok(r.models.filter(m=>m.suite).every(m=>m.suite.checks.text.status==='passed'&&m.suite.checks.image.status==='passed'&&m.suite.checks.thinking.max.status==='passed'));assert.equal(f.commits.length,0);assert.deepEqual(f.leaks,[]);
});

test('unsupported API stays explicitly untested and does not offer a runnable fake suite',async t=>{
  const f=await fixture(t,{initial:{}});await draft(f,{api:'anthropic-messages'});await act(f,'manual-connection');await manual(f,['a']);await act(f,'next-models');const p=snap(f,'preflight');assert.equal(p.plan.capability.available,false);assert.equal(p.plan.maxRequests,0);await act(f,'run',{planId:p.plan.id});assert.equal(f.calls.length,0);await act(f,'skip');assert.equal(snap(f,'report').models[0].suite,undefined);
});

test('stop during a real suite produces partial reports and never starts subsequent requests/models',async t=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});let release;const gate=new Promise(resolve=>{release=resolve;});const f=await fixture(t,{initial:{},fetcher:async options=>{started();await gate;return response(options);}});
  await draft(f);await act(f,'manual-connection');await manual(f,['a','b']);await act(f,'next-models');const p=snap(f,'preflight');const run=act(f,'run',{planId:p.plan.id});await ready;await act(f,'cancel-checks');await run;const r=snap(f,'report');assert.equal(r.cancelled,true);assert.equal(r.models[0].suite.cancelled,true);assert.equal(r.models[0].suite.checks.text.status,'not-tested');assert.equal(r.models[1].suite,undefined);release();await tick();assert.equal(f.calls.length,1);assert.equal(snap(f).viewId,r.viewId);
});

test('Ctrl+C during real suite records one terminal cancellation without late report/probe revival',async t=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});let release;const gate=new Promise(resolve=>{release=resolve;});const f=await fixture(t,{initial:{},fetcher:async options=>{started();await gate;return response(options);}});
  await draft(f);const secret=f.controller.formFields(snap(f).viewId).fields().find(f=>f.id==='key');await act(f,'manual-connection');await manual(f,['a','b']);await act(f,'next-models');const p=snap(f,'preflight');const run=act(f,'run',{planId:p.plan.id});await ready;await act(f,'cancel-task');await run;
  assert.equal(f.controller.active,false);assert.equal(secret.input.getValue(),'');assert.equal(f.calls.length,1);
  const terminal=clone(f.records.tests());assert.equal(terminal.length,1);assert.equal(terminal[0].cancelled,true);assert.equal(terminal[0].scope.modelId,'a');assert.equal(terminal[0].checks.text.status,'not-tested');
  assert.ok(!JSON.stringify(terminal).includes(SECRET));assert.equal(f.controller.taskSnapshot(),null);
  release();await tick();await tick();
  assert.equal(f.controller.active,false);assert.equal(f.controller.taskSnapshot(),null);assert.equal(secret.input.getValue(),'');assert.equal(f.calls.length,1);
  assert.equal(f.records.tests().length,1);assert.deepEqual(clone(f.records.tests()),terminal,'late fetch must not append or replace the terminal cancellation');
});

test('saved-model later inspection uses model override endpoint and finish never mutates enabled config',async t=>{
  const initial=config();initial.providers.p.models[0].baseUrl='https://override.invalid/private-path';const f=await fixture(t,{initial});const before=f.disk();f.controller.open({provider:'p',modelId:'m'},'inspect');const p=snap(f,'preflight');assert.equal(p.plan.targets[0].connection.endpoint,'https://override.invalid/private-path');await act(f,'run',{planId:p.plan.id});const r=snap(f,'report');assert.ok(r.models[0].suite);assert.ok(f.calls.every(c=>c.url==='https://override.invalid/private-path/chat/completions'));await act(f,'finish-inspect');assert.deepEqual(f.disk(),before);assert.equal(f.changes.length,0);assert.equal(f.records.tests().length,1);
});

test('saved-model adjust/apply requires independent visible diff confirmation and preserves unknown fields/overrides',async t=>{
  const initial=config();initial.providers.p.models[0].baseUrl='https://override.invalid/v1';const f=await fixture(t,{initial});f.controller.open({provider:'p',modelId:'m'},'inspect');await act(f,'skip');await act(f,'adjust',{modelId:'m'});field(f,'context','65536');field(f,'output','4096');field(f,'thinking:xhigh','=');field(f,'thinking:max','=-');await act(f,'save-form');const r=snap(f,'report');assert.equal(r.diffs.length,1);assert.equal(f.disk().providers.p.models[0].contextWindow,128000);await act(f,'apply-inspect');const c=snap(f,'confirm');assert.equal(c.purpose,'apply-inspect');await act(f,'apply-inspect',undefined,{proof:false});assert.equal(f.disk().providers.p.models[0].contextWindow,128000);await act(f,'apply-inspect');const saved=f.disk();assert.equal(saved.providers.p.models[0].contextWindow,65536);assert.deepEqual(saved.providers.p.models[0].thinkingLevelMap,{xhigh:'',max:'-'});assert.deepEqual(saved.providers.p.models[0].unknown,{keep:3});assert.equal(saved.providers.p.models[0].baseUrl,'https://override.invalid/v1');assert.deepEqual(saved.rootUnknown,{keep:1});
});

test('readonly inspection can run/report but never apply, even after private parameter adjustment',async t=>{
  const f=await fixture(t,{readonly:true});const before=f.disk();f.controller.open({provider:'p',modelId:'m'},'inspect');await act(f,'skip');await act(f,'adjust',{modelId:'m'});field(f,'context','65536');await act(f,'save-form');const r=snap(f,'report');assert.equal(r.actions.find(a=>a.id==='apply-inspect').disabled,true);await act(f,'apply-inspect');assert.deepEqual(f.disk(),before);
});

test('all seven thinking levels preserve undefined / explicit empty map / null / literal empty, minus and equals',async t=>{
  const maps=[undefined,{}, {off:null,minimal:'',low:'-',medium:'=',high:'==',xhigh:'extra-high',max:'maximum'}];
  for(const map of maps){const initial=config();if(map!==undefined)initial.providers.p.models[0].thinkingLevelMap=map;const f=await fixture(t,{initial});f.controller.open({provider:'p',modelId:'m'},'edit');field(f,'name','Edited name');await act(f,'save-form');
    snap(f,'confirm');await act(f,'apply-inspect');
    assert.deepEqual(f.disk().providers.p.models[0].thinkingLevelMap,map);
    f.controller.open({provider:'p',modelId:'m'},'edit');const port=f.controller.formFields(snap(f,'edit').viewId);
    assert.equal(port.fields().find(x=>x.id==='map-mode').choice(),map===undefined?0:1);
    const encode=v=>v===undefined?'':v===null?'-':v===''||v==='-'||v.startsWith('=')?'='+v:v;
    for(const level of ['off','minimal','low','medium','high','xhigh','max'])assert.equal(port.fields().find(x=>x.id==='thinking:'+level).input.getValue(),encode(map?.[level]));
  }
});

test('explicit Pi-default reset deletes an existing map only after independent diff consent and preserves unknown fields',async t=>{
  const maps=[{}, {off:null,minimal:'',low:'-',medium:'=',high:'==',xhigh:'extra-high',max:'maximum'}];
  for(const mode of ['edit','inspect'])for(const map of maps){
    const initial=config();initial.providers.p.models[0].thinkingLevelMap=map;initial.providers.p.models[0].baseUrl='https://override.invalid/v1';
    const f=await fixture(t,{initial});const edits=[];const put=f.store.putModel.bind(f.store);
    f.store.putModel=(...args)=>{edits.push(clone(args[5]??null));return put(...args);};
    f.controller.open({provider:'p',modelId:'m'},mode);
    if(mode==='inspect'){await act(f,'skip');await act(f,'adjust',{modelId:'m'});}
    field(f,'map-mode','Pi默认（未配置）');await act(f,'save-form');
    if(mode==='inspect'){
      const r=snap(f,'report');assert.equal(r.models[0].parameters.thinkingLevelMap,undefined);await act(f,'apply-inspect');
    }
    const c=snap(f,'confirm');assert.equal(c.purpose,'apply-inspect');
    const diff=c.diffs[0].fields.find(x=>x.field==='thinkingLevelMap');assert.deepEqual(diff.before,{present:true,value:map});assert.deepEqual(diff.after,{present:false});
    assert.deepEqual(f.disk().providers.p.models[0].thinkingLevelMap,map);assert.equal(edits.length,0);
    await act(f,'apply-inspect',undefined,{proof:false});assert.deepEqual(f.disk().providers.p.models[0].thinkingLevelMap,map);assert.equal(edits.length,0);
    await act(f,'apply-inspect');const saved=f.disk();assert.equal(Object.hasOwn(saved.providers.p.models[0],'thinkingLevelMap'),false);
    assert.deepEqual(edits,[{unsetThinkingLevelMap:true}]);assert.deepEqual(saved.providers.p.models[0].unknown,{keep:3});assert.equal(saved.providers.p.models[0].baseUrl,'https://override.invalid/v1');
    assert.deepEqual(saved.providers.p.providerUnknown,{keep:2});assert.deepEqual(saved.rootUnknown,{keep:1});assert.equal(f.changes.length,1);assert.equal(f.calls.length,0);
  }
  // A name-only edit of an absent, empty or literal map must never request deletion.
  for(const map of [undefined,...maps]){
    const initial=config();if(map!==undefined)initial.providers.p.models[0].thinkingLevelMap=map;const f=await fixture(t,{initial});
    const put=f.store.putModel.bind(f.store);const edits=[];f.store.putModel=(...args)=>{edits.push(args[5]);return put(...args);};
    f.controller.open({provider:'p',modelId:'m'},'edit');field(f,'name','Name-only');await act(f,'save-form');await act(f,'apply-inspect');
    assert.deepEqual(edits,[undefined]);assert.deepEqual(f.disk().providers.p.models[0].thinkingLevelMap,map);
  }
});

test('report reuse binds exact endpoint/API/credentials and does not send model requests',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p',modelId:'m'},'inspect');let p=snap(f,'preflight');await act(f,'run',{planId:p.plan.id});const before=f.calls.length;assert.equal(before,8);await act(f,'recheck');p=snap(f,'preflight');await act(f,'reuse',{planId:p.plan.id});assert.equal(f.calls.length,before);assert.equal(snap(f,'report').models[0].reused,true);
  await act(f,'recheck');f.setKey('SYNTHETIC-OTHER');p=snap(f,'preflight');await act(f,'reuse',{planId:p.plan.id});assert.equal(f.calls.length,before);assert.equal(snap(f,'report').models[0].suite,undefined);
});

test('final adoption re-resolves credentials and refuses a previously valid suite after key rotation',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p'},'add');await manual(f,['added']);await act(f,'next-models');const p=snap(f,'preflight');await act(f,'run',{planId:p.plan.id});await act(f,'commit');f.setKey('SYNTHETIC-ROTATED');await act(f,'commit');snap(f,'report');assert.equal(f.disk().providers.p.models.length,1);assert.equal(f.changes.length,0);assert.equal(f.calls.length,8);
});

test('report expiration is revalidated at final commit',async t=>{
  const clock={now:1_800_000_000_000};const f=await fixture(t,{clock});f.controller.open({provider:'p'},'add');await manual(f,['added']);await act(f,'next-models');const p=snap(f,'preflight');await act(f,'run',{planId:p.plan.id});await act(f,'commit');clock.now+=3_600_000;await act(f,'commit');snap(f,'report');assert.equal(f.disk().providers.p.models.length,1);
});

test('per-field attested evidence keeps its own time/test link and expiry, independent of fresh suite lifetime',async t=>{
  const clock={now:1_800_000_000_000};const f=await fixture(t,{clock});const credentialVersion=f.records.credentialVersion(f.api.__json({authorization:`Bearer ${SECRET}`}));f.records.append(f.api.__json({kind:'probe',report:{id:'exact-context-proof',scope:{provider:'p',modelId:'m',endpoint:'https://saved.invalid/v1',api:'openai-completions',credentialVersion},testedAt:clock.now-1000,expiresAt:clock.now+500,status:'passed',fields:{contextWindow:256000},verifiedFields:['contextWindow'],evidence:{contextWindow:{kind:'exact-limit'}}}}));
  f.controller.open({provider:'p',modelId:'m'},'inspect');const p=snap(f,'preflight');await act(f,'run',{planId:p.plan.id});const r=snap(f,'report');assert.equal(r.models[0].parameters.contextWindow,256000);const evidence=r.models[0].evidence.find(e=>e.field==='contextWindow');assert.equal(evidence.testId,'exact-context-proof');assert.equal(evidence.when,clock.now-1000);await act(f,'apply-inspect');clock.now+=500;await act(f,'apply-inspect');assert.equal(snap(f,'report').models[0].applicable,false);assert.equal(f.disk().providers.p.models[0].contextWindow,128000);
});

test('provider edited with blank key uses keep intent; unchanged connection fields are not rewritten',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p',kind:'provider'},'edit');await tick();field(f,'name','Renamed');await act(f,'save-form');assert.equal(f.commits.length,1);assert.deepEqual(f.commits[0].change.credential,{kind:'keep'});assert.deepEqual(f.commits[0].change.patch,{name:'Renamed'});assert.deepEqual(f.disk().providers.p.providerUnknown,{keep:2});assert.equal(f.saves.length,0);
});

test('coordinated unchanged / pending outcomes never refresh or falsely report success; committed refresh failure is not retried',async t=>{
  for(const outcome of [{status:'unchanged',code:'CONFLICT'},{status:'pending',transactionId:'tx',code:'IO_ERROR',state:'auth-only'}]){
    const f=await fixture(t,{initial:{},commitOutcome:outcome});const secret=await draft(f);await act(f,'manual-connection');await manual(f);await report(f);await finalCommit(f);assert.equal(f.changes.length,0);assert.equal(f.commits.length,1);assert.deepEqual(f.disk(),{});
    if(outcome.status==='pending'){assert.equal(snap(f).kind,'info');assert.equal(secret.input.getValue(),'');assert.match(JSON.stringify(snap(f)),/可能已部分写入/);}else snap(f,'report');
  }
  const f=await fixture(t,{initial:{},refreshFailure:true});const secret=await draft(f);await act(f,'manual-connection');await manual(f);await report(f);await finalCommit(f);assert.equal(f.commits.length,1);assert.equal(f.changes.length,1);assert.equal(f.disk().providers.new.models.length,1);assert.equal(secret.input.getValue(),'');const s=snap(f,'info');assert.match(JSON.stringify(s),/已保存/);assert.ok(!s.actions.some(a=>a.id==='commit'));await act(f,'back');assert.equal(f.commits.length,1);
});

test('authoritative empty discovery never resurrects local/foreign candidates; failed refresh preserves same-connection picks',async t=>{
  let mode='empty';const f=await fixture(t,{fetcher:options=>mode==='empty'?Response.json({data:[]}):new Response('',{status:429}),catalogExtra:[{provider:'p',id:'local'},{provider:'foreign',id:'not-ours'}]});f.controller.open({provider:'p'},'add');assert.deepEqual(snap(f,'basket').candidates.map(m=>m.id),['local']);await manual(f,['manual']);await act(f,'read-list');await act(f,'connect');assert.deepEqual(snap(f,'basket').candidates,[]);assert.equal(snap(f).selected.length,1);mode='failed';await act(f,'read-list');await act(f,'connect');const b=snap(f,'basket');assert.equal(b.listStatus,'failed');assert.equal(b.selected[0].id,'manual');assert.deepEqual(b.candidates,[]);
});

test('preflight binding is pinned to reviewed endpoint, not a later same-revision registry override',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p',modelId:'m'},'inspect');const p=snap(f,'preflight');const original=f.host.catalog;f.host.catalog=()=>f.api.__json(original().map(m=>({...m,baseUrl:'https://changed.invalid/v1'})));await act(f,'run',{planId:p.plan.id});assert.equal(f.calls.length,0);assert.equal(f.authCalls.length,0);
});

test('archive/remove/undo are guarded real store operations, with no permanent delete or current/default side effects',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p',modelId:'m',kind:'model'},'remove');snap(f,'confirm');assert.equal(f.disk().providers.p.models.length,1);await act(f,'confirm-remove',undefined,{proof:false});assert.equal(f.disk().providers.p.models.length,1);await act(f,'confirm-remove');assert.equal(f.disk().providers.p.models.length,0);assert.ok(f.controller.undoLabel);f.controller.undoLast();await tick();assert.equal(f.disk().providers.p.models.length,1);assert.deepEqual(f.disk().providers.p.models[0].unknown,{keep:3});assert.equal(f.controller.undoLabel,null);
});

test('remove rechecks current/default/busy after review and refuses stale safety state',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p',modelId:'m',kind:'model'},'remove');f.setGuard({current:{provider:'p',id:'m'}});await act(f,'confirm-remove');assert.equal(f.disk().providers.p.models.length,1);assert.equal(f.store.listArchives().length,0);
});

test('replacement is explicit then removal needs separate fresh confirmation; cancel does not undo a successful replacement',async t=>{
  const initial=config();initial.providers.q={name:'Other',baseUrl:'https://other.invalid/v1',api:'openai-completions',models:[model('next')]};const f=await fixture(t,{initial});let current={provider:'p',id:'m'};f.setGuard({current,default:current});f.host.available=()=>[{provider:'q',id:'next'}];const replacements=[];f.host.replace=async(ref,targets,expected)=>{replacements.push({ref,targets,expected});current=ref;f.setGuard({current,default:ref});};
  f.controller.open({provider:'p',kind:'provider'},'remove');const s=snap(f,'confirm');assert.equal(s.purpose,'replacement');await act(f,'replacement',{provider:'q',id:'next'});assert.equal(replacements.length,0);await act(f,'commit');assert.equal(replacements.length,1);assert.equal(snap(f,'confirm').purpose,'remove');assert.equal(f.disk().providers.p.models.length,1);await act(f,'cancel-confirm');assert.equal(f.controller.active,false);assert.equal(current.provider,'q');assert.ok(f.disk().providers.p);
});

test('archive restoration preserves collisions by generating provider copy, stable archive action identity and review gate',async t=>{
  const f=await fixture(t);const revision=f.store.snapshot().revision;f.store.archiveProvider('p',revision,{});f.store.addProviderWithModels(f.api.__json({id:'p',name:'Replacement',endpoint:'https://new.invalid/v1',api:'openai-completions'}),f.api.__json([model('other')]),f.store.snapshot().revision,{});
  f.controller.open({},'archives');const a=snap(f,'archives').entries[0];const bad=activation(f,'restore',{archiveId:'wrong'},{identity:`restore:${a.id}`});await f.controller.dispatch(bad);snap(f,'archives');await act(f,'restore',{archiveId:a.id},{identity:`restore:${a.id}`});await act(f,'confirm-restore',undefined,{proof:false});assert.equal(Object.keys(f.disk().providers).length,1);await act(f,'confirm-restore');assert.ok(f.disk().providers['p-restored']);assert.equal(f.disk().providers.p.models[0].id,'other');
});

test('Fast retains all tiers and complete observations while policy changes remain host-owned',async t=>{
  let tier='ultrafast';const calls=[];const fast={snapshot:()=>({modelLabel:'Current model',tier,supported:true,active:true,ultrafastEnabled:true}),setTier:t=>{calls.push(t);tier=t;return true;},describe:()=> 'request tier: ultrafast\nresponse tier: unknown\nhistory: branch-owned'};
  const f=await fixture(t,{fast});f.setGuard({current:{provider:'p',id:'m'}});f.controller.openFast();let s=snap(f,'fast');assert.equal(s.session.tier,'ultrafast');assert.equal(s.observations.length,3);assert.equal(s.session.current.id,'m');await act(f,'fast-priority');await act(f,'fast-ultrafast');await act(f,'fast-off');assert.deepEqual(calls,['priority','ultrafast','off']);await act(f,'fast-observations');assert.match(JSON.stringify(snap(f,'info')),/branch-owned/);assert.equal(f.calls.length,0);assert.equal(f.changes.length,0);
});

test('storage read-only and busy guards are independent of UI-disabled state',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p'},'add');await manual(f);await report(f);await act(f,'commit');f.host.storageWritable=false;await act(f,'commit');assert.equal(f.disk().providers.p.models.length,1);assert.equal(f.changes.length,0);
});

test('stable view and flow identities preserve basket/report/editor return frames while fresh tokens invalidate consent',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p'},'add');await manual(f,['one','two']);const basket=snap(f,'basket');await act(f,'next-models');const preflight=snap(f,'preflight');await act(f,'back');assert.equal(snap(f,'basket').viewId,basket.viewId);assert.equal(snap(f).flowId,basket.flowId);await act(f,'next-models');assert.equal(snap(f,'preflight').viewId,preflight.viewId);assert.notEqual(snap(f).reviewToken,preflight.reviewToken);await act(f,'skip');const report=snap(f,'report');assert.ok(report.reviewToken);await act(f,'adjust',{modelId:'one'});const edit=snap(f,'edit');await act(f,'back');assert.equal(snap(f,'report').viewId,report.viewId);await act(f,'adjust',{modelId:'one'});assert.equal(snap(f,'edit').viewId,edit.viewId);
});

test('xhigh/max acceptance suggestions are retained but require explicit per-field adoption',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p',modelId:'m'},'inspect');const p=snap(f,'preflight');await act(f,'run',{planId:p.plan.id});assert.equal(snap(f,'report').models[0].parameters.thinkingLevelMap,undefined);await act(f,'adjust',{modelId:'m'});field(f,'suggestion','采用接口接受建议');await act(f,'save-form');assert.deepEqual(snap(f,'report').models[0].parameters.thinkingLevelMap,{xhigh:'xhigh',max:'max'});assert.equal(f.disk().providers.p.models[0].thinkingLevelMap,undefined);await act(f,'apply-inspect');await act(f,'apply-inspect');assert.deepEqual(f.disk().providers.p.models[0].thinkingLevelMap,{xhigh:'xhigh',max:'max'});
});

test('changing config during real suite cannot strand progress or make stale partial results applicable',async t=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});let release;const gate=new Promise(resolve=>{release=resolve;});const f=await fixture(t,{fetcher:async options=>{started();await gate;return response(options);}});f.controller.open({provider:'p',modelId:'m'},'inspect');const p=snap(f,'preflight');const run=act(f,'run',{planId:p.plan.id});await ready;const external=f.disk();external.external=true;fs.writeFileSync(path.join(f.root,'models.json'),JSON.stringify(external),{mode:0o600});release();await run;const r=snap(f,'report');assert.equal(r.models[0].applicable,false);assert.equal(r.actions.find(a=>a.id==='apply-inspect').disabled,true);assert.equal(f.calls.length,1);await act(f,'back');assert.equal(f.controller.active,false);
});

test('even skipped-check final commit is bound to the actual full connection reviewed at final consent',async t=>{
  const f=await fixture(t);f.controller.open({provider:'p'},'add');await manual(f);await report(f);await act(f,'commit');const original=f.host.catalog;f.host.catalog=()=>f.api.__json([...original(),{provider:'p',id:'new',baseUrl:'https://changed.invalid/v1',api:'openai-completions'}]);await act(f,'commit');assert.equal(f.disk().providers.p.models.length,1);assert.equal(f.changes.length,0);assert.equal(f.calls.length,0);
});

test('ordinary pending journals recover through guarded real store recovery, never a credential bypass',async t=>{
  const f=await fixture(t);const store=f.store;
  // Become busy after the real store stages its protected journal.
  // The callback is a trusted guard seam, not a synthetic transaction executor.
  let checks=0;const g={recheck:()=>{checks++;return checks>=5?{busy:true}:{};}};
  try{store.putModels('p',f.api.__json([model('pending')]),store.snapshot().revision,g);}catch{}
  assert.equal(store.hasPending(),true);
  f.host.providerCommit.pending=async()=>{const e=Error('ordinary journal');Object.defineProperty(e,'code',{value:'LEGACY_PENDING'});throw e;};
  f.controller.open({},'recover');await tick();const s=snap(f,'recovery');assert.ok(s.pendingId);await act(f,'confirm-recover',undefined,{proof:false});assert.equal(store.hasPending(),true);await act(f,'confirm-recover');assert.equal(store.hasPending(),false);assert.equal(f.disk().providers.p.models.some(m=>m.id==='pending'),true);assert.equal(f.changes.length,1);
});

test('missing parameter properties are represented as absent in inspection diffs, not falsely as prior defaults',async t=>{
  const initial=config();initial.providers.p.models=[{id:'m',unknown:{keep:true}}];const f=await fixture(t,{initial});f.controller.open({provider:'p',modelId:'m'},'edit');field(f,'name','Explicit');await act(f,'save-form');const c=snap(f,'confirm');const context=c.diffs[0].fields.find(x=>x.field==='contextWindow');assert.deepEqual(context.before,{present:false});assert.equal(context.after.value,128000);await act(f,'apply-inspect');assert.deepEqual(f.disk().providers.p.models[0].unknown,{keep:true});
});

test('subscription snapshots are detached public projections, never secret inputs/auth scopes/config bags',async t=>{
  const f=await fixture(t);await draft(f);const s=snap(f,'connection');s.target.endpoint='https://mutated.invalid';s.actions.length=0;assert.notEqual(snap(f).target.endpoint,s.target.endpoint);assert.ok(snap(f).actions.length);assert.ok(f.renders>3);assert.deepEqual(f.leaks,[]);assert.ok(!JSON.stringify(snap(f)).includes('providerUnknown'));f.controller.dispose();assert.equal(f.controller.taskSnapshot(),null);
});
