import assert from 'node:assert/strict';
import { typescriptPath } from '../scripts/tooling.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';

// Only transpile local code. The runtime fs adapter confines all operations to
// a synthetic temp tree (ancestor metadata is read-only). No real configuration,
// credentials, environment resolution, subprocess, network or platform helper.
const require = createRequire(import.meta.url);
const ts = require(typescriptPath());
const sourceDir = fileURLToPath(new URL('../lib/model-pick/', import.meta.url));
const compiled = new Map();
const PASS = 'SYNTHETIC-old-explicit-password';
const SECRET = 'SYNTHETIC-raw-secret-47b9-not-output';
const P = { id: 'custom', name: 'Custom', endpoint: 'https://synthetic.invalid/v1', api: 'openai-responses', envVar: 'SYNTHETIC_REFERENCE_ONLY' };
const model = id => ({ id, contextWindow: 8192, maxTokens: 2048, reasoning: true, input: ['text', 'image'] });
const encode = value => `${JSON.stringify(value, null, 2)}\n`;
const seed = () => ({ unknownRoot: { keep: true }, providers: { custom: {
  name: 'Custom', baseUrl: P.endpoint, api: P.api, apiKey: SECRET, headers: { Authorization: SECRET }, unknownProvider: { keep: true },
  models: [{ ...model('m'), unknownModel: { secret: SECRET }, cost: { input: 7 } }],
} } });
const report = () => ({ kind: 'probe', report: {
  id: 'synthetic-probe', scope: { provider: 'custom', modelId: 'm', endpoint: P.endpoint, api: P.api, credentialVersion: 'opaque' },
  testedAt: 1, expiresAt: 2, fields: {}, verifiedFields: [], status: 'passed', checks: { text: 'passed' }, code: 'ok', elapsedMs: 1,
} });
const resolution = id => ({ kind: 'resolution', provider: 'custom', modelId: id, fields: model(id), provenance: { input: { source: 'manual' } } });

