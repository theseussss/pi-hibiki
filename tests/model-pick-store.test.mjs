import assert from 'node:assert/strict';
import { typescriptPath } from '../scripts/tooling.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Transpile only these local source modules, using the already-installed TS cache.
// Every store filesystem call below is checked against an isolated mkdtemp tree.
// No live models/auth/settings/session file, network, model, or install is used.
const require = createRequire(import.meta.url);
const ts = require(typescriptPath());
const sourceDir = fileURLToPath(new URL('../lib/model-pick/', import.meta.url));
const compiled = new Map();
const SECRET = 'SYNTHETIC-SECRET-never-display-81f79!';
const PASS = 'synthetic-store-passphrase';
const API = 'openai-responses';
const P = { id: 'custom', name: 'Custom', endpoint: 'https://synthetic.invalid/v1', api: API, envVar: 'SYNTHETIC_API_TOKEN' };
const M = { id: 'model/v1', name: 'A model', contextWindow: 8000, maxTokens: 2000, reasoning: true, input: ['text', 'image'] };
const normalize = value => JSON.parse(JSON.stringify(value));
const encode = value => `${JSON.stringify(value, null, 2)}\n`;

function load(fsImpl) {
  const modules = new Map();
  function source(name) {
    const filename = path.join(sourceDir, name);
    if (modules.has(filename)) return modules.get(filename).exports;
    let output = compiled.get(filename);
    if (!output) {
      output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
      }).outputText;
      compiled.set(filename, output);
    }
    const module = { exports: {} }; modules.set(filename, module);
    const localRequire = id => {
      if (id === 'node:fs') return fsImpl;
      if (id === 'node:path' || id === 'node:crypto' || id === 'node:util') return require(id);
      if (id === './vault.js') return source('vault.ts');
      throw new Error('Unexpected store dependency.');
    };
    vm.runInThisContext(`(function(exports,require,module,__filename,__dirname){\n${output}\n})`, { filename })(
      module.exports, localRequire, module, filename, sourceDir,
    );
    return module.exports;
  }
  return { ...source('store.ts'), vault: source('vault.ts') };
}

function fixture(t, value, protectedProviders = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-store-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelFile = path.join(root, 'models.json');
  const dataDir = path.join(root, 'model-pick-data');
  const vaultFile = path.join(dataDir, 'vault.json');
  const indexFile = path.join(dataDir, 'retention-index.json');
  const lockFile = path.join(dataDir, 'store.lock');
  if (value !== undefined) fs.writeFileSync(modelFile, typeof value === 'string' ? value : encode(value));
  const calls = []; const fds = new Map();
  const state = { fault: undefined };
  function check(p, write) {
    const abs = path.resolve(String(p));
    assert.ok(abs === root || abs.startsWith(`${root}${path.sep}`) || (!write && root.startsWith(`${abs === '/' ? '' : abs}/`)), 'Store accessed a non-synthetic path.');
    if (path.basename(abs) === 'auth.json' || path.basename(abs) === 'settings.json' || abs.includes('/sessions/')) {
      throw new Error('Forbidden credential/settings/session access.');
    }
  }
  const writing = new Set(['mkdirSync', 'unlinkSync', 'renameSync']);
  const fileCalls = new Set(['openSync', 'lstatSync', 'readdirSync', ...writing]);
  const fsImpl = new Proxy(fs, {
    get(target, op) {
      const value = target[op];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (fileCalls.has(op)) {
          const write = writing.has(op) || (op === 'openSync' && Boolean(args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)));
          check(args[0], write);
          if (op === 'renameSync') check(args[1], true);
        } else if (['readFileSync', 'writeFileSync', 'fstatSync', 'fchmodSync', 'fsyncSync', 'closeSync'].includes(op)) {
          assert.ok(typeof args[0] === 'number' && fds.has(args[0]), 'Store used an untracked descriptor.');
        } else throw new Error('Unexpected filesystem operation.');
        const event = { op, args, file: typeof args[0] === 'number' ? fds.get(args[0]) : args[0] };
        calls.push(event);
        state.fault?.(event);
        const result = value.apply(target, args);
        if (op === 'openSync') fds.set(result, args[0]);
        if (op === 'closeSync') fds.delete(args[0]);
        return result;
      };
    },
  });
  const loaded = load(fsImpl);
  const store = new loaded.PickerStore(root, protectedProviders);
  const config = () => JSON.parse(fs.readFileSync(modelFile, 'utf8'));
  const revision = () => store.snapshot().revision;
  const unlock = () => { store.unlock(PASS); return store; };
  const stateOfVault = () => loaded.vault.openJson(JSON.parse(fs.readFileSync(vaultFile, 'utf8')).sealed, PASS);
  const writeVaultState = value => fs.writeFileSync(vaultFile, encode({
    version: 1, pending: value.pending !== null, sealed: loaded.vault.sealJson(value, PASS),
  }), { mode: 0o600 });
  const addProvider = (p = P) => store.addProvider(p, revision());
  const addModel = (m = M) => store.putModel('custom', m, 'add', revision());
  return { root, modelFile, dataDir, vaultFile, indexFile, lockFile, store, config, revision, unlock,
    stateOfVault, writeVaultState, addProvider, addModel, state, calls, loaded };
}
function code(fn, expected, secret = SECRET) {
  assert.throws(fn, error => {
    assert.equal(error.name, 'StoreError'); assert.equal(error.code, expected);
    assert.ok(!String(error.stack).includes(secret));
    assert.ok(!String(error.message).includes(PASS));
    assert.equal(error.cause, undefined);
    return true;
  });
}
function seeded() {
  return { schemaNote: { keep: true }, providers: {
    custom: { name: 'Custom', baseUrl: P.endpoint, api: API, apiKey: SECRET,
      headers: { 'X-Secret': SECRET }, compat: { keep: ['unrecognized'] },
      models: [{ ...M, cost: { input: 7 }, compat: { unknown: true }, vendorSecret: SECRET }] },
    other: { baseUrl: 'http://other.invalid', api: 'unknown-api', apiKey: 'OTHER_ENV', models: [{ id: 'minimal' }], untouched: SECRET },
  } };
}
function interrupted(f, target) {
  let hit = false;
  f.state.fault = e => {
    if (!hit && e.op === 'renameSync' && e.args[1] === target) { hit = true; throw new Error(SECRET); }
  };
  code(() => f.store.archiveProvider('custom', f.revision()), 'IO_ERROR');
  f.state.fault = undefined;
  assert.ok(hit); assert.equal(f.store.hasPending(), true);
  return f.stateOfVault().pending;
}

