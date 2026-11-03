import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { piRoot, typescriptPath } from '../scripts/tooling.mjs';
import { createSyntheticProtection } from './model-pick-synthetic-protection.mjs';

// All store IO is injected and confined to one synthetic /tmp tree. The SDK
// integration also requires the existing network/filesystem isolation preload.
const require = createRequire(import.meta.url);
const ts = require(typescriptPath());
const sourceDir = fileURLToPath(new URL('../lib/model-pick/', import.meta.url));
const compiled = new Map();
const encode = value => JSON.stringify(value, null, 2) + '\n';
const copy = value => JSON.parse(JSON.stringify(value));
const hash = raw => createHash('sha256').update(raw === null ? 'absent\0' : `file\0${raw}`).digest('hex');
const NATIVE = 'openai-codex';
const ID = 'gpt-5.3-codex';
const SECRET = 'SYNTHETIC-secret-do-not-leak';
const MODEL = { id: ID, contextWindow: 8000, maxTokens: 1000, reasoning: true, input: ['text'] };
const PROVIDER = { id: NATIVE, name: 'Native', endpoint: 'https://synthetic.invalid/v1', api: 'openai-responses' };
function code(work, expected) {
  assert.throws(work, error => {
    assert.equal(error.name, 'StoreError'); assert.equal(error.code, expected);
    assert.ok(!String(error.stack).includes(SECRET)); assert.equal(error.cause, undefined);
    return true;
  });
}
function load(fsImpl) {
  const modules = new Map();
  function source(name) {
    if (modules.has(name)) return modules.get(name).exports;
    if (!compiled.has(name)) compiled.set(name, ts.transpileModule(fs.readFileSync(path.join(sourceDir, name), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: name,
    }).outputText);
    const module = { exports: {} }; modules.set(name, module);
    const localRequire = id => {
      if (id === 'node:fs') return fsImpl;
      if (['node:path', 'node:util', 'node:crypto'].includes(id)) return require(id);
      if (id === './vault.js') return source('vault.ts');
      if (id === './reference.js') return source('reference.ts');
      throw new Error('Unexpected dependency');
    };
    vm.runInThisContext(`(function(exports,require,module){\n${compiled.get(name)}\n})`, { filename: name })(module.exports, localRequire, module);
    return module.exports;
  }
  return { ...source('store.ts'), vault: source('vault.ts') };
}
function fixture(t, value, { legacy = false, modelsElsewhere = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-limits-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelFile = path.join(root, modelsElsewhere ? 'profile/models.json' : 'models.json');
  if (modelsElsewhere) fs.mkdirSync(path.dirname(modelFile));
  if (value !== undefined) fs.writeFileSync(modelFile, encode(value), { mode: 0o600 });
  const dataDir = path.join(root, 'model-pick-data');
  const vaultFile = path.join(dataDir, legacy ? 'vault.json' : 'vault.auto.json');
  const indexFile = path.join(dataDir, legacy ? 'retention-index.json' : 'retention-index.auto.json');
  const lockFile = path.join(dataDir, 'store.lock');
  const events = []; const fds = new Map(); const faults = {}; const protectionState = {};
  const protection = createSyntheticProtection(protectionState);
  const writeOps = new Set(['mkdirSync', 'unlinkSync', 'renameSync']);
  function check(file, write) {
    const p = path.resolve(String(file));
    assert.ok(p === root || p.startsWith(root + '/') || (!write && root.startsWith((p === '/' ? '' : p) + '/')), 'Store escaped synthetic fixture');
    assert.ok(!['auth.json', 'settings.json'].includes(path.basename(p)), 'Store touched credentials/settings');
  }
  const fsImpl = new Proxy(fs, { get(target, op) {
    if (typeof target[op] !== 'function') return target[op];
    return (...args) => {
      if (['openSync', 'lstatSync', 'readdirSync', ...writeOps].includes(op)) {
        check(args[0], writeOps.has(op) || (op === 'openSync' && Boolean(args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR))));
        if (op === 'renameSync') check(args[1], true);
      } else if (['readFileSync', 'writeFileSync', 'fstatSync', 'fchmodSync', 'fsyncSync', 'closeSync'].includes(op)) {
        assert.ok(fds.has(args[0]), 'Untracked descriptor');
      } else throw new Error('Unexpected filesystem operation');
      const event = { op, args, file: typeof args[0] === 'number' ? fds.get(args[0]) : args[0] }; events.push(event);
      faults.before?.(event);
      const result = target[op](...args);
      if (op === 'openSync') fds.set(result, args[0]);
      if (op === 'closeSync') fds.delete(args[0]);
      faults.after?.(event);
      return result;
    };
  } });
  const api = load(fsImpl);
  const makeStore = () => {
    const store = new api.PickerStore(root, [NATIVE, 'extension'], legacy ? undefined : protection, modelFile);
    if (legacy) store.unlock('synthetic-passphrase');
    return store;
  };
  const store = makeStore();
  const raw = () => fs.existsSync(modelFile) ? fs.readFileSync(modelFile, 'utf8') : null;
  const config = () => JSON.parse(raw());
  const revision = () => store.modelLimitsOverride(NATIVE, ID).revision;
  const state = () => {
    const sealed = JSON.parse(fs.readFileSync(vaultFile, 'utf8')).sealed;
    return legacy ? api.vault.openJson(sealed, 'synthetic-passphrase') : protection.open(sealed, 'models');
  };
  const putState = state => fs.writeFileSync(vaultFile, encode({ version: legacy ? 1 : 2, pending: state.pending !== null,
    sealed: legacy ? api.vault.sealJson(state, 'synthetic-passphrase') : protection.seal(state, 'models') }), { mode: 0o600 });
  const put = (patch, guard = {}, assertTarget = () => {}, expected = revision(), provider = NATIVE, id = ID) =>
    store.putModelLimitsOverride(provider, id, patch, expected, guard, assertTarget);
  return { root, modelFile, dataDir, vaultFile, indexFile, lockFile, events, faults, protectionState, protection, api, store, makeStore, raw, config, revision, state, putState, put };
}
function seeded() {
  return { rootFuture: { keep: true }, providers: {
    [NATIVE]: { apiKey: '!must-never-execute', headers: { synthetic: SECRET }, oauth: 'future', future: { keep: true },
      modelOverrides: { [ID]: { name: 'Keep name', contextWindow: 8000, maxTokens: 1000, cost: { input: 9 }, future: { keep: true } }, other: { future: [] } } },
    other: { apiKey: SECRET, models: [{ ...MODEL, future: true }] },
  } };
}
function interrupt(f, { applied = false, patch = { contextWindow: 16000 } } = {}) {
  let hit = false;
  f.faults[applied ? 'after' : 'before'] = e => {
    if (!hit && e.op === 'renameSync' && e.args[1] === f.modelFile) { hit = true; throw new Error(SECRET); }
  };
  code(() => f.put(patch), 'IO_ERROR');
  delete f.faults.before; delete f.faults.after;
  assert.equal(hit, true); assert.equal(f.store.hasPending(), true);
  const pending = f.state().pending;
  assert.equal(f.revision(), applied ? pending.afterRevision : pending.beforeRevision);
  return pending;
}

