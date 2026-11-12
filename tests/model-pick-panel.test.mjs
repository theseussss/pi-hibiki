import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, baseConfig, fakeSecret, password, seedLegacy, tui, enterManualIds } from './model-pick-ui-harness.mjs';

// All effects are driven through the real extension + formal PickerComponent.
// These helpers only read public geometry and send ordinary keyboard input.
const recorded = p => p.protection.open(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-data/records.auto.json'), 'utf8')).sealed, 'records').events;
const file = (p, name) => path.join(p.root, name);
const json = (p, name) => JSON.parse(fs.readFileSync(file(p, name), 'utf8'));
const noRequests = p => { assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0); };
const home = p => { assert.equal(p.debug().view, 'matrix'); };
const add = (p, id) => { p.action('add-model'); enterManualIds(p, id); };
const preflight = (p, id) => { add(p, id); p.action('next-models'); assert.equal(p.debug().view, 'preflight'); };
const finalConsent = p => { p.action('commit'); assert.equal(p.debug().view, 'confirm'); };
const confirmWithoutProbe = p => { p.action('skip'); finalConsent(p); p.action('commit'); };
const nextWithoutProbe = p => { p.action('next-models'); confirmWithoutProbe(p); };
const providerFocus = p => { if (p.debug().actionMode) p.send('esc'); p.send('left'); p.send('left'); };
const focusField = (p, label) => {
  for (let i = 0; i < 100; i++) {
    const screen = p.screen();
    if (!p.debug().actionMode && screen.split('\n').some(line => line.trimStart().startsWith(`› ${label}`))) return;
    p.send('tab');
  }
  assert.fail(`field not reachable: ${label}\n${p.screen()}`);
};
const field = (p, label, value) => { focusField(p, label); p.replace(value); };
const advanced = p => { if (!p.debug().advanced) { focusField(p, '推理映射'); p.send('enter'); } };
const adjustPicked = p => {
  for (let i = 0; i < 40; i++) {
    if (!p.debug().actionMode && p.debug().zone === 'selected') { p.send('enter'); assert.equal(p.debug().view, 'edit'); return; }
    p.send('tab');
  }
  assert.fail('selected model parameters not reachable');
};
const restoreFirst = p => {
  p.screen();
  const slot = p.debug().actionSlots.find(s => s.key?.startsWith('restore:'));
  assert.ok(slot, 'archive has an identity-bearing restore action'); p.action(slot.key);
};
const replacement = p => { p.action('replacement'); assert.match(p.readContent(), /仅替换|不立即移除/); };
const draft = async (p, name, endpoint, key) => {
  p.action('new-provider'); field(p, '名称', name); field(p, '地址', endpoint); field(p, 'API Key', key);
  p.action('manual-connection'); await flush(p); assert.equal(p.debug().view, 'basket');
};
const discoveryConsent = p => { p.action('add-model'); p.action('read-list'); assert.match(p.readContent(), /example.test/); };
const inspect = p => { p.action('inspect'); assert.equal(p.debug().view, 'preflight'); };
const suiteFetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'HIBIKI_PROBE_OK' }, finish_reason: 'stop' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  if (body.tools) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'synthetic-call', type: 'function', function: { name: 'hibiki_probe', arguments: '{}' } }] } }] }));
  if (body.reasoning_effort) return new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }));
  return new Response(JSON.stringify({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] }));
};
const flush = async p => { await p.flush(); await p.flush(); };
const commit = async p => { finalConsent(p); p.action('commit'); await flush(p); };
const assertFits = (p, width) => { assert.ok(p.lines(width).every(line => tui.visibleWidth(line) < width)); assert.ok(p.lines(width).length <= 24); };

test('matrix exposes semantic favorite and ordering actions without changing data or switching model', async t => {
  const p = await harness(t); const before = p.config();
  for (const width of [40, 80, 120]) {
    const screen = p.screen(width); assert.match(screen, /收藏/); assert.match(screen, /前移/); assert.match(screen, /后移/); assertFits(p, width);
  }
  const favorites = fs.readFileSync(file(p, 'model-pick-favorites.json'), 'utf8');
  p.send('tab'); assert.equal(p.debug().actionMode, true); p.send('backTab'); assert.equal(p.debug().actionMode, false);
  assert.equal(fs.readFileSync(file(p, 'model-pick-favorites.json'), 'utf8'), favorites);
  providerFocus(p); assert.match(p.screen(), /上移/); assert.match(p.screen(), /下移/);
  assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0); noRequests(p);
});

test('Alt+M focuses contextual actions and Esc preserves search, grid and current model', async t => {
  const p = await harness(t); p.type('p0'); p.send('down'); const original = p.screen();
  p.send('menu'); assert.equal(p.debug().view, 'matrix'); assert.equal(p.debug().actionMode, true); assert.match(p.screen(), /编辑/);
  p.send('esc'); assert.equal(p.screen(), original); assert.equal(p.selections.length, 0); noRequests(p);
  assert.ok(p.refreshes.every(o => o.allowNetwork === false));
});

test('empty matrix permits global actions and cancelled provider form has no side effects', async t => {
  const p = await harness(t, { config: { providers: {} } }); assert.match(p.screen(), /还没有供应商|暂无供应商/);
  p.action('new-provider'); assert.equal(p.debug().view, 'connection'); assert.match(p.screen(), /名称/);
  p.type('cancelled-provider'); p.send('esc'); home(p); assert.deepEqual(p.config(), { providers: {} }); noRequests(p);
  assert.equal(fs.existsSync(file(p, 'auth.json')), false);
});

test('/models manage enters visible actions without selecting or switching', async t => {
  const p = await harness(t, { args: 'manage' }); assert.equal(p.debug().actionMode, true); home(p);
  p.send('esc'); assert.equal(p.debug().actionMode, false); assert.match(p.screen(), /Pi Models/); assert.equal(p.selections.length, 0);
});

test('provider add coordinates direct key and keyless config, preserving search and private file state', async t => {
  const p = await harness(t); p.type('m0'); await draft(p, 'new-channel', 'https://new.test/v1', 'SYNTHETIC_NEW_KEY');
  assert.ok(!p.config().providers['new-channel']); assert.equal(fs.existsSync(file(p, 'auth.json')), false);
  enterManualIds(p, 'new-first-model'); assert.ok(!p.config().providers['new-channel']); nextWithoutProbe(p); await flush(p);
  home(p); assert.match(p.screen(), /配置已保存/); assert.match(p.screen(), /m0/); assert.equal('apiKey' in p.config().providers['new-channel'], false);
  assert.deepEqual(json(p, 'auth.json')['new-channel'], { type: 'api_key', key: 'SYNTHETIC_NEW_KEY' }); assert.deepEqual(p.config().futureRoot, { keep: true }); noRequests(p);
  const vault = fs.readFileSync(file(p, 'model-pick-data/vault.auto.json'), 'utf8'); assert.ok(!vault.includes(fakeSecret)); assert.ok(!vault.includes(password));
  assert.equal(fs.statSync(file(p, 'model-pick-data/vault.auto.json')).mode & 0o777, 0o600); assert.equal(fs.statSync(file(p, 'auth.json')).mode & 0o777, 0o600);
  p.send('esc'); p.send('clear'); assert.match(p.screen(), /new-channel/); assert.equal(p.config().providers['new-channel'].models[0].id, 'new-first-model');
});