test('empty snapshots, locked inspection, and unlocking never create files', t => {
  const f = fixture(t);
  const snapshot = f.store.snapshot();
  assert.match(snapshot.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(normalize(snapshot.providers), []);
  assert.equal(f.store.hasVault(), false); assert.equal(f.store.hasPending(), false);
  assert.deepEqual(normalize(f.store.retained()), { providers: [], models: [] });
  code(() => f.store.addProvider(P, snapshot.revision), 'LOCKED');
  f.unlock(); assert.equal(f.store.isUnlocked(), true);
  assert.deepEqual(fs.readdirSync(f.root), []);
  f.store.lock(); assert.equal(f.store.isUnlocked(), false);
  code(() => f.store.listArchives(), 'LOCKED');
});

test('real filesystem add-provider/add-model roundtrip creates private encrypted backups', t => {
  const f = fixture(t); f.unlock(); f.addProvider(); f.addModel();
  const cfg = f.config();
  assert.equal(cfg.providers.custom.baseUrl, P.endpoint);
  assert.equal(cfg.providers.custom.apiKey, `$${P.envVar}`);
  assert.deepEqual(cfg.providers.custom.models[0], M);
  assert.deepEqual(normalize(f.store.snapshot().providers[0]), {
    id: P.id, name: P.name, endpoint: P.endpoint, api: API, credentialState: 'reference', models: [M],
  });
  for (const file of [f.modelFile, f.vaultFile, f.indexFile]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.dataDir).mode & 0o777, 0o700);
  assert.equal(f.store.hasVault(), true); assert.equal(f.store.hasPending(), false);
  const state = f.stateOfVault();
  assert.equal(state.history.length, 2); assert.equal(state.history[0].before, null);
  assert.equal(state.history[1].after, fs.readFileSync(f.modelFile, 'utf8'));
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['model-pick-data', 'models.json']);
  assert.deepEqual(fs.readdirSync(f.dataDir).sort(), ['retention-index.json', 'vault.json']);
  f.store.lock(); f.store.unlock(PASS);
  assert.equal(f.store.snapshot().providers[0].models[0].id, M.id);
});

test('snapshot is a strict whitelist and strips legacy URL credentials, query and hash', t => {
  const input = seeded();
  input.providers.custom.baseUrl = `https://user:${SECRET}@synthetic.invalid/v1?token=${SECRET}#${SECRET}`;
  const f = fixture(t, input);
  const snap = f.store.snapshot();
  const raw = JSON.stringify(snap);
  assert.ok(!raw.includes(SECRET)); assert.ok(!raw.includes('apiKey')); assert.ok(!raw.includes('headers'));
  assert.equal(snap.providers[0].endpoint, 'https://synthetic.invalid/v1');
  assert.equal(snap.providers[0].credentialState, 'configured');
  assert.equal(snap.providers[1].credentialState, 'configured');
  assert.equal(snap.providers[1].api, '');
  assert.deepEqual(normalize(snap.providers[1].models), [{ id: 'minimal' }]);
  assert.equal(fs.existsSync(f.dataDir), false);
  snap.providers[0].models[0].input.push('other');
  assert.deepEqual(f.store.snapshot().providers[0].models[0].input, ['text', 'image']);
});

test('credential states follow Pi reference syntax, never guess references from bare variable-shaped literals', t => {
  const cases = [
    ['$SYNTHETIC_NAME', 'reference'], ['${SYNTHETIC_NAME}', 'reference'], ['!synthetic-command never-run', 'reference'],
    ['BARE_SYNTHETIC_NAME', 'configured'], [SECRET, 'configured'], ['!   ', 'configured'], ['$9BAD', 'configured'],
    ['${BAD-NAME}', 'configured'], ['', 'missing'],
  ];
  const f = fixture(t, { providers: Object.fromEntries(cases.map(([apiKey], index) => [
    `p${index}`, { baseUrl: P.endpoint, api: API, apiKey, models: [] },
  ])) });
  assert.deepEqual(f.store.snapshot().providers.map(p => p.credentialState), cases.map(([, expected]) => expected));
  assert.equal(fs.existsSync(f.dataDir), false);
  f.unlock();
  f.store.editProvider('p0', { envVar: 'REPLACEMENT_SYNTHETIC_ENV' }, f.revision());
  assert.equal(f.config().providers.p0.apiKey, '$REPLACEMENT_SYNTHETIC_ENV');
  assert.equal(f.config().providers.p1.apiKey, '${SYNTHETIC_NAME}');
  assert.equal(f.config().providers.p2.apiKey, '!synthetic-command never-run');
});