// Real AES-GCM, ephemeral test key, authenticated purpose. This is an injectable
// synthetic backend, not a simulation or test of Windows DPAPI availability.
function protector() {
  const key = randomBytes(32);
  const state = { seals: 0, opens: 0, clears: 0, failSeal: false, failOpen: false, sealHook: undefined };
  return {
    state,
    seal(value, purpose) {
      state.seals++; state.sealHook?.(value, purpose);
      if (state.failSeal) throw new Error(SECRET);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(purpose));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { version: 1, purpose, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(envelope, purpose) {
      state.opens++;
      if (state.failOpen || envelope?.version !== 1 || envelope?.purpose !== purpose) throw new Error(SECRET);
      assert.deepEqual(Object.keys(envelope).sort(), ['data', 'iv', 'purpose', 'tag', 'version']);
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8'));
    },
    clear() { state.clears++; }, // Real backends clear a cache and can reacquire without a human gate.
  };
}
function load(fsImpl) {
  const modules = new Map();
  function source(name) {
    assert.ok(['store.ts', 'records.ts', 'vault.ts'].includes(name));
    if (modules.has(name)) return modules.get(name).exports;
    if (!compiled.has(name)) compiled.set(name, ts.transpileModule(fs.readFileSync(path.join(sourceDir, name), 'utf8'), {
      fileName: name, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
    const module = { exports: {} }; modules.set(name, module);
    const localRequire = id => {
      if (id === 'node:fs') return fsImpl;
      if (['node:path', 'node:crypto', 'node:util'].includes(id)) return require(id);
      if (id === './vault.js') return source('vault.ts');
      throw new Error('Unexpected runtime dependency; platform initialization forbidden.');
    };
    vm.runInThisContext(`(function(exports,require,module){\n${compiled.get(name)}\n})`, { filename: path.join(sourceDir, name) })(module.exports, localRequire, module);
    return module.exports;
  }
  return { ...source('store.ts'), ...source('records.ts'), vault: source('vault.ts') };
}
function fixture(t, config = seed()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-auto-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'model-pick-data');
  const modelFile = path.join(root, 'models.json');
  if (config !== null) fs.writeFileSync(modelFile, encode(config), { mode: 0o600 });
  const calls = []; const fds = new Map(); const state = { fault: undefined };
  function check(file, write = false) {
    const abs = path.resolve(String(file));
    assert.ok(abs === root || abs.startsWith(root + path.sep) || (!write && root.startsWith((abs === '/' ? '' : abs) + path.sep)), 'Non-synthetic filesystem access.');
    assert.ok(!['auth.json', 'settings.json'].includes(path.basename(abs)) && !abs.includes('/sessions/'));
  }
  const writes = new Set(['mkdirSync', 'renameSync', 'unlinkSync']);
  const fakeFs = new Proxy(fs, { get(target, op) {
    if (typeof target[op] !== 'function') return target[op];
    return (...args) => {
      if (['openSync', 'lstatSync', 'readdirSync'].includes(op) || writes.has(op)) {
        check(args[0], writes.has(op) || (op === 'openSync' && Boolean(args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR))));
        if (op === 'renameSync') check(args[1], true);
      } else if (['readFileSync', 'writeFileSync', 'fstatSync', 'fchmodSync', 'fsyncSync', 'closeSync'].includes(op)) {
        if (typeof args[0] === 'number') assert.ok(fds.has(args[0]), 'Untracked descriptor.');
        else { assert.ok(['readFileSync', 'writeFileSync'].includes(op)); check(args[0], op === 'writeFileSync'); }
      } else throw new Error('Unexpected fs operation.');
      const event = { op, args, file: typeof args[0] === 'number' ? fds.get(args[0]) : args[0] };
      calls.push(event); state.fault?.(event);
      const result = target[op](...args);
      if (op === 'openSync') fds.set(result, args[0]);
      if (op === 'closeSync') fds.delete(args[0]);
      return result;
    };
  } });
  const loaded = load(fakeFs); const protection = protector();
  const store = new loaded.PickerStore(root, ['builtin'], protection);
  const records = new loaded.PickerRecords(root, protection);
  const file = name => path.join(dataDir, name);
  const raw = filename => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : null;
  const rev = () => store.snapshot().revision;
  const vaultState = () => protection.open(JSON.parse(raw(file('vault.auto.json'))).sealed, 'models');
  const recordState = () => protection.open(JSON.parse(raw(file('records.auto.json'))).sealed, 'records');
  const writeVault = value => fs.writeFileSync(file('vault.auto.json'), encode({ version: 2, pending: value.pending !== null, sealed: protection.seal(value, 'models') }), { mode: 0o600 });
  const disk = () => Object.fromEntries((fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []).map(name => [name, raw(file(name))]));
  const fresh = () => new loaded.PickerStore(root, ['builtin'], protection);
  return { root, dataDir, modelFile, loaded, protection, store, records, state, calls, file, raw, rev, vaultState, recordState, writeVault, disk, fresh };
}
function storeCode(run, expected) {
  assert.throws(run, error => {
    assert.equal(error.name, 'StoreError'); assert.equal(error.code, expected);
    assert.ok(!String(error.stack).includes(SECRET)); assert.equal(error.cause, undefined); return true;
  });
}
function recordError(run) {
  assert.throws(run, error => error.name === 'RecordError' && !String(error.stack).includes(SECRET) && error.cause === undefined);
}
function unchanged(f, run, expected) {
  const before = [f.raw(f.modelFile), f.disk()];
  if (expected) storeCode(run, expected); else recordError(run);
  assert.deepEqual([f.raw(f.modelFile), f.disk()], before);
}
function noLeak(f) {
  for (const [name, raw] of Object.entries(f.disk())) {
    assert.ok(!raw.includes(SECRET), name); assert.ok(!raw.includes(P.endpoint), name); assert.ok(!raw.includes(PASS), name);
    assert.ok(!/key\.(?:json|bin)|master|password/i.test(name), 'No local plaintext key file.');
    assert.equal(fs.statSync(f.file(name)).mode & 0o777, 0o600);
  }
}
function interrupt(f, operation = () => f.store.archiveProvider('custom', f.rev()), filename = f.modelFile) {
  let hit = false;
  f.state.fault = e => { if (!hit && e.op === 'renameSync' && e.args[1] === filename) { hit = true; throw new Error(SECRET); } };
  storeCode(operation, 'IO_ERROR'); f.state.fault = undefined; assert.ok(hit);
}

test('automatic APIs are ready without unlock; lock/dispose clear cache but never gate operations', t => {
  const f = fixture(t, null);
  assert.equal(f.store.isUnlocked(), true); assert.equal(f.records.isUnlocked(), true);
  assert.equal(f.store.hasVault(), false); assert.equal(f.records.hasData(), false);
  assert.equal(f.store.hasLegacyData(), false); assert.equal(f.records.hasLegacyData(), false);
  assert.deepEqual(f.store.retained(), { providers: [], models: [] }); assert.deepEqual(f.records.tests(), []);
  assert.deepEqual(fs.readdirSync(f.root), []);
  f.store.unlock(''); f.store.unlock(undefined); // No password gate or platform work.
  assert.equal(f.protection.state.seals, 0); assert.equal(f.protection.state.opens, 0);
  f.store.lock(); f.store.lock(); f.store.dispose(); f.records.lock(); f.records.dispose();
  assert.equal(f.protection.state.clears, 5);
  f.store.addProviderWithModels(P, [model('m')], f.rev());
  f.records.append(report()); f.records.appendMany([resolution('m'), report()]);
  assert.equal(f.records.tests().length, 2); assert.equal(f.store.hasVault(), true);
  assert.deepEqual(fs.readdirSync(f.dataDir).sort(), ['records.auto.json', 'retention-index.auto.json', 'vault.auto.json']);
  assert.equal(JSON.parse(f.raw(f.file('vault.auto.json'))).version, 2);
  assert.equal(JSON.parse(f.raw(f.file('records.auto.json'))).version, 2);
  assert.equal(f.vaultState().version, 1); assert.equal(f.recordState().version, 1);
  f.store.lock(); f.records.lock();
  f.store.editProvider('custom', { name: 'After clear' }, f.rev()); f.records.append(report());
  assert.equal(f.records.tests().length, 3); noLeak(f);
});

test('automatic add/edit preserves unknown fields and full authenticated before/after history', t => {
  const original = seed(); const f = fixture(t, original); const before = f.raw(f.modelFile);
  f.store.editProvider('custom', { name: 'Renamed', envVar: '' }, f.rev());
  f.store.putModel('custom', { ...model('m'), maxTokens: 1024 }, 'edit', f.rev());
  f.store.putModels('custom', [model('second'), model('third')], f.rev());
  const cfg = JSON.parse(f.raw(f.modelFile));
  assert.deepEqual(cfg.unknownRoot, original.unknownRoot); assert.deepEqual(cfg.providers.custom.headers, original.providers.custom.headers);
  assert.equal(cfg.providers.custom.apiKey, SECRET); assert.deepEqual(cfg.providers.custom.models[0].unknownModel, { secret: SECRET });
  const state = f.vaultState(); assert.equal(state.history.length, 3); assert.equal(state.history[0].before, before);
  assert.equal(state.history.at(-1).after, f.raw(f.modelFile)); assert.equal(state.pending, null); noLeak(f);
});

test('automatic archive/restore retains full payloads and refuses identity/binding/collision errors', t => {
  const original = seed(); const f = fixture(t, original);
  f.store.archiveModel('custom', 'm', f.rev()); const archive = f.store.listArchives()[0];
  f.store.editProvider('custom', { endpoint: 'https://changed.invalid/v2' }, f.rev());
  unchanged(f, () => f.store.restore(archive.id, f.rev()), 'CONFLICT');
  f.store.editProvider('custom', { endpoint: P.endpoint }, f.rev());
  f.store.putModel('custom', model('m'), 'add', f.rev());
  unchanged(f, () => f.store.restore(archive.id, f.rev()), 'EXISTS');
  f.store.archiveModel('custom', 'm', f.rev()); f.store.restore(archive.id, f.rev());
  assert.deepEqual(JSON.parse(f.raw(f.modelFile)).providers.custom.models[0], original.providers.custom.models[0]);
  unchanged(f, () => f.store.restore(archive.id, f.rev()), 'NOT_FOUND');
  f.store.archiveProvider('custom', f.rev()); const providerArchive = f.store.listArchives().find(a => a.kind === 'provider');
  unchanged(f, () => f.store.restore(providerArchive.id, f.rev(), undefined, 'builtin'), 'PROTECTED');
  f.store.restore(providerArchive.id, f.rev(), undefined, 'restored-copy');
  assert.deepEqual(JSON.parse(f.raw(f.modelFile)).providers['restored-copy'], original.providers.custom);
  assert.deepEqual(f.store.retained(), { providers: ['custom'], models: ['custom/m'] }); noLeak(f);
});

test('100-model automatic batches are one transaction; invalid later members never partly apply', t => {
  const f = fixture(t, null); const many = Array.from({ length: 100 }, (_, i) => model(`m${i}`));
  f.store.addProviderWithModels(P, many, f.rev());
  assert.equal(f.vaultState().history.length, 1);
  assert.equal(f.calls.filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, 1);
  for (const batch of [[], many.concat(model('extra')), [model('good'), { ...model('bad'), maxTokens: -1 }], [model('same'), model('same')]]) {
    unchanged(f, () => f.store.putModels('custom', batch, f.rev()), batch.length === 2 && batch[1].id === 'same' ? 'EXISTS' : 'INVALID_INPUT');
  }
  f.records.appendMany(Array.from({ length: 100 }, (_, i) => resolution(`m${i}`)));
  assert.equal(f.recordState().events.length, 100);
  assert.equal(f.calls.filter(e => e.op === 'renameSync' && e.args[1] === f.file('records.auto.json')).length, 1); noLeak(f);
});

test('automatic defaultUnknown/current/default/busy guards remain fail-closed without blocking safe adds', t => {
  const f = fixture(t);
  const cases = [[{ defaultUnknown: true }, 'DEFAULT_UNKNOWN'], [{ current: { provider: 'custom', id: 'm' } }, 'CURRENT_MODEL'], [{ default: { provider: 'custom', id: 'm' } }, 'DEFAULT_MODEL'], [{ busy: true }, 'BUSY']];
  for (const [guard, code] of cases) {
    unchanged(f, () => f.store.archiveProvider('custom', f.rev(), guard), code);
    unchanged(f, () => f.store.archiveModel('custom', 'm', f.rev(), guard), code);
  }
  unchanged(f, () => f.store.addProvider(P, f.rev(), { busy: true }), 'BUSY');
  unchanged(f, () => f.store.recover(f.rev(), { busy: true }), 'BUSY');
  f.store.putModels('custom', [model('safe-add')], f.rev(), { defaultUnknown: true });
  unchanged(f, () => f.store.putModels('builtin', [model('new')], f.rev()), 'PROTECTED');
});

// The callback is trusted runtime context, not part of models/archive/journal
// data. Mutate only this synthetic in-memory context during protection and IO;
// runtime fs access to settings/auth remains forbidden by fixture().
const lateGuards = [
  ['default', { default: { provider: 'custom', id: 'm' } }, 'DEFAULT_MODEL'],
  ['current', { current: { provider: 'custom', id: 'm' } }, 'CURRENT_MODEL'],
  ['unknown', { defaultUnknown: true }, 'DEFAULT_UNKNOWN'],
  ['busy', { busy: true }, 'BUSY'],
];
const archiveOperations = [
  ['provider', (f, guard) => f.store.archiveProvider('custom', f.rev(), guard)],
  ['model', (f, guard) => f.store.archiveModel('custom', 'm', f.rev(), guard)],
];
function runtimeGuard() {
  const state = { latest: {} };
  return { state, guard: { recheck: () => state.latest } };
}
function noStaging(f) {
  assert.ok(!fs.existsSync(f.file('store.lock')));
  for (const directory of [f.root, f.dataDir]) {
    if (fs.existsSync(directory)) assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('.model-pick-store-')));
  }
}
function pendingUnapplied(f, before, pending) {
  assert.equal(f.raw(f.modelFile), before); assert.equal(f.store.hasPending(), true);
  assert.deepEqual(f.vaultState().pending, pending);
  assert.equal(f.vaultState().history.length, 0); assert.deepEqual(f.vaultState().archives, []);
  assert.deepEqual(f.store.retained(), { providers: ['custom'], models: ['custom/m'] });
  noStaging(f); noLeak(f);
}

