import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, baseConfig, focusedNativeRow, fakeSecret } from './model-pick-ui-harness.mjs';

test('first manual pick retains the manual action identity; a second Enter cannot silently become Save', async (t) => {
  const p = await harness(t); const before = p.config(); p.send('\x1bn'); p.type('manual-focus'); p.send('backTab');
  assert.match(focusedNativeRow(p.raw().split('\n')), /手动输入/); p.send('enter');
  assert.match(p.screen(), /已选 1/); assert.match(focusedNativeRow(p.raw().split('\n')), /手动输入/);
  p.send('enter'); assert.deepEqual(p.config(), before); assert.equal(p.protection.state.seals.length, 0);
  p.send('save'); await p.settled(); assert.ok(p.config().providers.p00.models.some((m) => m.id === 'manual-focus'));
});

for (const [mode, keys] of [
  ['IME commit chunk', ['星河']],
  ['Kitty Unicode', ['\x1b[26143u', '\x1b[27827u']],
  ['bracketed paste', ['\x1b[200~星河\x1b[201~']],
]) test(`matrix native query supports provider display-name search: ${mode}`, async (t) => {
  const config = baseConfig(); config.providers.p01.name = '星河';
  const p = await harness(t, { config });
  for (const key of keys) p.send(key);
  assert.match(p.screen(), /› 星河/); assert.match(p.screen(), /Hibiki · 模型工作台 \(1\/2\)/);
  assert.match(p.screen(), /M1/); assert.ok(!p.screen().includes('M0'));
  p.send('clear'); assert.match(p.screen(), /Hibiki · 模型工作台 \(2\)/); assert.match(p.screen(), /M0/);
  assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('matrix paste with command-looking chunks cannot start add/remove or close the picker', async (t) => {
  const p = await harness(t); const before = p.config(); let finished = false; p.finished.then(() => { finished = true; });
  p.send('\x1b[200~query'); p.send('\x1bn'); p.send('\x1bx'); p.send('cancel'); p.send('\x1b[201~');
  await p.flush(); assert.equal(finished, false); assert.match(p.screen(), /Hibiki · 模型工作台/); assert.deepEqual(p.config(), before);
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data'))); assert.equal(p.calls.length, 0);
});

for (const discovery of [false, true]) test(`Ctrl+C still ends ${discovery ? 'discovery' : 'probe'} when its completion record cannot be saved`, async (t) => {
  let release; const auth = new Promise((resolve) => { release = resolve; }); const state = {};
  const p = await harness(t, { authResolver: () => auth, protectionState: state }); const before = p.config();
  if (discovery) {
    p.send('\x1bn'); p.type('retained-filter'); p.send('backTab'); p.select('读取模型清单'); p.select('确认读取');
  } else { p.send('menu'); p.select('更多'); p.select('测试连接'); p.select('确认文本测试'); }
  await p.flush(); assert.equal(p.authCalls(), 1); state.failSeal = true; p.send('cancel'); await p.settled();
  assert.match(p.screen(), /Hibiki · 模型工作台/); assert.match(p.screen(), /检查记录未能保存/); assert.deepEqual(p.config(), before);
  const file = path.join(p.root, 'model-pick-data/records.auto.json');
  const events = p.protection.open(JSON.parse(fs.readFileSync(file)).sealed, 'records').events;
  assert.deepEqual(events.map((e) => e.kind), [discovery ? 'discovery-start' : 'probe-start']);
  assert.equal(p.calls.length, 0); const frame = p.raw(); release({ ok: true, apiKey: fakeSecret, headers: {} }); await p.flush();
  assert.equal(p.calls.length, 0); assert.equal(p.raw(), frame); assert.ok(!p.raw().includes(fakeSecret));
});

test('enhanced cancel repeats cannot skip form/menu/matrix parent states', async (t) => {
  const p = await harness(t); p.send('left'); p.send('left'); p.send('enter'); p.select('编辑供应商'); p.replace('kept-draft');
  const form = p.raw(); p.send('\x1b[27;1:2u'); p.send('\x1b[27;1:2u'); assert.equal(p.raw(), form);
  p.send('esc'); const menu = p.raw(); p.send('\x1b[27;1:2u'); assert.equal(p.raw(), menu);
  p.send('esc'); assert.match(p.screen(), /Hibiki · 模型工作台/);
  let finished = false; p.finished.then(() => { finished = true; }); p.send('\x1b[27;1:2u'); await p.flush(); assert.equal(finished, false);
  assert.equal(p.config().providers.p00.name, 'A'); p.send('esc'); await p.flush(); assert.equal(finished, true);
});
