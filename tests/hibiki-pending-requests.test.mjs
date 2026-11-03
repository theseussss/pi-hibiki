import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {harness} from './model-pick-ui-harness.mjs';

function unknownPending(p){
 const dir=path.join(p.root,'model-pick-data');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 // An untrusted/incomplete external journal must fail closed just like a valid pending one.
 fs.writeFileSync(path.join(dir,'vault.auto.json'),JSON.stringify({version:2,pending:true,sealed:{}}),{mode:0o600});
}
const response=()=>new Response(JSON.stringify({choices:[{message:{content:'HIBIKI_PROBE_OK'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});

test('auth-only coordinated failure cannot probe old endpoint with the applied new key',async t=>{
 let armed=false,authRenames=0,modelsPath,authPath;
 const secret='SYNTHETIC-REVIEW-NEW-KEY';
 const p=await harness(t,{fsFault(op,args){if(!armed||op!=='renameSync')return;
   if(args[1]===modelsPath||(args[1]===authPath&&++authRenames>1)){const e=new Error('synthetic rename fault');e.code='EIO';throw e;}},
   authResolver:()=>({ok:true,apiKey:JSON.parse(fs.readFileSync(authPath,'utf8')).p01.key,headers:{}}),fetcher:()=>new Response('',{status:401})});
 modelsPath=p.configFile;authPath=path.join(p.root,'auth.json');
 p.send('down');p.send('left');p.send('left');p.action('edit-provider');await p.flush();
 p.send('down');p.replace('https://new-address.invalid/v1');p.send('down');p.send('down');p.replace(secret);
 armed=true;p.action('save-form');await p.waitForView('info');armed=false;
 assert.equal(p.config().providers.p01.baseUrl,'https://example.test/v1');
 assert.equal(JSON.parse(fs.readFileSync(authPath,'utf8')).p01.key,secret);
 assert.equal(JSON.parse(fs.readFileSync(path.join(p.root,'model-pick-data/vault.auto.json'),'utf8')).pending,true);
 assert.match(p.readContent(),/auth-only/);
 p.action('back');if(p.debug().actionMode)p.send('esc');p.send('right');p.action('inspect');
 assert.equal(p.calls.length,0);assert.equal(p.authCalls(),0);
 assert.ok(['matrix','info'].includes(p.debug().view),'pending cannot enter an executable check flow');
 assert.equal(JSON.parse(fs.readFileSync(path.join(p.root,'model-pick-data/vault.auto.json'),'utf8')).pending,true,'pending recovery material preserved');
});

test('pending introduced after rendered preflight blocks auth before resolving credentials',async t=>{
 const p=await harness(t);p.action('inspect');assert.equal(p.debug().view,'preflight');
 unknownPending(p);p.action('run');await p.flush();
 assert.equal(p.authCalls(),0);assert.equal(p.calls.length,0);
 assert.match(p.readContent(),/PENDING|待恢复|INVALID_VAULT|核对|未完成/);
});

test('pending introduced during asynchronous auth prevents every later fetch',async t=>{
 let release,entered;const ready=new Promise(r=>entered=r);
 const p=await harness(t,{authResolver:()=>{entered();return new Promise(resolve=>release=resolve);}});
 p.action('inspect');p.action('run');await ready;unknownPending(p);release({ok:true,apiKey:'SYNTHETIC-LATE-AUTH',headers:{}});
 await p.waitForView('report');assert.equal(p.calls.length,0);
 assert.match(p.readContent(),/仅供查看|已变化|不能采用|未完成|不适用/);
});

test('pending between suite items stops the next fetch even when first response is valid',async t=>{
 let p;let count=0;
 p=await harness(t,{fetcher:()=>{if(++count===1)unknownPending(p);return response();}});
 p.action('inspect');p.action('run');await p.waitForView('report');
 assert.equal(p.calls.length,1,'no request after the pending barrier');assert.equal(p.calls[0][1].method,'POST');
 assert.match(p.readContent(),/不能采用|已变化|仅供查看|未完成|不适用/);
});
