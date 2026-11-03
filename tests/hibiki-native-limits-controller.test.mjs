import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters as plain } from 'node:util';
import { loadTypeScript } from './model-pick-loader.mjs';
import { createSyntheticProtection } from './model-pick-synthetic-protection.mjs';
import { piRoot } from '../scripts/tooling.mjs';

// Real controller, component, private Inputs and protected store in a bounded
// synthetic profile. Neither authentication nor provider requests are permitted.
const tui = await import(pathToFileURL(path.join(piRoot(), 'node_modules/@earendil-works/pi-tui/dist/index.js')));
const source = fileURLToPath(new URL('../lib/model-pick/', import.meta.url));
const clone = value => JSON.parse(JSON.stringify(value));
const keys = ['contextWindow', 'maxTokens'];
const provider = 'openai-codex', id = 'gpt-5.1-codex';
const params = { contextWindow: 1000, maxTokens: 100, reasoning: true, input: ['text'] };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync('/tmp/model-pick-native-limits-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initial = options.initial ?? { rootUnknown: { keep: true }, providers: { [provider]: {
    apiKey: 'SYNTHETIC-DO-NOT-RESOLVE', connectionUnknown: { keep: 1 },
    modelOverrides: { [id]: { name: 'Unchanged display name', unknown: { keep: 2 }, ...options.overrides } },
  } } };
  const file = path.join(root, 'models.json');
  fs.writeFileSync(file, JSON.stringify(initial), { mode: 0o600 });
  const entry = path.join(root, 'entry.ts');
  fs.writeFileSync(entry, ['panel', 'component', 'store', 'records'].map(name => `export * from './${path.relative(root, path.join(source, name + '.ts')).replaceAll(path.sep, '/')}';`).join('\n'));
  const boundedFs = new Proxy(fs, { get(target, key) {
    const original = target[key]; if (typeof original !== 'function') return original;
    return (...args) => {
      if (typeof args[0] === 'string') {
        const p = path.resolve(args[0]);
        assert.ok(p === root || p.startsWith(root + '/') || key === 'lstatSync' && root.startsWith(p === '/' ? '/' : p + '/'), `fixture fs escaped: ${key}`);
      }
      if (key === 'renameSync') assert.ok(path.resolve(args[1]).startsWith(root + '/'));
      return original(...args);
    };
  } });
  const api = loadTypeScript(entry, { 'node:fs': boundedFs, '@earendil-works/pi-tui': tui });
  const protection = createSyntheticProtection();
  const adapter = { seal: (v, p) => api.__json(protection.seal(v, p)), open: (v, p) => api.__json(protection.open(v, p)), clear() {} };
  const store = new api.PickerStore(root, [provider, 'registered-extension'], adapter);
  const records = new api.PickerRecords(root, adapter);
  let guard = { current: { provider, id } }, allowed = true;
  let catalog = [{ provider, id, ...params }, { provider: 'registered-extension', id: 'registered/exact', ...params }];
  let directory = options.directory === undefined ? { contextWindow: 1000, maxTokens: 100 } : options.directory;
  const commits = [], changes = [], feedback = [], effects = [];
  let refresh = async () => {}, extraRead = () => ({});
  const host = { store, records, paint: (_kind, value) => value, requestRender() {}, viewport: () => ({ width: 120, height: 44 }),
    catalog: () => api.__json(catalog), guard: () => api.__json(guard), isProtected: p => p === provider || p === 'registered-extension',
    auth: () => { effects.push('auth'); throw Error('auth forbidden'); },
    changed: async target => { changes.push(clone(target)); await refresh(target); }, feedback: (...args) => feedback.push(args),
  };
  host.modelLimits = {
    canEdit: () => allowed,
    read(p, m) {
      const current = catalog.find(x => x.provider === p && x.id === m); if (!current) throw Error('missing exact live target');
      const saved = store.modelLimitsOverride(p, m);
      return { revision: saved.revision, overrides: saved.values,
        effective: Object.fromEntries(keys.map(k => [k, saved.values[k] ?? directory?.[k] ?? current[k]])),
        catalog: directory, ...extraRead(),
      };
    },
    commit(p, m, patch, revision) {
      commits.push({ provider: p, id: m, patch: clone(patch), revision });
      store.putModelLimitsOverride(p, m, patch, revision, api.__json(guard), () => {
        assert.ok(allowed); assert.ok(catalog.some(x => x.provider === p && x.id === m));
      });
    },
  };
  const controller = new api.PickerActions(host);
  t.after(() => controller.dispose());
  return { api, root, file, host, controller, store, records, commits, changes, feedback, effects,
    disk: () => JSON.parse(fs.readFileSync(file, 'utf8')), bytes: () => fs.readFileSync(file, 'utf8'),
    open: (p = provider, m = id) => controller.open({ provider: p, modelId: m }, 'edit'),
    setGuard: v => { guard = v; }, setAllowed: v => { allowed = v; }, setCatalog: v => { catalog = v; }, setDirectory: v => { directory = v; },
    setRefresh: fn => { refresh = fn; }, setRead: fn => { extraRead = fn; },
  };
}
function snap(f, kind) { const s = clone(f.controller.taskSnapshot()); if (kind) assert.equal(s?.kind, kind, JSON.stringify(s)); return s; }
function field(f, key, value) {
  const s = snap(f, 'edit'), port = f.controller.formFields(s.viewId), item = port.fields().find(x => x.id === key);
  assert.ok(item); item.input.setValue(value); port.changed(key); return item;
}
function command(f, id, proof = true) {
  const s = snap(f), a = s.actions.find(x => x.id === id); assert.ok(a, `missing ${id}`);
  return { type: 'activate', viewId: s.viewId, id, identity: a.identity, ...(proof ? { review: { reviewToken: s.reviewToken, layoutId: 'synthetic-reviewed-layout', renderEpoch: 1, width: 120, height: 44, complete: true } } : {}) };
}
async function act(f, id, proof = true) { await f.controller.dispatch(command(f, id, proof)); }
function noEffects(f, before) { assert.equal(f.bytes(), before); assert.equal(f.commits.length, 0); assert.equal(f.changes.length, 0); assert.equal(f.records.hasData(), false); assert.deepEqual(f.effects, []); }

