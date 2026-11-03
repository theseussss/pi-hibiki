import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, baseConfig, fakeSecret, tui, enterManualIds } from './model-pick-ui-harness.mjs';

function zone(p, name) {
  for (let i = 0; i < 60; i++) { const d = p.debug(); if (!d.actionMode && d.zone === name) return; p.send('tab'); }
  assert.fail(`zone not reachable: ${name}\n${p.screen()}`);
}
function field(p, label, value) {
  for (let i = 0; i < 60; i++) {
    if (p.screen().split('\n').some(line => line.trimStart().startsWith(`› ${label}`))) { p.replace(value); return; }
    p.send('tab');
  }
  assert.fail(`field not reachable: ${label}\n${p.screen()}`);
}
const enterIds = enterManualIds;
const ledger = p => p.protection.open(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-data/records.auto.json'), 'utf8')).sealed, 'records').events;
async function saveReferences(p) { p.action('next-models'); p.action('skip'); p.action('commit'); p.action('commit'); await p.settled(); }
async function draftProvider(p) {
  p.action('new-provider'); field(p, '名称', 'Cloud Bridge'); field(p, '地址', 'https://first.test/v1'); field(p, 'API Key', 'SYNTHETIC_BRIDGE_KEY');
  p.action('manual-connection'); await p.flush();
}

test('supplier context prioritizes this supplier; read-only suppliers do not advertise dead mutations', async t => {
  const p = await harness(t); p.send('left'); p.send('left'); p.send('tab');
  assert.equal(p.debug().selectedAction, 'edit-provider'); assert.match(p.screen(), /添加模型/); assert.match(p.screen(), /编辑连接/); assert.match(p.screen(), /移除供应商/);
  assert.doesNotMatch(p.screen(), /事务|首版|加密|openai-completions/);
  const n = await harness(t, { includeNative: true }); n.send('up'); n.send('left'); n.send('left'); n.send('tab');
  assert.match(n.screen(), /只读/);
  const before = n.config(); for (const id of ['edit-provider', 'remove-provider', 'add-model']) { n.action(id); assert.equal(n.debug().view, 'matrix'); }
  assert.deepEqual(n.config(), before); assert.equal(n.calls.length, 0);
});

test('new supplier retains picks and manual specs across name-only connection edits; changed tuples require fresh picks', async t => {
  const p = await harness(t); await draftProvider(p); enterIds(p, 'manual-first,manual-second');
  assert.match(p.screen(), /已选 2/); assert.doesNotMatch(p.screen(), /确认添加/); assert.match(p.screen(), /继续（2）/);
  zone(p, 'selected'); p.send('enter'); field(p, '显示名', 'Kept manual name'); field(p, '上下文窗口', '4096'); field(p, '最大输出', '1024'); p.action('save-form');
  assert.match(p.screen(), /4.096K \/ 1.024K/); p.action('back'); field(p, '名称', 'Cloud Bridge renamed'); p.action('manual-connection'); await p.flush();
  assert.match(p.screen(), /已选 2/); assert.match(p.screen(), /manual-second/); assert.match(p.screen(), /4.096K \/ 1.024K/);
  p.action('back'); field(p, '地址', 'https://second.test/v2'); p.action('manual-connection'); await p.flush();
  assert.match(p.screen(), /已选 0/); assert.equal(Object.keys(p.config().providers).length, 2, 'connection/back/parameter changes are drafts');
  enterIds(p, 'manual-first,manual-second'); zone(p, 'selected'); p.send('enter'); field(p, '显示名', 'Kept manual name'); field(p, '上下文窗口', '4096'); field(p, '最大输出', '1024'); p.action('save-form');
  await saveReferences(p); const created = p.config().providers['cloud-bridge'];
  assert.equal(created.name, 'Cloud Bridge renamed');
  assert.equal(created.baseUrl, 'https://second.test/v2'); assert.equal('apiKey' in created, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'auth.json'), 'utf8'))['cloud-bridge'].key, 'SYNTHETIC_BRIDGE_KEY');
  assert.equal(created.models.length, 2); assert.equal(created.models[0].name, 'Kept manual name'); assert.equal(created.models[0].contextWindow, 4096); assert.equal(created.models[0].maxTokens, 1024);
  assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.selections.length, 0);
});