test('read is a detached two-field view with exact IDs and no filesystem creation', t => {
  const f = fixture(t, seeded());
  assert.deepEqual(f.store.modelLimitsOverride(NATIVE, ID), { revision: f.revision(), values: { contextWindow: 8000, maxTokens: 1000 } });
  assert.deepEqual(f.store.modelLimitsOverride(NATIVE, ID.toUpperCase()).values, {});
  const values = f.store.modelLimitsOverride(NATIVE, ID).values; values.maxTokens = 5;
  assert.equal(f.store.modelLimitsOverride(NATIVE, ID).values.maxTokens, 1000);
  assert.equal(fs.existsSync(f.dataDir), false);
  const g = fixture(t); assert.deepEqual(g.store.modelLimitsOverride(NATIVE, ID).values, {});
  assert.deepEqual(fs.readdirSync(g.root), []);
});

test('native and registered providers accept only limit metadata while preserving all unknown fields and auth bytes', t => {
  const original = seeded(); const f = fixture(t, original, { modelsElsewhere: true });
  const authFile = path.join(f.root, 'auth.json'); const auth = '{ "openai-codex": {"type":"oauth","refresh":"SYNTHETIC"} }\n';
  fs.writeFileSync(authFile, auth);
  let checks = 0; f.put({ contextWindow: 16000 }, {}, () => { checks++; });
  const expected = copy(original); expected.providers[NATIVE].modelOverrides[ID].contextWindow = 16000;
  assert.deepEqual(f.config(), expected); assert.ok(checks >= 7);
  f.put({ maxTokens: 2000 }, {}, () => {}, f.revision(), 'extension', 'registered/chat');
  assert.deepEqual(f.config().providers.extension, { modelOverrides: { 'registered/chat': { maxTokens: 2000 } } });
  assert.equal(f.config().providers[NATIVE].models, undefined);
  assert.equal(fs.readFileSync(authFile, 'utf8'), auth);
  assert.equal(fs.existsSync(path.join(f.root, 'models.json')), false, 'only the verified profile is written');
  assert.equal(f.state().history[0].operation.kind, 'model-limits');
  assert.ok(!fs.readFileSync(f.vaultFile, 'utf8').includes(SECRET));
});