test('native edit is exactly two private override fields with truthful current/directory/local status', async t => {
  const f = await fixture(t, { overrides: { maxTokens: 120 } }); f.open();
  const s = snap(f, 'edit'); assert.equal(s.purpose, 'model-limits');
  const fields = f.controller.formFields(s.viewId).fields();
  assert.deepEqual(clone(fields.map(x => x.id)), keys); assert.deepEqual(clone(fields.map(x => x.input.getValue())), ['', '120']);
  assert.ok(fields.every(x => x.kind === 'input' && !x.readonly));
  assert.match(JSON.stringify(s.content), /当前生效.*目录参考.*本地覆盖/s);
  assert.match(JSON.stringify(s.content), /本地预算不等于上游真实容量/);
  assert.equal(s.parameters, undefined); assert.ok(!JSON.stringify(s).includes('SYNTHETIC-DO-NOT-RESOLVE'));
  assert.equal(f.records.hasData(), false); assert.deepEqual(f.effects, []);
});

test('one changed field, independent reviewed confirmation, exact commit and refresh target; unknown keys remain', async t => {
  const f = await fixture(t); const before = f.disk(); f.open(); field(f, 'contextWindow', '2000');
  await act(f, 'save-form'); const s = snap(f, 'confirm'); assert.equal(s.purpose, 'model-limits');
  assert.deepEqual(s.diffs[0].fields, [{ field: 'contextWindow', before: { present: false }, after: { present: true, value: 2000 } }]);
  await act(f, 'commit-limits', false); assert.equal(f.commits.length, 0);
  const stale = command(f, 'commit-limits'); stale.review.reviewToken = 'wrong'; await f.controller.dispatch(stale); assert.equal(f.commits.length, 0);
  await act(f, 'commit-limits'); assert.deepEqual(f.commits[0].patch, { contextWindow: 2000 });
  assert.deepEqual(f.changes, [{ provider, modelId: id }]); assert.equal(f.controller.active, false);
  before.providers[provider].modelOverrides[id].contextWindow = 2000; assert.deepEqual(f.disk(), before);
  assert.deepEqual(f.effects, []); assert.equal(f.records.hasData(), false);
});