for (const [kind, archive] of archiveOperations) {
  for (const [name, latest, code] of lateGuards) {
    for (const sealAt of [1, 2]) {
      test(`automatic archive ${kind} rechecks ${name} changed during preflight seal ${sealAt} before journaling`, t => {
        const f = fixture(t); const { state, guard } = runtimeGuard(); let hit = false;
        f.protection.state.sealHook = (_value, purpose) => {
          if (purpose === 'models' && f.protection.state.seals === sealAt) { hit = true; state.latest = latest; }
        };
        unchanged(f, () => archive(f, guard), code);
        assert.ok(hit); assert.equal(f.protection.state.seals, 2);
        assert.equal(f.store.hasPending(), false); assert.equal(f.store.hasVault(), false);
        assert.equal(f.calls.filter(e => e.op === 'renameSync').length, 0); noStaging(f);
      });
    }

    for (const barrier of ['index', 'models-staging']) {
      test(`automatic archive ${kind} rechecks ${name} after ${barrier} work and retains an unapplied journal`, t => {
        const f = fixture(t); const before = f.raw(f.modelFile); const { state, guard } = runtimeGuard(); let hit = false;
        f.state.fault = e => {
          const match = barrier === 'index'
            ? e.op === 'renameSync' && e.args[1] === f.file('retention-index.auto.json')
            : e.op === 'openSync' && String(e.args[0]).startsWith(f.root + '/.model-pick-store-');
          if (!hit && match) { hit = true; state.latest = latest; }
        };
        storeCode(() => archive(f, guard), code); f.state.fault = undefined;
        assert.ok(hit); const pending = f.vaultState().pending;
        assert.equal(pending.before, before); assert.equal(pending.operation.kind, `archive-${kind}`);
        assert.equal(f.calls.filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, 0);
        pendingUnapplied(f, before, pending);
        unchanged(f, () => f.store.recover(f.rev(), guard), code);
        state.latest = {}; const start = f.calls.length;
        f.fresh().recover(f.rev(), guard);
        assert.equal(f.raw(f.modelFile), pending.after); assert.equal(f.store.hasPending(), false);
        assert.equal(f.calls.slice(start).filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, 1);
        assert.equal(f.vaultState().history.length, 1); assert.equal(f.store.listArchives()[0].id, pending.archivesAfter[0].id);
        noStaging(f); noLeak(f);
      });
    }

    test(`automatic before-image ${kind} recovery rechecks ${name} changed during completed encryption`, t => {
      const f = fixture(t); const before = f.raw(f.modelFile);
      interrupt(f, () => archive(f)); const pending = f.vaultState().pending;
      const { state, guard } = runtimeGuard(); let hit = false; const start = f.calls.length;
      f.protection.state.sealHook = (_value, purpose) => {
        if (!hit && purpose === 'models') { hit = true; state.latest = latest; }
      };
      unchanged(f, () => f.fresh().recover(f.rev(), guard), code);
      assert.ok(hit); assert.equal(f.calls.slice(start).filter(e => e.op === 'renameSync').length, 0);
      pendingUnapplied(f, before, pending);
      f.protection.state.sealHook = undefined; state.latest = {};
      f.store.recover(f.rev(), guard);
      assert.equal(f.raw(f.modelFile), pending.after); assert.equal(f.store.hasPending(), false);
      assert.equal(f.vaultState().history.length, 1); assert.equal(f.store.listArchives()[0].id, pending.archivesAfter[0].id);
      noStaging(f); noLeak(f);
    });

    for (const barrier of ['index', 'models-staging']) {
      test(`automatic before-image ${kind} recovery rechecks ${name} after ${barrier} before models apply`, t => {
        const f = fixture(t); const before = f.raw(f.modelFile);
        interrupt(f, () => archive(f)); const pending = f.vaultState().pending;
        const { state, guard } = runtimeGuard(); let hit = false; const start = f.calls.length;
        f.state.fault = e => {
          const match = barrier === 'index'
            ? e.op === 'renameSync' && e.args[1] === f.file('retention-index.auto.json')
            : e.op === 'openSync' && String(e.args[0]).startsWith(f.root + '/.model-pick-store-');
          if (!hit && match) { hit = true; state.latest = latest; }
        };
        unchanged(f, () => f.store.recover(f.rev(), guard), code); f.state.fault = undefined;
        assert.ok(hit); assert.equal(f.calls.slice(start).filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, 0);
        pendingUnapplied(f, before, pending); state.latest = {};
        f.fresh().recover(f.rev(), guard);
        assert.equal(f.raw(f.modelFile), pending.after); assert.equal(f.store.hasPending(), false);
        assert.equal(f.vaultState().history.length, 1); noStaging(f); noLeak(f);
      });
    }
  }
}

