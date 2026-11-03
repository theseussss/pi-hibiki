import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadTypeScript } from './model-pick-loader.mjs';
import { tui, paint, mountActions, enterManualIds } from './model-pick-ui-harness.mjs';
const file = fileURLToPath(new URL('../lib/model-pick/panel.ts', import.meta.url));
const json = x => JSON.parse(JSON.stringify(x));
function harness(t, { guard = {}, replace, protectedProvider = false, auth, catalog: catalogOverride } = {}) {
  const events = [], records = [], notices = [], archives = [];
  let revision = 'r0', calls = 0;
  const providers = [{ id: 'p', name: 'P', endpoint: 'https://synthetic.test/v1', api: 'openai-completions', models: [{ id: 'm', name: 'M', contextWindow: 8000, maxTokens: 1000, reasoning: false, input: ['text'] }] }];
  class StoreError extends Error { constructor(code) { super(code); this.code = code; } }
  function commit(kind, args, expected, g) { if (expected !== revision) throw new StoreError('CONFLICT'); assert.ok(!g.busy); events.push([kind, json(args)]); revision += '+'; }
  const store = {
    snapshot: () => ({ revision, providers: json(providers) }), lock() {}, isUnlocked: () => true,
    hasVault: () => false, hasPending: () => false, unlock() { assert.fail('UI must not request a human unlock'); },
    putModels(p, models, r, g) { commit('models', { p, models }, r, g); },
    addProviderWithModels(provider, models, r, g) { assert.ok(models.length); commit('provider-models', { provider, models }, r, g); },
    retained: () => ({ providers: [], models: [] }), listArchives: () => json(archives),
    archiveModel(provider, id, r, g) { assert.ok(!(g.current?.provider === provider && g.current.id === id)); assert.ok(!(g.default?.provider === provider && g.default.id === id)); commit('archive-model', { provider, id }, r, g); archives.push({ id: 'a', kind: 'model', provider, modelId: id }); },
    archiveProvider(provider, r, g) { assert.notEqual(g.current?.provider, provider); assert.notEqual(g.default?.provider, provider); commit('archive-provider', { provider }, r, g); archives.push({ id: 'a', kind: 'provider', provider }); },
    restore(id, r, g) { commit('restore', { id }, r, g); },
  };
  const module = loadTypeScript(file, { '@earendil-works/pi-tui': tui, './store.js': { StoreError }, 'node:fs': {} }, { fetch() { calls++; throw new Error('network forbidden'); } });
  const actions = new module.PickerActions({ store,
    records: { hasData: () => false, tests: () => [], referenceData: () => ({ tests: [], references: [] }), append: r => records.push(json(r)), appendMany: batch => records.push(...json(batch)) },
    catalog: () => catalogOverride ?? [{ provider: 'local', id: 'known', name: 'Known', contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ['text', 'image'] }],
    guard: () => guard, changed: async () => {}, requestRender() {}, auth: auth ?? (async () => { throw new Error('SYNTHETIC-secret'); }), paint,
    providerCommit: { snapshotCredential: async () => ({ revision: 'credential-r0', kind: 'absent' }), commit: async request => {
      assert.equal(request.expectedCredentialRevision, 'credential-r0'); assert.equal(request.change.kind, 'add');
      const { provider, models, credential } = request.change; assert.equal(credential.kind, 'literal'); assert.equal(credential.value, 'SYNTHETIC_KEY');
      store.addProviderWithModels(provider, models, request.expectedModelsRevision, guard);
      return { status: 'committed', transactionId: 'synthetic-tx', modelsRevision: revision, refreshRequired: true };
    } },
    feedback: v => notices.push(v), isProtected: () => protectedProvider, available: () => [{ provider: 'other', id: 'replacement' }],
    ...(replace ? { replace: async (m, targets) => replace(m, targets, guard, events) } : {}),
  });
  const leaks = [];
  actions.subscribe(() => { const snapshot = JSON.stringify(actions.taskSnapshot()); if (/SYNTHETIC_KEY|SYNTHETIC-secret/.test(snapshot)) leaks.push(snapshot); });
  const ui = mountActions(actions);
  t.after(() => { ui.dispose(); actions.dispose(); assert.deepEqual(leaks, [], 'public task snapshots must not retain credentials or raw secret errors'); });
  const p = { ...ui, actions, events, records, notices, store, guard, calls: () => calls,
    external() { revision += '-external'; },
    replace(s) { this.send('clear'); this.type(s); },
    async flush() { await new Promise(setImmediate); },
    async settled() { await this.flush(); assert.doesNotMatch(this.screen(), /主密码|解锁并继续|再次输入/); },
    async supplier(name = 'New channel') {
      actions.open({}, 'new-provider'); this.screen();
      field(this, '名称', name); field(this, '地址', 'https://new.synthetic.test/v1'); field(this, 'API Key', 'SYNTHETIC_KEY');
      this.choose('manual-connection'); await this.flush();
    },
  }; return p;
}
function field(p, label, value) {
  for (let i = 0; i < 60; i++) {
    if (p.screen().split('\n').some(line => line.trimStart().startsWith(`› ${label}`))) { p.replace(value); return; }
    p.send('tab');
  }
  assert.fail(`field not reachable: ${label}\n${p.screen()}`);
}
function zone(p, name) {
  for (let i = 0; i < 60; i++) {
    const d = p.component.debug(); if (!d.actionMode && d.zone === name) return;
    p.send('tab');
  }
  assert.fail(`zone not reachable: ${name}`);
}
function pick(p, ids) { enterManualIds(p, ids); }
function adjust(p) { zone(p, 'selected'); p.send('enter'); }
function referenceReport(p) { p.choose('next-models'); p.choose('skip'); }
async function save(p) { referenceReport(p); p.choose('commit'); p.choose('commit'); await p.settled(); }