test('editing keeps unknown fields, all other providers and advanced model fields; blank env is no-op', t => {
  const original = seeded(); const f = fixture(t, original); f.unlock();
  f.store.editProvider('custom', { name: 'Renamed', envVar: '' }, f.revision());
  f.store.putModel('custom', { ...M, name: 'New name', maxTokens: 1000 }, 'edit', f.revision());
  const cfg = f.config();
  assert.deepEqual(cfg.schemaNote, original.schemaNote);
  assert.deepEqual(cfg.providers.other, original.providers.other);
  assert.deepEqual(cfg.providers.custom.compat, original.providers.custom.compat);
  assert.equal(cfg.providers.custom.apiKey, SECRET);
  assert.deepEqual(cfg.providers.custom.headers, original.providers.custom.headers);
  assert.deepEqual(cfg.providers.custom.models[0].compat, { unknown: true });
  assert.equal(cfg.providers.custom.models[0].vendorSecret, SECRET);
  assert.equal(cfg.providers.custom.models[0].cost.input, 7);
  const before = f.stateOfVault().history[0].before;
  assert.deepEqual(JSON.parse(before), original);
  assert.ok(!fs.readFileSync(f.vaultFile, 'utf8').includes(SECRET));
  assert.ok(!fs.readFileSync(f.indexFile, 'utf8').includes(SECRET));
  assert.ok(!JSON.stringify(f.store.snapshot()).includes(SECRET));
  f.store.editProvider('custom', { endpoint: 'https://new.invalid/v2', api: 'anthropic-messages', envVar: 'NEW_SYNTHETIC_ENV' }, f.revision());
  assert.equal(f.config().providers.custom.apiKey, '$NEW_SYNTHETIC_ENV');
});

test('provider archive retains full encrypted object and safe locked retention; restore marks rather than deletes', t => {
  const original = seeded(); const f = fixture(t, original); f.unlock();
  f.store.archiveProvider('custom', f.revision());
  assert.equal(f.config().providers.custom, undefined);
  const [a] = f.store.listArchives();
  assert.deepEqual(Object.keys(a).sort(), ['createdAt', 'id', 'kind', 'provider']);
  assert.equal(a.kind, 'provider');
  const disk = fs.readFileSync(f.vaultFile, 'utf8');
  assert.ok(!disk.includes(SECRET)); assert.ok(!disk.includes(P.endpoint));
  const state = f.stateOfVault(); assert.deepEqual(state.archives[0].payload, original.providers.custom);
  const expected = { providers: ['custom'], models: [`custom/${M.id}`] };
  assert.deepEqual(normalize(f.store.retained()), expected);
  f.store.lock(); assert.deepEqual(normalize(f.store.retained()), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.indexFile, 'utf8')), expected);
  f.store.unlock(PASS); f.store.restore(a.id, f.revision());
  assert.deepEqual(f.config(), original);
  assert.equal(f.store.listArchives().length, 0);
  assert.ok(f.stateOfVault().archives[0].restoredAt > 0);
  assert.deepEqual(normalize(f.store.retained()), expected);
  code(() => f.store.restore(a.id, f.revision()), 'NOT_FOUND');
});

test('provider restore never overwrites collisions and explicit new ID restores all fields', t => {
  const original = seeded(); const f = fixture(t, original, ['builtin']); f.unlock();
  f.store.archiveProvider('custom', f.revision()); const a = f.store.listArchives()[0];
  f.addProvider(); const before = fs.readFileSync(f.modelFile, 'utf8');
  code(() => f.store.restore(a.id, f.revision()), 'EXISTS');
  code(() => f.store.restore(a.id, f.revision(), undefined, 'builtin'), 'PROTECTED');
  code(() => f.store.restore(a.id, f.revision(), undefined, '__proto__'), 'INVALID_INPUT');
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), before);
  f.store.restore(a.id, f.revision(), undefined, 'restored-copy');
  assert.deepEqual(f.config().providers['restored-copy'], original.providers.custom);
  assert.equal(f.config().providers.custom.apiKey, `$${P.envVar}`);
});

test('model archive preserves advanced fields and checks endpoint/API binding and same-ID collision on restore', t => {
  const original = seeded(); const f = fixture(t, original); f.unlock();
  f.store.archiveModel('custom', M.id, f.revision()); const a = f.store.listArchives()[0];
  assert.equal(a.kind, 'model'); assert.equal(a.modelId, M.id);
  assert.equal(f.config().providers.custom.models.length, 0);
  f.store.editProvider('custom', { endpoint: 'https://changed.invalid' }, f.revision());
  code(() => f.store.restore(a.id, f.revision()), 'CONFLICT');
  f.store.editProvider('custom', { endpoint: P.endpoint, api: 'openai-completions' }, f.revision());
  code(() => f.store.restore(a.id, f.revision()), 'CONFLICT');
  f.store.editProvider('custom', { api: API }, f.revision());
  f.addModel(); code(() => f.store.restore(a.id, f.revision()), 'EXISTS');
  f.store.archiveModel('custom', M.id, f.revision());
  code(() => f.store.restore(a.id, f.revision(), undefined, 'renamed'), 'INVALID_INPUT');
  f.store.restore(a.id, f.revision());
  assert.deepEqual(f.config().providers.custom.models[0], original.providers.custom.models[0]);
  assert.equal(f.store.listArchives().length, 1);
});

