import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, baseConfig, fakeSecret, enterManualIds } from './model-pick-ui-harness.mjs';

function field(p, label, value) {
  for (let i = 0; i < 60; i++) {
    if (p.screen().split('\n').some(line => line.trimStart().startsWith(`› ${label}`))) { p.replace(value); return; }
    p.send('tab');
  }
  assert.fail(`field not reachable: ${label}\n${p.screen()}`);
}

test('first manual pick retains manual action identity; second Enter cannot silently become Save', async t => {
  const p = await harness(t); const before = p.config(); p.action('add-model'); enterManualIds(p, 'manual-focus');
  assert.match(p.screen(), /已选 1/); assert.equal(p.debug().selectedAction, 'manual-id');
  const identity = p.debug().selectedActionIdentity; p.send('enter'); assert.equal(p.debug().view, 'edit'); p.send('esc'); assert.equal(p.debug().selectedActionIdentity, identity);
  assert.deepEqual(p.config(), before); assert.equal(p.protection.state.seals.length, 0);
  p.action('next-models'); p.action('skip'); p.action('commit'); p.action('commit'); await p.settled(); assert.ok(p.config().providers.p00.models.some(m => m.id === 'manual-focus'));
});

for (const [mode, keys] of [
  ['IME commit chunk', ['星河']],
  ['Kitty Unicode', ['\x1b[26143u', '\x1b[27827u']],
  ['bracketed paste', ['\x1b[200~星河\x1b[201~']],
]) test(`matrix native query supports provider display-name search: ${mode}`, async t => {
  const config = baseConfig(); config.providers.p01.name = '星河'; const p = await harness(t, { config });
  for (const key of keys) p.send(key);
  assert.match(p.screen(), /▸ 星河/); assert.match(p.screen(), /M1/); assert.ok(!p.screen().includes('M0'));
  p.send('clear'); assert.match(p.screen(), /Pi Models · 模型管理/); assert.match(p.screen(), /M0/); assert.match(p.screen(), /M1/); assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('matrix paste command-looking chunks cannot start add/remove or close picker', async t => {
  const p = await harness(t); const before = p.config(); let finished = false; p.finished.then(() => { finished = true; });
  p.send('\x1b[200~query'); p.send('\x1bn'); p.send('\x1bx'); p.send('cancel'); p.send('\x1b[201~');
  await p.flush(); assert.equal(finished, false); assert.equal(p.debug().view, 'matrix'); assert.deepEqual(p.config(), before);
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data'))); assert.equal(p.calls.length, 0);
});

for (const discovery of [false, true]) test(`Ctrl+C still ends ${discovery ? 'discovery' : 'suite'} when completion record cannot be saved`, async t => {
  let release; const auth = new Promise(resolve => { release = resolve; }); const state = {};
  const p = await harness(t, { authResolver: () => auth, protectionState: state }); const before = p.config();
  if (discovery) { p.action('add-model'); p.type('retained-filter'); p.action('read-list'); p.action('connect'); }
  else { p.action('inspect'); p.action('run'); }
  await p.flush(); assert.equal(p.authCalls(), 1); state.failSeal = true; p.send('cancel'); await p.settled();
  assert.equal(p.debug().view, 'matrix'); assert.deepEqual(p.config(), before);
  const file = path.join(p.root, 'model-pick-data/records.auto.json'); const events = p.protection.open(JSON.parse(fs.readFileSync(file)).sealed, 'records').events;
  assert.deepEqual(events.map(e => e.kind), [discovery ? 'discovery-start' : 'probe-start']);
  assert.equal(p.calls.length, 0); const frame = p.raw(); release({ ok: true, apiKey: fakeSecret, headers: {} }); await p.flush();
  assert.equal(p.calls.length, 0); assert.equal(p.raw(), frame); assert.ok(!p.raw().includes(fakeSecret));
  assert.match(p.screen() + JSON.stringify(p.notices), /检查记录未能保存|安全记录无法保存/, 'abandonment must disclose failed terminal audit write');
});

test('enhanced cancel repeats cannot skip form/action/matrix parent states', async t => {
  const p = await harness(t); p.send('left'); p.send('left'); p.action('edit-provider'); await p.flush(); field(p, '名称', 'kept-draft');
  const form = p.raw(); p.unsafeSend('\x1b[27;1:2u'); p.unsafeSend('\x1b[27;1:2u'); assert.equal(p.raw(), form);
  p.send('esc'); assert.equal(p.debug().view, 'matrix'); assert.equal(p.debug().selectedAction, 'edit-provider'); const actions = p.raw();
  p.unsafeSend('\x1b[27;1:2u'); assert.equal(p.raw(), actions); p.send('esc'); assert.equal(p.debug().view, 'matrix'); assert.equal(p.debug().actionMode, false);
  let finished = false; p.finished.then(() => { finished = true; }); p.unsafeSend('\x1b[27;1:2u'); await p.flush(); assert.equal(finished, false);
  assert.equal(p.config().providers.p00.name, 'A'); p.send('esc'); await p.flush(); assert.equal(finished, true);
});

test('new task needs its own paint before Ctrl+S may authorize connection effects', async t => {
  const p = await harness(t); const before = p.config();
  // No positive helper or render between opening the new task and the negative key.
  p.unsafeSend('\x1b9'); p.unsafeSend('save'); await p.flush();
  assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0); assert.deepEqual(p.config(), before);
  assert.equal(p.debug().view, 'connection'); assert.doesNotMatch(p.raw(), new RegExp(fakeSecret));
});

test('final add is independent, repeats and an unpainted confirm cannot write config', async t => {
  const p = await harness(t); const before = p.config(); p.action('add-model'); enterManualIds(p, 'review-only'); p.action('next-models'); p.action('skip');
  p.readContent(); p.unsafeSend('\x1b1'); // report -> final confirmation, intentionally not painted
  p.unsafeSend('save'); p.unsafeSend('\x1b[13;1:2u'); await p.flush(); assert.deepEqual(p.config(), before);
  assert.equal(p.debug().view, 'confirm'); assert.equal(p.calls.length, 0); assert.equal(p.selections.length, 0);
  p.action('commit'); await p.settled(); assert.ok(p.config().providers.p00.models.some(m => m.id === 'review-only'));
});