test('model add fills parameters, records fallback provenance and returns to its supplier row', async t => {
  const p = await harness(t); p.send('down'); add(p, 'new-model'); assert.match(p.readContent(), /规格仍需核对/); adjustPicked(p);
  field(p, '显示名', '新增模型'); field(p, '上下文窗口', '4096'); field(p, '最大输出', '1024'); p.action('save-form');
  assert.match(p.readContent(), /4\.096K \/ 1\.024K/); nextWithoutProbe(p); await flush(p); home(p); assert.match(p.screen(), /配置已保存/);
  const m = p.config().providers.p01.models.find(item => item.id === 'new-model'); assert.equal(m.contextWindow, 4096); assert.equal(m.maxTokens, 1024); assert.equal(m.name, '新增模型');
  assert.equal(p.config().providers.p00.models[0].advanced.untouched, true); assert.equal(p.selections.length, 0);
  assert.ok(!fs.readFileSync(file(p, 'model-pick-data/records.auto.json'), 'utf8').includes('new-model'));
  const resolution = recorded(p).find(e => e.kind === 'resolution' && e.modelId === 'new-model');
  assert.equal(resolution.provenance.contextWindow.source, 'manual'); assert.ok(resolution.provenance.contextWindow.history.some(h => h.source === 'default'));
  assert.equal(resolution.fields.contextWindow, 4096); assert.equal(resolution.fields.maxTokens, 1024);
});

test('current/default model archive requires replacement, never silently switches or deletes', async t => {
  const p = await harness(t); const before = p.config(); p.action('remove-model'); assert.match(p.readContent(), /当前.*默认|替代/);
  assert.doesNotMatch(p.screen(), /主密码/); assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0);
});

test('model archive and restore preserve favorite/order metadata within the matrix', async t => {
  const p = await harness(t); p.send('down'); p.action('remove-model'); p.action('confirm-remove'); await flush(p); home(p);
  assert.equal(p.config().providers.p01.models.length, 0); p.action('archives'); restoreFirst(p); p.action('confirm-restore'); await flush(p);
  assert.equal(p.config().providers.p01.models[0].id, 'm1'); assert.deepEqual(json(p, 'model-pick-favorites.json'), ['p01/m1']); assert.deepEqual(json(p, 'model-pick-order.json').models.p01, ['m1']);
});

test('native model editing permits only explicit local limits and no-op does not create custom definitions', async t => {
  const p = await harness(t, { includeNative: true }); p.send('up'); p.action('edit-model'); assert.match(p.screen(), /本地限制/);
  p.send('tab'); assert.equal(p.debug().fieldIndex,1); p.send('tab'); assert.equal(p.debug().selectedAction,'save-form');
  assert.doesNotMatch(p.screen(), /强度映射|显示名.*:|名称.*:/);
  p.action('save-form'); assert.ok(!p.config().providers['native-provider']); noRequests(p);
});

test('maintenance has no master-password tasks and cancellation creates no private store', async t => {
  const p = await harness(t); p.action('archives');
  for (const width of [32, 60, 80, 180]) { assert.doesNotMatch(p.screen(width), /主密码|解锁|锁定安全存档|再次输入/); assert.ok(!p.raw(width).includes(fakeSecret)); assertFits(p, width); }
  p.send('esc'); assert.ok(!fs.existsSync(file(p, 'model-pick-data')));
});

test('inspection cancellation before consent resolves no credentials and sends no request', async t => {
  const p = await harness(t); inspect(p); assert.match(p.readContent(), /example.test/); p.send('esc'); noRequests(p);
});

test('confirmed discovery and full inspection never follow an externally changed endpoint', async t => {
  for (const discovery of [false, true]) {
    const p = await harness(t); if (discovery) discoveryConsent(p); else inspect(p);
    const config = p.config(); config.providers.p00.baseUrl = 'https://other-target.test/v1'; fs.writeFileSync(p.configFile, JSON.stringify(config));
    p.action(discovery ? 'connect' : 'run'); await flush(p); assert.equal(p.calls.length, 0); assert.equal(p.config().providers.p00.baseUrl, 'https://other-target.test/v1'); assert.ok(!p.raw().includes(fakeSecret));
  }
});

test('explicit bounded inspection suite saves encrypted evidence, not metadata or raw response', async t => {
  const p = await harness(t, { fetcher: suiteFetch }); const before = p.config(); inspect(p); noRequests(p);
  assert.match(p.readContent(), /8|512|64/); p.action('run'); await flush(p); assert.equal(p.debug().view, 'report');
  assert.match(p.readContent(), /文本.*通过/); assert.equal(p.calls.length, 8); assert.equal(p.authCalls(), 1);
  for (const [, options] of p.calls) assert.equal(JSON.parse(options.body).max_tokens, 64);
  assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0); assert.ok(!p.screen().includes(fakeSecret));
  const ledger = fs.readFileSync(file(p, 'model-pick-data/records.auto.json'), 'utf8'); assert.ok(!ledger.includes(fakeSecret)); assert.ok(!ledger.includes('HIBIKI_PROBE_OK'));
  const events = recorded(p); const probes = events.filter(e => e.kind === 'probe-start' || e.kind === 'probe'); assert.deepEqual(probes.map(e => e.kind), ['probe-start', 'probe']); assert.equal(probes[0].attemptId, probes[1].attemptId);
  assert.deepEqual(probes[1].report.verifiedFields, []); assert.deepEqual(probes[1].report.fields, {}); assert.ok(!JSON.stringify(events).includes(fakeSecret)); assert.ok(!JSON.stringify(events).includes('HIBIKI_PROBE_OK'));
  p.action('finish-inspect'); home(p); assert.deepEqual(p.config(), before);
});

test('model editing round-trips extended thinking levels and unknown advanced fields through separate diff consent', async t => {
  const config = baseConfig(); config.providers.p00.models[0].reasoning = true; config.providers.p00.models[0].thinkingLevelMap = { minimal: null, xhigh: 'xhigh', max: 'max' };
  const p = await harness(t, { config }); p.action('edit-model'); advanced(p); field(p, '强度 xhigh', 'vendor_high'); field(p, '强度 max', 'vendor_max');
  p.action('save-form'); assert.equal(p.debug().view, 'confirm'); assert.deepEqual(p.config(), config); p.action('apply-inspect'); await flush(p);
  assert.deepEqual(p.config().providers.p00.models[0].thinkingLevelMap, { minimal: null, xhigh: 'vendor_high', max: 'vendor_max' }); assert.deepEqual(p.config().providers.p00.models[0].advanced, { untouched: true });
  const resolution = recorded(p).find(e => e.kind === 'resolution'); assert.equal(resolution.provenance.thinkingLevelMap.source, 'manual'); assert.deepEqual(resolution.fields.thinkingLevelMap, { minimal: null, xhigh: 'vendor_high', max: 'vendor_max' }); assert.equal(p.calls.length, 0);
});

test('same-provider catalog thinking map retains extended strengths through save', async t => {
  const p = await harness(t, { catalogEntries: [{ provider: 'p00', id: 'known-thinking', name: 'Known', contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ['text'], thinkingLevelMap: { minimal: null, xhigh: 'xhigh', max: 'max' } }] });
  add(p, 'known-thinking'); nextWithoutProbe(p); await flush(p); assert.deepEqual(p.config().providers.p00.models.find(m => m.id === 'known-thinking').thinkingLevelMap, { minimal: null, xhigh: 'xhigh', max: 'max' });
  assert.equal(recorded(p).find(e => e.modelId === 'known-thinking').provenance.thinkingLevelMap.source, 'provider'); assert.equal(p.calls.length, 0);
});

test('cross-provider thinking reference requires explicit final acceptance', async t => {
  const p = await harness(t, { catalogEntries: [{ provider: 'foreign', id: 'borrowed', name: 'Borrowed', contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ['text'], thinkingLevelMap: { max: 'vendor-max' } }] });
  preflight(p, 'borrowed'); p.action('skip'); finalConsent(p); assert.match(p.readContent(), /跨供应商.*映射/); assert.ok(!p.config().providers.p00.models.some(m => m.id === 'borrowed'));
  p.action('commit'); await flush(p); assert.deepEqual(p.config().providers.p00.models.find(m => m.id === 'borrowed').thinkingLevelMap, { max: 'vendor-max' }); assert.equal(p.calls.length, 0);
});