test('automatic runtime guards fail closed with sanitized errors if their callback throws or returns no guard', t => {
  const f = fixture(t); const { guard } = runtimeGuard();
  for (const recheck of [() => { throw new Error(SECRET); }, () => { throw new f.loaded.StoreError(SECRET); }, () => undefined, () => null]) {
    unchanged(f, () => f.store.editProvider('custom', { name: 'Refused' }, f.rev(), { recheck }), 'IO_ERROR');
    noStaging(f);
  }
  const poisoned = () => { const error = new f.loaded.StoreError('CONFLICT'); error.message = SECRET; throw error; };
  unchanged(f, () => f.store.editProvider('custom', { name: 'Refused' }, f.rev(), { recheck: poisoned }), 'IO_ERROR');
  const initialSeals = f.protection.state.seals;
  guard.recheck = () => {
    if (f.protection.state.seals > initialSeals) throw new Error(SECRET);
    return {};
  };
  unchanged(f, () => f.store.archiveProvider('custom', f.rev(), guard), 'IO_ERROR');
  assert.equal(f.store.hasPending(), false); noStaging(f);
  interrupt(f); const before = f.raw(f.modelFile); const pending = f.vaultState().pending;
  const recoverySeals = f.protection.state.seals;
  guard.recheck = () => {
    if (f.protection.state.seals > recoverySeals) throw new Error(SECRET);
    return {};
  };
  unchanged(f, () => f.store.recover(f.rev(), guard), 'IO_ERROR'); pendingUnapplied(f, before, pending);
  guard.recheck = () => ({}); f.store.recover(f.rev(), guard);
  assert.equal(f.raw(f.modelFile), pending.after); assert.equal(f.store.hasPending(), false);
});

test('automatic runtime guard callback exceptions at final models barrier retain a recoverable before image', t => {
  const f = fixture(t); const before = f.raw(f.modelFile); let throwNow = false; let hit = false;
  const guard = { recheck: () => { if (throwNow) throw new Error(SECRET); return {}; } };
  f.state.fault = e => {
    if (!hit && e.op === 'openSync' && String(e.args[0]).startsWith(f.root + '/.model-pick-store-')) { hit = true; throwNow = true; }
  };
  storeCode(() => f.store.archiveModel('custom', 'm', f.rev(), guard), 'IO_ERROR'); f.state.fault = undefined;
  assert.ok(hit); const pending = f.vaultState().pending; pendingUnapplied(f, before, pending);
  throwNow = false; hit = false;
  f.state.fault = e => {
    if (!hit && e.op === 'openSync' && String(e.args[0]).startsWith(f.root + '/.model-pick-store-')) { hit = true; throwNow = true; }
  };
  unchanged(f, () => f.fresh().recover(f.rev(), guard), 'IO_ERROR'); f.state.fault = undefined;
  assert.ok(hit); pendingUnapplied(f, before, pending); throwNow = false;
  f.fresh().recover(f.rev(), guard); assert.equal(f.raw(f.modelFile), pending.after); assert.equal(f.store.hasPending(), false);
});