test('manual picks persist across searches and can be unpicked without abandoning task', async t => {
  const p = await harness(t); p.action('add-model'); enterIds(p, 'manual-first'); enterIds(p, 'manual-second');
  assert.match(p.screen(), /已选 2/); zone(p, 'selected'); assert.equal(p.debug().selectedIndex, 0);
  p.send('\x1b[3~'); assert.match(p.screen(), /已选 1/); await saveReferences(p);
  const ids = p.config().providers.p00.models.map(m => m.id); assert.ok(ids.includes('manual-second')); assert.ok(!ids.includes('manual-first'));
});

test('editing supplier name changes visible label/search, not identity or unknown fields', async t => {
  const p = await harness(t); const before = p.config(); p.send('down'); p.send('left'); p.send('left'); p.action('edit-provider'); await p.flush();
  field(p, '名称', '云桥'); p.action('save-form'); await p.settled();
  assert.equal(p.config().providers.p01.name, '云桥'); assert.equal(p.config().providers.p01.apiKey, before.providers.p01.apiKey);
  assert.deepEqual(p.config().futureRoot, before.futureRoot); assert.ok(!p.config().providers['云桥']); assert.match(p.screen(), /云桥/);
  p.send('tab'); p.send('right'); p.type('云桥'); assert.match(p.screen(), /▸ 云桥/); assert.match(p.screen(), /M1/); assert.ok(!p.screen().includes('M0'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-favorites.json'))), ['p01/m1']); assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('returning from connection edit restores actual parent action and selection', async t => {
  const p = await harness(t); p.send('left'); p.send('left'); p.send('tab');
  // Focus the actual provider edit slot using normal shared-column navigation.
  for (let i = 0; i < 12 && p.debug().selectedAction !== 'edit-provider'; i++) p.send('right');
  assert.equal(p.debug().selectedAction, 'edit-provider'); const before = p.raw();
  p.send('enter'); await p.flush(); field(p, '名称', 'not-saved'); p.send('esc'); assert.equal(p.raw(), before); assert.equal(p.config().providers.p00.name, 'A');
});

test('cancel after confirmed replacement stops only removal and retains switch', async t => {
  const p = await harness(t); p.action('remove-model'); p.action('replacement'); p.action('commit'); await p.flush();
  assert.match(p.readContent(), /已切换.*取消不会自动切回/); assert.equal(p.debug().view, 'confirm');
  p.action('cancel-confirm'); assert.equal(p.debug().view, 'matrix'); assert.equal(p.current().id, 'm1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm1'); assert.equal(p.config().providers.p00.models[0].id, 'm0');
  assert.equal(fs.existsSync(path.join(p.root, 'model-pick-data/vault.auto.json')), false);
});

test('archive list retains identity focus after opening and cancelling restore; return preserves matrix action', async t => {
  const config = baseConfig(); config.providers.p02 = { ...config.providers.p01, name: 'C', models: [{ ...config.providers.p01.models[0], id: 'm2' }] };
  const p = await harness(t, { config }); p.send('down'); p.action('remove-model'); p.action('confirm-remove'); await p.settled();
  p.send('tab'); p.send('down'); p.send('right'); p.action('remove-model'); p.action('confirm-remove'); await p.settled();
  p.action('archives'); const entries = p.screen(); assert.match(entries, /p01/); assert.match(entries, /p02/);
  // Dynamic archive identities are exposed in geometry, never translated labels.
  const d = p.debug(); assert.equal(d.view, 'archives');
  for (let i = 0; i < 10 && !p.debug().actionMode; i++) p.send('tab');
  p.send('tab'); const before = p.raw(); const identity = p.debug().selectedActionIdentity;
  assert.match(identity, /^restore:/); p.send('enter'); assert.equal(p.debug().view, 'confirm'); p.send('esc'); assert.equal(p.debug().selectedActionIdentity, identity); assert.equal(p.raw(), before);
  p.action('back'); assert.equal(p.debug().view, 'matrix'); assert.equal(p.debug().selectedAction, 'archives'); assert.equal(p.config().providers.p02.models.length, 0);
});

test('rendering/search are free of runtime filesystem, registry and crypto work even with saved ledger', async t => {
  const p = await harness(t, { catalogEntries: [{ provider: 'p00', id: 'a-long-model-search' }] }); p.action('add-model'); enterIds(p, 'seed-model'); await saveReferences(p);
  const beforeOpen = p.protection.state.opens.length; p.action('add-model');
  assert.equal(p.protection.state.opens.length - beforeOpen, 1, 'one explicit ledger read when opening task');
  const opened = { io: p.reads.length, crypto: p.protection.state.opens.length, catalog: p.catalogCalls(), refresh: p.refreshes.length };
  p.type('a-long-model-search'); for (const w of [32, 60, 80, 180]) for (let i = 0; i < 5; i++) p.raw(w);
  assert.deepEqual({ io: p.reads.length, crypto: p.protection.state.opens.length, catalog: p.catalogCalls(), refresh: p.refreshes.length }, opened);
  enterIds(p, 'one'); const afterFirstPick = p.protection.state.opens.length; assert.equal(afterFirstPick, opened.crypto, 'first pick reuses task-open ledger snapshot');
  enterIds(p, 'two'); zone(p, 'selected'); p.send('enter'); p.send('esc'); for (let i = 0; i < 8; i++) p.raw(80);
  assert.equal(p.protection.state.opens.length, afterFirstPick, 'subsequent picks/parameters reuse captured reference data'); assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
});

test('public renderer flush shows saving before any synchronous protected write', async t => {
  let p; const observed = []; const protectionState = { sealHook() { observed.push({ frame: p.frames.at(-1), view: p.debug().view }); } };
  p = await harness(t, { protectionState }); p.action('add-model'); enterIds(p, 'flush-check'); await saveReferences(p);
  assert.ok(observed.length); assert.ok(p.frames.length); assert.ok(p.config().providers.p00.models.some(m => m.id === 'flush-check'));
  for (const write of observed) { assert.equal(write.view, 'progress'); assert.match(write.frame, /保存/, 'last publicly flushed frame must show saving before a protected write'); }
});

test('paste command-looking chunks cannot save or cancel model/connection drafts', async t => {
  for (const supplier of [false, true]) {
    const p = await harness(t); const before = p.config(); p.action(supplier ? 'new-provider' : 'add-model');
    if (!supplier) p.action('manual-id');
    p.send('\x1b[200~draft'); p.send('save'); p.send('cancel'); p.send('\x1b[20'); p.send('1~');
    assert.deepEqual(p.config(), before); assert.notEqual(p.debug().view, 'matrix'); assert.ok(p.raw().includes('draft'));
    p.send('cancel'); assert.equal(p.debug().view, 'matrix'); assert.deepEqual(p.config(), before); assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
  }
});

test('Ctrl+C cancels running suite, records cancellation, and returns to matrix', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; }); const p = await harness(t, { authResolver: () => pending });
  p.action('inspect'); p.action('run'); await p.flush(); assert.equal(p.debug().view, 'progress'); p.send('cancel'); await p.settled();
  assert.equal(p.debug().view, 'matrix'); assert.equal(p.calls.length, 0);
  const events = ledger(p);
  const frame = p.raw(); release({ ok: true, apiKey: fakeSecret, headers: {} }); await p.flush(); assert.equal(p.calls.length, 0); assert.equal(p.raw(), frame);
  assert.ok(events.some(e => e.report?.code === 'cancelled' || e.report?.cancelled === true), 'authorized request must have a terminal cancellation audit record');
});

