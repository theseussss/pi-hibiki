import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadTypeScript} from './model-pick-loader.mjs';
const api=loadTypeScript(fileURLToPath(new URL('../lib/model-pick/limit-catalog.ts',import.meta.url)));
const j=x=>JSON.parse(JSON.stringify(x));
const model=(extra={})=>({id:'exact/id',contextWindow:160000,maxTokens:8000,...extra});
const read=(r,local=false,v='1.4.0')=>j(api.readLimitCatalog(r,'openai-codex','exact/id',v,local));
function registry(extra={}){
 let calls=0;const base=model(),builtin={getModels(){calls++;return[base];}};
 const r={runtime:{builtins:new Map([['openai-codex',builtin]]),virtualModels:new Map()},...extra};
 return {r,base,calls:()=>calls};
}
test('loaded builtin directory is exact-ID, detached and offline; no auth/config/projection read',()=>{
 const f=registry();let forbidden=0;
 for(const k of ['credentials','config','snapshot'])Object.defineProperty(f.r.runtime,k,{get(){forbidden++;throw Error('not metadata');}});
 f.r.getApiKeyAndHeaders=()=>{forbidden++;throw Error('auth forbidden');};
 const result=read(f.r);assert.deepEqual(result.catalog,{contextWindow:160000,maxTokens:8000});
 result.catalog.contextWindow=1;assert.equal(f.base.contextWindow,160000);assert.equal(forbidden,0);assert.equal(f.calls(),1);
 assert.equal(api.readLimitCatalog(f.r,'openai','exact/id','1.4.0',false).catalog,null);
 assert.equal(api.readLimitCatalog(f.r,'openai-codex','other/id','1.4.0',false).catalog,null);
});
test('static legacy chat replacement wins over builtin/local model definitions',()=>{
 const f=registry({getRegisteredProviderConfig:()=>({models:[model({contextWindow:240000}),model({type:'image'})]})});
 assert.deepEqual(read(f.r,true).catalog,{contextWindow:240000,maxTokens:8000});assert.equal(f.calls(),0);
});
for(const [name,registration]of[
 ['absent target',{models:[model({id:'other'})]}],['duplicate chat IDs',{models:[model(),model()]}],
 ['classifier only',{models:[model({type:'classifier'})]}],['incomplete dimensions',{models:[model({maxTokens:undefined})]}],
 ['dynamic list',{models:[model()],refreshModels(){throw Error('never invoke');}}],
 ['OAuth projection',{models:[model()],oauth:{modifyModels(){throw Error('never invoke');}}}],
])test(`uncertain replacement (${name}) stays unknown without builtin fallback`,()=>{
 const f=registry({getRegisteredProviderConfig:()=>registration});assert.equal(read(f.r).catalog,null);assert.equal(f.calls(),0);
});
test('metadata accessors are not executed; malformed runtime/version never guesses bundled values',()=>{
 let hits=0;const projected={models:[model()],oauth:{}};
 Object.defineProperty(projected.oauth,'modifyModels',{get(){hits++;throw Error('secret');}});
 const f=registry({getRegisteredProviderConfig:()=>projected});assert.equal(read(f.r).catalog,null);assert.equal(hits,0);
 const r={};Object.defineProperty(r,'runtime',{get(){hits++;throw Error('secret');}});
 assert.equal(read(r).catalog,null);assert.equal(hits,0);assert.equal(read(f.r,false,'1.5.0').catalog,null);assert.equal(f.calls(),0);
});
test('native extension base callback is not executed and local base shadow remains unknown',()=>{
 let called=0;const f=registry({getRegisteredNativeProvider:()=>({getModels(){called++;throw Error('third party');}})});
 assert.equal(read(f.r).catalog,null);assert.equal(called,0);assert.equal(f.calls(),0);
 const b=registry();assert.equal(read(b.r,true).catalog,null);assert.equal(b.calls(),0);
});
test('virtual aliases are excluded while exact physical IDs retain their narrow capability',()=>{
 const f=registry();f.r.runtime.virtualModels.set('openai-codex',new Map([['virtual',{}]]));
 assert.equal(api.isVirtualLimitTarget(f.r,'openai-codex','virtual','1.4.0'),true);
 assert.equal(api.isVirtualLimitTarget(f.r,'openai-codex','exact/id','1.4.0'),false);
 assert.equal(api.isVirtualLimitTarget(f.r,'other','virtual','1.4.0'),false);
 assert.equal(api.isVirtualLimitTarget(f.r,'openai-codex','exact/id','unknown'),true);
});
test('pair whitelist rejects invalid dimensions and does not read private extra fields',()=>{
 const m=model();Object.defineProperty(m,'headers',{get(){throw Error('never read');}});
 assert.deepEqual(j(api.limitPair(m)),{contextWindow:160000,maxTokens:8000});
 for(const n of [0,-1,1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'100'])assert.equal(api.limitPair(model({contextWindow:n})),null);
});
