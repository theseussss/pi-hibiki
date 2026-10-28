import assert from 'node:assert/strict';
import { typescriptPath } from '../scripts/tooling.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Like the existing store tests, transpile only local source using installed TS.
// Runtime dependencies are allowlisted; every store fs call is confined to a
// synthetic mkdtemp tree (and read-only ancestor metadata). No network import,
// credentials/config from the live agent, installs, reloads or upstream calls.
const require = createRequire(import.meta.url);
const ts = require(typescriptPath());
const sourceDir = fileURLToPath(new URL('../lib/model-pick/', import.meta.url));
const compiled = new Map();
const PASS = 'synthetic-batch-passphrase';
const SECRET = 'SYNTHETIC-BATCH-SECRET-32a89!';
const P = { id: 'new-provider', name: 'New provider', endpoint: 'https://batch.invalid/v1', api: 'openai-responses', envVar: 'SYNTHETIC_BATCH_KEY' };
const model = id => ({ id, name: `Model ${id}`, contextWindow: 8192, maxTokens: 2048, reasoning: true, input: ['text', 'image'] });
const batch = () => [model('first'), model('second')];
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
function seed() {
  return { unknownRoot: { keep: true }, providers: {
    legacy: { baseUrl: 'http://legacy.invalid', api: 'future-unknown-api', apiKey: SECRET,
      headers: { Authorization: SECRET }, unknownProvider: { keep: true },
      models: [{ id: 'minimal', name: 'Legacy', cost: { input: 7 }, unknownModel: { keep: true } }] },
    other: { models: [{ id: 'first' }], untouched: SECRET },
  } };
}
function load(fsImpl) {
  const modules = new Map();
  function source(name) {
    const filename = path.join(sourceDir, name);
    if (modules.has(filename)) return modules.get(filename).exports;
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    const module = { exports: {} }; modules.set(filename, module);
    const localRequire = id => {
      if (id === 'node:fs') return fsImpl;
      if (['node:path', 'node:crypto', 'node:util'].includes(id)) return require(id);
      if (id === './vault.js') return source('vault.ts');
      throw new Error('Unexpected batch-store dependency; network/config access forbidden.');
    };
    vm.runInThisContext(`(function(exports,require,module){\n${compiled.get(filename)}\n})`, { filename })(module.exports, localRequire, module);
    return module.exports;
  }
  return { ...source('store.ts'), vault: source('vault.ts') };
}
function fixture(t, value = seed(), protectedProviders = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-batch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelFile = path.join(root, 'models.json');
  const dataDir = path.join(root, 'model-pick-data');
  const vaultFile = path.join(dataDir, 'vault.json');
  const indexFile = path.join(dataDir, 'retention-index.json');
  const lockFile = path.join(dataDir, 'store.lock');
  if (value !== null) fs.writeFileSync(modelFile, encode(value), { mode: 0o600 });
  const fds = new Map(); const calls = []; const state = { fault: undefined };
  const writes = new Set(['mkdirSync', 'unlinkSync', 'renameSync']);
  function check(file, write) {
    const abs = path.resolve(String(file));
    assert.ok(abs === root || abs.startsWith(root + path.sep) || (!write && root.startsWith((abs === '/' ? '' : abs) + '/')), 'Non-synthetic store access.');
    assert.ok(!['auth.json', 'settings.json'].includes(path.basename(abs)) && !abs.includes('/sessions/'), 'Forbidden configuration access.');
  }
  const fsImpl = new Proxy(fs, { get(target, op) {
    const fn = target[op];
    if (typeof fn !== 'function') return fn;
    return (...args) => {
      if (['openSync', 'lstatSync', 'readdirSync'].includes(op) || writes.has(op)) {
        check(args[0], writes.has(op) || (op === 'openSync' && Boolean(args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR))));
        if (op === 'renameSync') check(args[1], true);
      } else if (['readFileSync', 'writeFileSync', 'fstatSync', 'fchmodSync', 'fsyncSync', 'closeSync'].includes(op)) {
        assert.ok(typeof args[0] === 'number' && fds.has(args[0]), 'Untracked descriptor.');
      } else throw new Error('Unexpected filesystem operation.');
      const event = { op, args, file: typeof args[0] === 'number' ? fds.get(args[0]) : args[0] };
      calls.push(event); state.fault?.(event);
      const result = fn.apply(target, args);
      if (op === 'openSync') fds.set(result, args[0]);
      if (op === 'closeSync') fds.delete(args[0]);
      return result;
    };
  } });
  const loaded = load(fsImpl); const store = new loaded.PickerStore(root, protectedProviders);
  const raw = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const config = () => JSON.parse(raw(modelFile));
  const revision = () => store.snapshot().revision;
  const vaultState = () => loaded.vault.openJson(JSON.parse(raw(vaultFile)).sealed, PASS);
  const unlock = () => store.unlock(PASS);
  const fresh = () => { const next = new loaded.PickerStore(root, protectedProviders); next.unlock(PASS); return next; };
  return { root, modelFile, dataDir, vaultFile, indexFile, lockFile, store, loaded, state, calls, raw, config, revision, vaultState, unlock, fresh };
}
function code(run, expected) {
  assert.throws(run, e => {
    assert.equal(e.name, 'StoreError'); assert.equal(e.code, expected);
    assert.ok(!String(e.stack).includes(SECRET)); assert.ok(!String(e.message).includes(PASS));
    assert.equal(e.cause, undefined); return true;
  });
}
const operations = [
  { name: 'addProviderWithModels', journal: 'add-provider', provider: P.id,
    run: (f, inputs = batch(), rev = f.revision(), guard) => f.store.addProviderWithModels(P, inputs, rev, guard) },
  { name: 'putModels', journal: 'edit-provider', provider: 'legacy',
    run: (f, inputs = batch(), rev = f.revision(), guard) => f.store.putModels('legacy', inputs, rev, guard) },
];
function unchanged(f, run, expected) {
  const before = [f.raw(f.modelFile), f.raw(f.vaultFile), f.raw(f.indexFile)];
  code(run, expected);
  assert.deepEqual([f.raw(f.modelFile), f.raw(f.vaultFile), f.raw(f.indexFile)], before);
  assert.equal(fs.existsSync(f.lockFile), false);
  if (fs.existsSync(f.dataDir)) assert.ok(fs.readdirSync(f.dataDir).every(n => !n.startsWith('.model-pick-store-')));
}
function noLeak(f) {
  for (const file of [f.vaultFile, f.indexFile]) {
    const raw = f.raw(file);
    if (raw !== null) for (const secret of [SECRET, PASS, P.endpoint, P.envVar]) assert.ok(!raw.includes(secret));
  }
  assert.ok(!JSON.stringify(f.store.snapshot()).includes(SECRET));
}