for (const stop of ['Ctrl+C', 'Esc']) test(`${stop} closes one suite attempt with completed checks preserved and no late duplicate`, async t => {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; }); const pending = new Promise(resolve => { release = resolve; });
  const p = await harness(t, { fetcher: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.stream) { entered(); return pending; }
    return Response.json({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' }, finish_reason: 'stop' }] });
  } });
  const before = p.config(); p.action('inspect'); p.action('run'); await ready;
  assert.equal(p.calls.length, 2); p.send(stop === 'Ctrl+C' ? 'cancel' : 'esc');
  if (stop === 'Esc') { await p.waitForView('report'); assert.match(p.readContent(), /模型检查报告/); p.action('finish-inspect'); }
  assert.equal(p.debug().view, 'matrix');
  const completed = ledger(p).filter(e => e.kind === 'probe'); assert.equal(completed.length, 1);
  const report = completed[0].report; assert.equal(report.cancelled, true); assert.equal(report.checks.text.status, 'passed'); assert.equal(report.checks.stream.status, 'not-tested');
  const start = ledger(p).find(e => e.kind === 'probe-start'); assert.equal(completed[0].attemptId, start.attemptId);
  assert.ok(!JSON.stringify(completed).includes(fakeSecret)); const frame = p.raw();
  release(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })); await p.flush(); await p.flush();
  assert.equal(p.calls.length, 2); assert.equal(p.raw(), frame); assert.deepEqual(p.config(), before); assert.equal(ledger(p).filter(e => e.kind === 'probe').length, 1);
});

