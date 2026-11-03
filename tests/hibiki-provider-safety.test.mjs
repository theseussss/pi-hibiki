import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { piRoot, typescriptPath, root } from '../scripts/tooling.mjs';
import { createSyntheticProtection } from './model-pick-synthetic-protection.mjs';

// Reviewed isolation: installed compiler/Pi reads only; emitted modules and all
// auth/models fixtures stay under /tmp/model-pick-*. No SDK defaults or network.
assert.ok(process.env.NODE_OPTIONS?.includes('isolation.cjs'), 'Run safety tests with the existing isolation preload');
const sdk = piRoot(); const require = createRequire(import.meta.url); const ts = require(typescriptPath());
const emitted = fs.mkdtempSync('/tmp/model-pick-safety-modules-');
for (const name of fs.readdirSync(path.join(root, 'lib/model-pick')).filter(n => n.endsWith('.ts'))) {
  const source = fs.readFileSync(path.join(root, 'lib/model-pick', name), 'utf8').replaceAll("from '@earendil-works/pi-coding-agent'", `from '${pathToFileURL(path.join(sdk, 'dist/index.js')).href}'`);
  const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  fs.writeFileSync(path.join(emitted, name.replace(/\.ts$/, '.js')), out.outputText);
}
const storeAPI = await import(pathToFileURL(path.join(emitted, 'store.js')));
const serviceAPI = await import(pathToFileURL(path.join(emitted, 'provider-commit.js')));
const native = await import(pathToFileURL(path.join(sdk, 'dist/core/auth-storage.js')));
const config = await import(pathToFileURL(path.join(sdk, 'dist/config.js')));
test.after(() => fs.rmSync(emitted, { recursive: true, force: true }));
const secret = 'SYNTHETIC-NEW';
const original = { type: 'api_key', key: 'SYNTHETIC-OLD', env: { ACCOUNT: 'synthetic-account' }, future: { retain: true } };
const model = { id: 'm', name: 'M', contextWindow: 8192, maxTokens: 1024, reasoning: false, input: ['text'] };
const provider = { id: 'new', name: 'New', endpoint: 'https://new.invalid/v1', api: 'openai-completions' };
async function fixture(t, { initial = { p: original }, protectionState = {}, current, authElsewhere = false } = {}) {
  const dir = fs.mkdtempSync('/tmp/model-pick-provider-safety-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modelsPath = path.join(dir, 'models.json'); const authPath = path.join(dir, authElsewhere ? 'custom-auth.json' : 'auth.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ future: { retain: true }, providers: { p: { name: 'P', baseUrl: 'https://old.invalid/v1', api: 'openai-completions', future: { retain: true }, models: [{ ...model, future: { retain: true } }] } } }, null, 2) + '\n', { mode: 0o600 });
  if (initial !== null) fs.writeFileSync(authPath, JSON.stringify(initial, null, 2), { mode: 0o600 });
  const protection = createSyntheticProtection(protectionState); const store = new storeAPI.PickerStore(dir, [], protection);
  const storage = { agentDir: dir, modelsPath, authPath };
  const registry = { runtime: { modelsPath, credentials: { store: { authPath } } } };
  const live = { current, busy: false };
  const bound = await serviceAPI.createProviderCommitBackend({ modelRegistry: registry, storageOverride: storage, store, getGuard: () => ({ ...live }) });
  assert.equal(bound.writable, true); const backend = bound.backend;
  return { dir, modelsPath, authPath, store, protection, protectionState, live, storage, registry, backend,
    auth: () => fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, 'utf8')) : null,
    models: () => JSON.parse(fs.readFileSync(modelsPath, 'utf8')),
    ledger: () => protection.open(JSON.parse(fs.readFileSync(path.join(dir, 'model-pick-data/vault.auto.json'), 'utf8')).sealed, 'models'),
    async request(change) { const id = change.kind === 'add' ? change.provider.id : change.providerId; return { change, expectedModelsRevision: store.snapshot().revision, expectedCredentialRevision: (await backend.snapshotCredential(id)).revision }; },
  };
}
const edit = (patch = {}, credential = { kind: 'literal', value: secret }) => ({ kind: 'edit', providerId: 'p', patch, credential });
const add = credential => ({ kind: 'add', provider, models: [model], credential });
async function fault(method, hook, work) {
  const old = fs[method]; fs[method] = (...args) => hook(old, args); syncBuiltinESMExports();
  try { return await work(); } finally { fs[method] = old; syncBuiltinESMExports(); }
}
function io() { const e = new Error('SYNTHETIC IO error must not escape'); e.code = 'EIO'; throw e; }