for (const op of operations) {
  test(`${op.name}: exactly one full-image transaction, private encrypted backup and legacy readers`, t => {
    const original = seed(); const f = fixture(t, original); f.unlock();
    const before = f.raw(f.modelFile); op.run(f);
    const cfg = f.config(); const journal = f.vaultState();
    assert.equal(journal.version, 1); assert.equal(journal.pending, null); assert.equal(journal.history.length, 1);
    assert.deepEqual(journal.history[0].operation, { kind: op.journal, provider: op.provider });
    assert.equal(journal.history[0].before, before); assert.equal(journal.history[0].after, f.raw(f.modelFile));
    assert.deepEqual(journal.archives, []); assert.deepEqual(journal.history[0].archivesAfter, []);
    assert.equal(f.calls.filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, 1);
    assert.deepEqual(cfg.unknownRoot, original.unknownRoot); assert.deepEqual(cfg.providers.other, original.providers.other);
    if (op.provider === 'legacy') {
      assert.deepEqual(cfg.providers.legacy, { ...original.providers.legacy, models: [...original.providers.legacy.models, ...batch()] });
    } else {
      assert.deepEqual(cfg.providers.legacy, original.providers.legacy);
      assert.deepEqual(cfg.providers[P.id], { name: P.name, baseUrl: P.endpoint, api: P.api, apiKey: `$${P.envVar}`, models: batch() });
    }
    noLeak(f);
    for (const file of [f.modelFile, f.vaultFile, f.indexFile]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.dataDir).mode & 0o777, 0o700);
    // Only legacy methods from here: v1 schema validation, editing, archive/restore.
    const reader = f.fresh();
    reader.editProvider(op.provider, { name: 'Edited' }, reader.snapshot().revision);
    reader.putModel(op.provider, { ...model('first'), maxTokens: 1024 }, 'edit', reader.snapshot().revision);
    reader.archiveModel(op.provider, 'second', reader.snapshot().revision);
    const archive = reader.listArchives()[0]; reader.restore(archive.id, reader.snapshot().revision);
    assert.equal(reader.hasPending(), false);
    assert.equal(reader.snapshot().providers.find(p => p.id === op.provider).models.length, op.provider === 'legacy' ? 3 : 2);
    noLeak(f);
  });

  test(`${op.name}: invalid second model, duplicate IDs and bounded/dense lists leave all durable images untouched`, t => {
    const f = fixture(t); f.unlock();
    const badChanges = [
      { id: '__proto__' }, { id: 'constructor' }, { id: 'bad\nID' }, { name: 'bad\u202e' },
      { contextWindow: 0 }, { contextWindow: 1.5 }, { contextWindow: Number.MAX_SAFE_INTEGER + 1 },
      { maxTokens: 8193 }, { maxTokens: 0 }, { reasoning: 'yes' },
      { input: [] }, { input: ['audio'] }, { input: ['text', 'text'] }, { input: ['text', 'image', 'text'] },
    ];
    for (const change of badChanges) unchanged(f, () => op.run(f, [model('first'), { ...model('second'), ...change }]), 'INVALID_INPUT');
    unchanged(f, () => op.run(f, [model('first'), model('first')]), 'EXISTS');
    for (const inputs of [[], Array.from({ length: 101 }, (_, i) => model(`m${i}`)), [model('first'), , model('third')], null, {}, 'bad']) {
      unchanged(f, () => op.run(f, inputs), 'INVALID_INPUT');
    }
    assert.equal(f.store.hasVault(), false);
    // Check refusal also preserves an already existing authenticated journal.
    op.run(f);
    unchanged(f, () => op.run(f, [model('third'), { ...model('fourth'), maxTokens: -1 }]), op.provider === 'legacy' ? 'INVALID_INPUT' : 'EXISTS');
  });

  test(`${op.name}: maximum batch of 100 and minimal single model are supported`, t => {
    const f = fixture(t); f.unlock();
    const inputs = Array.from({ length: 100 }, (_, i) => model(`m${i}`));
    op.run(f, inputs);
    assert.deepEqual(f.config().providers[op.provider].models.slice(-100), inputs);
    const one = { ...model('single') }; delete one.name;
    f.store.putModels(op.provider, [one], f.revision());
    assert.deepEqual(f.config().providers[op.provider].models.at(-1), one);
    assert.equal(f.vaultState().history.length, 2);
  });

  test(`${op.name}: getters, proxies, toJSON, inherited input and dangerous keys never execute`, t => {
    const f = fixture(t); f.unlock(); let invoked = 0;
    const trap = () => { invoked++; throw new Error(SECRET); };
    const getter = { ...model('second') }; Object.defineProperty(getter, 'id', { enumerable: true, get: trap });
    const arrayGetter = [model('first'), model('second')]; Object.defineProperty(arrayGetter, '1', { enumerable: true, get: trap });
    const badInputs = [
      new Proxy(batch(), { get: trap, ownKeys: trap }), arrayGetter,
      [model('first'), getter], [model('first'), new Proxy(model('second'), { get: trap, ownKeys: trap })],
      [model('first'), { ...model('second'), toJSON: trap }],
      [model('first'), Object.assign(Object.create({ inherited: true }), model('second'))],
      [model('first'), { ...model('second'), extra: JSON.parse('{"__proto__":{}}') }],
    ];
    for (const inputs of badInputs) unchanged(f, () => op.run(f, inputs), 'INVALID_INPUT');
    assert.equal(invoked, 0); assert.equal(f.store.hasVault(), false);
  });

  test(`${op.name}: locked, busy, protected and revision/concurrent-writer guards`, t => {
    const f = fixture(t, seed(), ['protected']);
    unchanged(f, () => op.run(f), 'LOCKED'); f.unlock();
    unchanged(f, () => op.run(f, batch(), f.revision(), { busy: true }), 'BUSY');
    unchanged(f, () => op.run(f, batch(), 'stale'), 'CONFLICT');
    unchanged(f, () => f.store.addProviderWithModels({ ...P, id: 'protected' }, batch(), f.revision()), 'PROTECTED');
    unchanged(f, () => f.store.putModels('protected', batch(), f.revision()), 'PROTECTED');
    fs.mkdirSync(f.dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f.lockFile, encode({ pid: process.pid, token: 'synthetic-live-lock' }), { mode: 0o600 });
    code(() => op.run(f), 'CONFLICT'); assert.equal(fs.existsSync(f.lockFile), true); fs.unlinkSync(f.lockFile);
    const beforeRevision = f.revision(); fs.writeFileSync(f.modelFile, encode({ ...seed(), external: true }));
    unchanged(f, () => op.run(f, batch(), beforeRevision), 'CONFLICT');
    assert.equal(f.store.hasVault(), false);
  });

  test(`${op.name}: additions do not remove/change current/default; archive protections remain`, t => {
    const f = fixture(t); f.unlock();
    const guard = { current: { provider: 'legacy', id: 'minimal' }, default: { provider: 'legacy', id: 'minimal' } };
    op.run(f, batch(), f.revision(), guard);
    assert.deepEqual(f.config().providers.legacy.models[0], seed().providers.legacy.models[0]);
    unchanged(f, () => f.store.archiveProvider('legacy', f.revision(), guard), 'CURRENT_MODEL');
    unchanged(f, () => f.store.archiveModel('legacy', 'minimal', f.revision(), { default: guard.default }), 'DEFAULT_MODEL');
  });

  for (const stage of ['journal', 'index-before', 'models', 'index-after', 'finish']) {
    test(`${op.name}: exception at ${stage} never exposes a partial batch and recovery stays v1-compatible`, t => {
      const f = fixture(t); f.unlock(); const before = f.raw(f.modelFile);
      const counts = new Map(); let hit = false;
      f.state.fault = e => {
        if (e.op !== 'renameSync') return;
        const file = e.args[1]; const n = (counts.get(file) ?? 0) + 1; counts.set(file, n);
        const match = stage === 'journal' ? file === f.vaultFile && n === 1
          : stage === 'index-before' ? file === f.indexFile && n === 1
          : stage === 'models' ? file === f.modelFile
          : stage === 'index-after' ? file === f.indexFile && n === 2
          : file === f.vaultFile && n === 2;
        if (match && !hit) { hit = true; throw new Error(SECRET); }
      };
      code(() => op.run(f), 'IO_ERROR'); f.state.fault = undefined; assert.ok(hit);
      assert.equal(fs.existsSync(f.lockFile), false);
      for (const dir of [f.root, f.dataDir]) assert.ok(fs.readdirSync(dir).every(n => !n.startsWith('.model-pick-store-')));
      noLeak(f);
      if (stage === 'journal') {
        assert.equal(f.raw(f.modelFile), before); assert.equal(f.store.hasVault(), false);
        op.run(f); assert.equal(f.vaultState().history.length, 1); return;
      }
      const alreadyApplied = stage === 'index-after' || stage === 'finish';
      const pending = f.vaultState().pending;
      assert.equal(pending.operation.kind, op.journal); assert.equal(pending.before, before);
      assert.equal(f.raw(f.modelFile), alreadyApplied ? pending.after : before);
      const planned = JSON.parse(pending.after).providers[op.provider].models;
      assert.deepEqual(planned.slice(-2), batch()); assert.equal(f.store.hasPending(), true);
      unchanged(f, () => op.run(f, [model('third')]), 'PENDING');
      unchanged(f, () => f.store.addProvider(P, f.revision()), 'PENDING');
      const next = f.fresh(); const start = f.calls.length;
      next.recover(next.snapshot().revision);
      assert.equal(f.calls.slice(start).filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, alreadyApplied ? 0 : 1);
      assert.equal(f.raw(f.modelFile), pending.after); assert.equal(next.hasPending(), false);
      assert.equal(f.vaultState().history.length, 1); assert.equal(f.vaultState().version, 1);
      noLeak(f);
    });
  }

  test(`${op.name}: external edits during commit are not overwritten or automatically recovered`, t => {
    const f = fixture(t); f.unlock(); let hit = false;
    const external = encode({ ...seed(), external: SECRET });
    f.state.fault = e => {
      if (!hit && e.op === 'openSync' && String(e.args[0]).startsWith(f.root + '/.model-pick-store-')) {
        hit = true; fs.writeFileSync(f.modelFile, external);
      }
    };
    code(() => op.run(f), 'CONFLICT'); f.state.fault = undefined;
    assert.ok(hit); assert.equal(f.raw(f.modelFile), external); assert.equal(f.store.hasPending(), true);
    unchanged(f, () => f.store.recover(f.revision()), 'CONFLICT'); noLeak(f);
  });

  test(`${op.name}: invalid active config and unauthenticated vault fail closed`, t => {
    const invalid = fixture(t, { providers: { legacy: { models: [{ id: 'duplicate' }, { id: 'duplicate' }] } } });
    invalid.unlock();
    unchanged(invalid, () => op.run(invalid, batch(), 'unused'), 'INVALID_CONFIG');
    assert.equal(invalid.store.hasVault(), false);
    const f = fixture(t); f.unlock(); op.run(f);
    const container = JSON.parse(f.raw(f.vaultFile));
    container.sealed.data = (container.sealed.data[0] === 'A' ? 'B' : 'A') + container.sealed.data.slice(1);
    fs.writeFileSync(f.vaultFile, encode(container));
    unchanged(f, () => op.run(f), 'INVALID_VAULT');
  });

  test(`${op.name}: authenticated vault size preflight fails before any active configuration change`, t => {
    const original = seed(); original.largeUnknownField = 'x'.repeat(2_100_000);
    const f = fixture(t, original); f.unlock();
    unchanged(f, () => op.run(f), 'IO_ERROR');
    assert.equal(f.store.hasVault(), false); assert.equal(f.store.hasPending(), false);
  });
}