test('suite results and preflight errors return to real preflight/parent, never completed busy screen', async t => {
  for (const fail of [false, true]) {
    const p = await harness(t, { protectionState: fail ? { failSeal: true } : {} }); p.action('inspect');
    p.readContent(); p.send('tab'); assert.equal(p.debug().selectedAction, 'run'); const consent = p.raw(); const returnState = p.debug(); p.send('enter'); await p.settled(); assert.equal(p.debug().view, 'report');
    if (fail) assert.match(p.readContent(), /安全记录无法保存|未测试/); else assert.match(p.readContent(), /能力检查|模型检查报告/);
    p.send('esc'); assert.equal(p.debug().view, 'preflight');
    assert.equal(p.debug().viewId, returnState.viewId); assert.equal(p.debug().offset, returnState.offset); assert.equal(p.debug().selectedActionIdentity, returnState.selectedActionIdentity);
    if (fail) assert.equal(p.raw(), consent); // Successful suites legitimately enable the previously disabled reuse action.
    else { assert.match(p.readContent(), /m0 · https:\/\/example.test\/v1/); assert.match(p.readContent(), /最多 8 次请求/); }
    p.action('back'); assert.equal(p.debug().view, 'matrix'); assert.equal(p.calls.length, fail ? 0 : 8);
  }
});

test('Shift+Tab is reversible and losing focus removes cursor/input ownership', async t => {
  const p = await harness(t); p.action('new-provider'); p.type('kept'); const before = p.raw(); p.send('backTab'); p.send('tab'); assert.equal(p.raw(), before);
  assert.ok(p.raw().includes(tui.CURSOR_MARKER)); p.setFocused(false); assert.ok(!p.raw().includes(tui.CURSOR_MARKER)); p.type('ignored'); p.setFocused(true); assert.equal(p.raw(), before); assert.ok(!p.raw().includes('ignored'));
});

test('short terminals keep explicit continuation visible without second search/header', async t => {
  const p = await harness(t, { terminalRows: 10 }); p.action('add-model'); enterIds(p, 'short-first,short-second');
  for (const width of [32, 60, 80]) {
    const lines = p.lines(width); assert.ok(lines.length <= 10); assert.ok(lines.every(l => tui.visibleWidth(l) < width));
    assert.match(lines.join('\n'), /继续（2）/); assert.doesNotMatch(lines.join('\n'), /输入模型名或渠道名过滤/); assert.equal(lines.filter(l => /Hibiki · 模型工作台/.test(l)).length, 1);
  }
  await saveReferences(p); assert.ok(p.config().providers.p00.models.some(m => m.id === 'short-second'));
});