test('set one field, reset one, reset both preserve other overrides and inherit by absence', t => {
  const original = seeded(); const f = fixture(t, original);
  f.put({ contextWindow: null });
  assert.deepEqual(f.store.modelLimitsOverride(NATIVE, ID).values, { maxTokens: 1000 });
  f.put({ maxTokens: null });
  const expected = copy(original); delete expected.providers[NATIVE].modelOverrides[ID].contextWindow; delete expected.providers[NATIVE].modelOverrides[ID].maxTokens;
  assert.deepEqual(f.config(), expected);
  f.put({ contextWindow: 20000 });
  assert.deepEqual(f.store.modelLimitsOverride(NATIVE, ID).values, { contextWindow: 20000 });
  f.put({ contextWindow: null, maxTokens: null }); assert.deepEqual(f.config(), expected);
});

test('reset prunes only required empty ancestors; unrelated empty containers survive', t => {
  for (const base of [{}, { providers: {} }, { extra: {}, providers: { unrelated: {} } }]) {
    const f = fixture(t, base); f.put({ contextWindow: 16000 }); f.put({ contextWindow: null, maxTokens: null });
    // Empty providers already present are the affected ancestor and are pruned;
    // unrelated provider/root containers are never cleaned up.
    const expected = copy(base); if (Object.keys(expected.providers ?? {}).length === 0) delete expected.providers;
    assert.deepEqual(f.config(), expected);
    assert.equal(f.state().history.length, 2);
  }
});

test('empty, identical and already-inherited intent do not write models, index, vault or history', t => {
  const f = fixture(t, seeded()); const before = f.raw();
  for (const patch of [{}, { contextWindow: 8000 }, { maxTokens: 1000 }]) f.put(patch);
  assert.equal(f.raw(), before); assert.equal(fs.existsSync(f.vaultFile), false);
  assert.equal(fs.existsSync(f.indexFile), false);
  const g = fixture(t); g.put({ contextWindow: null, maxTokens: null });
  assert.equal(g.raw(), null); assert.equal(fs.existsSync(g.vaultFile), false);
  f.put({ maxTokens: 2000 }); const bytes = fs.readFileSync(f.vaultFile, 'utf8'); const saved = f.raw();
  f.put({ maxTokens: 2000 }); assert.equal(f.raw(), saved); assert.equal(fs.readFileSync(f.vaultFile, 'utf8'), bytes);
});

test('strict positive safe integers and the known explicit pair are validated atomically', t => {
  const f = fixture(t, seeded()); const before = f.raw();
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', true, undefined]) {
    for (const key of ['contextWindow', 'maxTokens']) code(() => f.put({ [key]: value }), 'INVALID_INPUT');
  }
  code(() => f.put({ maxTokens: 9000 }), 'INVALID_INPUT');
  code(() => f.put({ contextWindow: 500 }), 'INVALID_INPUT');
  assert.equal(f.raw(), before); assert.equal(fs.existsSync(f.vaultFile), false);
  const g = fixture(t); g.put({ maxTokens: 9000 }); // no invented inherited context
  assert.deepEqual(g.store.modelLimitsOverride(NATIVE, ID).values, { maxTokens: 9000 });
});

