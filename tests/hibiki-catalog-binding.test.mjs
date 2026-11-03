import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,baseConfig} from './model-pick-ui-harness.mjs';

test('own-list discovery uses provider defaults, not the first model override endpoint or API',async t=>{
 const config=baseConfig();config.providers.p00.models[0].baseUrl='https://model-override.invalid/only-model';config.providers.p00.models[0].api='openai-responses';
 const p=await harness(t,{config,fetcher:()=>new Response(JSON.stringify({data:[{id:'m0'},{id:'fresh-model'}]}),{headers:{'content-type':'application/json'}})});
 const before=structuredClone(p.config());p.action('add-model');p.action('read-list');assert.equal(p.calls.length,0);p.action('connect');await p.waitForView('basket');
 assert.equal(p.calls.length,1);assert.equal(p.calls[0][0],'https://example.test/v1/models');assert.equal(p.calls[0][1].method,'GET');assert.deepEqual(p.config(),before);
 assert.match(p.readContent(),/fresh-model/);assert.ok(!p.readContent().includes('model-override.invalid'));
});

test('later model inspection retains its actual model-level endpoint and API',async t=>{
 const config=baseConfig();config.providers.p00.models[0].baseUrl='https://model-override.invalid/only-model';config.providers.p00.models[0].api='openai-responses';
 const p=await harness(t,{config,fetcher:()=>new Response('',{status:401})});p.action('inspect');assert.match(p.readContent(),/model-override.invalid\/only-model/);p.action('run');await p.waitForView('report');
 assert.equal(p.calls.length,1);assert.equal(p.calls[0][0],'https://model-override.invalid/only-model/responses');assert.equal(p.calls[0][1].method,'POST');assert.equal(p.current().id,'m0');
});