test('restoring a model requires its original provider to remain active', t => {
  const f = fixture(t, seeded()); f.unlock();
  f.store.archiveModel('custom', M.id, f.revision()); const a = f.store.listArchives()[0];
  f.store.archiveProvider('custom', f.revision());
  code(() => f.store.restore(a.id, f.revision()), 'NOT_FOUND');
});

test('add/edit modes and provider uniqueness never silently overwrite', t => {
  const f = fixture(t, seeded()); f.unlock();
  code(() => f.addProvider(), 'EXISTS');
  code(() => f.addModel(), 'EXISTS');
  code(() => f.store.putModel('custom', { ...M, id: 'new' }, 'edit', f.revision()), 'NOT_FOUND');
  code(() => f.store.editProvider('absent', { name: 'X' }, f.revision()), 'NOT_FOUND');
  code(() => f.store.archiveModel('custom', 'absent', f.revision()), 'NOT_FOUND');
  assert.equal(f.store.hasVault(), false);
});

test('all four protocols are supported, no credentials are resolved, and malformed input fails without artifacts', t => {
  const f = fixture(t); f.unlock();
  const rev = f.revision();
  for (const endpoint of ['http://host.invalid', 'https://user@host.invalid', 'https://host.invalid?x=1', 'https://host.invalid?', 'https://host.invalid#x', 'https://host.invalid#', 'https://host.invalid\\x', 'not a URL']) {
    code(() => f.store.addProvider({ ...P, endpoint }, rev), 'INVALID_INPUT');
  }
  for (const envVar of [SECRET, '!read-secret', '$API_KEY', 'bad name', '9TOKEN', 'X\nY']) code(() => f.store.addProvider({ ...P, envVar }, rev), 'INVALID_INPUT');
  for (const id of ['__proto__', 'constructor', 'prototype', '../bad', '\x1b[31m', 'x'.repeat(129)]) code(() => f.store.addProvider({ ...P, id }, rev), 'INVALID_INPUT');
  code(() => f.store.addProvider({ ...P, api: 'unsupported' }, rev), 'INVALID_INPUT');
  code(() => f.store.addProvider({ ...P, name: 'bad\x1b[0m' }, rev), 'INVALID_INPUT');
  assert.equal(f.store.hasVault(), false); assert.equal(fs.existsSync(f.modelFile), false);
  for (const [i, api] of ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].entries()) {
    f.addProvider({ ...P, id: `p${i}`, api, envVar: undefined });
  }
  assert.ok(f.store.snapshot().providers.every(p => p.credentialState === 'missing'));
});

test('putModel validates bounded text, integer specs, capabilities and maxTokens <= context', t => {
  const f = fixture(t, seeded()); f.unlock(); const before = fs.readFileSync(f.modelFile, 'utf8');
  for (const change of [
    { contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: 2.5 }, { contextWindow: Number.MAX_SAFE_INTEGER + 1 },
    { maxTokens: 0 }, { maxTokens: 9000 }, { reasoning: undefined }, { input: [] }, { input: ['audio'] },
    { input: ['text', 'text'] }, { id: 'bad\x1b[0m' }, { id: 'bad\nID' }, { id: 'x'.repeat(513) },
    { name: 'x'.repeat(257) }, { name: 'bad\u009b' }, { name: 'bad\u202e' },
  ]) code(() => f.store.putModel('custom', { ...M, ...change }, 'edit', f.revision()), 'INVALID_INPUT');
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), before);
  assert.equal(f.store.hasVault(), false);
});

test('current/default model and provider guards refuse archive without implicit switching', t => {
  const f = fixture(t, seeded()); f.unlock(); const before = fs.readFileSync(f.modelFile, 'utf8');
  const current = { current: { provider: 'custom', id: M.id } };
  const defaults = { default: { provider: 'custom', id: M.id } };
  code(() => f.store.archiveProvider('custom', f.revision(), current), 'CURRENT_MODEL');
  code(() => f.store.archiveModel('custom', M.id, f.revision(), current), 'CURRENT_MODEL');
  code(() => f.store.archiveProvider('custom', f.revision(), defaults), 'DEFAULT_MODEL');
  code(() => f.store.archiveModel('custom', M.id, f.revision(), defaults), 'DEFAULT_MODEL');
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), before);
  f.store.archiveModel('custom', M.id, f.revision(), { current: { provider: 'other', id: M.id } });
  assert.equal(f.store.listArchives().length, 1);
});

test('busy and locked guards cover every mutating entry point including recovery', t => {
  const f = fixture(t, seeded()); f.unlock();
  const attempts = [
    (g) => f.store.addProvider({ ...P, id: 'new' }, f.revision(), g),
    (g) => f.store.editProvider('custom', { name: 'X' }, f.revision(), g),
    (g) => f.store.putModel('custom', M, 'edit', f.revision(), g),
    (g) => f.store.archiveProvider('custom', f.revision(), g),
    (g) => f.store.archiveModel('custom', M.id, f.revision(), g),
    (g) => f.store.restore('not-present', f.revision(), g),
    (g) => f.store.recover(f.revision(), g),
  ];
  for (const run of attempts) code(() => run({ busy: true }), 'BUSY');
  f.store.lock(); for (const run of attempts) code(() => run(), 'LOCKED');
  assert.equal(f.store.hasVault(), false);
});