test('direct model edit replaces obsolete root/more menu without advertising unrelated tasks', t => {
  const p = harness(t); p.actions.open({ kind: 'model', provider: 'p', modelId: 'm' });
  assert.equal(p.actions.taskSnapshot().kind, 'edit'); assert.match(p.screen(), /参数|显示名/);
  assert.doesNotMatch(p.screen(), /更多…|主密码|加密|清单/); assert.equal(p.events.length, 0);
});

test('direct add opens local filtering and explicit manual form with real Input and no network', t => {
  const p = harness(t, { catalog: [{ provider: 'p', id: 'known', name: 'Known', contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ['text', 'image'] }] });
  p.actions.open({ kind: 'model', provider: 'p', modelId: 'm' }, 'add');
  assert.match(p.screen(), /known/); assert.equal(p.actions.taskSnapshot().selected.length, 0);
  p.type('unknown'); p.send('save'); assert.equal(p.actions.taskSnapshot().purpose, 'discovery-consent'); p.send('esc'); assert.equal(p.actions.taskSnapshot().kind, 'basket');
  assert.equal(p.events.length, 0, 'a filter is not a picked model');
  p.send('enter'); assert.equal(p.actions.taskSnapshot().selected.length, 0); pick(p, 'unknown'); adjust(p);
  assert.match(p.screen(), /unknown.*参数/); assert.ok(p.actions.taskSnapshot().evidence.some(e => e.provenance.source === 'default'));
  for (const width of [12, 32, 80]) assert.ok(p.component.render(width).every(line => tui.visibleWidth(line) < width));
  p.choose('back'); referenceReport(p); assert.match(p.readContent(), /待确认|待核对/);
  assert.equal(p.calls(), 0); assert.equal(p.events.length, 0);
});