test('patch proxies, accessors, inherited data, symbols and unknown fields are rejected without executing hooks', t => {
  const f = fixture(t); let executions = 0;
  const accessor = Object.defineProperty({}, 'contextWindow', { enumerable: true, get() { executions++; return 1; } });
  const proxy = new Proxy({}, { ownKeys() { executions++; return []; }, get() { executions++; return 1; } });
  const hidden = Object.defineProperty({}, 'contextWindow', { value: 1 });
  for (const patch of [null, undefined, [], proxy, accessor, hidden, Object.create({ contextWindow: 1 }),
    { name: 'no' }, { apiKey: SECRET }, { [Symbol('x')]: 1 }, { contextWindow: null, unknown: true },
    { toJSON() { executions++; return {}; } }]) code(() => f.put(patch), 'INVALID_INPUT');
  assert.equal(executions, 0); assert.equal(f.raw(), null); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('invalid identities and missing required live guards are refused', t => {
  const f = fixture(t);
  for (const id of ['', ' padded', '__proto__', 'constructor', 'prototype']) {
    code(() => f.store.modelLimitsOverride(id, ID), 'INVALID_INPUT');
    code(() => f.store.modelLimitsOverride(NATIVE, id), 'INVALID_INPUT');
    code(() => f.put({ contextWindow: 1 }, {}, () => {}, f.revision(), id), 'INVALID_INPUT');
  }
  code(() => f.store.putModelLimitsOverride(NATIVE, ID, {}, f.revision(), undefined, () => {}), 'INVALID_INPUT');
  code(() => f.store.putModelLimitsOverride(NATIVE, ID, {}, f.revision(), {}, undefined), 'INVALID_INPUT');
});

test('Object.prototype spellings remain exact own IDs without modifying prototypes', t => {
  const f = fixture(t); const baseline = Object.getOwnPropertyNames(Object.prototype);
  f.put({ contextWindow: 16000 }, {}, () => {}, f.revision(), 'toString', 'hasOwnProperty');
  assert.deepEqual(f.config(), { providers: { toString: { modelOverrides: { hasOwnProperty: { contextWindow: 16000 } } } } });
  f.put({ contextWindow: null }, {}, () => {}, f.revision(), 'toString', 'hasOwnProperty');
  assert.deepEqual(f.config(), {}); assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), baseline);
});