test('built-in/extension provider IDs are readable but protected from all mutation paths', t => {
  const cfg = seeded(); cfg.providers.builtin = structuredClone(cfg.providers.custom);
  const f = fixture(t, cfg, ['builtin', 'extension-provider']); f.unlock();
  assert.ok(f.store.snapshot().providers.some(p => p.id === 'builtin'));
  const rev = f.revision();
  code(() => f.store.addProvider({ ...P, id: 'builtin' }, rev), 'PROTECTED');
  code(() => f.store.addProvider({ ...P, id: 'extension-provider' }, rev), 'PROTECTED');
  code(() => f.store.editProvider('builtin', { name: 'X' }, rev), 'PROTECTED');
  code(() => f.store.putModel('builtin', M, 'edit', rev), 'PROTECTED');
  code(() => f.store.archiveProvider('builtin', rev), 'PROTECTED');
  code(() => f.store.archiveModel('builtin', M.id, rev), 'PROTECTED');
  assert.equal(f.store.hasVault(), false);
});

test('expectedRevision detects external edits before journaling without modifying either file', t => {
  const f = fixture(t, seeded()); f.unlock(); const rev = f.revision();
  const changed = seeded(); changed.external = true;
  fs.writeFileSync(f.modelFile, encode(changed)); const raw = fs.readFileSync(f.modelFile, 'utf8');
  code(() => f.store.editProvider('custom', { name: 'X' }, rev), 'CONFLICT');
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), raw); assert.equal(f.store.hasVault(), false);
});

test('a write-time external edit is not overwritten and its full journal remains for manual review', t => {
  const f = fixture(t, seeded()); f.unlock();
  const external = { ...seeded(), external: SECRET }; const externalRaw = encode(external);
  let changed = false;
  f.state.fault = e => {
    if (!changed && e.op === 'openSync' && String(e.args[0]).startsWith(f.root + '/.model-pick-store-')) {
      changed = true; fs.writeFileSync(f.modelFile, externalRaw);
    }
  };
  code(() => f.store.archiveProvider('custom', f.revision()), 'CONFLICT'); f.state.fault = undefined;
  assert.ok(changed); assert.equal(fs.readFileSync(f.modelFile, 'utf8'), externalRaw);
  assert.equal(f.store.hasPending(), true);
  const vaultBefore = fs.readFileSync(f.vaultFile, 'utf8');
  code(() => f.store.recover(f.revision()), 'CONFLICT');
  assert.equal(fs.readFileSync(f.vaultFile, 'utf8'), vaultBefore);
  assert.equal(f.stateOfVault().pending.before.includes(SECRET), true);
});

test('fault before models rename keeps encrypted before/after; explicit recovery rolls forward, not rollback', t => {
  const f = fixture(t, seeded()); f.unlock(); const before = fs.readFileSync(f.modelFile, 'utf8');
  const journal = interrupted(f, f.modelFile);
  assert.equal(journal.before, before); assert.equal(fs.readFileSync(f.modelFile, 'utf8'), before);
  assert.equal(journal.operation.kind, 'archive-provider'); assert.equal(journal.archivesAfter[0].payload.apiKey, SECRET);
  code(() => f.store.editProvider('custom', { name: 'X' }, f.revision()), 'PENDING');
  f.store.lock(); assert.equal(f.store.hasPending(), true);
  assert.deepEqual(normalize(f.store.retained()), { providers: ['custom'], models: [`custom/${M.id}`] });
  f.store.unlock(PASS);
  code(() => f.store.recover(f.revision(), { current: { provider: 'custom', id: M.id } }), 'CURRENT_MODEL');
  f.store.recover(f.revision());
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), journal.after);
  assert.equal(f.store.hasPending(), false); assert.equal(f.store.listArchives().length, 1);
  assert.equal(f.stateOfVault().history.length, 1);
});

test('fault completing vault after models rename recovers from exact after hash without rewriting models', t => {
  const f = fixture(t, seeded()); f.unlock();
  let writes = 0;
  f.state.fault = e => {
    if (e.op === 'renameSync' && e.args[1] === f.vaultFile && ++writes === 2) throw new Error(SECRET);
  };
  code(() => f.store.archiveProvider('custom', f.revision()), 'IO_ERROR'); f.state.fault = undefined;
  assert.equal(f.store.hasPending(), true); assert.equal(f.config().providers.custom, undefined);
  const journal = f.stateOfVault().pending;
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), journal.after);
  const revision = f.revision(); const at = f.calls.length;
  // A fresh instance must see pending on disk, not only cached state.
  const restarted = new f.loaded.PickerStore(f.root);
  assert.equal(restarted.isUnlocked(), false); assert.equal(restarted.hasPending(), true);
  restarted.unlock(PASS); restarted.recover(revision);
  assert.equal(f.calls.slice(at).filter(e => e.op === 'renameSync' && e.args[1] === f.modelFile).length, 0);
  assert.equal(f.store.hasPending(), false); assert.equal(f.store.listArchives().length, 1);
});

