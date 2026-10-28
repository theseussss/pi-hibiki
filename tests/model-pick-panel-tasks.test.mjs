import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadTypeScript } from './model-pick-loader.mjs';
import { tui, key as keys, plain, paint, focusedNativeRow } from './model-pick-ui-harness.mjs';
const file = fileURLToPath(new URL('../lib/model-pick/panel.ts', import.meta.url));
const json = (x) => JSON.parse(JSON.stringify(x));
function harness(t, { guard = {}, replace, protectedProvider = false, auth, catalog: catalogOverride } = {}) {
  const events = []; const records = []; const notices = []; const archives = [];
  let revision = 'r0'; let calls = 0;
  const providers = [{ id: 'p', name: 'P', endpoint: 'https://synthetic.test/v1', api: 'openai-completions', models: [{ id: 'm', name: 'M', contextWindow: 8000, maxTokens: 1000, reasoning: false, input: ['text'] }] }];
  class StoreError extends Error {}
  function commit(kind, args, expected, g) { assert.equal(expected, revision); assert.ok(!g.busy); events.push([kind, json(args)]); revision += '+'; }
  const store = {
    snapshot: () => ({ revision, providers: json(providers) }), lock() {}, isUnlocked: () => true,
    hasVault: () => false, hasPending: () => false, unlock() { assert.fail('UI must not request a human unlock'); },
    putModels(p, models, r, g) { commit('models', { p, models }, r, g); },
    addProviderWithModels(provider, models, r, g) { assert.ok(models.length); commit('provider-models', { provider, models }, r, g); },
    retained: () => ({ providers: [], models: [] }),
    listArchives: () => json(archives),
    archiveModel(provider, id, r, g) { assert.ok(!(g.current?.provider === provider && g.current.id === id)); assert.ok(!(g.default?.provider === provider && g.default.id === id)); commit('archive-model', { provider, id }, r, g); archives.push({ id: 'a', kind: 'model', provider, modelId: id }); },
    archiveProvider(provider, r, g) { assert.notEqual(g.current?.provider, provider); assert.notEqual(g.default?.provider, provider); commit('archive-provider', { provider }, r, g); archives.push({ id: 'a', kind: 'provider', provider }); },
    restore(id, r, g) { commit('restore', { id }, r, g); },
  };
  const module = loadTypeScript(file, { '@earendil-works/pi-tui': tui, './store.js': { StoreError }, 'node:fs': {} }, { fetch() { calls++; throw new Error('network forbidden'); } });
  const actions = new module.PickerActions({ store, records: { hasData: () => false, tests: () => [], append: (r) => records.push(json(r)), appendMany: (batch) => records.push(...json(batch)) }, catalog: () => catalogOverride ?? [{ provider: 'local', id: 'known', name: 'Known', contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ['text', 'image'] }], guard: () => guard, changed: async () => {}, requestRender() {}, auth: auth ?? (async () => { throw new Error('SYNTHETIC-secret'); }), paint, feedback: (v) => notices.push(v), isProtected: () => protectedProvider, available: () => [{ provider: 'other', id: 'replacement' }], ...(replace ? { replace: async (m, targets) => replace(m, targets, guard, events) } : {}) });
  t.after(() => actions.dispose());
  const p = {
    actions, events, records, notices, store, guard, calls: () => calls,
    external() { revision += '-external'; },
    raw(width = 180) { return actions.render(width, 24); },
    screen(width = 180) { return this.raw(width).map(plain).join('\n'); },
    send(s) { actions.handleInput(keys[s] ?? s); }, type(s) { for (const c of s) this.send(c); },
    replace(s) { this.send('clear'); this.type(s); },
    choose(label) {
      for (let i = 0; i < 100; i++) {
        const selected = focusedNativeRow(this.raw());
        assert.ok(selected, `native list does not own focus; use Tab/ShiftTab first: ${label}\n${this.screen()}`);
        if (selected.includes(label)) { this.send('enter'); return; }
        this.send('down');
      }
      assert.fail(`missing ${label}: ${this.screen()}`);
    },
    async flush() { await new Promise(setImmediate); },
    async settled() { assert.doesNotMatch(this.screen(), /主密码|解锁并继续|再次输入/); await this.flush(); },
    supplier(name = 'New channel') { actions.open({ kind: 'provider', provider: 'p' }, 'add'); this.type(name); this.send('tab'); this.type('https://new.synthetic.test/v1'); this.send('tab'); this.send('tab'); this.type('SYNTHETIC_KEY'); this.send('save'); },
  }; return p;
}