for (const target of [[provider, id], ['registered-extension', 'registered/exact']]) test(`exact native/registered target ${target[0]} uses metadata-only port`, async t => {
  const f = await fixture(t); f.open(...target); field(f, 'maxTokens', '200'); await act(f, 'save-form'); await act(f, 'commit-limits');
  assert.equal(f.commits[0].provider, target[0]); assert.equal(f.commits[0].id, target[1]); assert.deepEqual(f.commits[0].patch, { maxTokens: 200 });
  assert.deepEqual(f.effects, []);
});

test('blank deletes one explicit override, keeps other limit and all unrelated override keys', async t => {
  const f = await fixture(t, { overrides: { contextWindow: 2000, maxTokens: 150 } }); f.open(); field(f, 'maxTokens', '');
  await act(f, 'save-form'); const s = snap(f, 'confirm'); assert.deepEqual(s.diffs[0].fields[0].after, { present: false });
  assert.match(JSON.stringify(s.content), /输出上限 100/); await act(f, 'commit-limits');
  assert.deepEqual(f.commits[0].patch, { maxTokens: null });
  assert.deepEqual(f.disk().providers[provider].modelOverrides[id], { name: 'Unchanged display name', unknown: { keep: 2 }, contextWindow: 2000 });
});

test('reset both deletes only explicit fields after independent review; next directory updates inherit', async t => {
  const f = await fixture(t, { overrides: { contextWindow: 2000, maxTokens: 150 } }); f.open();
  await act(f, 'reset-limits'); const first = command(f, 'commit-limits'); snap(f, 'confirm'); await act(f, 'back');
  assert.deepEqual(clone(f.controller.formFields(snap(f).viewId).fields().map(x => x.input.getValue())), ['2000', '150']);
  await act(f, 'reset-limits'); assert.notEqual(snap(f).reviewToken, first.review.reviewToken);
  await f.controller.dispatch(first); assert.equal(f.commits.length, 0);
  await act(f, 'commit-limits'); assert.deepEqual(f.commits[0].patch, { contextWindow: null, maxTokens: null });
  assert.deepEqual(f.disk().providers[provider].modelOverrides[id], { name: 'Unchanged display name', unknown: { keep: 2 } });
  f.setDirectory({ contextWindow: 3000, maxTokens: 300 }); f.open(); assert.match(JSON.stringify(snap(f).content), /当前生效：上下文窗口 3000 · 输出上限 300/);
  assert.deepEqual(clone(f.controller.formFields(snap(f).viewId).fields().map(x => x.input.getValue())), ['', '']);
});

test('save/reset no-op, Back and cancel do not write history, config or refresh', async t => {
  for (const action of ['save-form', 'reset-limits', 'back', 'cancel-task']) {
    const f = await fixture(t); const before = f.bytes(); f.open(); await act(f, action); assert.equal(f.controller.active, false); noEffects(f, before);
  }
  const f = await fixture(t); const before = f.bytes(); f.open(); field(f, 'contextWindow', '2000'); await act(f, 'save-form'); await act(f, 'cancel-task'); noEffects(f, before);
});

for (const value of ['0', '-1', '1.5', '1e3', '0x10', 'Infinity', '9007199254740992', 'text']) test(`invalid limit ${value} stays in form with no effects`, async t => {
  const f = await fixture(t); const before = f.bytes(); f.open(); field(f, 'contextWindow', value); await act(f, 'save-form');
  assert.ok(snap(f, 'edit').error); assert.equal(f.controller.formFields(snap(f).viewId).fields()[0].input.getValue(), value); noEffects(f, before);
});

test('known inherited preview rejects output greater than context, including reset', async t => {
  const f = await fixture(t, { overrides: { contextWindow: 2000, maxTokens: 1500 } }); const before = f.bytes(); f.open(); field(f, 'contextWindow', ''); await act(f, 'save-form'); assert.ok(snap(f, 'edit').error); noEffects(f, before);
  f.setDirectory({ contextWindow: 100, maxTokens: 200 }); await act(f, 'back'); f.open(); await act(f, 'reset-limits'); assert.ok(snap(f, 'edit').error); noEffects(f, before);
});