test('explicit batch picks resolve and record each model in one save; no automatic switch', async t => {
  const p = harness(t); p.actions.open({ provider: 'p' }, 'add'); pick(p, 'known,unknown');
  assert.equal(p.events.length, 0); assert.equal(p.records.length, 0); assert.equal(p.actions.taskSnapshot().selected.length, 2);
  await save(p); assert.equal(p.actions.active, false); assert.equal(p.events[0][0], 'models');
  assert.equal(p.events[0][1].models.length, 2); assert.equal(p.events[0][1].models[0].contextWindow, 64000);
  assert.deepEqual(p.records.map(r => r.kind), ['resolution', 'resolution', 'reference', 'reference']);
  assert.equal(p.records[1].provenance.contextWindow.source, 'default'); assert.equal(p.records[0].provenance.contextWindow.source, 'generic'); assert.equal(p.calls(), 0);
});

test('details cancellation preserves exact picked pane and original draft without any password step', t => {
  const p = harness(t); p.actions.open({ provider: 'p' }, 'add'); pick(p, 'unknown'); zone(p, 'selected'); const before = p.screen();
  p.send('enter'); field(p, '显示名', 'discard-name'); p.send('esc'); assert.equal(p.screen(), before);
  p.send('enter'); assert.doesNotMatch(p.screen(), /discard-name|主密码|解锁/); assert.equal(p.events.length, 0); assert.equal(p.records.length, 0);
});

test('new supplier is one continuous task with generated ID and coordinated models commit', async t => {
  const p = harness(t); await p.supplier(); assert.equal(p.events.length, 0); pick(p, 'known'); assert.equal(p.events.length, 0);
  await save(p); assert.equal(p.events.length, 1); const [kind, data] = p.events[0]; assert.equal(kind, 'provider-models');
  assert.equal(data.provider.id, 'new-channel'); assert.equal('envVar' in data.provider, false); assert.equal('apiKey' in data.provider, false); assert.equal(data.models[0].id, 'known');
});

test('returning through unread supplier connection retains explicit manual model draft', async t => {
  const p = harness(t); await p.supplier(); pick(p, 'typed-draft'); const before = json(p.actions.taskSnapshot());
  p.choose('back'); assert.match(p.readContent(), /New channel/); p.choose('manual-connection'); await p.flush();
  assert.equal(p.actions.taskSnapshot().viewId, before.viewId); assert.deepEqual(json(p.actions.taskSnapshot().selected), before.selected); assert.equal(p.actions.taskSnapshot().query, before.query);
  p.choose('back'); p.choose('cancel-task'); assert.equal(p.actions.active, false); assert.equal(p.events.length, 0);
});

test('same flow discovery failure keeps typed input and immediately allows manual continuation', async t => {
  const p = harness(t, { catalog: [{ provider: 'p', id: 'typed-manual' }] }); p.actions.open({ provider: 'p' }, 'add'); p.type('typed-manual'); p.choose('read-list'); p.choose('connect'); await p.settled();
  assert.match(p.screen(), /可继续手输/); assert.equal(p.actions.taskSnapshot().query, 'typed-manual'); assert.doesNotMatch(p.screen(), /SYNTHETIC-secret/);
  zone(p, 'query'); p.send('enter'); assert.equal(p.actions.taskSnapshot().selected.length, 0); pick(p, 'typed-manual'); adjust(p); assert.match(p.screen(), /typed-manual.*参数/); assert.ok(p.actions.taskSnapshot().evidence.some(e => e.provenance.source === 'default'));
  assert.equal(p.events.length, 0); assert.equal(p.calls(), 0);
});

test('busy and protected removal are blocked; current/default require explicit replacement', t => {
  for (const options of [{ guard: { busy: true } }, { protectedProvider: true }, { guard: { current: { provider: 'p', id: 'm' } } }, { guard: { default: { provider: 'p', id: 'm' } } }, { guard: { current: { provider: 'p', id: 'm' }, default: { provider: 'p', id: 'm' } } }]) {
    const p = harness(t, options); p.actions.open({ kind: 'provider', provider: 'p' }, 'remove');
    assert.doesNotMatch(p.screen(), /主密码/); assert.ok(p.actions.taskSnapshot().kind === 'info' || p.actions.taskSnapshot().purpose === 'replacement');
    assert.ok(!p.actions.taskSnapshot().actions.some(a => a.id === 'confirm-remove')); assert.equal(p.events.length, 0);
  }
});

