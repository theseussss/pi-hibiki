import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {harness} from './model-pick-ui-harness.mjs';

test('metadata refresh preserves an intervening trusted current-model switch',async t=>{
 let release,entered;
 const ready=new Promise(resolve=>{entered=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});
 const p=await harness(t,{onRefresh:async(_options,count)=>{if(count===2){entered();await gate;}}});
 p.action('edit-model');p.replace('Metadata edited');p.action('save-form');p.action('apply-inspect');
 await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('save refresh not reached')),3000))]);
 p.setCurrent('p01','m1');release();await p.flush();await p.flush();
 assert.equal(p.current().provider,'p01');assert.equal(p.current().id,'m1');assert.equal(p.selections.length,0);
 assert.equal(p.config().providers.p00.models[0].name,'Metadata edited');assert.equal(p.calls.length,0);
});

test('paint, home focus, palette preview and fuzzy-query navigation do not read profile files',async t=>{
 const p=await harness(t,{includeNative:true});const reads=p.reads.length,protections=p.protection.state.seals.length,catalogCallbacks=p.catalogCalls();
 for(let i=0;i<12;i++)p.screen(120);
 p.send('tab');p.send('right');p.send('down');p.send('tab');p.type('B');p.screen();p.send('clear');p.screen();
 assert.equal(p.reads.length,reads,'render/search is a pure cached metadata path');
 assert.equal(p.protection.state.seals.length,protections);
 assert.equal(p.catalogCalls(),catalogCallbacks,'native edit capability must not invoke registry/provider metadata callbacks while painting');
 assert.equal(p.calls.length,0);assert.equal(p.selections.length,0);
});

test('same-current model metadata save still rebinds canonical model without altering default or unknown fields',async t=>{
 const p=await harness(t);const before=JSON.parse(fs.readFileSync(p.root+'/settings.json','utf8'));
 p.action('edit-model');p.replace('Canonical metadata');p.action('save-form');p.action('apply-inspect');
 for(let i=0;i<10;i++)await p.flush();
 assert.equal(p.current().provider,'p00');assert.equal(p.current().id,'m0');assert.equal(p.current().name,'Canonical metadata');
 assert.equal(p.selections.length,1);assert.deepEqual(p.config().providers.p00.models[0].advanced,{untouched:true});
 assert.deepEqual(JSON.parse(fs.readFileSync(p.root+'/settings.json','utf8')),before);assert.equal(p.calls.length,0);
});