test('single model wizard obtains consent, runs bounded suite and requires independent final confirmation', async t => {
  const p = await harness(t, { fetcher: suiteFetch }); const before = p.config(); preflight(p, 'wizard-model'); noRequests(p); assert.deepEqual(p.config(), before);
  p.action('run'); await flush(p); assert.equal(p.debug().view, 'report'); assert.equal(p.calls.length, 8); assert.deepEqual(p.config(), before);
  assert.match(p.readContent(), /文本.*通过/); p.action('details'); assert.match(p.readContent(), /max/); p.action('details');
  assert.equal(recorded(p).filter(e => e.kind === 'probe').length, 1); finalConsent(p); assert.deepEqual(p.config(), before); p.action('commit'); await flush(p);
  assert.ok(p.config().providers.p00.models.some(m => m.id === 'wizard-model')); assert.equal(p.selections.length, 0);
});

test('new supplier suite uses memory-only direct key before coordinated keyless-config commit', async t => {
  const draftKey = 'SYNTHETIC_DRAFT_KEY'; const p = await harness(t, { fetcher: async (url, options) => { assert.equal(options.headers.authorization, `Bearer ${draftKey}`); return suiteFetch(url, options); } });
  const before = p.config(); await draft(p, 'draft bridge', 'https://draft.test/v1', draftKey); enterManualIds(p, 'model-draft'); p.action('next-models'); assert.deepEqual(p.config(), before); assert.equal(p.calls.length, 0);
  p.action('run'); await flush(p); assert.equal(p.calls.length, 8); assert.equal(p.debug().view, 'report'); assert.ok(!p.raw().includes(draftKey)); assert.deepEqual(p.config(), before);
  assert.equal(fs.existsSync(file(p, 'auth.json')), false); await commit(p);
  assert.equal('apiKey' in p.config().providers['draft-bridge'], false); assert.equal(json(p, 'auth.json')['draft-bridge'].key, draftKey); assert.equal(p.config().providers['draft-bridge'].models[0].id, 'model-draft');
});

test('candidate mapping is proposed, history reuse is request-free, and adoption requires explicit parameter plus final consent', async t => {
  const p = await harness(t, { catalogEntries: [{ provider: 'p00', id: 'mapping-candidate', name: 'Candidate', contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ['text'] }], fetcher: suiteFetch });
  preflight(p, 'mapping-candidate'); p.action('run'); await flush(p); assert.match(p.readContent(), /建议.*xhigh.*max/); assert.ok(!p.config().providers.p00.models.some(m => m.id === 'mapping-candidate'));
  p.action('back'); p.action('reuse'); await flush(p); assert.match(p.readContent(), /历史|复用/); assert.equal(p.calls.length, 8);
  p.action('adjust'); advanced(p); focusField(p, '实测建议映射'); p.send('right'); p.action('save-form'); await commit(p);
  assert.deepEqual(p.config().providers.p00.models.find(m => m.id === 'mapping-candidate').thinkingLevelMap, { xhigh: 'xhigh', max: 'max' });
});

test('confirmed reference is reused only for the same provider/model/endpoint/API', async t => {
  const p = await harness(t); add(p, 'remembered-model'); adjustPicked(p); field(p, '显示名', 'Remembered'); field(p, '上下文窗口', '4096'); field(p, '最大输出', '1024'); p.action('save-form'); nextWithoutProbe(p); await flush(p);
  const config = p.config(); config.providers.p00.models = config.providers.p00.models.filter(m => m.id !== 'remembered-model'); fs.writeFileSync(p.configFile, JSON.stringify(config)); await p.close();
  const q = await harness(t, { existingHome: p.home }); add(q, 'remembered-model'); adjustPicked(q); assert.match(q.readContent(), /4096/); assert.match(q.readContent(), /Remembered/); q.send('cancel');
  const changed = q.config(); changed.providers.p00.baseUrl = 'https://different.test/v1'; fs.writeFileSync(q.configFile, JSON.stringify(changed)); await q.close();
  const r = await harness(t, { existingHome: p.home }); add(r, 'remembered-model'); adjustPicked(r); assert.match(r.readContent(), /128000/); assert.doesNotMatch(r.readContent(), /4096/); assert.equal(r.calls.length, 0);
});

test('reference-record failure after config commit reports partial success without plaintext fallback', async t => {
  const state = { modelSeals: 0, sealHook(_value, purpose) { if (purpose === 'models') this.modelSeals++; if (purpose === 'records' && this.modelSeals >= 2) this.failSeal = 'records'; } };
  const p = await harness(t, { protectionState: state }); preflight(p, 'reference-failure'); confirmWithoutProbe(p); await flush(p);
  assert.ok(p.config().providers.p00.models.some(m => m.id === 'reference-failure')); assert.match(p.screen(), /配置已保存.*参考记录未保存/);
  const events = recorded(p); assert.ok(events.some(e => e.kind === 'resolution')); assert.ok(!events.some(e => e.kind === 'reference')); assert.ok(!fs.readFileSync(file(p, 'model-pick-data/records.auto.json'), 'utf8').includes('reference-failure')); noRequests(p);
});

test('credential rotation between suite and final confirmation refuses stale report before saving', async t => {
  let token = 'SYNTHETIC-A'; const p = await harness(t, { authResolver: async () => ({ ok: true, apiKey: token, headers: {} }), fetcher: suiteFetch }); const before = p.config();
  preflight(p, 'rotate-model'); p.action('run'); await flush(p); assert.equal(p.debug().view, 'report'); finalConsent(p); token = 'SYNTHETIC-B'; p.action('commit'); await flush(p);
  assert.match(p.readContent(), /CONFLICT/); assert.deepEqual(p.config(), before); assert.equal(p.calls.length, 8); assert.ok(!p.raw().includes('SYNTHETIC-B'));
});

test('Esc after one completed probe keeps partial report and prevents every later request', async t => {
  let release; const delayed = new Promise(resolve => { release = resolve; }); const p = await harness(t, { fetcher: async (_url, options) => JSON.parse(options.body).stream ? delayed : new Response(JSON.stringify({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] })) });
  const before = p.config(); preflight(p, 'cancel-suite'); p.action('run'); await p.flush(); assert.equal(p.calls.length, 2); p.send('esc'); await flush(p);
  assert.equal(p.debug().view, 'report'); assert.match(p.readContent(), /已停止/); assert.match(p.readContent(), /文本.*通过/); assert.match(p.readContent(), /流式.*未测试/); assert.deepEqual(p.config(), before);
  const report = recorded(p).find(e => e.kind === 'probe').report; assert.equal(report.cancelled, true); assert.equal(report.checks.text.status, 'passed'); assert.equal(report.checks.stream.status, 'not-tested');
  release(new Response('{}')); await p.flush(); assert.equal(p.calls.length, 2);
});

test('Ctrl+C during suite records partial state and exits without another request', async t => {
  let release; const delayed = new Promise(resolve => { release = resolve; }); const p = await harness(t, { fetcher: async (_url, options) => JSON.parse(options.body).stream ? delayed : new Response(JSON.stringify({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] })) });
  const before = p.config(); preflight(p, 'cancel-ctrlc'); p.action('run'); await p.flush(); assert.equal(p.calls.length, 2); p.send('cancel'); await flush(p); home(p); assert.deepEqual(p.config(), before);
  const report = recorded(p).find(e => e.kind === 'probe'); release(new Response('{}')); await p.flush(); assert.equal(p.calls.length, 2); assert.ok(report, 'Ctrl+C must persist terminal partial evidence, not leave only probe-start'); assert.equal(report.report.cancelled, true);
});