for (const name of ['add-provider', 'add-provider-with-models', 'edit-provider', 'put-model', 'put-models', 'restore-provider', 'restore-model']) {
  test(`automatic ${name} rechecks busy during sealing, without applying archive-only restrictions`, t => {
    const f = fixture(t); let archiveId;
    if (name.startsWith('restore-')) {
      if (name === 'restore-provider') f.store.archiveProvider('custom', f.rev());
      else f.store.archiveModel('custom', 'm', f.rev());
      archiveId = f.store.listArchives()[0].id;
    }
    const { state, guard } = runtimeGuard(); let hit = false;
    const run = () => {
      if (name === 'add-provider') f.store.addProvider({ ...P, id: 'new' }, f.rev(), guard);
      else if (name === 'add-provider-with-models') f.store.addProviderWithModels({ ...P, id: 'new' }, [model('new')], f.rev(), guard);
      else if (name === 'edit-provider') f.store.editProvider('custom', { name: 'Edited' }, f.rev(), guard);
      else if (name === 'put-model') f.store.putModel('custom', model('m'), 'edit', f.rev(), guard);
      else if (name === 'put-models') f.store.putModels('custom', [model('new')], f.rev(), guard);
      else f.store.restore(archiveId, f.rev(), guard);
    };
    f.protection.state.sealHook = (_value, purpose) => { if (purpose === 'models') { hit = true; state.latest = { busy: true }; } };
    unchanged(f, run, 'BUSY'); assert.ok(hit); noStaging(f);
    f.protection.state.sealHook = undefined;
    state.latest = { defaultUnknown: true, current: { provider: 'custom', id: 'm' }, default: { provider: 'custom', id: 'm' } };
    run(); assert.equal(f.store.hasPending(), false);
    const serialized = JSON.stringify(f.vaultState());
    assert.ok(!serialized.includes('recheck')); assert.ok(!serialized.includes('defaultUnknown')); assert.ok(!serialized.includes('busy'));
    noStaging(f); noLeak(f);
  });
}

test('automatic non-archive before-image recovery also rechecks busy after encryption and before applying models', t => {
  const f = fixture(t); const before = f.raw(f.modelFile);
  interrupt(f, () => f.store.putModels('custom', [model('new')], f.rev())); const pending = f.vaultState().pending;
  const { state, guard } = runtimeGuard(); let hit = false;
  f.protection.state.sealHook = (_value, purpose) => { if (purpose === 'models') { hit = true; state.latest = { busy: true }; } };
  unchanged(f, () => f.store.recover(f.rev(), guard), 'BUSY'); assert.ok(hit);
  assert.equal(f.raw(f.modelFile), before); assert.deepEqual(f.vaultState().pending, pending); noStaging(f);
  f.protection.state.sealHook = undefined; state.latest = {}; hit = false;
  f.state.fault = e => {
    if (!hit && e.op === 'openSync' && String(e.args[0]).startsWith(f.root + '/.model-pick-store-')) { hit = true; state.latest = { busy: true }; }
  };
  unchanged(f, () => f.store.recover(f.rev(), guard), 'BUSY'); f.state.fault = undefined;
  assert.ok(hit); assert.equal(f.raw(f.modelFile), before); assert.deepEqual(f.vaultState().pending, pending);
  state.latest = { defaultUnknown: true }; f.store.recover(f.rev(), guard);
  assert.equal(f.raw(f.modelFile), pending.after); assert.equal(f.store.hasPending(), false); noStaging(f); noLeak(f);
});

test('automatic after-image recovery enforces fresh busy but does not pretend archive guards can undo applied models', t => {
  const f = fixture(t); let vaultRenames = 0;
  f.state.fault = e => { if (e.op === 'renameSync' && e.args[1] === f.file('vault.auto.json') && ++vaultRenames === 2) throw new Error(SECRET); };
  storeCode(() => f.store.archiveProvider('custom', f.rev()), 'IO_ERROR'); f.state.fault = undefined;
  const pending = f.vaultState().pending; assert.equal(f.raw(f.modelFile), pending.after);
  const { state, guard } = runtimeGuard(); let hit = false;
  f.protection.state.sealHook = (_value, purpose) => { if (purpose === 'models') { hit = true; state.latest = { busy: true }; } };
  unchanged(f, () => f.store.recover(f.rev(), guard), 'BUSY'); assert.ok(hit);
  f.protection.state.sealHook = undefined;
  state.latest = { defaultUnknown: true, current: { provider: 'custom', id: 'm' }, default: { provider: 'custom', id: 'm' } };
  const start = f.calls.length; f.fresh().recover(f.rev(), guard);
  assert.equal(f.calls.slice(start).filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, 0);
  assert.equal(f.raw(f.modelFile), pending.after); assert.equal(f.store.hasPending(), false);
  assert.equal(f.store.listArchives()[0].id, pending.archivesAfter[0].id); noStaging(f); noLeak(f);
});

test('automatic busy rechecks cover metadata commits even after models have already applied', t => {
  const f = fixture(t); const { state, guard } = runtimeGuard(); let hit = false;
  f.state.fault = e => {
    if (!hit && e.op === 'renameSync' && e.args[1] === f.modelFile) { hit = true; state.latest = { busy: true }; }
  };
  storeCode(() => f.store.archiveProvider('custom', f.rev(), guard), 'BUSY'); f.state.fault = undefined;
  assert.ok(hit); const pending = f.vaultState().pending; assert.equal(f.raw(f.modelFile), pending.after);
  const start = f.calls.length; unchanged(f, () => f.store.recover(f.rev(), guard), 'BUSY');
  assert.equal(f.calls.slice(start).filter(e => e.op === 'renameSync').length, 0);
  state.latest = {}; hit = false;
  f.state.fault = e => {
    if (!hit && e.op === 'renameSync' && e.args[1] === f.file('retention-index.auto.json')) { hit = true; state.latest = { busy: true }; }
  };
  unchanged(f, () => f.store.recover(f.rev(), guard), 'BUSY'); f.state.fault = undefined;
  assert.ok(hit); assert.deepEqual(f.vaultState().pending, pending); noStaging(f);
  state.latest = {}; f.store.recover(f.rev(), guard); assert.equal(f.store.hasPending(), false);
  assert.equal(f.raw(f.modelFile), pending.after); noStaging(f); noLeak(f);
});

test('automatic callers without recheck retain their supplied snapshot contract and never read hidden settings', t => {
  const f = fixture(t); const supplied = { default: { provider: 'other', id: 'safe' } }; let latest = supplied;
  f.protection.state.sealHook = () => { latest = { default: { provider: 'custom', id: 'm' } }; };
  f.store.archiveModel('custom', 'm', f.rev(), supplied);
  assert.equal(latest.default.provider, 'custom'); assert.equal(f.store.hasPending(), false);
  assert.equal(JSON.parse(f.raw(f.modelFile)).providers.custom.models.length, 0);
  assert.equal(f.vaultState().history[0].operation.kind, 'archive-model'); noStaging(f); noLeak(f);
});