test('putModels refuses existing IDs even in second position and accepts same ID in another provider', t => {
  const f = fixture(t); f.unlock();
  unchanged(f, () => f.store.putModels('legacy', [model('new'), model('minimal')], f.revision()), 'EXISTS');
  unchanged(f, () => f.store.putModels('absent', batch(), f.revision()), 'NOT_FOUND');
  f.store.putModels('legacy', [model('first')], f.revision());
  unchanged(f, () => f.store.putModels('legacy', [model('second'), model('first')], f.revision()), 'EXISTS');
  assert.deepEqual(f.config().providers.other, seed().providers.other);
});

test('addProviderWithModels validates provider data/hooks and collisions without leaving provider-only config', t => {
  const f = fixture(t); f.unlock(); let invoked = false;
  const getter = { ...P }; Object.defineProperty(getter, 'id', { enumerable: true, get() { invoked = true; throw new Error(SECRET); } });
  const proxy = new Proxy(P, { get() { invoked = true; throw new Error(SECRET); } });
  for (const input of [getter, proxy, null, { ...P, id: '__proto__' }, { ...P, name: '' }, { ...P, api: 'unknown' },
    { ...P, endpoint: 'http://batch.invalid' }, { ...P, endpoint: 'https://batch.invalid?token=synthetic' }, { ...P, envVar: '!never-run' }]) {
    unchanged(f, () => f.store.addProviderWithModels(input, batch(), f.revision()), 'INVALID_INPUT');
  }
  assert.equal(invoked, false);
  unchanged(f, () => f.store.addProviderWithModels({ ...P, id: 'legacy' }, batch(), f.revision()), 'EXISTS');
  assert.equal(f.store.hasVault(), false);
});