test('fault after durable models rename but before index completion retains pending and materials', t => {
  const f = fixture(t, seeded()); f.unlock();
  let indexes = 0;
  f.state.fault = e => {
    if (e.op === 'renameSync' && e.args[1] === f.indexFile && ++indexes === 2) throw new Error(SECRET);
  };
  code(() => f.store.archiveProvider('custom', f.revision()), 'IO_ERROR'); f.state.fault = undefined;
  assert.equal(f.config().providers.custom, undefined); assert.equal(f.store.hasPending(), true);
  f.store.lock(); assert.deepEqual(normalize(f.store.retained()), { providers: ['custom'], models: [`custom/${M.id}`] });
  f.store.unlock(PASS); f.store.recover(f.revision());
  assert.equal(f.store.hasPending(), false);
});

test('recovery refuses stale expectedRevision and external changes, preserving both new edits and journal', t => {
  const f = fixture(t, seeded()); f.unlock(); interrupted(f, f.modelFile);
  const beforeRevision = f.revision(); const changed = seeded(); changed.userNewEdit = true;
  fs.writeFileSync(f.modelFile, encode(changed)); const raw = fs.readFileSync(f.modelFile, 'utf8');
  const encrypted = fs.readFileSync(f.vaultFile, 'utf8');
  code(() => f.store.recover(beforeRevision), 'CONFLICT');
  code(() => f.store.recover(f.revision()), 'CONFLICT');
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), raw);
  assert.equal(fs.readFileSync(f.vaultFile, 'utf8'), encrypted); assert.equal(f.store.hasPending(), true);
});

test('explicit recovery can clean a provably-dead PID lock; live/extra transaction conflicts never auto-unlock', t => {
  const f = fixture(t, seeded()); f.unlock(); interrupted(f, f.modelFile);
  fs.writeFileSync(f.lockFile, encode({ pid: process.pid, token: 'live-synthetic-lock' }), { mode: 0o600 });
  code(() => f.store.recover(f.revision()), 'CONFLICT'); assert.equal(fs.existsSync(f.lockFile), true);
  fs.writeFileSync(f.lockFile, encode({ pid: 2147483647, token: 'dead-synthetic-lock' }), { mode: 0o600 });
  // This PID is not a guess from age/mtime. Signal 0 must report ESRCH or test cannot claim recovery.
  assert.throws(() => process.kill(2147483647, 0), e => e.code === 'ESRCH');
  f.store.recover(f.revision()); assert.equal(fs.existsSync(f.lockFile), false);
  const extra = path.join(f.dataDir, '.model-pick-store-extra.tmp'); fs.writeFileSync(extra, 'synthetic');
  code(() => f.store.editProvider('other', { name: 'Other' }, f.revision()), 'CONFLICT');
  assert.equal(fs.existsSync(extra), true);
});

test('ordinary writes refuse another writer lock even when it appears stale', t => {
  const f = fixture(t, seeded()); f.unlock();
  fs.mkdirSync(f.dataDir, { mode: 0o700 });
  fs.writeFileSync(f.lockFile, encode({ pid: 2147483647, token: 'dead-synthetic-lock' }), { mode: 0o600 });
  code(() => f.store.editProvider('custom', { name: 'X' }, f.revision()), 'CONFLICT');
  assert.equal(fs.existsSync(f.lockFile), true); assert.equal(f.store.hasVault(), false);
});

test('model symlinks and nonregular paths are refused without changing targets', t => {
  const f = fixture(t); const target = path.join(f.root, 'target.json'); fs.writeFileSync(target, encode(seeded()));
  fs.symlinkSync(target, f.modelFile);
  code(() => f.store.snapshot(), 'UNSAFE_PATH'); f.unlock();
  code(() => f.store.addProvider(P, 'unused'), 'UNSAFE_PATH');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), seeded());
  fs.unlinkSync(f.modelFile); fs.mkdirSync(f.modelFile);
  code(() => f.store.snapshot(), 'UNSAFE_PATH');
});

test('data directory, vault, index, lock and ancestor symlinks fail closed', t => {
  const f = fixture(t, seeded()); f.unlock();
  const target = path.join(f.root, 'target'); fs.mkdirSync(target, { mode: 0o700 });
  fs.symlinkSync(target, f.dataDir);
  code(() => f.store.editProvider('custom', { name: 'X' }, f.revision()), 'UNSAFE_PATH');
  fs.unlinkSync(f.dataDir); fs.mkdirSync(f.dataDir, { mode: 0o700 });
  const file = path.join(target, 'synthetic.json'); fs.writeFileSync(file, '{}', { mode: 0o600 });
  fs.symlinkSync(file, f.vaultFile); code(() => f.store.unlock(PASS), 'UNSAFE_PATH'); fs.unlinkSync(f.vaultFile);
  f.unlock(); fs.symlinkSync(file, f.indexFile);
  code(() => f.store.retained(), 'UNSAFE_PATH');
  code(() => f.store.editProvider('custom', { name: 'X' }, f.revision()), 'UNSAFE_PATH');
  fs.unlinkSync(f.indexFile);
  fs.symlinkSync(file, f.lockFile);
  code(() => f.store.editProvider('custom', { name: 'X' }, f.revision()), 'UNSAFE_PATH'); fs.unlinkSync(f.lockFile);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(target, alias);
  const store = new f.loaded.PickerStore(alias);
  code(() => store.snapshot(), 'UNSAFE_PATH');
});