test('context root contains tasks and one secondary maintenance entry only', (t) => {
  const p = harness(t); p.actions.open({ kind: 'model', provider: 'p', modelId: 'm' });
  assert.match(p.screen(), /添加模型/); assert.match(p.screen(), /移除模型/); assert.match(p.screen(), /更多…/);
  assert.doesNotMatch(p.screen(), /来源|清单|加密|恢复|测试/);
});

test('direct add opens searchable local/manual input with real Input and no network', (t) => {
  const p = harness(t, { catalog: [{ provider: 'p', id: 'known', name: 'Known', contextWindow: 64000, maxTokens: 4096, reasoning: true, input: ['text', 'image'] }] }); p.actions.open({ kind: 'model', provider: 'p', modelId: 'm' }, 'add');
  assert.match(p.screen(), /搜索或输入模型 ID/); assert.match(p.screen(), /known/); assert.doesNotMatch(p.screen(), /添加0个模型/);
  p.type('unknown'); p.send('save');
  assert.match(p.screen(), /请先选择至少一个模型/); assert.match(p.screen(), /已选 0/);
  assert.equal(p.events.length, 0, 'a filter is not a picked model');
  p.send('enter'); p.send('tab'); p.send('tab');
  assert.match(p.screen(), /参数 · unknown/); assert.match(p.screen(), /规格待确认/); assert.doesNotMatch(p.screen(), /上下文窗口:/);
  for (const width of [12, 32, 80]) assert.ok(p.actions.render(width).every((line) => tui.visibleWidth(line) < width));
  assert.equal(p.calls(), 0); assert.equal(p.events.length, 0);
});

test('explicit batch picks resolve and record each model in one save; no automatic switch', async (t) => {
  const p = harness(t); p.actions.open({ provider: 'p' }, 'add'); p.type('known,unknown'); p.send('enter');
  assert.equal(p.events.length, 0); assert.equal(p.records.length, 0); assert.match(p.screen(), /已选 2/);
  p.send('save'); await p.settled();
  assert.equal(p.actions.active, false); assert.equal(p.events[0][0], 'models');
  assert.equal(p.events[0][1].models.length, 2); assert.equal(p.events[0][1].models[0].contextWindow, 64000);
  assert.equal(p.records.length, 2); assert.equal(p.records[1].provenance.contextWindow.source, 'default');
  assert.equal(p.records[0].provenance.contextWindow.source, 'generic'); assert.equal(p.calls(), 0);
});

test('details cancellation preserves exact picked pane and original draft without any password step', (t) => {
  const p = harness(t); p.actions.open({ provider: 'p' }, 'add'); p.type('unknown'); p.send('enter');
  p.send('down'); const before = p.screen(); p.choose('参数 · unknown'); p.replace('discard-name'); p.send('esc');
  assert.equal(p.screen(), before); assert.doesNotMatch(p.screen(), /主密码|解锁/);
  p.choose('参数 · unknown'); assert.doesNotMatch(p.screen(), /discard-name/); assert.equal(p.events.length, 0);
  assert.equal(p.records.length, 0);
});

test('new supplier is one continuous task with generated ID and atomic models commit', async (t) => {
  const p = harness(t); p.supplier(); assert.equal(p.events.length, 0);
  assert.doesNotMatch(p.screen(), /读取模型清单…/); p.type('known'); p.send('enter');
  assert.equal(p.events.length, 0); p.send('save'); await p.settled();
  assert.equal(p.events.length, 1); const [kind, data] = p.events[0]; assert.equal(kind, 'provider-models');
  assert.equal(data.provider.id, 'new-channel'); assert.equal(data.provider.envVar, 'SYNTHETIC_KEY'); assert.equal(data.models[0].id, 'known');
});

test('returning through supplier connection stage retains model search draft', (t) => {
  const p = harness(t); p.supplier(); p.type('typed-draft'); const before = p.screen();
  p.send('esc'); assert.match(p.screen(), /New channel/); p.send('save'); assert.equal(p.screen(), before);
  p.send('esc'); p.send('esc'); assert.equal(p.actions.active, false); assert.equal(p.events.length, 0);
});