test('external config change during suite aborts all later requests and blocks stale commit', async t => {
  let release; const delayed = new Promise(resolve => { release = resolve; }); const p = await harness(t, { fetcher: async () => delayed }); preflight(p, 'changing-model'); p.action('run'); await p.flush(); assert.equal(p.calls.length, 1);
  const changed = p.config(); changed.providers.p00.baseUrl = 'https://changed.test/v1'; fs.writeFileSync(p.configFile, JSON.stringify(changed)); release(new Response(JSON.stringify({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] }))); await flush(p);
  assert.equal(p.calls.length, 1); assert.equal(p.debug().view, 'report'); assert.match(p.readContent(), /不适用于当前连接/); p.action('commit'); await p.flush(); assert.notEqual(p.debug().view, 'confirm'); assert.ok(!p.config().providers.p00.models.some(m => m.id === 'changing-model'));
});

test('editing borrowed thinking mapping removes borrowed adoption without losing manual value', async t => {
  const p = await harness(t, { catalogEntries: [{ provider: 'foreign', id: 'borrow-edit', contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ['text'], thinkingLevelMap: { max: 'foreign-max' } }] });
  preflight(p, 'borrow-edit'); p.action('skip'); finalConsent(p); assert.match(p.readContent(), /跨供应商/); p.action('back'); p.action('adjust'); advanced(p); field(p, '强度 max', 'manual-max'); p.action('save-form');
  finalConsent(p); assert.doesNotMatch(p.readContent(), /确认即明确接受跨供应商建议映射/); p.action('commit'); await flush(p); assert.deepEqual(p.config().providers.p00.models.find(m => m.id === 'borrow-edit').thinkingLevelMap, { max: 'manual-max' });
});

test('preflight cannot accept a request before its first full render', async t => {
  const p = await harness(t); add(p, 'first-render');
  // Ctrl+S transitions basket -> preflight without the driver's post-input paint.
  p.unsafeSend('save'); p.unsafeSend('\x1b1'); p.unsafeSend('enter'); await p.flush(); noRequests(p); assert.equal(p.debug().view, 'preflight');
  assert.match(p.screen(), /确认检查范围/);
});

test('inspection and discovery consent reject pre-render input and unread small-screen scope', async t => {
  for (const discovery of [false, true]) {
    const p = await harness(t, { terminalRows: 10 });
    if (discovery) { p.action('add-model'); p.unsafeSend('\x1b2'); } else p.unsafeSend('\x1b3');
    p.unsafeSend('\x1b1'); p.unsafeSend('enter'); await p.flush(); noRequests(p);
    assert.match(p.screen(32), /窗口太小|未读|PgDn/); p.unsafeSend('\x1b1'); p.unsafeSend('enter'); await p.flush(); noRequests(p);
  }
});

test('suite consent cannot proceed when terminal cannot display scope and limits', async t => {
  const p = await harness(t, { terminalRows: 10 }); const before = p.config(); preflight(p, 'narrow-safety'); assert.match(p.screen(32), /窗口太小|未读|PgDn/);
  for (let i = 0; i < 5; i++) { p.unsafeSend('\x1b1'); p.unsafeSend('enter'); }
  noRequests(p); assert.deepEqual(p.config(), before); p.send('esc'); assert.equal(p.debug().view, 'basket');
});

test('invalid existing thinking map blocks editing rather than silently replacing it', async t => {
  const config = baseConfig(); config.providers.p00.models[0].thinkingLevelMap = { unexpected: 'secret-synthetic' }; const p = await harness(t, { config }); p.action('edit-model');
  assert.match(p.readContent(), /INVALID_INPUT/); assert.equal(p.debug().view, 'info'); assert.deepEqual(p.config(), config); assert.doesNotMatch(p.raw(), /secret-synthetic/);
});

test('provider connection guidance explains native login, direct keys and real auth status without leaks', async t => {
  const p = await harness(t, { authStatus: () => ({ configured: true, source: 'stored' }) }); providerFocus(p); p.action('edit-provider');
  const screen = p.readContent(); assert.match(screen, /已通过原生凭据库保存/); assert.match(screen, /\/login/); assert.match(screen, /--api-key/); assert.match(screen, /API Key/); assert.match(screen, /0600.*明文/); assert.ok(!p.raw().includes(fakeSecret));
  p.send('esc'); home(p); const q = await harness(t, { authStatus: () => ({ configured: false }) }); providerFocus(q); q.action('edit-provider'); assert.match(q.readContent(), /未配置/); noRequests(q);
});

test('invalid numeric parameters remain in form without config or vault writes', async t => {
  const p = await harness(t); const before = p.config(); p.action('edit-model'); field(p, '上下文窗口', '1000'); field(p, '最大输出', '2000'); p.action('save-form'); assert.match(p.screen(), /输出不能大于窗口/);
  assert.deepEqual(p.config(), before); assert.ok(!fs.existsSync(file(p, 'model-pick-data/vault.auto.json')));
});

test('Chinese display names preserve shared ordinal grid columns', async t => {
  const config = baseConfig(); config.providers.p01.models[0].name = '这是一个很长的中文模型显示名称需要按列宽截断'; config.providers.p01.models.push({ ...config.providers.p01.models[0], id: 'm2', name: 'ASCII_TWO' });
  const p = await harness(t, { config }); p.screen(180); const cells = p.debug().matrixCells; const m0 = cells.find(c => c.mid === 'm0'), m1 = cells.find(c => c.mid === 'm1');
  assert.ok(m0 && m1, 'public matrix geometry contains both first ordinal models'); assert.equal(m0.x, m1.x); assert.match(p.screen(), /ASCII_TWO/); assertFits(p, 180);
});

test('supplier name-only edit preserves unsupported protocol and secret-bearing legacy URL', async t => {
  const config = baseConfig(); config.providers.p01.api = 'openai-codex-responses'; config.providers.p01.baseUrl = 'https://example.test/v1?api_key=SYNTHETIC_URL_SECRET';
  const p = await harness(t, { config }); p.send('down'); providerFocus(p); p.action('edit-provider'); await flush(p); assert.ok(!p.raw().includes('SYNTHETIC_URL_SECRET')); field(p, '名称', 'B-renamed'); p.action('save-form'); await flush(p);
  assert.equal(p.config().providers.p01.name, 'B-renamed', p.readContent()); assert.equal(p.config().providers.p01.api, 'openai-codex-responses'); assert.equal(p.config().providers.p01.baseUrl, config.providers.p01.baseUrl); assert.equal(p.config().providers.p01.apiKey, config.providers.p01.apiKey);
  home(p); assert.match(p.screen(), /B-renamed/); p.type('B-renamed'); assert.match(p.screen(), /M1/); assert.deepEqual(json(p, 'model-pick-favorites.json'), ['p01/m1']);
});

test('unready model cannot become default or be switched to', async t => {
  const p = await harness(t, { available: m => m.provider === 'p00' }); const before = fs.readFileSync(file(p, 'settings.json'), 'utf8'); p.send('down'); assert.match(p.screen(), /未就绪/);
  p.action('default'); assert.equal(fs.readFileSync(file(p, 'settings.json'), 'utf8'), before); p.send('esc'); p.send('enter'); assert.equal(p.selections.length, 0);
});

test('archiving then moving active model neighbors preserves archived order slot', async t => {
  const config = baseConfig(); config.providers.p01.models.push({ ...config.providers.p01.models[0], id: 'm2', name: 'M2' }, { ...config.providers.p01.models[0], id: 'm3', name: 'M3' });
  const p = await harness(t, { config }); p.send('down'); p.action('remove-model'); p.action('confirm-remove'); await flush(p); p.screen(); p.send('esc'); p.action('move-right'); assert.deepEqual(json(p, 'model-pick-order.json').models.p01, ['m1', 'm3', 'm2']);
});