test('invalid JSON, shape, unsafe text and dangerous prototype keys are rejected with fixed secret-free errors', t => {
  const f = fixture(t);
  for (const raw of [
    `{"providers":${SECRET}`, '[]', '{"providers":[]}', '{"providers":{"x":{"models":[{"id":"same"},{"id":"same"}]}}}',
    '{"providers":{"x":{"models":[{"id":"bad\\u001b[31m"}]}}}',
    '{"providers":{"x":{"models":[{"id":"ok","name":"bad\\nname"}]}}}',
    '{"providers":{"__proto__":{}}}', '{"nested":{"prototype":{"secret":"synthetic"}}}',
    '{"providers":{"x":{"constructor":{}}}}',
  ]) {
    fs.writeFileSync(f.modelFile, raw); code(() => f.store.snapshot(), 'INVALID_CONFIG');
    assert.equal(fs.readFileSync(f.modelFile, 'utf8'), raw);
  }
  fs.writeFileSync(f.modelFile, encode(seeded())); f.unlock();
  const input = JSON.parse('{"name":"X","__proto__":{"polluted":true}}');
  code(() => f.store.editProvider('custom', input, f.revision()), 'INVALID_INPUT');
  assert.equal({}.polluted, undefined);
  assert.equal(f.store.hasVault(), false);
});

test('bad vault JSON, ciphertext, password and plaintext pending flag mismatch never erase archives', t => {
  const f = fixture(t, seeded()); f.unlock(); f.store.archiveProvider('custom', f.revision());
  const good = fs.readFileSync(f.vaultFile, 'utf8');
  code(() => f.store.unlock('wrong synthetic passphrase'), 'INVALID_VAULT'); assert.equal(f.store.isUnlocked(), false);
  assert.equal(fs.readFileSync(f.vaultFile, 'utf8'), good);
  for (const raw of [`{${SECRET}`, '{}', encode({ version: 1, pending: false, sealed: {} })]) {
    fs.writeFileSync(f.vaultFile, raw, { mode: 0o600 }); code(() => f.store.unlock(PASS), 'INVALID_VAULT');
    code(() => f.store.editProvider('other', { name: 'X' }, f.revision()), 'LOCKED');
  }
  const badCiphertext = JSON.parse(good);
  badCiphertext.sealed.data = `${badCiphertext.sealed.data[0] === 'A' ? 'B' : 'A'}${badCiphertext.sealed.data.slice(1)}`;
  fs.writeFileSync(f.vaultFile, encode(badCiphertext), { mode: 0o600 }); code(() => f.store.unlock(PASS), 'INVALID_VAULT');
  const wrongFlag = JSON.parse(good); wrongFlag.pending = true;
  fs.writeFileSync(f.vaultFile, encode(wrongFlag), { mode: 0o600 }); code(() => f.store.unlock(PASS), 'INVALID_VAULT');
  fs.writeFileSync(f.vaultFile, good, { mode: 0o600 }); f.unlock();
  assert.equal(f.store.listArchives().length, 1);
});

test('unlocked retained ignores forged plaintext index; locked malformed index fails closed', t => {
  const f = fixture(t, seeded()); f.unlock(); f.store.archiveProvider('custom', f.revision());
  fs.writeFileSync(f.indexFile, encode({ providers: [], models: [] }), { mode: 0o600 });
  assert.deepEqual(normalize(f.store.retained()), { providers: ['custom'], models: [`custom/${M.id}`] });
  f.store.lock();
  fs.writeFileSync(f.indexFile, encode({ providers: ['custom'], models: [], url: SECRET }), { mode: 0o600 });
  code(() => f.store.retained(), 'INVALID_INDEX');
  fs.unlinkSync(f.indexFile); code(() => f.store.retained(), 'INVALID_INDEX');
  f.unlock(); assert.equal(f.store.retained().models[0], `custom/${M.id}`);
});

test('authenticated journal schema corruption and additional pending transaction are not silently accepted', t => {
  const f = fixture(t, seeded()); f.unlock(); interrupted(f, f.modelFile);
  const v = f.stateOfVault(); v.pending.beforeRevision = 'forged'; f.writeVaultState(v);
  code(() => f.store.unlock(PASS), 'INVALID_VAULT');
  assert.equal(f.store.isUnlocked(), false); assert.equal(f.store.hasPending(), true);
});

test('normal history is bounded at 20 full backups while all archive records survive', t => {
  const f = fixture(t, seeded()); f.unlock();
  f.store.archiveModel('custom', M.id, f.revision()); const a = f.store.listArchives()[0];
  for (let i = 0; i < 22; i++) f.store.editProvider('custom', { name: `Custom ${i}` }, f.revision());
  const state = f.stateOfVault();
  assert.equal(state.history.length, 20);
  assert.equal(state.archives.length, 1); assert.equal(state.archives[0].id, a.id);
  assert.equal(JSON.parse(state.history[0].after).providers.custom.name, 'Custom 2');
  assert.equal(JSON.parse(state.history.at(-1).after).providers.custom.name, 'Custom 21');
  assert.ok(state.history.every(h => h.before.includes(SECRET)));
  assert.ok(!fs.readFileSync(f.vaultFile, 'utf8').includes(SECRET));
});