test('first-ever batched provider add recovers from absent models and legacy addProvider still allows no models', t => {
  const f = fixture(t, null); f.unlock(); let hit = false;
  f.state.fault = e => { if (!hit && e.op === 'renameSync' && e.args[1] === f.modelFile) { hit = true; throw new Error(SECRET); } };
  code(() => f.store.addProviderWithModels(P, batch(), f.revision()), 'IO_ERROR'); f.state.fault = undefined;
  assert.ok(hit); assert.equal(f.raw(f.modelFile), null); assert.equal(f.vaultState().pending.before, null);
  const next = f.fresh(); next.recover(next.snapshot().revision);
  assert.deepEqual(f.config().providers[P.id].models, batch());
  next.addProvider({ ...P, id: 'empty' }, next.snapshot().revision);
  assert.deepEqual(f.config().providers.empty.models, []);
});

test('legacy putModel edit still preserves unknown fields/name and ignores unrecognized input fields', t => {
  const f = fixture(t); f.unlock(); f.store.putModels('legacy', batch(), f.revision());
  const input = model('minimal'); delete input.name; input.unrecognizedNewField = SECRET;
  f.store.putModel('legacy', input, 'edit', f.revision());
  assert.deepEqual(f.config().providers.legacy.models[0], { ...seed().providers.legacy.models[0], ...model('minimal'), name: 'Legacy' });
  assert.equal(f.config().providers.legacy.models[0].unrecognizedNewField, undefined);
  noLeak(f);
});