test('explicit replacement is separate from archive consent and final guards are rechecked', async t => {
  const p = harness(t, { guard: { current: { provider: 'p', id: 'm' }, default: { provider: 'p', id: 'm' } }, replace: async (m, targets, g, events) => { events.push(['replace', json(targets)]); g.current = m; g.default = m; } });
  p.actions.open({ kind: 'provider', provider: 'p' }, 'remove'); p.choose('replacement'); assert.equal(p.events.length, 0); p.choose('commit'); await p.flush();
  assert.equal(p.actions.taskSnapshot().purpose, 'remove'); assert.equal(p.events.length, 1);
  p.choose('confirm-remove'); await p.settled(); assert.equal(p.events[1][0], 'archive-provider');
  assert.match(p.actions.undoLabel, /撤销移除 p/); p.actions.undoLast(); await p.flush(); assert.equal(p.events[2][0], 'restore'); assert.equal(p.actions.undoLabel, null);
});

test('partial replacement failure is honest and never starts archive', async t => {
  const p = harness(t, { guard: { current: { provider: 'p', id: 'm' } }, replace: async (m, _targets, g) => { g.current = m; throw new Error('SYNTHETIC-secret'); } });
  p.actions.open({ kind: 'model', provider: 'p', modelId: 'm' }, 'remove'); p.choose('replacement'); p.choose('commit'); await p.flush();
  assert.match(p.readContent(), /未归档.*可能已部分改变/); assert.doesNotMatch(p.screen(), /SYNTHETIC-secret|主密码/); assert.equal(p.events.length, 0);
});

test('undo refuses external revision conflict without overwriting', async t => {
  const p = harness(t); p.actions.open({ provider: 'p', modelId: 'm' }, 'remove'); p.choose('confirm-remove'); await p.settled();
  const label = p.actions.undoLabel; p.external(); p.actions.undoLast(); await p.flush(); assert.equal(p.events.length, 1); assert.match(p.readContent(), /CONFLICT|配置操作已停止|修改未确认完成|无法撤销/);
  assert.equal(p.actions.undoLabel, label, 'a refused undo must retain the original archive/revision identity');
});

test('supplier ID collision gets a safe suffix, never overwrites an existing row', async t => {
  const p = harness(t); await p.supplier('P'); pick(p, 'known'); await save(p); assert.equal(p.events[0][1].provider.id, 'p-2');
});

test('external edits during replacement prevent archive after explicit switch', async t => {
  let p; p = harness(t, { guard: { current: { provider: 'p', id: 'm' } }, replace: async (m, _targets, g) => { g.current = m; p.external(); } });
  p.actions.open({ kind: 'provider', provider: 'p' }, 'remove'); p.choose('replacement'); p.choose('commit'); await p.flush();
  assert.match(p.readContent(), /未归档/); assert.deepEqual(json(p.guard.current), { provider: 'other', id: 'replacement' }); assert.equal(p.events.length, 0);
});

test('cancelling list consent preserves parent input without credentials, records or requests', t => {
  let authCalls = 0; const p = harness(t, { catalog: [{ provider: 'p', id: 'kept-model' }], auth: async () => { authCalls++; throw new Error('Forbidden authentication'); } });
  p.actions.open({ provider: 'p' }, 'add'); p.type('kept-model'); p.choose('read-list'); p.send('esc'); const before = p.screen();
  p.send('enter'); assert.equal(p.actions.taskSnapshot().purpose, 'discovery-consent'); p.send('esc'); assert.equal(p.screen(), before);
  assert.equal(p.actions.taskSnapshot().query, 'kept-model'); assert.equal(p.calls(), 0); assert.equal(authCalls, 0); assert.equal(p.records.length, 0);
});