test('archived supplier keeps row-order slot across moves, reopen and restore', async t => {
  const config = baseConfig(); config.providers.p02 = { ...config.providers.p01, name: 'C', models: [{ ...config.providers.p01.models[0], id: 'm2' }] }; const p = await harness(t, { config });
  p.send('down'); providerFocus(p); p.action('remove-provider'); p.action('confirm-remove'); await flush(p); p.screen(); if (p.debug().actionMode) p.send('esc'); p.send('down'); p.screen(); p.send('\x1b[1;3A'); assert.deepEqual(json(p, 'model-pick-order.json').providers, ['p02', 'p01', 'p00']); await p.close();
  const q = await harness(t, { existingHome: p.home }); assert.deepEqual(json(q, 'model-pick-favorites.json'), ['p01/m1']); q.action('archives'); restoreFirst(q); q.action('confirm-restore'); await flush(q);
  assert.equal(q.config().providers.p01.models[0].id, 'm1'); assert.deepEqual(json(q, 'model-pick-order.json').providers, ['p02', 'p01', 'p00']);
});

test('Basic credential reflection never appears in raw ANSI candidates', async t => {
  const payload = Buffer.from('usr:secretxy').toString('base64');
  for (const prefix of ['Basic ', ' Basic ', '\tBasic\t']) {
    const p = await harness(t, { authResolver: async () => ({ ok: true, headers: { authorization: `${prefix}${payload}\t` } }), fetcher: async () => new Response(JSON.stringify({ data: [{ id: payload }, { id: 'secretxy' }, { id: 'model-safe' }] })) });
    discoveryConsent(p); p.action('connect'); await flush(p); assert.match(p.screen(), /model-safe/); assert.ok(!p.raw().includes(payload)); assert.ok(!p.raw().includes('secretxy')); assert.equal(p.calls.length, 1);
  }
});

test('failed upstream list preserves manual entry without another request', async t => {
  const p = await harness(t, { fetcher: async () => new Response(fakeSecret, { status: 503 }) }); discoveryConsent(p); p.action('connect'); await flush(p); assert.match(p.readContent(), /手输|手动/); assert.ok(!p.raw().includes(fakeSecret));
  enterManualIds(p, 'manual-model'); adjustPicked(p); assert.match(p.readContent(), /manual-model/); assert.equal(p.calls.length, 1); assert.equal(p.config().providers.p00.models.length, 1);
});

test('Esc cancels stalled inspection auth, records cancellation and rejects late requests', async t => {
  let release; const auth = new Promise(resolve => { release = resolve; }); const p = await harness(t, { authResolver: () => auth }); inspect(p); p.action('run'); await p.flush(); assert.equal(p.debug().view, 'progress');
  p.send('esc'); await flush(p); assert.equal(p.debug().view, 'report'); const event = recorded(p).find(e => e.kind === 'probe'); p.screen(); p.send('cancel'); home(p); const before = p.raw();
  release({ ok: true, apiKey: fakeSecret, headers: {} }); await p.flush(); assert.equal(p.calls.length, 0); assert.equal(p.raw(), before); assert.ok(event, 'cancelled auth must leave terminal evidence'); assert.equal(event.report.cancelled, true); assert.equal(event.report.code, 'cancelled');
});

test('auth returning beyond absolute deadline cannot beat timer microtask', async t => {
  const clock = { value: 0 }; const p = await harness(t, { monotonicClock: clock, authResolver: async () => { clock.value = 11000; return { ok: true, apiKey: fakeSecret, headers: {} }; } });
  inspect(p); p.action('run'); await flush(p); assert.match(p.readContent(), /\(timeout\)|（timeout）/); assert.equal(p.authCalls(), 1); assert.equal(p.calls.length, 0); const event = recorded(p).find(e => e.kind === 'probe'); assert.ok(event, 'deadline must produce terminal evidence'); assert.equal(event.report.timedOut, true); assert.equal(event.report.code, 'timeout');
});

test('whole-stage timeout includes auth resolution without a late request', async t => {
  let release; const auth = new Promise(resolve => { release = resolve; }); const p = await harness(t, { authResolver: () => auth, shortDeadline: true }); inspect(p); p.action('run'); await p.flush(); await new Promise(resolve => setTimeout(resolve, 20)); await p.flush();
  assert.match(p.readContent(), /\(timeout\)|（timeout）/); const event = recorded(p).find(e => e.kind === 'probe'); release({ ok: true, apiKey: fakeSecret, headers: {} }); await p.flush(); assert.equal(p.calls.length, 0); assert.ok(event, 'whole-stage deadline must produce terminal evidence'); assert.equal(event.report.timedOut, true); assert.equal(event.report.code, 'timeout');
});

test('direct shortcuts preserve matrix/query on cancelling add or remove without root detour', async t => {
  const p = await harness(t); p.type('p0'); p.send('down'); const before = p.screen(); p.send('\x1bn'); assert.equal(p.debug().view, 'basket'); p.type('cancelled'); p.send('\x1bx'); assert.equal(p.config().providers.p01.models.length, 1);
  p.action('back'); assert.equal(p.screen(), before); p.send('\x1bx'); assert.equal(p.debug().view, 'confirm'); assert.match(p.readContent(), /p01\s*\/\s*m1/); p.send('esc'); assert.equal(p.screen(), before); noRequests(p); assert.equal(p.selections.length, 0);
});

test('provider-column shortcuts are contextual and cancellation preserves provider focus', async t => {
  const p = await harness(t); providerFocus(p); p.send('down'); const before = p.screen(); p.send('\x1bn'); assert.equal(p.debug().view, 'connection'); assert.match(p.screen(), /名称/); assert.doesNotMatch(p.screen(), /供应商 ID:/);
  p.send('esc'); assert.equal(p.screen(), before); p.send('\x1bx'); assert.match(p.readContent(), /全量影响 1 个模型/); p.send('esc'); assert.equal(p.screen(), before); assert.equal(p.selections.length, 0); noRequests(p);
});

test('busy undo retains a valid retry and succeeds when idle again', async t => {
  let idle = true; const p = await harness(t, { idle: () => idle }); p.send('down'); p.action('remove-model'); p.action('confirm-remove'); await flush(p); assert.equal(p.config().providers.p01.models.length, 0);
  idle = false; p.screen(); p.send('\x1bz'); await p.flush(); assert.equal(p.config().providers.p01.models.length, 0); assert.match(p.screen(), /撤销/);
  if (p.debug().view !== 'matrix') p.send('esc'); idle = true; p.send('\x1bz'); await flush(p); assert.equal(p.config().providers.p01.models[0].id, 'm1'); assert.equal(p.calls.length, 0);
});

test('live current context rather than opening snapshot protects active model', async t => {
  const p = await harness(t); p.setCurrent('p01', 'm1'); p.send('down'); p.action('remove-model'); assert.match(p.readContent(), /替代|替换/); assert.doesNotMatch(p.screen(), /主密码/); assert.equal(p.config().providers.p01.models[0].id, 'm1'); assert.equal(p.selections.length, 0);
});

test('invalid/partial default settings fail closed before destructive confirmation', async t => {
  for (const bad of ['{invalid', 'null', '[]', '{"defaultProvider":"p01"}']) {
    const p = await harness(t); const before = p.config(); fs.writeFileSync(file(p, 'settings.json'), bad); p.send('down'); p.action('remove-model'); assert.match(p.readContent(), /DEFAULT_UNKNOWN/); assert.doesNotMatch(p.screen(), /主密码/);
    assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0); assert.ok(!fs.existsSync(file(p, 'model-pick-data')));
  }
});