for (const [key, value] of [['contextWindow', '99'], ['maxTokens', '1001']]) test(`null directory still validates ${key} against a currently inherited effective peer`, async t => {
  const f = await fixture(t, { directory: null }); const before = f.bytes(); f.open(); field(f, key, value); await act(f, 'save-form');
  assert.match(snap(f, 'edit').error, /输出上限不能大于上下文窗口/); noEffects(f, before);
});

test('null directory inherited preview values are never persisted as overrides', async t => {
  const f = await fixture(t, { directory: null }); f.open(); field(f, 'contextWindow', '2000'); await act(f, 'save-form');
  assert.match(JSON.stringify(snap(f, 'confirm').content), /刷新后预览：上下文窗口 2000 · 输出上限 100/);
  await act(f, 'commit-limits'); assert.deepEqual(f.commits[0].patch, { contextWindow: 2000 });
  assert.equal(Object.hasOwn(f.disk().providers[provider].modelOverrides[id], 'maxTokens'), false);
});

test('unknown reset baseline is not current effective: review truthfully defers preview to refresh', async t => {
  const f = await fixture(t, { directory: null, overrides: { contextWindow: 2000, maxTokens: 150 } }); f.open();
  await act(f, 'reset-limits'); const s = snap(f, 'confirm'); assert.match(JSON.stringify(s.content), /未知（刷新后确认）/);
  assert.ok(!JSON.stringify(s.content).includes('2000')); await act(f, 'commit-limits'); assert.deepEqual(f.commits[0].patch, { contextWindow: null, maxTokens: null });
});

for (const barrier of ['revision', 'directory', 'effective', 'permission', 'target', 'readonly', 'busy', 'pending']) test(`fresh ${barrier} barrier blocks stale confirmation`, async t => {
  const f = await fixture(t); f.open(); field(f, 'contextWindow', '2000'); await act(f, 'save-form'); const before = f.bytes();
  if (barrier === 'revision') f.setRead(() => ({ revision: 'changed-revision' }));
  if (barrier === 'directory') f.setDirectory({ contextWindow: 3000, maxTokens: 100 });
  if (barrier === 'effective') f.setRead(() => ({ effective: { contextWindow: 999, maxTokens: 100 } }));
  if (barrier === 'permission') f.setAllowed(false);
  if (barrier === 'target') f.setCatalog([]);
  if (barrier === 'readonly') f.host.storageWritable = false;
  if (barrier === 'busy') f.setGuard({ busy: true });
  if (barrier === 'pending') f.store.hasPending = () => true;
  await act(f, 'commit-limits'); assert.ok(snap(f, 'confirm').error); noEffects(f, before);
});

test('raw retained Input changes cannot reuse prior review even without changed notification', async t => {
  const f = await fixture(t); const before = f.bytes(); f.open(); const raw = field(f, 'contextWindow', '2000').input; await act(f, 'save-form');
  raw.setValue('3000'); await act(f, 'commit-limits'); assert.ok(snap(f, 'edit').error); noEffects(f, before);
  await act(f, 'save-form'); await act(f, 'commit-limits'); assert.deepEqual(f.commits[0].patch, { contextWindow: 3000 });
});

test('no metadata port retains read-only fallback and custom full parameter form stays unchanged', async t => {
  const f = await fixture(t); delete f.host.modelLimits; f.open(); const s = snap(f, 'edit'); assert.equal(s.readonly, true); assert.equal(s.purpose, undefined);
  const fields = f.controller.formFields(s.viewId).fields(); assert.ok(fields.some(x => x.id === 'name')); assert.ok(fields.every(x => x.readonly));
  const custom = await fixture(t, { initial: { providers: { custom: { baseUrl: 'https://custom.invalid/v1', api: 'openai-responses', models: [{ id: 'own', name: 'own', ...params }] } } } });
  custom.setCatalog([{ provider: 'custom', id: 'own', ...params }]); custom.open('custom', 'own');
  const edit = snap(custom, 'edit'); assert.equal(edit.purpose, undefined); assert.equal(edit.readonly, false);
  assert.ok(custom.controller.formFields(edit.viewId).fields().some(x => x.id === 'reasoning'));
});

