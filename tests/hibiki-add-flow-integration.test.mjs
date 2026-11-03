import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, enterManualIds, tui } from './model-pick-ui-harness.mjs';

// Real extension/controller/component/store. Only the closed /tmp host, synthetic
// protection and explicitly supplied in-memory HTTP responses are substituted.
// Every action is ordinary key/mouse input; no dispatch, private cursor or proof.
function zone(p, name) {
  for (let i=0;i<80;i++) { if (!p.debug().actionMode && p.debug().zone===name) return; p.send('tab'); }
  assert.fail(`unreachable ${name}\n${p.screen()}`);
}
function field(p, value) {
  for (let i=0;i<80;i++) {
    if (!p.debug().actionMode && p.screen().split('\n').some(l=>l.trimStart().startsWith('› 模型ID（可多个）'))) { p.replace(value); return; }
    p.send('tab');
  }
  assert.fail(`manual input unreachable\n${p.screen()}`);
}
const authFile = p => path.join(p.root,'auth.json');
const unchanged = (p,before) => { assert.deepEqual(p.config(),before); assert.equal(fs.existsSync(authFile(p)),false); assert.equal(p.selections.length,0); };
const offlineDraft = (p,before) => { unchanged(p,before); assert.equal(p.calls.length,0); assert.equal(p.authCalls(),0); assert.equal(p.protection.state.seals.length,0); };
async function read(p) { p.action('read-list'); assert.equal(p.calls.length,0); assert.equal(p.authCalls(),0); p.action('connect'); await p.waitForView('basket'); }
function clickAction(p,id) {
  p.screen(); const d=p.debug(),slot=d.actionSlots.find(s=>s.key===id);
  assert.ok(slot && slot.actionIndex!==null,id);
  const rect=d.actionRects.find(r=>r.index===slot.actionIndex); assert.ok(rect,id);
  const rule=p.lines().findIndex(l=>/^\s*─+\s*$/.test(l));
  const result=p.component.handleMouse({type:'click',button:'left',x:rect.x+2,y:rule+1+rect.y-d.offset,shift:false,alt:false,ctrl:false});
  assert.equal(result?.handled,true); p.screen();
}

for(const width of [32,80,120]) test(`unread empty basket has consent/manual/back, no query or implicit text control at ${width}`,async t=>{
  const p=await harness(t); const before=p.config(); p.action('add-model');
  const screen=p.screen(width); assert.match(screen,/尚未读取/); assert.doesNotMatch(screen,/筛选候选ID|本家模型 0/);
  assert.ok(!p.raw().includes(tui.CURSOR_MARKER)); assert.equal(p.debug().selectedAction,'read-list');
  p.type('1230'); p.send('\x1b[200~not-an-id\x1b[201~');
  assert.doesNotMatch(p.screen(),/not-an-id|已选 [1-9]/); offlineDraft(p,before);
  clickAction(p,'manual-id'); assert.equal(p.debug().view,'edit'); field(p,'exact/one,exact-two');
  p.send('\x1b1'); assert.equal(p.debug().view,'basket'); assert.match(p.readContent(),/已选 2/);
  assert.equal(p.debug().selectedAction,'manual-id'); offlineDraft(p,before);
  assert.ok(p.lines().every(l=>tui.visibleWidth(l)<width));
});

for(const width of [32,80,120]) test(`query Enter, bare digits and paste only filter raw local candidates at ${width}`,async t=>{
  const p=await harness(t,{catalogEntries:[{provider:'p00',id:'1230'},{provider:'p00',id:'second'},{provider:'p01',id:'foreign'}]});
  const before=p.config(); p.action('add-model'); p.screen(width); assert.match(p.readContent(),/筛选候选ID.*2\/2/);
  zone(p,'query'); p.type('1230'); assert.match(p.readContent(),/筛选候选ID.*1\/2/); p.send('enter');
  assert.equal(p.debug().zone,'candidates'); assert.match(p.readContent(),/已选 0/); offlineDraft(p,before);
  p.send('enter'); assert.match(p.readContent(),/已选 1/);
  zone(p,'query'); p.replace(''); p.send('\x1b[200~absent-exact-ID\x1b[201~'); p.send('enter');
  assert.match(p.readContent(),/筛选候选ID.*0\/2/); assert.match(p.readContent(),/没有匹配/); assert.match(p.readContent(),/已选 1/);
  assert.ok(p.raw().includes(tui.CURSOR_MARKER),'raw candidates retain an actual query on no-match');
  offlineDraft(p,before); p.send('\x1b3'); assert.equal(p.debug().view,'edit'); p.send('esc');
  assert.equal(p.debug().view,'basket'); assert.match(p.readContent(),/absent-exact-ID/); assert.match(p.readContent(),/已选 1/);
});

for(const [name,ids] of [['empty',''],['duplicate','fresh,fresh'],['configured','fresh,m0'],['invalid','fresh,bad id'],['empty segment','fresh,'],['101 IDs',Array.from({length:101},(_,i)=>'id-'+i).join(',')]]) {
  test(`manual ${name} is atomic, retained and has no config/auth/network effects`,async t=>{
    const p=await harness(t); const before=p.config(); p.action('add-model'); enterManualIds(p,'seed');
    p.action('manual-id'); field(p,ids); p.action('add-ids'); assert.equal(p.debug().view,'edit');
    assert.match(p.readContent(),/本次未加入/);
    if(ids) assert.ok(p.readContent().includes(ids.slice(-20)), 'invalid private input remains visible/editable rather than being cleared');
    field(p,''); // Returning to the actual field must preserve editable ownership.
    p.type('replacement'); p.action('back'); assert.equal(p.debug().view,'basket'); assert.match(p.readContent(),/已选 1/);
    assert.match(p.readContent(),/seed/); assert.doesNotMatch(p.readContent(),/✓ fresh|✓ replacement/); offlineDraft(p,before);
  });
}

