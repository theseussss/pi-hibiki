import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, baseConfig, fakeSecret, focusedNativeRow, tui } from './model-pick-ui-harness.mjs';

const enterIds = (p, ids) => { p.type(ids); p.send('enter'); };
const ledger = (p) => p.protection.open(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-data/records.auto.json'), 'utf8')).sealed, 'records').events;

test('supplier context prioritizes this supplier; read-only suppliers do not advertise dead mutations', async (t) => {
  const p = await harness(t); p.send('left'); p.send('left'); p.send('enter');
  assert.match(focusedNativeRow(p.raw().split('\n')), /添加模型/);
  assert.match(p.screen(), /编辑供应商/); assert.match(p.screen(), /移除供应商/);
  assert.doesNotMatch(p.screen(), /事务|首版|加密|openai-completions/);
  const n = await harness(t, { includeNative: true }); n.send('up'); n.send('left'); n.send('left'); n.send('enter');
  assert.match(n.screen(), /只读/); assert.doesNotMatch(n.screen(), /编辑供应商|移除供应商|添加模型/);
});

test('new supplier has two task states, persistent picks and manual specs across connection edits', async (t) => {
  const p = await harness(t); p.send('left'); p.send('left'); p.send('\x1bn');
  p.type('Cloud Bridge'); p.send('tab'); p.type('https://first.test/v1'); p.send('tab'); p.send('tab'); p.type('SYNTHETIC_BRIDGE_KEY'); p.send('save');
  enterIds(p, 'manual-first,manual-second');
  assert.match(p.screen(), /已选 2/); assert.doesNotMatch(p.screen(), /确认添加|下一步/);
  p.send('down'); p.select('参数 · manual-first');
  p.replace('Kept manual name'); p.send('tab'); p.replace('4096'); p.send('tab'); p.replace('1024'); p.send('save');
  assert.match(p.screen(), /4096 \/ 1024/); p.send('esc');
  assert.match(p.screen(), /Cloud Bridge/); p.send('up'); p.send('up'); p.replace('https://second.test/v2'); p.send('save');
  assert.match(p.screen(), /已选 2/); assert.match(p.screen(), /manual-first/); assert.match(p.screen(), /manual-second/);
  assert.equal(Object.keys(p.config().providers).length, 2, 'connection/back/parameter changes are still drafts');
  p.send('save'); await p.settled();
  const created = p.config().providers['cloud-bridge'];
  assert.equal(created.baseUrl, 'https://second.test/v2'); assert.equal(created.apiKey, '$SYNTHETIC_BRIDGE_KEY');
  assert.equal(created.models.length, 2); assert.equal(created.models[0].name, 'Kept manual name');
  assert.equal(created.models[0].contextWindow, 4096); assert.equal(created.models[0].maxTokens, 1024);
  assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.selections.length, 0);
});

test('manual picks persist across searches and can be unpicked without abandoning the task', async (t) => {
  const p = await harness(t); p.send('\x1bn'); enterIds(p, 'manual-first'); enterIds(p, 'manual-second');
  assert.match(p.screen(), /已选 2/); p.send('down');
  assert.match(focusedNativeRow(p.raw().split('\n')), /参数 · manual-first/);
  p.send('\x1b[3~'); assert.match(p.screen(), /已选 1/); p.send('save'); await p.settled();
  const ids = p.config().providers.p00.models.map((m) => m.id);
  assert.ok(ids.includes('manual-second')); assert.ok(!ids.includes('manual-first'));
});