test('protected provider connection/add/remove remain blocked, even when the metadata port allows edits', async t => {
  const f = await fixture(t); const before = f.bytes();
  for (const [target, intent] of [[{ provider, kind: 'provider' }, 'edit'], [{ provider }, 'add'], [{ provider, modelId: id }, 'remove']]) {
    f.controller.open(target, intent); const s = snap(f); assert.ok(s.kind === 'info' || s.readonly === true); noEffects(f, before);
  }
  f.open(provider, 'not-in-catalog'); assert.equal(snap(f).kind, 'info'); noEffects(f, before);
});

test('host commit failure returns retained form without retry; uncertain write never presents retry', async t => {
  const f = await fixture(t); f.open(); field(f, 'contextWindow', '2000'); await act(f, 'save-form');
  f.host.modelLimits.commit = () => { throw Error('synthetic unchanged failure'); }; await act(f, 'commit-limits');
  assert.ok(snap(f, 'edit').error); assert.equal(f.controller.formFields(snap(f).viewId).fields()[0].input.getValue(), '2000'); assert.equal(f.changes.length, 0);
  await act(f, 'save-form'); const commit = f.store.putModelLimitsOverride.bind(f.store);
  f.host.modelLimits.commit = (p, m, patch, revision) => { commit(p, m, patch, revision, f.api.__json({}), () => {}); throw Error('synthetic after-write failure'); };
  await act(f, 'commit-limits'); assert.match(snap(f, 'info').title, /待核对/); assert.equal(f.changes.length, 0);
});

test('storeWrite/saved passes exact metadata target and waits for host refresh without restoring intervening selection (B1)', async t => {
  const f = await fixture(t); let release; const gate = new Promise(resolve => { release = resolve; });
  let current = { provider, id }; const rebinds = [];
  f.setRefresh(async target => { const expected = current; await gate; if (current === expected && current.provider === target.provider && current.id === target.modelId) { current = { ...current, contextWindow: 2000 }; rebinds.push(current); } });
  f.open(); field(f, 'contextWindow', '2000'); await act(f, 'save-form'); const write = act(f, 'commit-limits'); await tick(); snap(f, 'progress');
  current = { provider: 'registered-extension', id: 'registered/exact' }; release(); await write;
  assert.deepEqual(current, { provider: 'registered-extension', id: 'registered/exact' }); assert.deepEqual(rebinds, []); assert.equal(f.controller.active, false);
});

test('permission is rechecked after the save progress barrier, not just on reviewed activation', async t => {
  const f = await fixture(t); const before = f.bytes(); f.open(); field(f, 'contextWindow', '2000'); await act(f, 'save-form');
  f.host.requestRender = () => { if (f.controller.taskSnapshot()?.kind === 'progress') f.setAllowed(false); };
  await act(f, 'commit-limits'); assert.ok(snap(f, 'edit').error); noEffects(f, before);
});

test('positive safe-integer boundary is accepted without changing the inherited second field', async t => {
  const f = await fixture(t); f.open(); field(f, 'contextWindow', String(Number.MAX_SAFE_INTEGER)); await act(f, 'save-form'); await act(f, 'commit-limits');
  assert.deepEqual(f.commits[0].patch, { contextWindow: Number.MAX_SAFE_INTEGER });
  assert.equal(Object.hasOwn(f.disk().providers[provider].modelOverrides[id], 'maxTokens'), false);
});

test('late refresh completion after disposal cannot revive the task or publish a stale success', async t => {
  const f = await fixture(t); let release; const gate = new Promise(resolve => { release = resolve; }); f.setRefresh(() => gate);
  f.open(); field(f, 'contextWindow', '2000'); await act(f, 'save-form'); const write = act(f, 'commit-limits'); await tick(); snap(f, 'progress');
  f.controller.dispose(); release(); await write; assert.equal(f.controller.active, false); assert.deepEqual(f.feedback, []); assert.equal(f.commits.length, 1);
});