test('a first-ever interrupted add recovers from absent models.json, including the complete after image', t => {
  const f = fixture(t); f.unlock();
  let once = false;
  f.state.fault = e => {
    if (!once && e.op === 'renameSync' && e.args[1] === f.modelFile) { once = true; throw new Error(SECRET); }
  };
  code(() => f.addProvider(), 'IO_ERROR'); f.state.fault = undefined;
  assert.equal(fs.existsSync(f.modelFile), false); assert.equal(f.store.hasPending(), true);
  const journal = f.stateOfVault().pending; assert.equal(journal.before, null);
  const restarted = new f.loaded.PickerStore(f.root); restarted.unlock(PASS); restarted.recover(restarted.snapshot().revision);
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), journal.after);
  assert.equal(restarted.hasPending(), false); assert.equal(f.stateOfVault().history.length, 1);
});

test('executable/prototype-bearing input is rejected without evaluating accessors or proxy traps', t => {
  const f = fixture(t, seeded()); f.unlock();
  let invoked = false;
  const getter = { get name() { invoked = true; throw new Error(SECRET); } };
  code(() => f.store.editProvider('custom', getter, f.revision()), 'INVALID_INPUT');
  const proxy = new Proxy({ name: 'X' }, { ownKeys() { invoked = true; throw new Error(SECRET); } });
  code(() => f.store.editProvider('custom', proxy, f.revision()), 'INVALID_INPUT');
  const inherited = Object.create({ name: 'X' });
  code(() => f.store.editProvider('custom', inherited, f.revision()), 'INVALID_INPUT');
  assert.equal(invoked, false); assert.equal(f.store.hasVault(), false);
  fs.writeFileSync(f.modelFile, '{"providers":{},"unknown":1e999}');
  code(() => f.store.snapshot(), 'INVALID_CONFIG');
});

test('missing vault material and additional authenticated transaction fields fail closed', t => {
  const f = fixture(t, seeded()); f.unlock(); f.store.archiveProvider('custom', f.revision());
  const raw = fs.readFileSync(f.vaultFile, 'utf8');
  fs.unlinkSync(f.vaultFile);
  code(() => f.store.editProvider('other', { name: 'X' }, f.revision()), 'INVALID_VAULT');
  code(() => f.store.unlock(PASS), 'INVALID_VAULT');
  assert.equal(fs.existsSync(f.vaultFile), false);
  fs.writeFileSync(f.vaultFile, raw, { mode: 0o600 });
  const state = f.stateOfVault(); state.extraTransaction = { before: SECRET }; f.writeVaultState(state);
  code(() => f.store.unlock(PASS), 'INVALID_VAULT');
  assert.ok(f.stateOfVault().extraTransaction);
});

test('private store permissions and hardlinked model files are checked before writes', t => {
  const f = fixture(t, seeded()); f.unlock(); f.store.editProvider('custom', { name: 'Updated' }, f.revision());
  fs.chmodSync(f.vaultFile, 0o644);
  code(() => f.store.unlock(PASS), 'UNSAFE_PATH');
  fs.chmodSync(f.vaultFile, 0o600); f.unlock();
  fs.chmodSync(f.dataDir, 0o755); code(() => f.store.hasVault(), 'UNSAFE_PATH');
  fs.chmodSync(f.dataDir, 0o700);
  const alias = path.join(f.root, 'hardlink'); fs.linkSync(f.modelFile, alias);
  code(() => f.store.snapshot(), 'UNSAFE_PATH');
  assert.equal(fs.statSync(alias).ino, fs.statSync(f.modelFile).ino);
});

test('final vault capacity is preflighted before models commit, not only pending capacity', t => {
  const cfg = seeded(); cfg.providers.custom.largeUnknownField = 'x'.repeat(1_450_000);
  const f = fixture(t, cfg); f.unlock();
  const before = fs.readFileSync(f.modelFile, 'utf8');
  // For this provider, pending's payload+before is below the vault's 4 MiB
  // limit, but completed archives+history adds a third full payload above it.
  code(() => f.store.archiveProvider('custom', f.revision()), 'IO_ERROR');
  assert.equal(fs.readFileSync(f.modelFile, 'utf8'), before);
  assert.equal(f.store.hasVault(), false); assert.equal(f.store.hasPending(), false);
  assert.equal(fs.existsSync(f.lockFile), false);
});

test('lock creation failure cleans only its own lock and permits a subsequent retry', t => {
  const f = fixture(t, seeded()); f.unlock();
  let once = false;
  f.state.fault = e => {
    if (!once && e.op === 'writeFileSync' && e.file === f.lockFile) { once = true; throw new Error(SECRET); }
  };
  code(() => f.store.editProvider('custom', { name: 'X' }, f.revision()), 'IO_ERROR'); f.state.fault = undefined;
  assert.equal(fs.existsSync(f.lockFile), false); assert.equal(f.store.hasVault(), false);
  f.store.editProvider('custom', { name: 'After retry' }, f.revision());
  assert.equal(f.config().providers.custom.name, 'After retry');
});

test('native filesystem failures with secret-bearing error messages are sanitized', t => {
  const f = fixture(t, seeded()); f.unlock();
  f.state.fault = e => { if (e.op === 'mkdirSync') throw new Error(SECRET); };
  code(() => f.store.editProvider('custom', { name: 'X' }, f.revision()), 'IO_ERROR');
  f.state.fault = undefined;
  assert.equal(f.config().providers.custom.name, 'Custom'); assert.equal(f.store.hasVault(), false);
});