test('same flow discovery failure keeps typed input and immediately allows manual continuation', async (t) => {
  const p = harness(t); p.actions.open({ provider: 'p' }, 'add'); p.type('typed-manual'); p.send('backTab'); p.choose('读取模型清单'); p.choose('确认读取'); await p.settled(); await p.flush();
  assert.match(p.screen(), /可继续手输/); assert.match(p.screen(), /^› typed-manual/m); assert.doesNotMatch(p.screen(), /SYNTHETIC-secret/);
  p.send('tab'); p.send('enter'); p.send('down');
  assert.match(p.screen(), /参数 · typed-manual/); assert.match(p.screen(), /规格待确认/); assert.equal(p.events.length, 0); assert.equal(p.calls(), 0);
});

test('busy and protected removal are blocked; current/default require explicit replacement', (t) => {
  for (const options of [{ guard: { busy: true } }, { protectedProvider: true }, { guard: { current: { provider: 'p', id: 'm' } } }, { guard: { default: { provider: 'p', id: 'm' } } }, { guard: { current: { provider: 'p', id: 'm' }, default: { provider: 'p', id: 'm' } } }]) {
    const p = harness(t, options); p.actions.open({ kind: 'provider', provider: 'p' }, 'remove');
    assert.doesNotMatch(p.screen(), /主密码/); assert.match(p.screen(), /只读|请求运行中|先明确切换/); assert.equal(p.events.length, 0);
  }
});

test('explicit replacement is separate from archive consent and final guards are rechecked', async (t) => {
  const p = harness(t, { guard: { current: { provider: 'p', id: 'm' }, default: { provider: 'p', id: 'm' } }, replace: async (m, targets, g, events) => { events.push(['replace', json(targets)]); g.current = m; g.default = m; } });
  p.actions.open({ kind: 'provider', provider: 'p' }, 'remove'); assert.equal(p.events.length, 0);
  p.choose('other / replacement'); assert.equal(p.events.length, 0); p.choose('确认替换'); await p.flush();
  assert.match(p.screen(), /整行 1 个模型/); assert.equal(p.events.length, 1);
  p.choose('确认移除'); await p.settled(); assert.equal(p.events[1][0], 'archive-provider');
  assert.match(p.actions.undoLabel, /撤销移除 p/); p.actions.undoLast(); await p.flush(); assert.equal(p.events[2][0], 'restore'); assert.equal(p.actions.undoLabel, null);
});

test('partial replacement failure is honest and never starts archive', async (t) => {
  const p = harness(t, { guard: { current: { provider: 'p', id: 'm' } }, replace: async (m, _targets, g) => { g.current = m; throw new Error('SYNTHETIC-secret'); } });
  p.actions.open({ kind: 'model', provider: 'p', modelId: 'm' }, 'remove'); p.choose('other / replacement'); p.choose('确认替换'); await p.flush();
  assert.match(p.screen(), /未归档.*可能已部分改变/); assert.doesNotMatch(p.screen(), /SYNTHETIC-secret|主密码/); assert.equal(p.events.length, 0);
});

test('undo refuses external revision conflict without overwriting', async (t) => {
  const p = harness(t); p.actions.open({ provider: 'p', modelId: 'm' }, 'remove'); p.choose('确认移除'); await p.settled();
  p.external(); p.actions.undoLast(); await p.flush(); assert.equal(p.events.length, 1); assert.match(p.screen(), /修改未确认完成/);
});

test('supplier ID collision gets a safe suffix, never overwrites an existing row', async (t) => {
  const p = harness(t); p.supplier('P'); p.type('known'); p.send('enter'); p.send('save'); await p.settled();
  assert.equal(p.events[0][1].provider.id, 'p-2');
});

test('external edits during replacement prevent archive after explicit switch', async (t) => {
  let p;
  p = harness(t, { guard: { current: { provider: 'p', id: 'm' } }, replace: async (m, _targets, g) => { g.current = m; p.external(); } });
  p.actions.open({ kind: 'provider', provider: 'p' }, 'remove'); p.choose('other / replacement'); p.choose('确认替换'); await p.flush();
  assert.match(p.screen(), /替换已完成，但未归档/); assert.equal(p.events.length, 0);
});