for (const cleared of keys) test(`per-field blank clears only ${cleared}, retaining the other explicit limit`, async t => {
  const f = await fixture(t, { overrides: { contextWindow: 2000, maxTokens: 150 } }); f.open(); field(f, cleared, '');
  await act(f, 'save-form'); const diff = snap(f, 'confirm').diffs[0].fields; assert.equal(diff.length, 1); assert.equal(diff[0].field, cleared);
  await act(f, 'commit-limits'); assert.deepEqual(f.commits[0].patch, { [cleared]: null });
  const saved = f.disk().providers[provider].modelOverrides[id]; assert.equal(Object.hasOwn(saved, cleared), false);
  const kept = keys.find(k => k !== cleared); assert.equal(saved[kept], kept === 'contextWindow' ? 2000 : 150);
});

test('progress-barrier private Input mutation invalidates reviewed intent before host commit', async t => {
  const f = await fixture(t), before = f.bytes(); f.open(); const input = field(f, 'contextWindow', '2000').input; await act(f, 'save-form');
  f.host.requestRender = () => { if (f.controller.taskSnapshot()?.kind === 'progress') input.setValue('3000'); };
  await act(f, 'commit-limits'); assert.ok(snap(f, 'edit').error); noEffects(f, before);
  f.host.requestRender = () => {}; await act(f, 'save-form'); await act(f, 'commit-limits'); assert.deepEqual(f.commits[0].patch, { contextWindow: 3000 });
});

for (const malformed of [{ effective: { contextWindow: 0, maxTokens: 100 } }, { overrides: { maxTokens: 1.5 } }, { catalog: { contextWindow: Number.MAX_SAFE_INTEGER + 1 } }, { revision: '' }]) test(`malformed state frame is rejected: ${JSON.stringify(malformed)}`, async t => {
  const f = await fixture(t), before = f.bytes(); f.setRead(() => malformed); f.open(); snap(f, 'info'); noEffects(f, before);
});

test('stale private form port stays detached through confirmation, cancellation and reopening', async t => {
  const f = await fixture(t), before = f.bytes(); f.open(); const first = snap(f, 'edit'); const old = f.controller.formFields(first.viewId);
  const oldInput = old.fields()[0].input; oldInput.setValue('2000'); old.changed('contextWindow'); await act(f, 'save-form');
  assert.equal(f.controller.formFields(first.viewId), undefined); assert.equal(f.controller.formFields(snap(f).viewId), undefined);
  oldInput.setValue('3000'); old.changed('contextWindow'); await act(f, 'cancel-task'); f.open(); const reopened = snap(f, 'edit');
  assert.notEqual(reopened.viewId, first.viewId); oldInput.setValue('4000'); old.changed('contextWindow');
  assert.equal(f.controller.formFields(reopened.viewId).fields()[0].input.getValue(), ''); await act(f, 'save-form'); noEffects(f, before);
});

function component(f, t) {
  const terminal = { columns: 120, rows: 44 }, listeners = new Set();
  const model = { ref: { provider, id }, name: id, parameters: params, favorite: false, readonly: true, limitsEditable: true, availability: 'ready' };
  const act = id => ({ id, identity: id, label: id, disabled: false });
  const matrix = { kind: 'matrix', viewId: 'home', reviewToken: null, providers: [{ id: provider, name: provider, readonly: true, models: [model] }], visible: [{ provider, modelIds: [id] }],
    selected: { kind: 'model', ref: model.ref }, query: '', current: model.ref, default: null, defaultKnown: true, busy: false, configReadable: true,
    palette: { id: 'test', name: 'test', colors: Object.fromEntries(['current', 'default', 'favorite', 'selection', 'text', 'dim', 'accent', 'blue', 'success', 'warning', 'error'].map(k => [k, '#aabbcc'])), gradient: ['#aabbcc', '#ddeeff'], stepped: false },
    fast: { current: model.ref, modelLabel: id, tier: 'off', supported: false, active: false, ultrafastEnabled: false }, undo: null, locate: null,
    actions: ['switch', 'favorite', 'edit-model', 'inspect', 'default', 'move-left', 'move-right', 'add-model', 'remove-model', 'new-provider', 'archives'].map(act) };
  const commands = [], pending = [];
  const workspace = { snapshot: () => ({ matrix, task: f.controller.taskSnapshot() }), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, formFields: view => f.controller.formFields(view),
    dispatch(command) { commands.push(clone(command)); if (command.id === 'edit-model') f.open(); else { const task = f.controller.dispatch(command); pending.push(task); return task; } }, dispose() {} };
  const unsubscribe = f.controller.subscribe(() => { for (const fn of listeners) fn(); }); t.after(unsubscribe);
  const c = new f.api.PickerComponent(workspace, { terminal, requestRender() {} }, { style: (text, style) => tui.styleText(text, style, 'truecolor'), appearance: 'dark' }, () => {});
  c.focused = true; t.after(() => c.dispose());
  const screen = () => c.render(terminal.columns).map(plain).join('\n');
  const key = data => { c.handleInput(data); return screen(); };
  const read = () => { for (let n = 0; n < 100 && c.debug().offset; n++) key('\x1b[5~'); for (let n = 0; n < 100; n++) { screen(); const d = c.debug(); if (d.offset + d.page >= d.total) return; key('\x1b[6~'); } assert.fail('review did not finish'); };
  return { c, matrix, terminal, commands, screen, key, read, send: data => c.handleInput(data), settle: () => Promise.all(pending.splice(0)) };
}

