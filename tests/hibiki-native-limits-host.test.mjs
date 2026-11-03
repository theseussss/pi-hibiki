import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {harness,baseConfig} from './model-pick-ui-harness.mjs';
const native={provider:'native-provider',id:'native-m'};
const fixture=(t,options={})=>harness(t,{includeNative:true,currentRef:native,terminalColumns:120,...options});
const bytes=(p,name)=>fs.readFileSync(p.root+'/'+name,'utf8');
const auth=' {"native-provider":{"type":"oauth","access":"EXAMPLE-not-real","refresh":"EXAMPLE-refresh","future":true},"unrelated":{"keep":42}}\n';
async function commit(p){p.action('save-form');assert.equal(p.debug().view,'confirm');p.action('commit-limits');await p.waitForView('matrix');}
function noRequests(p){assert.equal(p.authCalls(),0);assert.equal(p.calls.length,0);}
test('native edit2 commits context-only override then refreshes/rebinds current without auth/default changes',async t=>{
 const p=await fixture(t,{fixtureFiles:{'auth.json':auth}}),before=p.config(),settings=bytes(p,'settings.json');
 p.action('edit-model');assert.match(p.readContent(),/本地限制|本地预算/);p.replace('64000');
 p.action('save-form');assert.equal(p.debug().view,'confirm');assert.deepEqual(p.config(),before);assert.equal(p.selections.length,0);
 p.action('commit-limits');await p.waitForView('matrix');
 assert.deepEqual(p.config(),{...before,providers:{...before.providers,'native-provider':{modelOverrides:{'native-m':{contextWindow:64000}}}}});
 assert.equal(p.current().contextWindow,64000);assert.equal(p.current().maxTokens,8192);assert.equal(p.selections.length,1);
 assert.equal(bytes(p,'auth.json'),auth);assert.equal(bytes(p,'settings.json'),settings);noRequests(p);
});
test('native two-field save, reset and field-level inheritance retain unrelated override metadata',async t=>{
 const config=baseConfig();config.providers['native-provider']={futureProvider:{keep:true},modelOverrides:{'native-m':{contextWindow:64000,maxTokens:4096,name:'Keep name',future:{keep:1}},other:{contextWindow:32000}}};
 const p=await fixture(t,{config,fixtureFiles:{'auth.json':auth}});const initial=p.config();
 p.action('edit-model');p.replace('');await commit(p);
 const expected=structuredClone(initial);delete expected.providers['native-provider'].modelOverrides['native-m'].contextWindow;
 assert.deepEqual(p.config(),expected);assert.equal(p.current().contextWindow,128000);assert.equal(p.current().maxTokens,4096);
 p.action('edit-model');p.action('reset-limits');assert.equal(p.debug().view,'confirm');assert.deepEqual(p.config(),expected);
 p.action('commit-limits');await p.waitForView('matrix');delete expected.providers['native-provider'].modelOverrides['native-m'].maxTokens;
 assert.deepEqual(p.config(),expected);assert.equal(p.current().maxTokens,8192);assert.equal(bytes(p,'auth.json'),auth);noRequests(p);
});
test('native no-op/back/cancel and invalid limits create no override or journal',async t=>{
 const p=await fixture(t),before=bytes(p,'models.json');
 p.action('edit-model');p.action('save-form');assert.equal(p.debug().view,'matrix');assert.equal(bytes(p,'models.json'),before);
 p.action('edit-model');p.replace('100');p.action('save-form');assert.equal(p.debug().view,'edit');assert.match(p.screen(),/输出上限不能大于上下文/);
 p.action('back');assert.equal(bytes(p,'models.json'),before);assert.equal(p.protection.state.seals.length,0,'no-op/cancel/invalid input must not create a protected journal');
 assert.equal(p.selections.length,0);noRequests(p);
});
test('native save rechecks file revision after independent confirmation without clobbering external changes',async t=>{
 const p=await fixture(t);p.action('edit-model');p.replace('64000');p.action('save-form');
 const external=p.config();external.outsideEdit={keep:true};const raw=JSON.stringify(external);fs.writeFileSync(p.configFile,raw);
 p.action('commit-limits');await p.flush();assert.match(p.screen(),/CONFLICT/);assert.equal(bytes(p,'models.json'),raw);assert.equal(p.selections.length,0);noRequests(p);
});
test('native metadata refresh does not undo an intervening trusted model selection (B1)',async t=>{
 let release,entered;const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{entered=r;});
 const p=await fixture(t,{onRefresh:async(_o,count)=>{if(count===2){entered();await gate;}}});
 p.action('edit-model');p.replace('64000');p.action('save-form');p.action('commit-limits');
 await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('refresh not entered')),3000))]);
 p.setCurrent('p01','m1');release();await p.waitForView('matrix');
 assert.equal(p.current().provider,'p01');assert.equal(p.current().id,'m1');assert.equal(p.selections.length,0);
 assert.equal(p.config().providers['native-provider'].modelOverrides['native-m'].contextWindow,64000);noRequests(p);
});
test('unsupported metadata adapter keeps native full editing read-only',async t=>{
 const p=await fixture(t,{registryVersion:'unverified'}),before=bytes(p,'models.json');p.action('edit-model');assert.match(p.screen(),/只读/);
 p.action('save-form');assert.equal(bytes(p,'models.json'),before);assert.equal(p.selections.length,0);noRequests(p);
});