test('cancelling list consent preserves parent input without credentials, records or requests', (t) => {
  let authCalls = 0;
  const p = harness(t, { auth: async () => { authCalls++; throw new Error('Forbidden authentication'); } });
  p.actions.open({ provider: 'p' }, 'add'); p.type('kept-model'); p.send('backTab'); p.send('down'); const before = p.screen(); p.choose('读取模型清单');
  assert.doesNotMatch(p.screen(), /主密码|解锁/); p.send('esc');
  assert.equal(p.screen(), before); assert.match(p.screen(), /^› kept-model/m); assert.equal(p.calls(), 0); assert.equal(authCalls, 0); assert.equal(p.records.length, 0);
});

test('changed current guard after confirmation opens requires an explicit replacement, not archive', async (t) => {
  const p = harness(t); p.actions.open({ provider: 'p', modelId: 'm' }, 'remove');
  p.guard.current = { provider: 'p', id: 'm' }; p.choose('确认移除'); await p.settled();
  assert.equal(p.events.length, 0); assert.match(p.screen(), /当前模型.*先明确切换当前模型/); assert.equal(p.records.length, 0);
});

test('changing a supplier draft connection re-resolves generated fields and preserves only deliberate manual edits', async (t) => {
  const p = harness(t); p.supplier(); p.type('known'); p.send('enter'); p.send('down');
  p.choose('参数 · known'); p.replace('Manual name'); p.send('save');
  p.send('esc');
  p.send('up'); p.send('up'); p.replace('https://changed.synthetic.test/v1'); p.send('save');
  assert.match(p.screen(), /参数 · known/); p.send('save'); await p.settled();
  assert.equal(p.events[0][1].provider.endpoint, 'https://changed.synthetic.test/v1');
  assert.equal(p.events[0][1].models[0].name, 'Manual name');
  assert.equal(p.records[0].provenance.name.source, 'manual');
  assert.equal(p.records[0].provenance.contextWindow.source, 'generic');
  assert.equal(p.calls(), 0);
});

test('candidate lists omit already added IDs and disclose the bounded visible match count', (t) => {
  const p = harness(t, { catalog: [{ provider: 'p', id: 'm' }, ...Array.from({ length: 30 }, (_, i) => ({ provider: 'p', id: `ref${i}` }))] });
  p.actions.open({ kind: 'model', provider: 'p', modelId: 'm' }, 'add');
  assert.ok(!p.screen().split('\n').some((line) => /^(?:→ |  )\[[ x]\] m(?:\s|$)/.test(line)));
  assert.match(p.screen(), /候选 30 · 已选 0/); assert.match(p.screen(), /\(1\/30\)/);
  assert.ok(p.screen().split('\n').filter((line) => /^(?:→ |  )\[[ x]\] ref\d+/.test(line)).length <= 20);
  p.send('down'); p.send('down'); p.type('ref29');
  assert.match(p.screen(), /^› ref29/m); assert.match(p.screen(), /候选 1 · 已选 0/); assert.match(p.screen(), /\[ \] ref29/);
  assert.ok(!p.screen().includes('(1/30)')); assert.equal(p.events.length, 0); assert.equal(p.records.length, 0);
  p.send('esc'); assert.equal(p.actions.active, false);
});

test('enhanced repeat and release events cannot pick or submit the model basket', (t) => {
  const p = harness(t); p.actions.open({ provider: 'p' }, 'add'); p.type('unknown');
  p.send('\x1b[13;1:2u'); p.send('\x1b[13;1:2u'); p.send('\x1b[115;5:2u');
  assert.match(p.screen(), /^› unknown/m); assert.match(p.screen(), /已选 0/); assert.equal(p.events.length, 0);
  p.send('enter'); assert.match(p.screen(), /已选 1/);
  p.send('\x1b[13;1:2u'); p.send('\x1b[13;1:3u'); p.send('\x1b[115;5:2u'); p.send('\x1b[115;5:3u');
  assert.ok(!p.screen().includes('主密码')); assert.equal(p.events.length, 0); assert.equal(p.records.length, 0);
});