test('real component root edit2 → only two inputs → reviewed confirm → registry refresh; reset has own visible slot', async t => {
  const f = await fixture(t), ui = component(f, t); assert.match(ui.screen(), /编辑 \[2\]/); assert.doesNotMatch(ui.screen(), /查看参数/);
  ui.key('\x1b2'); assert.equal(snap(f, 'edit').purpose, 'model-limits');
  assert.deepEqual(clone(f.controller.formFields(snap(f).viewId).fields().map(x => x.id)), keys);
  assert.match(ui.screen(), /重置为继承 \[2\]/);
  ui.key('2000'); ui.key('\x1b1'); await ui.settle(); snap(f, 'confirm');
  // A task transition is never allowed to consume the prior view's review.
  assert.equal(f.commits.length, 0); ui.read(); ui.key('\x1b1'); await ui.settle();
  assert.equal(f.commits.length, 1); assert.deepEqual(f.commits[0].patch, { contextWindow: 2000 }); assert.equal(f.changes.length, 1);
  assert.deepEqual(f.effects, []);
});

test('real component reviewed reset and cancel preserve other override keys', async t => {
  const f = await fixture(t, { overrides: { contextWindow: 2000, maxTokens: 200 } }), ui = component(f, t); const before = f.bytes();
  ui.screen(); ui.key('\x1b2'); ui.key('\x1b2'); await ui.settle(); snap(f, 'confirm'); ui.key('\x1b0'); await ui.settle(); snap(f, 'edit'); noEffects(f, before);
  ui.key('\x1b2'); await ui.settle(); ui.read(); ui.key('\x1b1'); await ui.settle(); assert.deepEqual(f.commits[0].patch, { contextWindow: null, maxTokens: null });
  assert.deepEqual(f.disk().providers[provider].modelOverrides[id], { name: 'Unchanged display name', unknown: { keep: 2 } });
});

test('limits form Tab and Shift+Tab traverse exactly two inputs, save, reset and Back', async t => {
  const f = await fixture(t), ui = component(f, t); ui.screen(); ui.key('\x1b2');
  const at = () => { const d = ui.c.debug(); return d.actionMode ? d.selectedAction : `field:${d.fieldIndex}`; };
  const forward = [at()]; for (let n = 0; n < 5; n++) { ui.key('\t'); forward.push(at()); }
  assert.deepEqual(forward, ['field:0', 'field:1', 'save-form', 'reset-limits', 'back', 'field:0']);
  const reverse = []; for (let n = 0; n < 5; n++) { ui.key('\x1b[Z'); reverse.push(at()); }
  assert.deepEqual(reverse, ['back', 'reset-limits', 'save-form', 'field:1', 'field:0']); assert.equal(f.commits.length, 0);
  field(f, 'contextWindow', '2000'); ui.screen(); ui.key('\x1b1'); await ui.settle(); ui.read();
  ui.key('\t'); assert.equal(at(), 'commit-limits'); ui.key('\t'); assert.equal(at(), 'back'); ui.key('\t'); assert.equal(ui.c.debug().actionMode, false);
  ui.key('\x1b[Z'); assert.equal(at(), 'back'); ui.key('\x1b[Z'); assert.equal(at(), 'commit-limits');
  assert.equal(f.commits.length, 0);
});