for (const stage of ['models', 'index-before', 'index-after', 'finish']) {
  test(`automatic recovery at ${stage} keeps authenticated mirrors, index and archive identity`, t => {
    const f = fixture(t); const before = f.raw(f.modelFile); const counts = new Map(); let hit = false;
    f.state.fault = e => {
      if (e.op !== 'renameSync') return;
      const target = e.args[1]; const count = (counts.get(target) ?? 0) + 1; counts.set(target, count);
      const match = stage === 'models' ? target === f.modelFile
        : stage === 'index-before' ? target === f.file('retention-index.auto.json') && count === 1
        : stage === 'index-after' ? target === f.file('retention-index.auto.json') && count === 2
        : target === f.file('vault.auto.json') && count === 2;
      if (!hit && match) { hit = true; throw new Error(SECRET); }
    };
    storeCode(() => f.store.archiveProvider('custom', f.rev()), 'IO_ERROR'); f.state.fault = undefined; assert.ok(hit);
    const pending = f.vaultState().pending; assert.equal(pending.before, before); assert.ok(pending.after);
    assert.equal(f.fresh().hasPending(), true); unchanged(f, () => f.store.editProvider('custom', { name: 'X' }, f.rev()), 'PENDING');
    if (stage === 'models' || stage === 'index-before') unchanged(f, () => f.store.recover(f.rev(), { defaultUnknown: true }), 'DEFAULT_UNKNOWN');
    const start = f.calls.length; const fresh = f.fresh(); fresh.recover(fresh.snapshot().revision);
    assert.equal(f.calls.slice(start).filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, stage === 'models' || stage === 'index-before' ? 1 : 0);
    assert.equal(f.raw(f.modelFile), pending.after); assert.equal(f.store.hasPending(), false);
    assert.equal(f.store.listArchives()[0].id, pending.archivesAfter[0].id); noLeak(f);
  });
}

test('automatic first add recovers from no models file; history remains bounded without pruning archives', t => {
  const f = fixture(t, null);
  interrupt(f, () => f.store.addProviderWithModels(P, [model('m')], f.rev()));
  assert.equal(f.raw(f.modelFile), null); assert.equal(f.vaultState().pending.before, null);
  f.fresh().recover(f.rev()); f.store.archiveModel('custom', 'm', f.rev()); const a = f.store.listArchives()[0];
  for (let i = 0; i < 22; i++) f.store.editProvider('custom', { name: `Custom ${i}` }, f.rev());
  assert.equal(f.vaultState().history.length, 20); assert.equal(f.vaultState().archives[0].id, a.id);
  assert.equal(JSON.parse(f.vaultState().history[0].after).providers.custom.name, 'Custom 2');
});

test('completed legacy stores coexist untouched; retained union protects both archive sets', t => {
  const f = fixture(t); const legacy = new f.loaded.PickerStore(f.root); legacy.unlock(PASS);
  legacy.archiveProvider('custom', legacy.snapshot().revision);
  const oldRecords = new f.loaded.PickerRecords(f.root); oldRecords.append(report(), PASS);
  const old = Object.fromEntries(['vault.json', 'retention-index.json', 'records.json'].map(name => [name, f.raw(f.file(name))]));
  const configBefore = f.raw(f.modelFile);
  assert.equal(f.store.hasLegacyData(), true); assert.equal(f.records.hasLegacyData(), true);
  assert.equal(f.store.hasVault(), false); assert.equal(f.records.hasData(), false); assert.equal(f.store.hasPending(), false);
  assert.deepEqual(f.store.retained(), { providers: ['custom'], models: ['custom/m'] });
  f.records.append(report()); assert.equal(f.records.tests().length, 1); assert.equal(f.raw(f.modelFile), configBefore);
  f.store.addProviderWithModels({ ...P, id: 'auto' }, [model('new')], f.rev()); f.store.archiveProvider('auto', f.rev());
  const union = { providers: ['auto', 'custom'], models: ['auto/new', 'custom/m'] };
  assert.deepEqual(f.store.retained(), union); legacy.lock(); assert.deepEqual(legacy.retained(), union);
  legacy.unlock(PASS); assert.deepEqual(legacy.retained(), union); // Authenticated own archives + foreign advisory union.
  for (const [name, bytes] of Object.entries(old)) assert.equal(f.raw(f.file(name)), bytes);
  noLeak(f);
});

test('retained uses authenticated own state but strictly refuses missing/malformed foreign indexes', t => {
  const f = fixture(t); f.store.archiveProvider('custom', f.rev());
  fs.writeFileSync(f.file('retention-index.auto.json'), encode({ providers: [], models: [] }), { mode: 0o600 });
  assert.deepEqual(f.store.retained(), { providers: ['custom'], models: ['custom/m'] });
  const oldVault = encode({ version: 1, pending: false, sealed: f.loaded.vault.sealJson({ version: 1, archives: [], history: [], pending: null }, PASS) });
  fs.writeFileSync(f.file('vault.json'), oldVault, { mode: 0o600 });
  storeCode(() => f.store.retained(), 'INVALID_INDEX');
  for (const index of ['{', encode({ providers: ['old'], models: [], extra: SECRET }), encode({ providers: ['../bad'], models: [] }), encode({ providers: [], models: ['bad'] })]) {
    fs.writeFileSync(f.file('retention-index.json'), index, { mode: 0o600 });
    storeCode(() => f.store.retained(), 'INVALID_INDEX');
    unchanged(f, () => f.store.addProvider({ ...P, id: 'new' }, f.rev()), 'INVALID_INDEX');
  }
  fs.writeFileSync(f.file('retention-index.json'), encode({ providers: ['old'], models: ['old/archived'] }), { mode: 0o600 });
  assert.deepEqual(f.store.retained(), { providers: ['custom', 'old'], models: ['custom/m', 'old/archived'] });
});