test('100 exact manual IDs join only draft; overflow, selected duplicates and second Enter never become Next',async t=>{
  const p=await harness(t); const before=p.config(); p.action('add-model'); const ids=Array.from({length:100},(_,i)=>`exact-${i}`);
  enterManualIds(p,ids); assert.match(p.readContent(),/已选 100/); assert.equal(p.debug().selectedAction,'manual-id');
  const identity=p.debug().selectedActionIdentity; p.send('enter'); assert.equal(p.debug().view,'edit');
  field(p,'overflow'); p.action('add-ids'); assert.equal(p.debug().view,'edit'); assert.match(p.readContent(),/本次未加入/);
  field(p,'exact-0'); p.action('add-ids'); assert.equal(p.debug().view,'edit'); p.action('back');
  assert.equal(p.debug().selectedActionIdentity,identity); assert.match(p.readContent(),/已选 100/); offlineDraft(p,before);
});

for(const [name,data,pattern] of [['empty',[],/上游清单为空/],['all configured',[{id:'m0'}],/均已配置/]]) {
  test(`authorized GET ${name} is not unread/filter-zero and does not show an empty query`,async t=>{
    const p=await harness(t,{fetcher:async()=>Response.json({data})}); const before=p.config(); p.action('add-model'); await read(p);
    assert.match(p.readContent(),pattern); assert.doesNotMatch(p.readContent(),/尚未读取|筛选候选ID/);
    assert.equal(p.calls.length,1); assert.equal(p.calls[0][1].method,'GET'); unchanged(p,before);
  });
}

test('failed and cancelled refresh preserve full candidate set, filter and selected draft; retry is explicit',async t=>{
  let mode='loaded',release,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const p=await harness(t,{fetcher:async()=>{
    if(mode==='failed') return new Response('',{status:503});
    if(mode==='cancel') { started(); return new Promise(resolve=>{release=resolve;}); }
    return Response.json({data:[{id:'first'},{id:'second'},{id:'m0'}]});
  }});
  const before=p.config(); p.action('add-model'); await read(p); zone(p,'query'); p.type('first'); p.send('enter'); p.send('enter');
  mode='failed'; p.action('read-list'); assert.equal(p.calls.length,1); p.action('connect'); await p.waitForView('basket');
  assert.match(p.readContent(),/失败|server/); assert.match(p.readContent(),/已选 1/); assert.match(p.readContent(),/1\/2/);
  mode='cancel'; p.action('read-list'); p.action('connect'); await ready; p.send('esc'); await p.waitForView('basket');
  assert.match(p.readContent(),/取消|cancelled/); assert.match(p.readContent(),/已选 1/); assert.match(p.readContent(),/1\/2/);
  const frame=p.raw(); release(Response.json({data:[{id:'late-must-not-publish'}]})); await p.flush(); await p.flush(); assert.equal(p.raw(),frame);
  mode='loaded'; p.action('read-list'); assert.equal(p.calls.length,3); p.action('connect'); await p.waitForView('basket');
  assert.equal(p.calls.length,4); assert.match(p.readContent(),/已选 1/); unchanged(p,before);
});

for(const isNew of [false,true]) test(`${isNew?'new':'existing'} provider own GET → two deliberate picks → skipped checks → independent final commit`,async t=>{
  const p=await harness(t,{fetcher:async()=>Response.json({data:[{id:'own-first'},{id:'own-second'}]})});
  const before=p.config(),settings=fs.readFileSync(path.join(p.root,'settings.json'),'utf8'),current=p.current();
  if(isNew) {
    p.action('new-provider'); p.type('Synthetic Add'); p.send('tab'); p.type('https://synthetic-add.invalid/v1'); p.send('tab'); p.send('tab'); p.type('SYNTHETIC-NEW-KEY');
    assert.equal(p.calls.length,0); unchanged(p,before); p.action('connect'); await p.waitForView('basket');
  } else { p.action('add-model'); await read(p); }
  assert.equal(p.calls.length,1); assert.equal(p.calls[0][1].method,'GET'); unchanged(p,before);
  zone(p,'query'); p.send('enter'); assert.match(p.readContent(),/已选 0/); p.send('enter'); p.send('down'); p.send('enter'); assert.match(p.readContent(),/已选 2/);
  p.action('next-models'); assert.equal(p.debug().view,'preflight'); p.action('skip'); assert.equal(p.debug().view,'report'); unchanged(p,before);
  p.action('commit'); assert.equal(p.debug().view,'confirm'); unchanged(p,before);
  p.unsafeSend('\x1b[13;1:2u'); p.unsafeSend('\x1b[13;1:3u'); assert.deepEqual(p.config(),before);
  p.action('commit'); await p.waitForView('matrix'); const provider=isNew?'synthetic-add':'p00';
  assert.deepEqual(p.config().providers[provider].models.slice(isNew?0:1).map(m=>m.id),['own-first','own-second']);
  assert.equal(p.calls.length,1); assert.equal(p.selections.length,0); assert.deepEqual(p.current(),current); assert.equal(fs.readFileSync(path.join(p.root,'settings.json'),'utf8'),settings);
  if(isNew) assert.equal(JSON.parse(fs.readFileSync(authFile(p),'utf8'))[provider].key,'SYNTHETIC-NEW-KEY'); else assert.equal(fs.existsSync(authFile(p)),false);
});