test('batch transactions retain all archives while history stays bounded at 20 full backups', t => {
  const f = fixture(t); f.unlock();
  f.store.archiveModel('legacy', 'minimal', f.revision()); const archive = f.store.listArchives()[0];
  f.store.addProviderWithModels(P, [model('initial')], f.revision());
  for (let i = 0; i < 20; i++) f.store.putModels(P.id, [model(`m${i}`)], f.revision());
  const state = f.vaultState(); assert.equal(state.history.length, 20);
  assert.equal(state.archives.length, 1); assert.equal(state.archives[0].id, archive.id);
  assert.equal(state.history[0].operation.kind, 'edit-provider');
  assert.equal(JSON.parse(state.history[0].after).providers[P.id].models.at(-1).id, 'm0');
  assert.equal(JSON.parse(state.history.at(-1).after).providers[P.id].models.at(-1).id, 'm19');
  f.store.lock(); assert.deepEqual(f.store.retained(), { providers: ['legacy'], models: ['legacy/minimal'] });
  f.unlock(); f.store.restore(archive.id, f.revision());
  assert.deepEqual(f.config().providers.legacy.models[0], seed().providers.legacy.models[0]); noLeak(f);
});

test('unknown default state fails closed for both archive methods without blocking safe additions', t => {
  const f = fixture(t); f.unlock(); const guard = { defaultUnknown: true };
  unchanged(f, () => f.store.archiveModel('legacy', 'minimal', f.revision(), guard), 'DEFAULT_UNKNOWN');
  unchanged(f, () => f.store.archiveProvider('legacy', f.revision(), guard), 'DEFAULT_UNKNOWN');
  f.store.putModels('legacy', [model('safe-add')], f.revision(), guard);
  assert.equal(f.config().providers.legacy.models.at(-1).id, 'safe-add');
});

test('unknown default state also blocks roll-forward of an unapplied archive journal', t => {
  const f = fixture(t); f.unlock(); let hit = false;
  f.state.fault = e => { if (!hit && e.op === 'renameSync' && e.args[1] === f.modelFile) { hit = true; throw new Error('synthetic'); } };
  code(() => f.store.archiveModel('legacy', 'minimal', f.revision()), 'IO_ERROR'); f.state.fault = undefined;
  assert.equal(f.store.hasPending(), true);
  unchanged(f, () => f.store.recover(f.revision(), { defaultUnknown: true }), 'DEFAULT_UNKNOWN');
  f.store.recover(f.revision()); assert.equal(f.store.hasPending(), false);
  assert.ok(!f.config().providers.legacy.models.some((m) => m.id === 'minimal'));
});