test('native async lease commits literal and preserves target metadata, other providers and unknown config', async t => {
  const f = await fixture(t, { initial: { p: original, other: { type: 'oauth', access: 'SYNTHETIC-A', refresh: 'SYNTHETIC-R', expires: 1, future: true } }, authElsewhere: true });
  const result = await f.backend.commit(await f.request(edit({ name: 'Renamed' })));
  assert.equal(result.status, 'committed'); assert.equal(result.refreshRequired, true);
  assert.deepEqual(f.auth().p, { ...original, key: secret }); assert.equal(f.auth().other.future, true);
  assert.deepEqual(f.models().future, { retain: true }); assert.deepEqual(f.models().providers.p.models[0].future, { retain: true });
  assert.equal(fs.statSync(f.authPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(f.authPath + '.lock'), false);
  const ledger = f.ledger(); assert.equal(ledger.pending, null); assert.equal(ledger.history.length, 1);
  assert.equal(Object.hasOwn(ledger.history[0], 'credential'), false);
  assert.ok(!JSON.stringify(ledger).includes(secret)); assert.ok(!JSON.stringify(result).includes(secret));
});

test('actual native AuthStorage resolves each encoded literal once, without shell execution', async t => {
  const f = await fixture(t);
  for (const value of ['prefix-$HIBIKI_UNSET_93', '!SYNTHETIC-NOT-EXECUTED', '${HIBIKI_UNSET_93}', '$!literal', '$$literal', 'a!b']) {
    assert.equal((await f.backend.commit(await f.request(edit({}, { kind: 'literal', value })))).status, 'committed');
    assert.equal((await native.AuthStorage.create(f.authPath).read('p')).key, value);
    assert.ok(!fs.readFileSync(f.modelsPath, 'utf8').includes(value));
  }
});

test('new draft none is not edit keep; no early credential file, no orphan credential adoption', async t => {
  const f = await fixture(t, { initial: null });
  assert.equal((await f.backend.snapshotCredential('new')).kind, 'absent'); assert.equal(fs.existsSync(f.authPath), false);
  assert.equal((await f.backend.commit(await f.request(add({ kind: 'none' })))).status, 'committed');
  assert.equal(f.auth().new, undefined); assert.equal(f.models().providers.new.models.length, 1);
  const g = await fixture(t, { initial: { new: original } });
  assert.equal((await g.backend.commit(await g.request(add({ kind: 'none' })))).code, 'EXISTS');
  assert.deepEqual(g.auth().new, original); assert.equal(g.models().providers.new, undefined);
});

test('validation, revision, credential CAS and protection failure occur before auth writes', async t => {
  for (const failure of ['invalid', 'revision', 'credential', 'protection']) {
    const f = await fixture(t, { initial: null });
    const request = await f.request(add({ kind: 'literal', value: secret }));
    if (failure === 'invalid') request.change.provider = { ...provider, endpoint: 'not-a-url' };
    if (failure === 'revision') request.expectedModelsRevision = 'stale';
    if (failure === 'credential') request.expectedCredentialRevision = 'stale';
    if (failure === 'protection') f.protectionState.failSeal = true;
    const result = await f.backend.commit(request);
    assert.equal(result.status, 'unchanged', failure); assert.equal(fs.existsSync(f.authPath), false, failure);
    assert.equal(f.models().providers.new, undefined);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('OAuth never overwritten; name-only edits keep OAuth and existing key unchanged', async t => {
  const oauth = { type: 'oauth', access: 'SYNTHETIC-A', refresh: 'SYNTHETIC-R', expires: 1, future: true };
  const f = await fixture(t, { initial: { p: oauth } });
  assert.equal((await f.backend.commit(await f.request(edit()))).code, 'OAUTH'); assert.deepEqual(f.auth().p, oauth);
  assert.equal((await f.backend.commit(await f.request(edit({ name: 'Safe rename' }, { kind: 'keep' })))).status, 'committed');
  assert.deepEqual(f.auth().p, oauth);
});

test('current supplier blocks key/endpoint/API changes, but not rename-only', async t => {
  const f = await fixture(t, { current: { provider: 'p', id: 'm' } }); const before = f.auth();
  for (const change of [edit(), edit({ endpoint: 'https://new.invalid/v2' }, { kind: 'keep' }), edit({ api: 'openai-responses' }, { kind: 'keep' })]) {
    assert.equal((await f.backend.commit(await f.request(change))).code, 'CURRENT_CONNECTION'); assert.deepEqual(f.auth(), before);
  }
  assert.equal((await f.backend.commit(await f.request(edit({ name: 'Rename' }, { kind: 'keep' })))).status, 'committed');
});

test('live guard changes during protection preflight prevent any auth write', async t => {
  const f = await fixture(t, { initial: null });
  f.protectionState.sealHook = () => { f.live.busy = true; };
  const result = await f.backend.commit(await f.request(add({ kind: 'literal', value: secret })));
  assert.equal(result.status, 'unchanged'); assert.equal(result.code, 'BUSY'); assert.equal(fs.existsSync(f.authPath), false);
});

test('models rename failure rolls target back while preserving unrelated concurrent credentials', async t => {
  const f = await fixture(t); let failed = false;
  const result = await fault('renameSync', (old, args) => {
    if (args[1] === f.modelsPath && !failed) {
      failed = true; const auth = f.auth(); auth.other = { type: 'api_key', key: 'SYNTHETIC-OTHER' };
      fs.writeFileSync(f.authPath, JSON.stringify(auth), { mode: 0o600 }); io();
    }
    return old(...args);
  }, async () => f.backend.commit(await f.request(edit({ name: 'Refused' }))));
  assert.equal(result.status, 'unchanged'); assert.deepEqual(f.auth().p, original); assert.equal(f.auth().other.key, 'SYNTHETIC-OTHER');
  assert.equal(f.models().providers.p.name, 'P'); assert.equal(f.ledger().pending, null);
});

test('external target OAuth change is not overwritten by rollback; pending protects raw images only until recovery', async t => {
  const f = await fixture(t); const oauth = { type: 'oauth', access: 'SYNTHETIC-A', refresh: 'SYNTHETIC-R', expires: 1 }; let failed = false;
  const result = await fault('renameSync', (old, args) => {
    if (args[1] === f.modelsPath && !failed) { failed = true; const auth = f.auth(); auth.p = oauth; fs.writeFileSync(f.authPath, JSON.stringify(auth), { mode: 0o600 }); io(); }
    return old(...args);
  }, async () => f.backend.commit(await f.request(edit({ name: 'Refused' }))));
  assert.equal(result.status, 'pending'); assert.equal(result.state, 'conflict'); assert.deepEqual(f.auth().p, oauth);
  assert.equal(f.ledger().pending.credential.after.key, secret);
  assert.ok(!fs.readFileSync(path.join(f.dir, 'model-pick-data/vault.auto.json'), 'utf8').includes(secret));
  assert.throws(() => f.store.recover(f.store.snapshot().revision), { code: 'CREDENTIAL_PENDING' });
  const recovery = await f.backend.recover({ transactionId: result.transactionId, action: 'rollback', expectedModelsRevision: f.store.snapshot().revision, expectedCredentialRevision: (await f.backend.snapshotCredential('p')).revision });
  assert.equal(recovery.status, 'pending'); assert.deepEqual(f.auth().p, oauth);
});

test('applied models followed by metadata failure classifies applied; explicit recovery finishes without storing auth history', async t => {
  const f = await fixture(t); let applied = false;
  const result = await fault('renameSync', (old, args) => {
    if (applied && args[1] === path.join(f.dir, 'model-pick-data/retention-index.auto.json')) io();
    const out = old(...args); if (args[1] === f.modelsPath) applied = true; return out;
  }, async () => f.backend.commit(await f.request(edit({ name: 'Applied' }))));
  assert.equal(result.status, 'pending'); assert.equal(result.state, 'applied'); assert.equal(f.auth().p.key, secret);
  const retry = await f.backend.recover({ transactionId: result.transactionId, action: 'complete', expectedModelsRevision: f.store.snapshot().revision, expectedCredentialRevision: (await f.backend.snapshotCredential('p')).revision });
  assert.equal(retry.status, 'committed'); assert.equal(f.models().providers.p.name, 'Applied');
  assert.equal(f.ledger().pending, null); assert.ok(!JSON.stringify(f.ledger()).includes(secret));
});

test('native stale empty directory recovers; unknown nonempty owner lock remains untouched', async t => {
  for (const nonempty of [false, true]) {
    const f = await fixture(t); fs.mkdirSync(f.authPath + '.lock');
    if (nonempty) fs.writeFileSync(path.join(f.authPath + '.lock', 'owner.json'), '{"unknown":true}');
    const old = new Date(Date.now() - 120000); fs.utimesSync(f.authPath + '.lock', old, old);
    const result = await f.backend.commit(await f.request(edit()));
    assert.equal(result.status, nonempty ? 'unchanged' : 'committed');
    if (nonempty) { assert.equal(result.code, 'BUSY'); assert.equal(fs.existsSync(path.join(f.authPath + '.lock', 'owner.json')), true); assert.deepEqual(f.auth().p, original); }
  }
});

test('actual native async holder excludes commit; cancellation while waiting does not mutate credentials/config', async t => {
  const f = await fixture(t); let release; let entered;
  const ready = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; });
  const holder = new native.FileAuthStorageBackend(f.authPath).withLockAsync(async () => { entered(); await gate; return { result: undefined }; });
  await ready;
  const request = await f.request(edit()); const controller = new AbortController(); request.signal = controller.signal;
  setTimeout(() => controller.abort(), 20);
  try { const result = await f.backend.commit(request); assert.equal(result.status, 'unchanged'); assert.equal(result.code, 'CANCELLED'); assert.deepEqual(f.auth().p, original); }
  finally { release(); await holder; }
});

test('binding checks use explicit native paths, refuse contradictions/unknown SDK, never default to HOME writes', async t => {
  const f = await fixture(t);
  const bind = modelRegistry => serviceAPI.createProviderCommitBackend({ modelRegistry, store: f.store, getGuard: () => ({}) });
  assert.equal((await bind({})).writable, false);
  assert.equal((await bind(f.registry)).code, 'STORAGE_MISMATCH'); // fixture != CLI default
  const wrong = await serviceAPI.createProviderCommitBackend({ modelRegistry: f.registry, storageOverride: { ...f.storage, authPath: path.join(f.dir, 'wrong.json') }, store: f.store, getGuard: () => ({}) });
  assert.equal(wrong.code, 'STORAGE_MISMATCH'); assert.equal(fs.existsSync(path.join(f.dir, 'wrong.json')), false);
  const explicit = await serviceAPI.createProviderCommitBackend({ modelRegistry: {}, storageOverride: f.storage, store: f.store, getGuard: () => ({}) });
  assert.equal(explicit.writable, true);
  assert.equal(config.getAgentDir(), process.env.PI_CODING_AGENT_DIR);
});


test('auth rename that throws after applying is detected and target-compensated', async t => {
  const f = await fixture(t); let failed = false;
  const result = await fault('renameSync', (old, args) => {
    const out = old(...args);
    if (args[1] === f.authPath && !failed) { failed = true; io(); }
    return out;
  }, async () => f.backend.commit(await f.request(edit({ name: 'Not applied' }))));
  assert.equal(result.status, 'unchanged'); assert.deepEqual(f.auth().p, original); assert.equal(f.models().providers.p.name, 'P');
  assert.equal(f.ledger().pending, null);
});

test('models rename that throws after applying is classified applied, not rolled back', async t => {
  const f = await fixture(t); let failed = false;
  const result = await fault('renameSync', (old, args) => {
    const out = old(...args); if (args[1] === f.modelsPath && !failed) { failed = true; io(); } return out;
  }, async () => f.backend.commit(await f.request(edit({ name: 'Applied' }))));
  assert.equal(result.status, 'pending'); assert.equal(result.state, 'applied'); assert.equal(f.auth().p.key, secret);
  const currentAuth = f.auth(); currentAuth.p = original; fs.writeFileSync(f.authPath, JSON.stringify(currentAuth), { mode: 0o600 });
  for (const action of ['complete', 'rollback']) {
    const r = await f.backend.recover({ transactionId: result.transactionId, action, expectedModelsRevision: f.store.snapshot().revision, expectedCredentialRevision: (await f.backend.snapshotCredential('p')).revision });
    assert.equal(r.status, 'pending'); assert.equal(r.state, 'conflict'); assert.deepEqual(f.auth().p, original);
  }
});

test('restart recovery of auth-only pending can explicitly complete or rollback; no new auth history images', async t => {
  for (const action of ['complete', 'rollback']) {
    const f = await fixture(t); let authWrites = 0;
    const result = await fault('renameSync', (old, args) => {
      if (args[1] === f.modelsPath) io();
      if (args[1] === f.authPath && ++authWrites > 1) io();
      return old(...args);
    }, async () => f.backend.commit(await f.request(edit({ name: 'Recovered' }))));
    assert.equal(result.status, 'pending'); assert.equal(result.state, 'auth-only');
    const freshStore = new storeAPI.PickerStore(f.dir, [], createSyntheticProtection());
    const rebound = await serviceAPI.createProviderCommitBackend({ modelRegistry: f.registry, storageOverride: f.storage, store: freshStore, getGuard: () => ({}) });
    assert.equal(rebound.writable, true); const backend = rebound.backend;
    const recovery = await backend.recover({ transactionId: result.transactionId, action, expectedModelsRevision: freshStore.snapshot().revision, expectedCredentialRevision: (await backend.snapshotCredential('p')).revision });
    assert.equal(recovery.status, action === 'complete' ? 'committed' : 'unchanged');
    assert.equal(f.auth().p.key, action === 'complete' ? secret : original.key);
    assert.equal(f.models().providers.p.name, action === 'complete' ? 'Recovered' : 'P');
    assert.equal(f.ledger().pending, null); assert.ok(!JSON.stringify(f.ledger()).includes(secret));
  }
});

test('prepared-only pending recovery completes or aborts explicitly', async t => {
  for (const action of ['complete', 'rollback']) {
    const f = await fixture(t); let writes = 0;
    const result = await fault('renameSync', (old, args) => {
      if (args[1] === path.join(f.dir, 'model-pick-data/vault.auto.json')) {
        if (++writes === 1) old(...args); // durable journal, then failure
        io(); // abort itself fails BEFORE clearing pending
      }
      return old(...args);
    }, async () => f.backend.commit(await f.request(edit({ name: 'Prepared' }))));
    assert.notEqual(await f.backend.pending(), null);
    assert.equal(result.status, 'pending'); assert.equal(result.state, 'prepared');
    const recovery = await f.backend.recover({ transactionId: result.transactionId, action, expectedModelsRevision: f.store.snapshot().revision, expectedCredentialRevision: (await f.backend.snapshotCredential('p')).revision });
    assert.equal(recovery.status, action === 'complete' ? 'committed' : 'unchanged');
  }
});

test('cancellation after auth rename compensates; cancellation after models rename retains applied pending', async t => {
  for (const phase of ['auth', 'models']) {
    const f = await fixture(t); const controller = new AbortController();
    const request = await f.request(edit({ name: 'Cancelled change' })); request.signal = controller.signal;
    const result = await fault('renameSync', (old, args) => {
      const out = old(...args); if (args[1] === (phase === 'auth' ? f.authPath : f.modelsPath)) controller.abort(); return out;
    }, () => f.backend.commit(request));
    assert.equal(result.status, phase === 'auth' ? 'unchanged' : 'pending');
    assert.equal(f.auth().p.key, phase === 'auth' ? original.key : secret);
    if (phase === 'models') assert.equal(result.state, 'applied');
  }
});

test('current-supplier guard is repeated after durable journal and before credential rename', async t => {
  const f = await fixture(t);
  const result = await fault('renameSync', (old, args) => {
    const out = old(...args); if (args[1] === path.join(f.dir, 'model-pick-data/vault.auto.json')) f.live.current = { provider: 'p', id: 'm' }; return out;
  }, async () => f.backend.commit(await f.request(edit({ name: 'Blocked late' }))));
  assert.equal(result.status, 'pending'); assert.equal(result.code, 'CURRENT_CONNECTION'); assert.deepEqual(f.auth().p, original);
  f.live.current = undefined;
  const recovery = await f.backend.recover({ transactionId: result.transactionId, action: 'rollback', expectedModelsRevision: f.store.snapshot().revision, expectedCredentialRevision: (await f.backend.snapshotCredential('p')).revision });
  assert.equal(recovery.status, 'unchanged'); assert.equal(f.ledger().pending, null);
});

test('unsupported Pi version and missing native features fail closed in compatibility adapter', async t => {
  const dir = fs.mkdtempSync('/tmp/model-pick-native-features-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = fs.readFileSync(path.join(root, 'lib/model-pick/native-auth.ts'), 'utf8');
  for (const [version, expected] of [['0.0.0', 'UNSUPPORTED_PI'], ['1.4.0', 'UNSUPPORTED_NATIVE_API']]) {
    const sub = path.join(dir, version); fs.mkdirSync(path.join(sub, 'dist/core'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'public.js'), `export const VERSION=${JSON.stringify(version)}; export const getPackageDir=()=>${JSON.stringify(sub)}; export const getAgentDir=()=>${JSON.stringify(sub)};`);
    fs.writeFileSync(path.join(sub, 'dist/core/auth-storage.js'), 'export class FileAuthStorageBackend {}');
    const text = src.replace("from '@earendil-works/pi-coding-agent'", `from '${pathToFileURL(path.join(sub, 'public.js')).href}'`);
    const out = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    fs.writeFileSync(path.join(sub, 'adapter.js'), out);
    const adapter = await import(pathToFileURL(path.join(sub, 'adapter.js')));
    await assert.rejects(adapter.resolveNativeAuth({}, { agentDir: sub, modelsPath: path.join(sub, 'models.json'), authPath: path.join(sub, 'auth.json') }), { code: expected });
    assert.equal(fs.existsSync(path.join(sub, 'auth.json')), false);
  }
});


test('credential or config changed while awaiting native lease is unchanged refusal, never phantom pending', async t => {
  for (const target of ['credential', 'config']) {
    const f = await fixture(t); const request = await f.request(edit({ name: 'Must not apply' }));
    let release; let entered;
    const ready = new Promise(r => { entered = r; }); const gate = new Promise(r => { release = r; });
    const holder = new native.FileAuthStorageBackend(f.authPath).withLockAsync(async () => { entered(); await gate; return { result: undefined }; });
    await ready; const committing = f.backend.commit(request);
    await new Promise(r => setTimeout(r, 25));
    if (target === 'credential') fs.writeFileSync(f.authPath, JSON.stringify({ p: { type: 'api_key', key: 'SYNTHETIC-EXTERNAL' } }), { mode: 0o600 });
    else { const cfg = f.models(); cfg.future.external = true; fs.writeFileSync(f.modelsPath, JSON.stringify(cfg), { mode: 0o600 }); }
    release(); await holder;
    const result = await committing;
    assert.equal(result.status, 'unchanged'); assert.equal(result.code, 'CONFLICT'); assert.equal(await f.backend.pending(), null);
    assert.equal(f.models().providers.p.name, 'P'); assert.notEqual(f.auth().p.key, secret);
  }
});

test('a separate native worker lease prevents credential writes until release', async t => {
  const { spawn } = await import('node:child_process');
  const f = await fixture(t);
  const program = `import {pathToFileURL} from 'node:url'; const {FileAuthStorageBackend}=await import(pathToFileURL(process.argv[1])); await new FileAuthStorageBackend(process.argv[2]).withLockAsync(async()=>{ console.log('ready'); await new Promise(r=>process.stdin.once('data',r)); return {result:undefined}; });`;
  // Static Node-only synthetic worker; inherited environment is the reviewed
  // sanitized test environment, not the user's provider environment.
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, path.join(sdk, 'dist/core/auth-storage.js'), f.authPath], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  t.after(async () => { if (child.exitCode === null) { child.stdin.end('release'); await exited; } });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', n => { if (n !== null && n !== 0) reject(new Error('Synthetic native lease worker failed')); }); });
  const request = await f.request(edit({ name: 'After worker' }));
  const committing = f.backend.commit(request); await new Promise(r => setTimeout(r, 25));
  assert.deepEqual(f.auth().p, original); assert.equal(f.models().providers.p.name, 'P');
  assert.deepEqual(fs.readdirSync(f.authPath + '.lock'), []);
  child.stdin.end('release'); assert.equal(await exited, 0);
  assert.equal((await committing).status, 'committed');
});


test('completed-journal rename failure after application is committed, not fictitious pending or unchanged', async t => {
  const f = await fixture(t); let journalWrites = 0;
  const result = await fault('renameSync', (old, args) => {
    const out = old(...args);
    if (args[1] === path.join(f.dir, 'model-pick-data/vault.auto.json') && ++journalWrites === 2) io();
    return out;
  }, async () => f.backend.commit(await f.request(edit({ name: 'Committed' }))));
  assert.equal(result.status, 'committed'); assert.equal(await f.backend.pending(), null);
  assert.equal(f.auth().p.key, secret); assert.equal(f.models().providers.p.name, 'Committed');
  assert.ok(!JSON.stringify(f.ledger()).includes(secret));
});

test('coordinator rejects invalid or throwing live guards with only closed error codes', async t => {
  const f = await fixture(t);
  for (const getGuard of [() => undefined, () => Promise.resolve({}), () => { throw new Error(secret); }]) {
    const bound = await serviceAPI.createProviderCommitBackend({ modelRegistry: f.registry, storageOverride: f.storage, store: f.store, getGuard });
    assert.equal(bound.writable, true); const request = await f.request(edit());
    request.expectedCredentialRevision = (await bound.backend.snapshotCredential('p')).revision;
    const result = await bound.backend.commit(request);
    assert.equal(result.status, 'unchanged'); assert.equal(result.code, 'IO_ERROR'); assert.ok(!JSON.stringify(result).includes(secret));
    assert.deepEqual(f.auth().p, original);
  }
});


test('protection seal/open never executes inside native lease, including explicit recovery', async t => {
  const f = await fixture(t);
  f.protectionState.sealHook = f.protectionState.openHook = () => assert.equal(fs.existsSync(f.authPath + '.lock'), false, 'No crypto/subprocess protection under native lease');
  let applied = false;
  const result = await fault('renameSync', (old, args) => {
    if (applied && args[1] === path.join(f.dir, 'model-pick-data/retention-index.auto.json')) io();
    const out = old(...args); if (args[1] === f.modelsPath) applied = true; return out;
  }, async () => f.backend.commit(await f.request(edit({ name: 'Recover without crypto under lease' }))));
  assert.equal(result.status, 'pending'); assert.equal(result.state, 'applied');
  const recovery = await f.backend.recover({ transactionId: result.transactionId, action: 'complete', expectedModelsRevision: f.store.snapshot().revision, expectedCredentialRevision: (await f.backend.snapshotCredential('p')).revision });
  assert.equal(recovery.status, 'committed');
  assert.equal((await f.backend.commit(await f.request(edit({ name: 'Normal commit' })))).status, 'committed');
});

test('CLI default is public getAgentDir only when both native paths verify', async t => {
  const f = await fixture(t); const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.dir;
  try {
    const bound = await serviceAPI.createProviderCommitBackend({ modelRegistry: f.registry, store: f.store, getGuard: () => ({}) });
    assert.equal(bound.writable, true); assert.deepEqual(bound.storage, f.storage);
  } finally { process.env.PI_CODING_AGENT_DIR = old; }
});

test('rollback deletes only a newly created target entry and preserves unrelated credentials', async t => {
  const f = await fixture(t, { initial: { other: original } }); let failed = false;
  const result = await fault('renameSync', (old, args) => {
    if (args[1] === f.modelsPath && !failed) { failed = true; io(); } return old(...args);
  }, async () => f.backend.commit(await f.request(add({ kind: 'literal', value: secret }))));
  assert.equal(result.status, 'unchanged'); assert.equal(f.auth().new, undefined); assert.deepEqual(f.auth().other, original);
  assert.equal(f.models().providers.new, undefined); assert.equal(f.ledger().pending, null);
});


test('an auth lease capability cannot be retained and used after native release', async t => {
  const f = await fixture(t); const { AuthFile } = await import(pathToFileURL(path.join(emitted, 'auth-file.js')));
  const file = new AuthFile(f.dir, new native.FileAuthStorageBackend(f.authPath), f.authPath); let lease;
  await file.withLease(value => { lease = value; });
  assert.throws(() => lease.entry('p'), { code: 'coordinated' });
  assert.throws(() => lease.replace('p', original, { type: 'api_key', key: secret }, () => {}), { code: 'coordinated' });
  assert.deepEqual(f.auth().p, original);
});