test('own orphan auto index fails closed and never confuses a legacy index with auto state', t => {
  const f = fixture(t); fs.mkdirSync(f.dataDir, { mode: 0o700 });
  fs.writeFileSync(f.file('retention-index.auto.json'), encode({ providers: ['lost'], models: ['lost/m'] }), { mode: 0o600 });
  assert.equal(f.store.hasVault(), false);
  unchanged(f, () => f.store.editProvider('custom', { name: 'X' }, f.rev()), 'INVALID_VAULT');
  storeCode(() => f.store.retained(), 'INVALID_VAULT');
  fs.unlinkSync(f.file('retention-index.auto.json'));
  fs.writeFileSync(f.file('retention-index.json'), encode({ providers: ['old'], models: [] }), { mode: 0o600 });
  unchanged(f, () => f.store.editProvider('custom', { name: 'X' }, f.rev()), 'INVALID_INDEX');
});

test('unfinished legacy journal blocks both auto mutation and auto recovery without decrypting or altering old bytes', t => {
  const f = fixture(t); const legacy = new f.loaded.PickerStore(f.root); legacy.unlock(PASS);
  interrupt(f, () => legacy.archiveProvider('custom', legacy.snapshot().revision));
  assert.equal(f.store.hasPending(), true); assert.equal(f.store.hasVault(), false);
  const opens = f.protection.state.opens;
  unchanged(f, () => f.store.addProvider({ ...P, id: 'new' }, f.rev()), 'LEGACY_PENDING');
  unchanged(f, () => f.store.recover(f.rev()), 'LEGACY_PENDING');
  assert.equal(f.protection.state.opens, opens);
  // Separately invoked explicit legacy recovery still functions; auto never does it.
  legacy.recover(legacy.snapshot().revision); assert.equal(f.store.hasPending(), false);
  f.store.addProvider({ ...P, id: 'new' }, f.rev());
});

test('legacy writer also detects unfinished automatic state and cannot overwrite its models mirror', t => {
  const f = fixture(t); interrupt(f);
  const legacy = new f.loaded.PickerStore(f.root); legacy.unlock(PASS); assert.equal(legacy.hasPending(), true);
  unchanged(f, () => legacy.addProvider({ ...P, id: 'new' }, legacy.snapshot().revision), 'PENDING');
  unchanged(f, () => legacy.recover(legacy.snapshot().revision), 'PENDING');
  f.store.recover(f.rev()); assert.equal(legacy.hasPending(), false);
});

test('store and records never fall back to password crypto or plaintext on protection failure', t => {
  const f = fixture(t); f.protection.state.failSeal = true;
  unchanged(f, () => f.store.archiveProvider('custom', f.rev()), 'IO_ERROR');
  unchanged(f, () => f.records.append(report()));
  assert.equal(f.store.isUnlocked(), true); assert.equal(f.records.isUnlocked(), true);
  assert.equal(f.store.hasVault(), false); assert.equal(f.records.hasData(), false);
  f.protection.state.failSeal = false; f.store.editProvider('custom', { name: 'Saved' }, f.rev()); f.records.append(report());
  f.protection.state.failOpen = true;
  unchanged(f, () => f.store.archiveProvider('custom', f.rev()), 'INVALID_VAULT');
  unchanged(f, () => f.records.append(report())); recordError(() => f.records.tests());
  assert.ok(!fs.existsSync(f.file('vault.json'))); assert.ok(!fs.existsSync(f.file('records.json'))); noLeak(f);
});

test('tampering and purpose substitution cannot open automatic stores or replace their data', t => {
  const f = fixture(t); f.store.editProvider('custom', { name: 'Saved' }, f.rev()); f.records.append(report());
  const vault = JSON.parse(f.raw(f.file('vault.auto.json'))); const records = JSON.parse(f.raw(f.file('records.auto.json')));
  const goodVault = encode(vault); const goodRecords = encode(records);
  for (const change of [v => { v.sealed.data = (v.sealed.data[0] === 'A' ? 'B' : 'A') + v.sealed.data.slice(1); }, v => { v.sealed = records.sealed; }, v => { v.pending = true; }, v => { v.version = 1; }]) {
    const value = JSON.parse(goodVault); change(value); fs.writeFileSync(f.file('vault.auto.json'), encode(value), { mode: 0o600 });
    unchanged(f, () => f.store.archiveProvider('custom', f.rev()), 'INVALID_VAULT');
  }
  fs.writeFileSync(f.file('vault.auto.json'), goodVault, { mode: 0o600 });
  for (const sealed of [vault.sealed, { ...records.sealed, tag: Buffer.alloc(16).toString('base64') }]) {
    fs.writeFileSync(f.file('records.auto.json'), encode({ version: 2, sealed }), { mode: 0o600 });
    unchanged(f, () => f.records.append(report())); recordError(() => f.records.tests());
  }
  fs.writeFileSync(f.file('records.auto.json'), goodRecords, { mode: 0o600 });
  assert.equal(f.records.tests().length, 1); noLeak(f);
});

test('authenticated but invalid automatic payload schema is rejected before application', t => {
  const f = fixture(t); f.store.editProvider('custom', { name: 'Saved' }, f.rev());
  const good = f.vaultState();
  for (const corrupt of [v => { v.extra = SECRET; }, v => { v.history[0].beforeRevision = 'forged'; }, v => { v.history[0].operation.kind = 'arbitrary'; }, v => { v.archives = [{}]; }]) {
    const value = structuredClone(good); corrupt(value); f.writeVault(value);
    unchanged(f, () => f.store.archiveProvider('custom', f.rev()), 'INVALID_VAULT');
  }
  for (const value of [
    { version: 1, kind: 'model-pick-records', events: [null] },
    { version: 1, kind: 'model-pick-records', events: [{ kind: 'probe', report: {} }] },
    { version: 1, kind: 'model-pick-records', events: [report()], extra: SECRET },
    { version: 2, kind: 'model-pick-records', events: [] },
  ]) {
    fs.writeFileSync(f.file('records.auto.json'), encode({ version: 2, sealed: f.protection.seal(value, 'records') }), { mode: 0o600 });
    unchanged(f, () => f.records.append(report())); recordError(() => f.records.tests());
  }
});