for (const [name, input] of [['Alt+1', '\x1b1'], ['Ctrl+S', '\x13'], ['Enter', '\r']]) test(`commit-limits ${name} cannot bypass complete review, then carries digit-1 proof`, async t => {
  const f = await fixture(t), ui = component(f, t); ui.screen(); ui.key('\x1b2');
  ui.terminal.columns = 60; ui.terminal.rows = 10; f.host.viewport = () => ({ width: ui.terminal.columns, height: ui.terminal.rows });
  field(f, 'contextWindow', '2000'); ui.screen();
  // Do not paint the new confirmation yet: old action slots cannot authorize it.
  ui.send('\x1b1'); await ui.settle(); snap(f, 'confirm'); ui.send(input); await ui.settle(); assert.equal(f.commits.length, 0);
  ui.screen(); assert.equal(ui.c.debug().reviewComplete, false); ui.key(input); await ui.settle(); assert.equal(f.commits.length, 0);
  ui.read(); ui.key(input); await ui.settle(); assert.equal(f.commits.length, 1);
  const activation = ui.commands.find(c => c.id === 'commit-limits'); assert.ok(activation.review.complete); assert.ok(activation.review.reviewToken);
});

for (const reset of [false, true]) test(`commit-limits mouse requires complete review for ${reset ? 'reset' : 'save'}`, async t => {
  const f = await fixture(t, { overrides: reset ? { contextWindow: 2000 } : {} }), ui = component(f, t); ui.screen(); ui.key('\x1b2');
  ui.terminal.columns = 60; ui.terminal.rows = 10; f.host.viewport = () => ({ width: ui.terminal.columns, height: ui.terminal.rows });
  if (!reset) field(f, 'maxTokens', '200'); ui.screen(); ui.key(reset ? '\x1b2' : '\x1b1'); await ui.settle();
  const click = () => {
    const text = ui.screen(), d = ui.c.debug(), rect = d.actionRects.find(r => r.index === d.actionSlots.find(s => s.key === 'confirm').actionIndex);
    const rule = text.split('\n').findIndex(line => /^\s*─+\s*$/.test(line));
    const y = rule + 1 + rect.y - d.offset; assert.ok(y >= rule + 1 && y < ui.terminal.rows);
    return ui.c.handleMouse({ type: 'click', button: 'left', x: rect.x + 3, y, shift: false, alt: false, ctrl: false });
  };
  assert.equal(ui.c.debug().reviewComplete, false); ui.key('\t'); assert.equal(ui.c.debug().selectedAction, 'commit-limits');
  assert.equal(ui.c.debug().reviewComplete, false); assert.equal(click()?.handled, true); await ui.settle(); assert.equal(f.commits.length, 0);
  ui.read(); assert.equal(click()?.handled, true); await ui.settle(); assert.equal(f.commits.length, 1);
  assert.ok(ui.commands.find(c => c.id === 'commit-limits').review.complete);
});

for (const reset of [false, true]) test(`commit-limits caption and digit are honest for ${reset ? 'reset' : 'save'}`, async t => {
  const f = await fixture(t, { overrides: reset ? { contextWindow: 2000 } : {} }), ui = component(f, t); ui.screen(); ui.key('\x1b2');
  if (!reset) field(f, 'maxTokens', '200'); ui.screen(); ui.key(reset ? '\x1b2' : '\x1b1'); await ui.settle(); ui.read();
  const text = ui.screen(); assert.match(text, reset ? /确认重置 \[1\]/ : /确认保存 \[1\]/); assert.doesNotMatch(text, /确认添加|应用修改/);
  const slot = ui.c.debug().actionSlots.find(x => x.key === 'confirm'); assert.ok(slot); assert.notEqual(slot.actionIndex, null);
});