test('changed current guard after confirmation opens requires explicit replacement, not archive', async t => {
  const p = harness(t); p.actions.open({ provider: 'p', modelId: 'm' }, 'remove'); p.guard.current = { provider: 'p', id: 'm' };
  p.choose('confirm-remove'); await p.settled(); assert.equal(p.events.length, 0); assert.equal(p.records.length, 0);
  assert.equal(p.actions.taskSnapshot().purpose, 'replacement'); assert.ok(!p.actions.taskSnapshot().actions.some(a => a.id === 'confirm-remove'));
});

test('changing supplier connection invalidates old picks/references; deliberately re-entered manual specs persist', async t => {
  const p = harness(t); await p.supplier(); pick(p, 'known'); adjust(p); field(p, '显示名', 'Manual name'); p.choose('save-form'); p.choose('back');
  field(p, '地址', 'https://changed.synthetic.test/v1'); p.choose('manual-connection'); await p.flush();
  assert.equal(p.actions.taskSnapshot().selected.length, 0, 'changed tuple must invalidate old resolutions, even edited ones');
  pick(p, 'known'); adjust(p); field(p, '显示名', 'Manual name'); p.choose('save-form'); await save(p);
  assert.equal(p.events[0][1].provider.endpoint, 'https://changed.synthetic.test/v1'); assert.equal(p.events[0][1].models[0].name, 'Manual name');
  assert.equal(p.records[0].provenance.name.source, 'manual'); assert.equal(p.records[0].provenance.contextWindow.source, 'generic'); assert.equal(p.calls(), 0);
});

test('candidate lists omit already added IDs and disclose bounded visible match count', t => {
  const p = harness(t, { catalog: [{ provider: 'p', id: 'm' }, ...Array.from({ length: 30 }, (_, i) => ({ provider: 'p', id: `ref${i}` }))] });
  p.actions.open({ kind: 'model', provider: 'p', modelId: 'm' }, 'add'); assert.equal(p.actions.taskSnapshot().candidates.length, 30);
  assert.ok(!p.actions.taskSnapshot().candidates.some(m => m.id === 'm')); assert.match(p.screen(), /候选.*30|30.*候选/); assert.match(p.screen(), /\(1\/30\)/);
  assert.ok(p.screen().split('\n').filter(line => /ref\d+/.test(line)).length <= 20);
  zone(p, 'query'); p.type('ref29'); assert.equal(p.actions.taskSnapshot().query, 'ref29'); assert.match(p.screen(), /ref29/); assert.equal(p.actions.taskSnapshot().candidates.length, 30, 'snapshot retains raw candidate count');
  assert.equal(p.events.length, 0); assert.equal(p.records.length, 0); p.send('esc'); assert.equal(p.actions.active, false);
});

test('enhanced repeat and release events cannot pick or submit model basket', t => {
  const p = harness(t, { catalog: [{ provider: 'p', id: 'unknown' }] }); p.actions.open({ provider: 'p' }, 'add'); p.type('unknown');
  for (const key of ['\x1b[13;1:2u', '\x1b[13;1:2u', '\x1b[115;5:2u']) p.unsafeSend(key);
  assert.equal(p.actions.taskSnapshot().query, 'unknown'); assert.equal(p.actions.taskSnapshot().selected.length, 0); assert.equal(p.events.length, 0);
  p.send('enter'); assert.equal(p.actions.taskSnapshot().selected.length, 0, 'query Enter only focuses a candidate'); p.send('enter'); assert.equal(p.actions.taskSnapshot().selected.length, 1);
  for (const key of ['\x1b[13;1:2u', '\x1b[13;1:3u', '\x1b[115;5:2u', '\x1b[115;5:3u']) p.unsafeSend(key);
  assert.doesNotMatch(p.screen(), /主密码/); assert.equal(p.events.length, 0); assert.equal(p.records.length, 0);
});