test('editing a supplier name changes its visible label/search, not its identity or unknown fields', async (t) => {
  const p = await harness(t); const before = p.config();
  p.send('down'); p.send('left'); p.send('left'); p.send('enter'); p.select('编辑供应商');
  p.replace('云桥'); p.send('save'); await p.settled();
  assert.equal(p.config().providers.p01.name, '云桥'); assert.equal(p.config().providers.p01.apiKey, before.providers.p01.apiKey);
  assert.deepEqual(p.config().futureRoot, before.futureRoot); assert.ok(!p.config().providers['云桥']);
  assert.match(p.screen(), /云桥/); p.send('right'); p.type('云桥'); assert.match(p.screen(), /› 云桥/); assert.match(p.screen(), /Hibiki · 模型工作台 \(1\//); assert.match(p.screen(), /M1/); assert.ok(!p.screen().includes('M0'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-favorites.json'))), ['p01/m1']);
  assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('returning from a connection edit restores the actual parent menu and selection', async (t) => {
  const p = await harness(t); p.send('menu'); p.select('更多'); p.send('down');
  assert.match(focusedNativeRow(p.raw().split('\n')), /编辑供应商/); const before = p.raw();
  p.send('enter'); p.replace('not-saved'); p.send('esc'); assert.equal(p.raw(), before);
  assert.equal(p.config().providers.p00.name, 'A');
});

test('cancel after confirmed replacement clearly stops only removal and retains the switch', async (t) => {
  const p = await harness(t); p.send('\x1bx'); p.select('p01 / m1'); p.select('确认替换'); await p.flush();
  assert.match(p.screen(), /已切换.*取消只停止移除/);
  assert.match(focusedNativeRow(p.raw().split('\n')), /停止移除/); p.send('enter');
  assert.match(p.screen(), /Hibiki · 模型工作台/); assert.equal(p.current().id, 'm1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm1');
  assert.equal(p.config().providers.p00.models[0].id, 'm0');
  assert.equal(fs.existsSync(path.join(p.root, 'model-pick-data/vault.auto.json')), false);
});

test('archive list and its parent retain focus after opening and cancelling a restore', async (t) => {
  const config = baseConfig(); config.providers.p02 = { ...config.providers.p01, name: 'C', models: [{ ...config.providers.p01.models[0], id: 'm2' }] };
  const p = await harness(t, { config }); p.send('down'); p.send('\x1bx'); p.select('确认移除'); await p.settled();
  p.send('down'); p.send('\x1bx'); p.select('确认移除'); await p.settled();
  p.send('menu'); assert.match(p.screen(), /添加模型/); p.select('更多'); const moreBefore = p.screen(); p.select('已移除的项目');
  p.send('down'); const before = p.raw(); assert.match(focusedNativeRow(before.split('\n')), /p02/);
  p.send('enter'); p.send('esc'); assert.equal(p.raw(), before);
  p.send('esc'); assert.match(focusedNativeRow(p.raw().split('\n')), /已移除的项目/);
  assert.ok(moreBefore.includes('已移除的项目')); assert.equal(p.config().providers.p02.models.length, 0);
});

test('rendering/search are free of runtime filesystem, registry and crypto work even with a saved ledger', async (t) => {
  const p = await harness(t); p.send('\x1bn'); enterIds(p, 'seed-model'); p.send('save'); await p.settled();
  p.send('\x1bn');
  const opened = { io: p.reads.length, crypto: p.protection.state.opens.length, catalog: p.catalogCalls(), refresh: p.refreshes.length };
  p.type('a-long-model-search');
  for (const w of [32, 60, 80, 180]) for (let i = 0; i < 5; i++) p.raw(w);
  assert.deepEqual({ io: p.reads.length, crypto: p.protection.state.opens.length, catalog: p.catalogCalls(), refresh: p.refreshes.length }, opened);
  p.replace('one'); p.send('enter'); const afterFirstPick = p.protection.state.opens.length;
  assert.equal(afterFirstPick - opened.crypto, 1, 'one explicit ledger read on first pick');
  p.type('two'); p.send('enter'); p.send('down'); p.select('参数 · one'); p.send('esc');
  for (let i = 0; i < 8; i++) p.raw(80);
  assert.equal(p.protection.state.opens.length, afterFirstPick, 'subsequent picks/parameters reuse the captured reference data');
  assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
});

test('a public renderer flush shows saving before any synchronous protected write', async (t) => {
  let p; let observed = false;
  const protectionState = { sealHook() { observed = true; assert.match(p.frames.at(-1), /保存中/); } };
  p = await harness(t, { protectionState }); p.send('\x1bn'); enterIds(p, 'flush-check'); p.send('save'); await p.settled();
  assert.equal(observed, true); assert.ok(p.frames.length); assert.ok(p.config().providers.p00.models.some((m) => m.id === 'flush-check'));
});

test('paste command-looking chunks cannot save or cancel model/connection drafts', async (t) => {
  for (const supplier of [false, true]) {
    const p = await harness(t); const before = p.config();
    if (supplier) { p.send('left'); p.send('left'); }
    p.send('\x1bn'); p.send('\x1b[200~draft'); p.send('save'); p.send('cancel'); p.send('\x1b[20'); p.send('1~');
    assert.deepEqual(p.config(), before); assert.doesNotMatch(p.screen(), /Hibiki · 模型工作台/); assert.ok(p.raw().includes('draft'));
    p.send('cancel'); assert.match(p.screen(), /Hibiki · 模型工作台/); assert.deepEqual(p.config(), before);
    assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
  }
});

test('Ctrl+C cancels a running request, records the cancellation, and returns to the matrix', async (t) => {
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const p = await harness(t, { authResolver: () => pending });
  p.send('menu'); p.select('更多'); p.select('测试连接'); p.select('确认文本测试');
  assert.match(p.screen(), /文本测试中/); p.send('cancel'); await p.settled();
  assert.match(p.screen(), /Hibiki · 模型工作台/); assert.equal(p.calls.length, 0);
  const events = ledger(p); assert.equal(events.at(-1).report.code, 'cancelled');
  const frame = p.raw(); release({ ok: true, apiKey: fakeSecret, headers: {} }); await p.flush();
  assert.equal(p.calls.length, 0); assert.equal(p.raw(), frame);
});

test('network results and preflight errors return to real consent/parent states, never a completed busy screen', async (t) => {
  for (const fail of [false, true]) {
    const p = await harness(t, { protectionState: fail ? { failSeal: true } : {} });
    p.send('menu'); p.select('更多'); const more = p.raw(); p.select('测试连接'); p.send('down'); const consent = p.raw();
    p.send('enter'); await p.settled(); assert.match(p.screen(), fail ? /测试未开始/ : /连接检查/);
    p.send('esc'); assert.equal(p.raw(), consent); p.send('esc'); assert.equal(p.raw(), more);
    p.send('esc'); p.send('esc'); assert.match(p.screen(), /Hibiki · 模型工作台/);
    assert.equal(p.calls.length, fail ? 0 : 1);
  }
});

test('Shift+Tab is reversible and losing focus removes cursor/input ownership', async (t) => {
  const p = await harness(t); p.send('left'); p.send('left'); p.send('\x1bn');
  p.type('kept'); const before = p.raw(); p.send('backTab'); p.send('tab'); assert.equal(p.raw(), before);
  assert.ok(p.raw().includes(tui.CURSOR_MARKER)); p.setFocused(false); assert.ok(!p.raw().includes(tui.CURSOR_MARKER));
  p.type('ignored'); p.setFocused(true); assert.equal(p.raw(), before); assert.ok(!p.raw().includes('ignored'));
});

test('short terminals keep the explicit add action visible without a second search/header', async (t) => {
  const p = await harness(t, { terminalRows: 10 }); p.send('\x1bn'); enterIds(p, 'short-first,short-second');
  for (const width of [32, 60, 80]) {
    const lines = p.lines(width); assert.ok(lines.length <= 10); assert.ok(lines.every((l) => tui.visibleWidth(l) < width));
    assert.match(lines.join('\n'), /添加2个模型/); assert.doesNotMatch(lines.join('\n'), /Hibiki · 模型工作台|输入模型名或渠道名过滤/);
  }
  p.send('save'); await p.settled(); assert.ok(p.config().providers.p00.models.some((m) => m.id === 'short-second'));
});