test('unknown targets and denied permissions are host-guarded before work, including no-op', t => {
  const f = fixture(t); let checks = 0;
  for (const expected of ['NOT_FOUND', 'PROTECTED']) {
    code(() => f.put({}, {}, () => { checks++; throw new f.api.StoreError(expected); }), expected);
    code(() => f.put({ contextWindow: 16000 }, {}, () => { throw new Error(SECRET); }), 'IO_ERROR');
  }
  assert.equal(checks, 2); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('a target or busy-state change during protection preflight leaves no journal or applied values', t => {
  for (const busy of [false, true]) {
    const f = fixture(t, seeded()); const before = f.raw(); let changed = false;
    f.protectionState.sealHook = () => { changed = true; };
    code(() => f.put({ contextWindow: 16000 }, { recheck: () => ({ busy: busy && changed }) }, () => {
      if (!busy && changed) throw new f.api.StoreError('NOT_FOUND');
    }), busy ? 'BUSY' : 'NOT_FOUND');
    assert.equal(f.raw(), before); assert.equal(fs.existsSync(f.vaultFile), false);
  }
});

test('revision changes inside live-target callbacks never overwrite concurrent config at any phase', t => {
  for (const phase of ['initial', 'preflight', 'models', 'completion']) {
    const f = fixture(t, seeded()); let trigger = phase === 'initial'; let changed;
    if (phase === 'preflight') f.protectionState.sealHook = () => { trigger = true; };
    f.faults.after = e => {
      if (e.op === 'renameSync' && e.args[1] === (phase === 'models' ? f.indexFile : phase === 'completion' ? f.modelFile : 'never')) trigger = true;
    };
    code(() => f.put({ contextWindow: 16000 }, {}, () => {
      if (trigger && changed === undefined) {
        const config = f.config(); config.concurrent = { keep: true };
        changed = encode(config); fs.writeFileSync(f.modelFile, changed);
      }
    }), 'CONFLICT');
    delete f.faults.after;
    assert.equal(f.raw(), changed);
    assert.equal(f.store.hasPending(), phase === 'models' || phase === 'completion');
    if (f.store.hasPending()) code(() => f.makeStore().recover(f.revision()), 'CONFLICT');
  }
});

test('callback rechecks at final models barrier; validated recovery needs no surviving catalog target', t => {
  const f = fixture(t, seeded()); let live = true;
  f.faults.after = e => { if (e.op === 'renameSync' && e.args[1] === f.indexFile) live = false; };
  code(() => f.put({ contextWindow: 16000 }, {}, () => { if (!live) throw new f.api.StoreError('NOT_FOUND'); }), 'NOT_FOUND');
  delete f.faults.after;
  const pending = f.state().pending; assert.equal(f.revision(), pending.beforeRevision);
  const restart = f.makeStore(); restart.recover(f.revision(), {}, pending.id);
  assert.equal(f.config().providers[NATIVE].modelOverrides[ID].contextWindow, 16000);
  assert.equal(f.store.hasPending(), false);
});

test('post-apply target guard failure preserves applied classification and restart only finishes metadata', t => {
  const f = fixture(t, seeded()); let live = true;
  f.faults.after = e => { if (e.op === 'renameSync' && e.args[1] === f.modelFile) live = false; };
  code(() => f.put({ contextWindow: 16000 }, {}, () => { if (!live) throw new f.api.StoreError('NOT_FOUND'); }), 'NOT_FOUND');
  delete f.faults.after; const pending = f.state().pending;
  assert.equal(f.revision(), pending.afterRevision); const before = f.raw();
  const count = f.events.filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length;
  f.makeStore().recover(f.revision(), {}, pending.id);
  assert.equal(f.raw(), before); assert.equal(f.events.filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, count);
  assert.equal(f.state().pending, null);
});

test('IO faults before/after model rename preserve before/applied journal classification in both protection modes', t => {
  for (const legacy of [false, true]) for (const applied of [false, true]) {
    const f = fixture(t, seeded(), { legacy }); const pending = interrupt(f, { applied });
    code(() => f.put({ maxTokens: 500 }), 'PENDING');
    f.makeStore().recover(f.revision(), {}, pending.id);
    assert.equal(f.config().providers[NATIVE].modelOverrides[ID].contextWindow, 16000);
    assert.equal(f.state().pending, null); assert.equal(f.state().history.length, 1);
  }
});

test('reset-to-inheritance is recoverable with exact pruning and does not copy effective values', t => {
  const f = fixture(t, { providers: { [NATIVE]: { modelOverrides: { [ID]: { contextWindow: 16000, maxTokens: 2000 } } } } });
  const pending = interrupt(f, { patch: { contextWindow: null, maxTokens: null } });
  assert.deepEqual(JSON.parse(pending.after), {});
  f.makeStore().recover(f.revision(), {}, pending.id); assert.deepEqual(f.config(), {});
});

test('model-limits history and pending reject any non-whitelisted semantic delta before protected recovery', t => {
  const mutations = [
    cfg => { cfg.providers[NATIVE].apiKey = 'injected'; },
    cfg => { delete cfg.providers[NATIVE].headers; },
    cfg => { cfg.providers[NATIVE].baseUrl = 'https://injected.invalid'; },
    cfg => { cfg.providers[NATIVE].api = 'anthropic-messages'; },
    cfg => { cfg.providers[NATIVE].models = [MODEL]; },
    cfg => { cfg.providers[NATIVE].modelOverrides[ID].name = 'injected'; },
    cfg => { delete cfg.providers[NATIVE].modelOverrides[ID].future; },
    cfg => { cfg.providers[NATIVE].modelOverrides.other.maxTokens = 1; },
    cfg => { cfg.rootFuture = false; },
    cfg => { delete cfg.providers.other; },
    cfg => { cfg.providers[NATIVE].modelOverrides[ID].contextWindow = 1.5; },
    cfg => { cfg.providers[NATIVE].modelOverrides[ID].maxTokens = 90000; },
  ];
  for (const mutate of mutations) {
    const f = fixture(t, seeded()); interrupt(f); const state = f.state(); const cfg = JSON.parse(state.pending.after);
    mutate(cfg); state.pending.after = encode(cfg); state.pending.afterRevision = hash(state.pending.after); f.putState(state);
    const before = f.raw(); code(() => f.makeStore().recover(f.revision()), 'INVALID_VAULT');
    assert.equal(f.raw(), before); assert.equal(f.store.hasPending(), true);
    // Completed history gets exactly the same transition validation.
    const history = { version: 1, archives: [], history: [state.pending], pending: null }; f.putState(history);
    code(() => f.store.listArchives(), 'INVALID_VAULT');
  }
});

test('journals cannot exploit omitted target IDs, no-op labels, altered archives, credentials or arbitrary empty pruning', t => {
  for (const mutate of [
    p => { delete p.operation.modelId; },
    p => { p.operation.archiveId = 'unexpected'; },
    p => { p.after = p.before; p.afterRevision = p.beforeRevision; },
    p => { p.archivesAfter = [{ id: 'forged', kind: 'provider', provider: 'other', createdAt: 1, payload: {} }]; },
    p => { p.credential = { version: 1, kind: 'edit', provider: NATIVE, authPath: '/tmp/model-pick-forged/auth.json', modelsPath: '/tmp/model-pick-forged/models.json', before: null, after: null, connectionChanged: false }; },
    p => { const cfg = JSON.parse(p.after); cfg.providers[NATIVE] = {}; p.after = encode(cfg); p.afterRevision = hash(p.after); },
  ]) {
    const f = fixture(t, seeded()); interrupt(f); const state = f.state(); mutate(state.pending); f.putState(state);
    const before = f.raw(); code(() => f.store.recover(f.revision()), 'INVALID_VAULT'); assert.equal(f.raw(), before);
  }
  for (const extra of [true, false]) {
    const f = fixture(t, { extra: {}, providers: { [NATIVE]: { modelOverrides: { [ID]: { contextWindow: 8000 } } } } });
    interrupt(f, { patch: { contextWindow: null } }); const state = f.state();
    const cfg = extra ? { extra: {}, providers: {} } : {}; // retain an affected empty ancestor, or prune an unrelated one
    state.pending.after = encode(cfg); state.pending.afterRevision = hash(state.pending.after); f.putState(state);
    code(() => f.store.recover(f.revision()), 'INVALID_VAULT');
  }
});

test('stale revisions, busy state and pending identity remain barriers even for metadata-only recovery', t => {
  const f = fixture(t, seeded()); const before = f.raw();
  code(() => f.put({}, {}, () => {}, 'stale'), 'CONFLICT');
  code(() => f.put({ contextWindow: 16000 }, { busy: true }), 'BUSY'); assert.equal(f.raw(), before);
  const pending = interrupt(f);
  code(() => f.store.recover(f.revision(), { busy: true }, pending.id), 'BUSY');
  code(() => f.store.recover(f.revision(), {}, 'different'), 'CONFLICT');
  code(() => f.store.recover('stale', {}, pending.id), 'CONFLICT');
  fs.writeFileSync(f.modelFile, encode({ concurrent: true })); const changed = f.raw();
  code(() => f.store.recover(f.revision(), {}, pending.id), 'CONFLICT'); assert.equal(f.raw(), changed);
});

test('metadata recovery rechecks revisions after a live guard runs at the models barrier', t => {
  const f = fixture(t, seeded()); interrupt(f); let staged = false; let concurrent;
  f.faults.before = e => {
    if (e.op === 'openSync' && path.dirname(e.args[0]) === f.root && path.basename(e.args[0]).startsWith('.model-pick-store-')) staged = true;
  };
  code(() => f.store.recover(f.revision(), { recheck: () => {
    if (staged && concurrent === undefined) {
      const config = f.config(); config.concurrent = true; concurrent = encode(config); fs.writeFileSync(f.modelFile, concurrent);
    }
    return {};
  } }), 'CONFLICT');
  delete f.faults.before; assert.equal(f.raw(), concurrent); assert.equal(f.store.hasPending(), true);
});

test('legacy foreign pending, live writer locks and unknown journals are never bypassed', t => {
  const f = fixture(t, seeded()); fs.mkdirSync(f.dataDir, { mode: 0o700 });
  fs.writeFileSync(path.join(f.dataDir, 'vault.json'), encode({ version: 1, pending: true, sealed: {} }), { mode: 0o600 });
  code(() => f.put({ contextWindow: 16000 }), 'LEGACY_PENDING');
  fs.unlinkSync(path.join(f.dataDir, 'vault.json'));
  fs.writeFileSync(f.lockFile, encode({ pid: process.pid, token: 'live' }), { mode: 0o600 });
  code(() => f.put({ contextWindow: 16000 }), 'CONFLICT'); fs.unlinkSync(f.lockFile);
  interrupt(f); const state = f.state(); state.pending.operation.kind = 'unknown-future-kind'; f.putState(state);
  code(() => f.store.recover(f.revision()), 'INVALID_VAULT');
});

test('protected full-model/provider add, edit, archive and restore permissions remain unchanged', t => {
  const f = fixture(t, seeded());
  for (const work of [
    () => f.store.addProvider(PROVIDER, f.revision()),
    () => f.store.addProviderWithModels(PROVIDER, [MODEL], f.revision()),
    () => f.store.editProvider(NATIVE, { name: 'no' }, f.revision()),
    () => f.store.putModel(NATIVE, MODEL, 'add', f.revision()),
    () => f.store.putModel(NATIVE, MODEL, 'edit', f.revision()),
    () => f.store.putModels(NATIVE, [MODEL], f.revision()),
    () => f.store.archiveProvider(NATIVE, f.revision()),
    () => f.store.archiveModel(NATIVE, ID, f.revision()),
  ]) code(work, 'PROTECTED');
  f.store.archiveProvider('other', f.revision()); const [archive] = f.store.listArchives();
  code(() => f.store.restore(archive.id, f.revision(), {}, NATIVE), 'PROTECTED');
});

test('locked, protection failures and unsafe/read-only filesystem paths fail closed', t => {
  const f = fixture(t, seeded(), { legacy: true }); f.store.lock();
  code(() => f.put({ contextWindow: 16000 }), 'LOCKED');
  const g = fixture(t, seeded()); const before = g.raw(); g.protectionState.failSeal = true;
  code(() => g.put({ contextWindow: 16000 }), 'IO_ERROR'); assert.equal(g.raw(), before); assert.equal(fs.existsSync(g.vaultFile), false);
  g.protectionState.failSeal = false;
  g.faults.before = e => { if (e.op === 'openSync' && (e.args[1] & fs.constants.O_WRONLY)) { const error = new Error(SECRET); error.code = 'EACCES'; throw error; } };
  code(() => g.put({ contextWindow: 16000 }), 'IO_ERROR'); assert.equal(g.raw(), before); delete g.faults.before;
  fs.renameSync(g.modelFile, g.modelFile + '.original'); fs.symlinkSync(g.modelFile + '.original', g.modelFile);
  code(() => g.store.modelLimitsOverride(NATIVE, ID), 'UNSAFE_PATH');
  fs.unlinkSync(g.modelFile); fs.linkSync(g.modelFile + '.original', g.modelFile);
  code(() => g.store.modelLimitsOverride(NATIVE, ID), 'UNSAFE_PATH');
});

test('malformed existing limit containers or values fail honestly without touching config', t => {
  for (const p of [{ modelOverrides: [] }, { modelOverrides: { [ID]: null } }, { modelOverrides: { [ID]: { contextWindow: 'bad' } } }]) {
    const f = fixture(t, { providers: { [NATIVE]: p } }); const before = f.raw();
    code(() => f.store.modelLimitsOverride(NATIVE, ID), 'INVALID_CONFIG');
    code(() => f.store.putModelLimitsOverride(NATIVE, ID, { contextWindow: 8000 }, hash(before), {}, () => {}), 'INVALID_CONFIG');
    assert.equal(f.raw(), before);
  }
});

test('installed SDK applies the store override above builtin, registered extension and OAuth projection; resets inherit fresh metadata', async t => {
  assert.ok(process.env.NODE_OPTIONS?.includes('isolation.cjs'), 'Run with the existing isolation preload');
  const sdk = piRoot();
  const { ModelRuntime } = await import(pathToFileURL(path.join(sdk, 'dist/core/model-runtime.js')));
  const ai = path.join(sdk, 'node_modules/@earendil-works/pi-ai/dist');
  const { InMemoryCredentialStore } = await import(pathToFileURL(path.join(ai, 'auth/credential-store.js')));
  const { InMemoryModelsStore } = await import(pathToFileURL(path.join(ai, 'models-store.js')));
  const credentials = new InMemoryCredentialStore();
  const oauth = { type: 'oauth', access: 'SYNTHETIC-access', refresh: 'SYNTHETIC-refresh', expires: Date.now() + 86400000 };
  await credentials.modify('extension', () => oauth);
  const f = fixture(t, {});
  const runtime = await ModelRuntime.create({ credentials, modelsPath: f.modelFile, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
  const builtinId = 'gpt-6.1-sol';
  const builtin = runtime.getPhysicalModel(NATIVE, builtinId); assert.ok(builtin, 'exact builtin Codex ID');
  assert.ok(runtime.getPhysicalModel(NATIVE, 'gpt-6-sol'), 'second exact builtin Codex ID');
  const builtinIds = runtime.getModels(NATIVE).map(m => m.id);
  const nativePut = patch => f.put(patch, {}, () => { assert.ok(runtime.getPhysicalModel(NATIVE, builtinId)); }, f.revision(), NATIVE, builtinId);
  nativePut({ contextWindow: builtin.contextWindow + 1000 });
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getPhysicalModel(NATIVE, builtinId).contextWindow, builtin.contextWindow + 1000);
  assert.equal(runtime.getPhysicalModel(NATIVE, builtinId).maxTokens, builtin.maxTokens);
  assert.deepEqual(runtime.getModels(NATIVE).map(m => m.id), builtinIds);
  nativePut({ contextWindow: null }); await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getPhysicalModel(NATIVE, builtinId).contextWindow, builtin.contextWindow);
  const extId = 'registered/chat'; let projection = 24000; let projected = 0;
  runtime.registerProvider('extension', { api: 'openai-responses', baseUrl: 'https://synthetic.invalid/v1',
    models: [{ id: extId, name: 'Registered', reasoning: true, input: ['text'], contextWindow: 18000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    oauth: { name: 'Synthetic', login: async () => { throw new Error('No login'); }, refreshToken: async () => { throw new Error('No refresh'); },
      getApiKey: () => { throw new Error('No auth resolution'); }, modifyModels: models => { projected++; return models.map(m => ({ ...m, contextWindow: projection, maxTokens: 2000 })); } },
  });
  await runtime.refresh({ allowNetwork: false }); assert.ok(projected > 0);
  const guard = () => { if (!runtime.getPhysicalModel('extension', extId)) throw new f.api.StoreError('NOT_FOUND'); };
  const extPut = patch => f.put(patch, {}, guard, f.revision(), 'extension', extId);
  extPut({ contextWindow: 32000 }); await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getPhysicalModel('extension', extId).contextWindow, 32000);
  assert.equal(runtime.getPhysicalModel('extension', extId).maxTokens, 2000);
  extPut({ maxTokens: 3000 }); await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getPhysicalModel('extension', extId).maxTokens, 3000);
  extPut({ contextWindow: null }); projection = 28000; await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getPhysicalModel('extension', extId).contextWindow, 28000);
  assert.equal(runtime.getPhysicalModel('extension', extId).maxTokens, 3000);
  extPut({ contextWindow: null, maxTokens: null }); await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getPhysicalModel('extension', extId).maxTokens, 2000);
  assert.deepEqual(await credentials.read('extension'), oauth);
  assert.deepEqual(runtime.getModels(NATIVE).map(m => m.id), builtinIds);
  assert.equal(f.config().providers, undefined);
});