test('automatic final-state capacity is preflighted independently of the protection backend', t => {
  const cfg = seed(); cfg.providers.custom.large = 'x'.repeat(1_450_000); const f = fixture(t, cfg);
  unchanged(f, () => f.store.archiveProvider('custom', f.rev()), 'IO_ERROR');
  assert.equal(f.protection.state.seals, 0); assert.equal(f.store.hasPending(), false);
  const tooLarge = { ...resolution('m'), fields: { value: 'x'.repeat(4 * 1024 * 1024) } };
  unchanged(f, () => f.records.append(tooLarge)); assert.equal(f.records.hasData(), false);
});

test('shared writer locks, stale revisions and external changes are never silently overwritten', t => {
  const f = fixture(t); f.store.editProvider('custom', { name: 'Saved' }, f.rev()); f.records.append(report());
  for (const [filename, run, code] of [
    ['store.lock', () => f.store.archiveProvider('custom', f.rev()), 'CONFLICT'],
    ['records.lock', () => f.records.append(report()), undefined],
  ]) {
    fs.writeFileSync(f.file(filename), 'synthetic-other-writer', { mode: 0o600 }); unchanged(f, run, code); fs.unlinkSync(f.file(filename));
  }
  unchanged(f, () => f.store.archiveProvider('custom', 'stale'), 'CONFLICT');
  let changed = false; const external = encode({ ...seed(), external: true });
  f.state.fault = e => { if (!changed && e.op === 'openSync' && String(e.args[0]).startsWith(f.root + '/.model-pick-store-')) { changed = true; fs.writeFileSync(f.modelFile, external); } };
  storeCode(() => f.store.archiveProvider('custom', f.rev()), 'CONFLICT'); f.state.fault = undefined;
  assert.ok(changed); assert.equal(f.raw(f.modelFile), external); assert.equal(f.store.hasPending(), true);
  unchanged(f, () => f.store.recover(f.rev()), 'CONFLICT');
});

test('records source recheck preserves a concurrent external ledger and cleans only its own lock/temp', t => {
  const f = fixture(t); f.records.append(report());
  const external = encode({ version: 2, sealed: f.protection.seal({ version: 1, kind: 'model-pick-records', events: [resolution('external')] }, 'records') });
  let changed = false;
  f.state.fault = e => { if (!changed && e.op === 'writeFileSync' && String(e.args[0]).endsWith('.tmp')) { changed = true; fs.writeFileSync(f.file('records.auto.json'), external, { mode: 0o600 }); } };
  recordError(() => f.records.append(report())); f.state.fault = undefined;
  assert.ok(changed); assert.equal(f.raw(f.file('records.auto.json')), external);
  assert.ok(!fs.existsSync(f.file('records.lock'))); assert.ok(!fs.readdirSync(f.dataDir).some(n => n.endsWith('.tmp')));
});

test('automatic unsafe paths, broad permissions, hardlinks and missing agents fail closed', t => {
  const f = fixture(t); const missing = path.join(f.root, 'missing');
  const absent = new f.loaded.PickerStore(missing, [], f.protection);
  storeCode(() => absent.addProvider(P, absent.snapshot().revision), 'IO_ERROR');
  const absentRecords = new f.loaded.PickerRecords(missing, f.protection); recordError(() => absentRecords.append(report()));
  const target = path.join(f.root, 'target'); fs.mkdirSync(target, { mode: 0o700 }); fs.symlinkSync(target, f.dataDir);
  storeCode(() => f.store.hasVault(), 'UNSAFE_PATH'); recordError(() => f.records.hasData());
  fs.unlinkSync(f.dataDir); fs.mkdirSync(f.dataDir, { mode: 0o700 });
  const other = path.join(target, 'other.json'); fs.writeFileSync(other, '{}', { mode: 0o600 });
  for (const filename of ['vault.auto.json', 'retention-index.auto.json', 'vault.json', 'retention-index.json']) {
    fs.symlinkSync(other, f.file(filename)); storeCode(() => f.store.retained(), 'UNSAFE_PATH'); fs.unlinkSync(f.file(filename));
  }
  fs.symlinkSync(other, f.file('records.auto.json')); recordError(() => f.records.hasData()); fs.unlinkSync(f.file('records.auto.json'));
  f.store.editProvider('custom', { name: 'Saved' }, f.rev()); f.records.append(report());
  fs.chmodSync(f.file('vault.auto.json'), 0o644); storeCode(() => f.store.hasVault(), 'UNSAFE_PATH'); fs.chmodSync(f.file('vault.auto.json'), 0o600);
  fs.chmodSync(f.file('records.auto.json'), 0o644); recordError(() => f.records.hasData()); fs.chmodSync(f.file('records.auto.json'), 0o600);
  fs.linkSync(f.file('records.auto.json'), path.join(f.root, 'hardlink')); recordError(() => f.records.tests());
  fs.chmodSync(f.dataDir, 0o755); storeCode(() => f.store.hasVault(), 'UNSAFE_PATH'); recordError(() => f.records.hasData());
});

test('automatic record invalid batches/getters/proxies are rejected without executing hooks or replacing data', t => {
  const f = fixture(t); f.records.append(report()); let invoked = false;
  const trap = () => { invoked = true; throw new Error(SECRET); };
  const getter = { kind: 'probe', get report() { return trap(); } };
  for (const batch of [[], Array(101).fill(report()), [,], [getter], new Proxy([], { get: trap }), [report(), { toJSON: trap }], [report(), { kind: 'arbitrary' }]]) {
    unchanged(f, () => f.records.appendMany(batch));
  }
  assert.equal(invoked, false);
});

test('legacy empty/omitted passwords never create automatic/fixed-password substitutes', t => {
  const f = fixture(t); const legacy = new f.loaded.PickerStore(f.root); const ledger = new f.loaded.PickerRecords(f.root);
  storeCode(() => legacy.unlock(''), 'INVALID_INPUT'); storeCode(() => legacy.unlock(undefined), 'INVALID_INPUT');
  unchanged(f, () => legacy.editProvider('custom', { name: 'X' }, legacy.snapshot().revision), 'LOCKED');
  unchanged(f, () => ledger.append(report())); unchanged(f, () => ledger.append(report(), '')); recordError(() => ledger.tests());
  assert.equal(legacy.hasVault(), false); assert.equal(ledger.hasData(), false);
});