test('unreadable default settings retain deletion protection', async t => {
  let refuse = false; const p = await harness(t, { fsFault(op, args) { if (refuse && op === 'openSync' && String(args[0]).endsWith('/settings.json')) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' }); } });
  refuse = true; p.send('down'); p.action('remove-model'); assert.match(p.readContent(), /DEFAULT_UNKNOWN/); assert.equal(p.config().providers.p01.models.length, 1); assert.equal(p.calls.length, 0);
});

test('replacement updates current/default only after confirmation, then separately archives', async t => {
  const p = await harness(t); p.action('remove-model'); replacement(p); assert.equal(p.selections.length, 0); p.action('commit'); await flush(p); assert.equal(p.debug().view, 'confirm'); assert.equal(p.current().id, 'm1'); assert.equal(json(p, 'settings.json').defaultModel, 'm1');
  assert.equal(p.config().providers.p00.models.length, 1, 'replacement is not archive consent'); p.action('confirm-remove'); await flush(p); assert.equal(p.config().providers.p00.models.length, 0); assert.equal(p.current().provider, 'p01'); assert.equal(p.calls.length, 0);
});

test('external default edit during async replacement is never overwritten', async t => {
  let release; const deferred = new Promise(resolve => { release = resolve; }); const config = baseConfig(); config.providers.p02 = { ...config.providers.p01, models: [{ ...config.providers.p01.models[0], id: 'm2' }] };
  const p = await harness(t, { config, switcher: () => deferred }); p.action('remove-model'); replacement(p); p.action('commit'); await p.flush(); assert.equal(p.selections.length, 1);
  const external = JSON.stringify({ defaultProvider: 'p02', defaultModel: 'm2', keepExternal: true }); fs.writeFileSync(file(p, 'settings.json'), external); release(true); await flush(p);
  assert.match(p.readContent(), /替换未完整完成/); assert.equal(fs.readFileSync(file(p, 'settings.json'), 'utf8'), external); assert.equal(p.current().id, 'm1'); assert.equal(p.config().providers.p00.models.length, 1); assert.ok(!fs.existsSync(file(p, 'model-pick-data')));
});

test('current change between replacement choice and confirmation is not silently replaced', async t => {
  const config = baseConfig(); config.providers.p02 = { ...config.providers.p01, models: [{ ...config.providers.p01.models[0], id: 'm2' }] }; const p = await harness(t, { config }); p.action('remove-model'); replacement(p); p.setCurrent('p02', 'm2'); p.action('commit'); await p.flush();
  assert.match(p.readContent(), /CONFLICT/); assert.equal(p.current().id, 'm2'); assert.equal(p.selections.length, 0); assert.equal(p.config().providers.p00.models.length, 1);
});

test('default-write failure after explicit switch is honest and cleans temporary files', async t => {
  const p = await harness(t, { fsFault(op, args) { if (op === 'renameSync' && String(args[1]).endsWith('/settings.json')) throw new Error('SYNTHETIC settings rename failure'); } });
  p.action('remove-model'); replacement(p); p.action('commit'); await flush(p); assert.match(p.readContent(), /替换未完整完成/); assert.equal(p.current().id, 'm1'); assert.equal(p.config().providers.p00.models.length, 1); assert.equal(json(p, 'settings.json').defaultModel, 'm0'); assert.ok(!fs.readdirSync(p.root).some(name => name.endsWith('.tmp')));
});

test('supplier removal confirms full configured count including filtered-out models', async t => {
  const config = baseConfig(); config.providers.p01.models.push({ ...config.providers.p01.models[0], id: 'hidden-second', name: 'Hidden' }); const p = await harness(t, { config }); p.type('m1'); providerFocus(p); p.action('remove-provider');
  assert.match(p.readContent(), /全量影响 2 个模型/); assert.match(p.readContent(), /搜索隐藏/); assert.equal(p.config().providers.p01.models.length, 2); p.send('esc'); assert.match(p.screen(), /m1/);
});

test('locating newly added model is explicit; saving preserves query and current session', async t => {
  const p = await harness(t); p.type('m0'); add(p, 'hidden-new'); nextWithoutProbe(p); await flush(p); assert.match(p.screen(), /m0/); assert.match(p.screen(), /定位/); assert.equal(p.selections.length, 0);
  p.send('\x1bl'); assert.match(p.screen(), /hidden-new/); assert.doesNotMatch(p.screen(), /› m0/); assert.equal(p.current().id, 'm0'); assert.equal(p.selections.length, 0);
});

test('losing focus cancels armed provider-boundary press without changing normal navigation', async t => {
  const p = await harness(t); p.send('left'); p.setFocused(false); p.setFocused(true); p.send('left'); assert.match(p.screen(), /模型「|M0/); const modelActions = p.debug().actionSlots.map(s => s.key);
  assert.ok(modelActions.includes('favorite')); p.send('left'); assert.ok(p.debug().actionSlots.some(s => s.key === 'edit')); assert.match(p.screen(), /编辑连接/);
});

test('default unreadable after removal consent still blocks before storage changes', async t => {
  const p = await harness(t); p.send('down'); p.action('remove-model'); fs.writeFileSync(file(p, 'settings.json'), '{invalid'); p.action('confirm-remove'); await flush(p);
  assert.equal(p.config().providers.p01.models.length, 1); assert.ok(!fs.existsSync(file(p, 'model-pick-data'))); assert.doesNotMatch(p.screen(), /主密码/); assert.match(p.readContent(), /DEFAULT_UNKNOWN/);

  // A later guard failure may also invalidate the old task's return callback.
  // That must produce a usable safe error task, never noncancellable progress.
  let q; let changed = false;
  const protectionState = { sealHook(_value, purpose) {
    if (purpose === 'models' && !changed) { changed = true; fs.writeFileSync(file(q, 'settings.json'), '{invalid'); }
  } };
  q = await harness(t, { protectionState }); const before = q.config(); q.send('down'); q.action('remove-model'); q.action('confirm-remove'); await flush(q);
  assert.equal(changed, true); assert.deepEqual(q.config(), before); assert.equal(q.debug().view, 'info'); assert.match(q.readContent(), /DEFAULT_UNKNOWN/);
  assert.ok(!q.raw().includes(fakeSecret)); assert.ok(!fs.existsSync(file(q, 'model-pick-data/vault.auto.json'))); q.action('back'); home(q); noRequests(q);
});

test('unreadable custom declarations never prune existing favorite/order identities', async t => {
  const p = await harness(t); await p.close(); const favorites = JSON.stringify(['p01/m1', 'unknown/missing']); const order = JSON.stringify({ providers: ['p00', 'unknown', 'p01'], models: { unknown: ['missing'] } });
  fs.writeFileSync(file(p, 'model-pick-favorites.json'), favorites); fs.writeFileSync(file(p, 'model-pick-order.json'), order);
  const q = await harness(t, { existingHome: p.home, fsFault(op, args) { if (op === 'openSync' && String(args[0]).endsWith('/models.json')) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' }); } });
  assert.equal(fs.readFileSync(file(p, 'model-pick-favorites.json'), 'utf8'), favorites); assert.equal(fs.readFileSync(file(p, 'model-pick-order.json'), 'utf8'), order); assert.equal(q.calls.length, 0);
});

test('formal rendered task screens fit narrow/normal terminals without secret exposure', async t => {
  const p = await harness(t); const capture = label => {
    for (const width of [32, 60, 80, 180]) {
      const raw = p.raw(width); assert.ok(!raw.includes(password)); assert.ok(!raw.includes(fakeSecret)); assertFits(p, width);
      if (process.env.MODEL_PICK_SNAPSHOT_DIR) { fs.mkdirSync(process.env.MODEL_PICK_SNAPSHOT_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(process.env.MODEL_PICK_SNAPSHOT_DIR, `${label}-${width}.ansi`), raw + '\n', { mode: 0o600 }); fs.writeFileSync(path.join(process.env.MODEL_PICK_SNAPSHOT_DIR, `${label}-${width}.txt`), p.screen(width) + '\n', { mode: 0o600 }); }
    }
  };
  capture('matrix'); p.send('left'); capture('armed'); p.send('left'); capture('provider'); p.action('new-provider'); capture('supplier-form'); p.send('esc'); p.send('right'); p.send('down');
  add(p, 'synthetic-new'); capture('candidates'); adjustPicked(p); capture('parameters'); p.send('esc'); p.action('next-models'); capture('preflight'); p.action('skip'); capture('report'); finalConsent(p); capture('final-confirm'); p.action('commit'); await flush(p); capture('saved-without-password'); p.action('remove-provider'); capture('remove-confirmation'); assert.equal(p.calls.length, 0);
});

test('restore conflicts generate supplier copy without overwriting active config or moving old metadata', async t => {
  const p = await harness(t); p.send('down'); providerFocus(p); p.action('remove-provider'); p.action('confirm-remove'); await flush(p); assert.ok(!p.config().providers.p01);
  const current = p.config(); current.providers.p01 = { ...baseConfig().providers.p01, name: 'Replacement', models: [{ ...baseConfig().providers.p01.models[0], id: 'fresh' }] }; fs.writeFileSync(p.configFile, JSON.stringify(current));
  p.action('archives'); restoreFirst(p); assert.match(p.readContent(), /p01-restored.*副本|副本.*p01-restored/); assert.doesNotMatch(p.screen(), /供应商 ID:/); p.action('confirm-restore'); await flush(p);
  assert.equal(p.config().providers.p01.models[0].id, 'fresh'); assert.equal(p.config().providers['p01-restored'].models[0].id, 'm1'); p.send('\x1bl'); assert.match(p.screen(), /B/); assert.match(p.screen(), /M1/); p.type('p01-restored'); assert.match(p.screen(), /B/);
  assert.deepEqual(json(p, 'model-pick-favorites.json'), ['p01/m1']); assert.equal(p.selections.length, 0); noRequests(p);
});

test('empty removed-items list demands no password and creates no private store', async t => {
  const p = await harness(t); p.action('archives'); assert.match(p.screen(), /还没有移除任何项目/); assert.doesNotMatch(p.screen(), /主密码/); assert.ok(!fs.existsSync(file(p, 'model-pick-data')));
});

test('default backup is protected, preserves private fields and leaves legacy plaintext backups untouched', async t => {
  const p = await harness(t); const settings = file(p, 'settings.json'); const original = JSON.stringify({ defaultProvider: 'p00', defaultModel: 'm0', privateExtensionValue: fakeSecret }); fs.writeFileSync(settings, original);
  const oldBackup = file(p, 'settings.json.bak-model-pick'); fs.writeFileSync(oldBackup, 'SYNTHETIC-legacy-copy', { mode: 0o600 }); p.send('down'); p.send('\x1bd'); assert.equal(json(p, 'settings.json').defaultModel, 'm1'); assert.equal(json(p, 'settings.json').privateExtensionValue, fakeSecret);
  const backupFile = file(p, 'settings.json.bak-model-pick.sealed'); const backup = fs.readFileSync(backupFile, 'utf8'); assert.ok(!backup.includes(fakeSecret)); const restored = p.protection.open(JSON.parse(backup), 'settings'); assert.equal(restored.before, original); assert.equal(restored.kind, 'model-pick-settings-backup'); assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(oldBackup, 'utf8'), 'SYNTHETIC-legacy-copy'); assert.ok(!fs.readdirSync(p.root).some(name => name.endsWith('.tmp'))); assert.doesNotMatch(p.screen(), /主密码|解锁/); noRequests(p);
});

test('unavailable protection refuses save without plaintext fallback and preserves task for retry', async t => {
  const protectionState = { failSeal: true }; const p = await harness(t, { protectionState }); const original = p.config(); preflight(p, 'retry-safe-model'); confirmWithoutProbe(p); await flush(p);
  assert.match(p.readContent(), /安全记录无法保存；未使用明文替代/); assert.deepEqual(p.config(), original); assert.deepEqual(fs.readdirSync(file(p, 'model-pick-data')), []); noRequests(p); assert.ok(!p.raw().includes(fakeSecret));
  assert.equal(p.debug().view, 'report'); protectionState.failSeal = false; await commit(p); assert.ok(p.config().providers.p00.models.some(m => m.id === 'retry-safe-model')); assert.match(p.screen(), /配置已保存/);
});

test('failed secure preflight prevents auth resolution and discovery/suite requests', async t => {
  for (const discovery of [false, true]) {
    const p = await harness(t, { protectionState: { failSeal: true } }); const original = p.config(); if (discovery) discoveryConsent(p); else inspect(p); p.action(discovery ? 'connect' : 'run'); await flush(p);
    noRequests(p); assert.deepEqual(p.config(), original); assert.doesNotMatch(p.screen(), /主密码|解锁/); assert.ok(!p.raw().includes(fakeSecret)); assert.deepEqual(fs.readdirSync(file(p, 'model-pick-data')), []); assert.match(p.readContent(), /记录|安全保存|保留/);
  }
});

test('completed legacy records remain separate and do not block automatic writes', async t => {
  const first = await harness(t); const unchanged = seedLegacy(first); fs.writeFileSync(file(first, 'model-pick-favorites.json'), JSON.stringify(['p01/m1', 'legacy/legacy-m'])); await first.close(); const p = await harness(t, { existingHome: first.home });
  assert.deepEqual(json(p, 'model-pick-favorites.json'), ['p01/m1', 'legacy/legacy-m']); p.action('archives'); assert.match(p.readContent(), /旧版.*保留|旧版.*迁移/); assert.doesNotMatch(p.screen(), /主密码|解锁/); unchanged(); p.send('esc');
  preflight(p, 'automatic-beside-legacy'); confirmWithoutProbe(p); await flush(p); assert.ok(p.config().providers.p00.models.some(m => m.id === 'automatic-beside-legacy')); assert.ok(fs.existsSync(file(p, 'model-pick-data/vault.auto.json'))); unchanged(); noRequests(p);
});

test('unfinished legacy transaction blocks write/recovery without password or migration', async t => {
  const p = await harness(t); const unchanged = seedLegacy(p, true); const original = p.config(); p.action('add-model'); p.action('manual-id'); p.send('\x1b1'); await flush(p);
  assert.equal(p.debug().view, 'basket', 'pending work blocks the draft before request/final-save preparation'); const writeMessage = p.readContent(); assert.deepEqual(p.config(), original); unchanged(); assert.ok(!fs.existsSync(file(p, 'model-pick-data/vault.auto.json')));
  p.send('cancel'); home(p); p.action('archives'); p.action('recover'); await flush(p); const recoveryMessage = p.readContent(); assert.deepEqual(p.config(), original); unchanged(); noRequests(p);
  assert.match(writeMessage, /PENDING/); assert.match(recoveryMessage, /旧版.*保留|LEGACY_PENDING/);
});

test('production guard rechecks default changed during protected archive preflight', async t => {
  let p; let hit = false; const protectionState = { sealHook(_value, purpose) { if (purpose === 'models' && !hit) { hit = true; fs.writeFileSync(file(p, 'settings.json'), JSON.stringify({ defaultProvider: 'p01', defaultModel: 'm1' })); } } };
  p = await harness(t, { protectionState }); const original = p.config(); p.send('down'); p.action('remove-model'); p.action('confirm-remove'); await flush(p); assert.equal(hit, true); assert.deepEqual(p.config(), original); assert.match(p.readContent(), /默认模型.*先更换默认|先.*替代/);
  assert.equal(json(p, 'settings.json').defaultModel, 'm1'); assert.ok(!fs.existsSync(file(p, 'model-pick-data/vault.auto.json'))); assert.equal(p.calls.length, 0);
});

test('pending after-image cannot make stale archived row default; recovery retains valid default', async t => {
  let vaultRenames = 0; const p = await harness(t, { fsFault(op, args) { if (op === 'renameSync' && String(args[1]).endsWith('/vault.auto.json') && ++vaultRenames === 2) throw new Error('Synthetic finish failure'); } });
  p.send('down'); p.action('remove-model'); p.action('confirm-remove'); await flush(p); assert.equal(p.config().providers.p01.models.length, 0); assert.match(p.readContent(), /待核对|未确认完成/); const vaultFile = file(p, 'model-pick-data/vault.auto.json'); assert.equal(JSON.parse(fs.readFileSync(vaultFile)).pending, true);
  p.send('esc'); home(p); p.screen(); p.action('default'); home(p); assert.equal(json(p, 'settings.json').defaultModel, 'm0'); assert.ok(!fs.existsSync(file(p, 'settings.json.bak-model-pick.sealed')));
  p.action('archives'); p.action('recover'); await flush(p); p.action('confirm-recover'); await flush(p); assert.equal(JSON.parse(fs.readFileSync(vaultFile)).pending, false); assert.equal(json(p, 'settings.json').defaultModel, 'm0'); assert.equal(p.current().id, 'm0'); assert.equal(p.calls.length, 0);
});

test('external deletion without journal cannot make stale available row default', async t => {
  const p = await harness(t); p.send('down'); const changed = p.config(); changed.providers.p01.models = []; fs.writeFileSync(p.configFile, JSON.stringify(changed)); p.send('\x1bd'); assert.match(p.screen(), /默认设置未确认完成/); assert.equal(json(p, 'settings.json').defaultModel, 'm0');
  assert.ok(!fs.existsSync(file(p, 'settings.json.bak-model-pick.sealed'))); assert.deepEqual(p.protection.state.seals, []);
});

test('settings protection failure precedes explicit current/default replacement', async t => {
  const p = await harness(t, { protectionState: { failSeal: 'settings' } }); p.action('remove-model'); replacement(p); p.action('commit'); await flush(p); assert.match(p.readContent(), /替换未完整完成/); assert.equal(p.selections.length, 0); assert.equal(p.current().id, 'm0'); assert.equal(json(p, 'settings.json').defaultModel, 'm0');
  assert.ok(!fs.readdirSync(p.root).some(name => name.endsWith('.tmp') || name.endsWith('.sealed'))); assert.equal(p.calls.length, 0);
});

test('default target removed during protection is revalidated before settings or backup write', async t => {
  let p; let hit = false; const protectionState = { sealHook(_value, purpose) { if (purpose === 'settings' && !hit) { hit = true; const config = p.config(); config.providers.p01.models = []; fs.writeFileSync(p.configFile, JSON.stringify(config)); } } };
  p = await harness(t, { protectionState }); p.send('down'); p.send('\x1bd'); assert.equal(hit, true); assert.equal(json(p, 'settings.json').defaultModel, 'm0'); assert.ok(!fs.existsSync(file(p, 'settings.json.bak-model-pick.sealed'))); assert.ok(!fs.readdirSync(p.root).some(name => name.endsWith('.tmp')));
});

test('new supplier reads its own authorized list and commits two selected models only after final consent', async t => {
  const directKey = 'SYNTHETIC_LIST_KEY'; const p = await harness(t, { config: { providers: {} }, fetcher: async (url, options) => {
    assert.equal(url, 'https://draft-list.test/v1/models'); assert.equal(options.method, 'GET'); assert.equal(options.headers.authorization, `Bearer ${directKey}`);
    return Response.json({ data: [{ id: 'own-a' }, { id: 'own-b' }] });
  } });
  p.action('new-provider'); field(p, '名称', 'Own list'); field(p, '地址', 'https://draft-list.test/v1'); field(p, 'API Key', directKey);
  noRequests(p); assert.deepEqual(p.config(), { providers: {} }); p.action('connect'); await flush(p); assert.equal(p.debug().view, 'basket'); assert.equal(p.calls.length, 1); assert.equal(p.authCalls(), 0);
  p.send('down'); p.send('enter'); p.send('down'); p.send('enter'); assert.match(p.screen(), /已选 2 个/); assert.deepEqual(p.config(), { providers: {} }); assert.equal(fs.existsSync(file(p, 'auth.json')), false);
  p.action('next-models'); p.action('skip'); finalConsent(p); assert.deepEqual(p.config(), { providers: {} }); assert.equal(fs.existsSync(file(p, 'auth.json')), false); assert.ok(!p.raw().includes(directKey));
  p.action('commit'); await flush(p); home(p); assert.deepEqual(p.config().providers['own-list'].models.map(m => m.id), ['own-a', 'own-b']); assert.equal('apiKey' in p.config().providers['own-list'], false); assert.equal(json(p, 'auth.json')['own-list'].key, directKey);
  assert.equal(p.calls.length, 1); assert.equal(p.selections.length, 0); assert.equal(p.current(), undefined); assert.equal(json(p, 'settings.json').defaultModel, 'm0');
});

test('thinking codecs preserve absent/empty/null and literal extended strengths through a reviewed metadata edit', async t => {
  for (const map of [undefined, {}, { off: null, minimal: '', xhigh: '-', max: '=vendor' }]) {
    const config = baseConfig(); if (map !== undefined) config.providers.p01.models[0].thinkingLevelMap = map;
    const p = await harness(t, { config }); p.send('down'); p.action('edit-model'); advanced(p);
    field(p, '显示名', 'Codec roundtrip'); p.action('save-form'); assert.deepEqual(p.config(), config); p.action('apply-inspect'); await flush(p);
    const model = p.config().providers.p01.models[0]; assert.equal(model.name, 'Codec roundtrip'); assert.deepEqual(model.thinkingLevelMap, map);
    assert.equal(Object.hasOwn(model, 'thinkingLevelMap'), map !== undefined); assert.equal(p.current().id, 'm0'); assert.equal(p.selections.length, 0); noRequests(p);
  }
});

// Current-provider connection changes are intentionally fail-closed. Exercise the
// denied tuple and a switched-away positive edit instead of relying on old menus.
test('current supplier direct-key/endpoint/API edits fail closed without file changes', async t => {
  for (const changed of ['key', 'endpoint', 'api']) {
    const p = await harness(t); const before = fs.readFileSync(p.configFile, 'utf8'); providerFocus(p); p.action('edit-provider'); await p.flush();
    if (changed === 'key') field(p, 'API Key', 'SYNTHETIC_ROTATED');
    else if (changed === 'endpoint') field(p, '地址', 'https://rotated.test/v1');
    else { focusField(p, '接口类型'); p.send('right'); p.send('right'); }
    p.action('save-form'); await flush(p); assert.equal(fs.readFileSync(p.configFile, 'utf8'), before); assert.equal(fs.existsSync(file(p, 'auth.json')), false); assert.equal(p.current().baseUrl, 'https://example.test/v1'); assert.match(p.readContent(), /CURRENT|当前|未提交/); noRequests(p);
  }
});

test('switching away permits coordinated provider direct-key edit while preserving unknown fields', async t => {
  const config = baseConfig(); config.providers.p00.extra = { preserved: true }; const p = await harness(t, { config }); p.setCurrent('p01', 'm1'); providerFocus(p); p.action('edit-provider'); await p.flush(); field(p, 'API Key', 'SYNTHETIC_ROTATED'); p.action('save-form'); await flush(p);
  assert.equal(json(p, 'auth.json').p00.key, 'SYNTHETIC_ROTATED'); assert.equal(p.config().providers.p00.apiKey, config.providers.p00.apiKey); assert.deepEqual(p.config().providers.p00.extra, { preserved: true }); assert.equal(p.current().provider, 'p01'); assert.equal(p.current().id, 'm1'); assert.equal(p.selections.length, 0); noRequests(p);
});
