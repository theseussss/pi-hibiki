import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSyntheticProtection } from './model-pick-synthetic-protection.mjs';

// This file is deliberately NOT a .test.mjs: only the sanitized spawning test
// may run it. No default SDK profile, persistent credentials, provider request,
// login, token refresh, subprocess or virtual route is permitted.
const home = process.env.HOME;
assert.match(home ?? '', /^\/tmp\/model-pick-limits-sdk-[^/]+$/);
assert.equal(process.cwd(), home);
assert.equal(process.env.PI_OFFLINE, '1');
assert.ok(process.env.NODE_OPTIONS?.includes('isolation.cjs'));
assert.ok(!Object.keys(process.env).some(key => /API.?KEY|TOKEN|SECRET|CREDENTIAL/i.test(key)));
const counters = { networkAttempts: 0, requestAuthCalls: 0, credentialFileAccesses: 0, childProcessAttempts: 0, routeCalls: 0 };
let fileReads = 0;
const forbidden = name => () => { counters[name]++; throw new Error(`Synthetic SDK proof forbids ${name}`); };
const require = createRequire(import.meta.url);
const defaultProfile = process.env.PI_CODING_AGENT_DIR;
function fileGuard(file) {
  if (file instanceof URL) file = fileURLToPath(file);
  if (typeof file !== 'string') return;
  const resolved = path.resolve(file);
  if (['auth.json', 'settings.json'].includes(path.basename(resolved)) || resolved === defaultProfile || resolved.startsWith(defaultProfile + '/')) {
    counters.credentialFileAccesses++;
    throw new Error('Synthetic SDK proof forbids default profile/credential/settings access');
  }
}
for (const op of ['readFileSync', 'readFile', 'openSync', 'open', 'writeFileSync', 'writeFile', 'existsSync', 'accessSync', 'statSync', 'lstatSync']) {
  const original = fs[op];
  fs[op] = function(file, ...args) { fileGuard(file); if (op.startsWith('readFile')) fileReads++; return original.call(this, file, ...args); };
}
for (const op of ['readFile', 'open', 'writeFile', 'access', 'stat', 'lstat']) {
  const original = fs.promises[op];
  fs.promises[op] = function(file, ...args) { fileGuard(file); if (op === 'readFile') fileReads++; return original.call(this, file, ...args); };
}
for (const mod of [require('node:http'), require('node:https')]) for (const op of ['get', 'request']) mod[op] = forbidden('networkAttempts');
require('node:net').Socket.prototype.connect = forbidden('networkAttempts');
require('node:dns').lookup = forbidden('networkAttempts');
require('node:dgram').createSocket = forbidden('networkAttempts');
globalThis.fetch = forbidden('networkAttempts');
const childProcess = require('node:child_process');
for (const op of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[op] = forbidden('childProcessAttempts');
syncBuiltinESMExports();

const sdk = process.env.HIBIKI_PI_ROOT;
const piVersion = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8')).version;
assert.ok(['1.4.0', '1.5.2'].includes(piVersion), 'Only explicitly reviewed Pi layouts may pass this compatibility proof');
const ts = require(path.join(process.env.HIBIKI_TYPESCRIPT_ROOT, 'lib/typescript.js'));
const emitted = path.join(home, 'compiled'); fs.mkdirSync(emitted);
for (const name of ['store', 'vault', 'reference', 'limit-catalog', 'pi-compat']) {
  const file = path.join(process.env.HIBIKI_PACKAGE_ROOT, 'lib/model-pick', `${name}.ts`);
  fs.writeFileSync(path.join(emitted, `${name}.js`), ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: file,
  }).outputText);
}
const { PickerStore, StoreError } = await import(pathToFileURL(path.join(emitted, 'store.js')));
const { readLimitCatalog, isVirtualLimitTarget } = await import(pathToFileURL(path.join(emitted, 'limit-catalog.js')));
// Real installed implementations, not a hand-built equivalent composition.
const { ModelRuntime } = await import(pathToFileURL(path.join(sdk, 'dist/core/model-runtime.js')));
const { ModelRegistry } = await import(pathToFileURL(path.join(sdk, 'dist/core/model-registry.js')));
const ai = path.join(sdk, 'node_modules/@earendil-works/pi-ai/dist');
const { InMemoryCredentialStore } = await import(pathToFileURL(path.join(ai, 'auth/credential-store.js')));
const { InMemoryModelsStore } = await import(pathToFileURL(path.join(ai, 'models-store.js')));
const NATIVE = 'openai-codex'; const ID = 'gpt-6.1-sol';
const encode = value => JSON.stringify(value, null, 2) + '\n';
const copy = value => JSON.parse(JSON.stringify(value));
const pair = value => ({ contextWindow: value.contextWindow, maxTokens: value.maxTokens });
const model = (id, contextWindow = 18000, maxTokens = 2000) => ({ id, name: id, reasoning: true, input: ['text'],
  contextWindow, maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const preserved = { rootFuture: { keep: true }, providers: {} };
const memorySnapshots = [];
async function fixture(config = preserved, seed = {}) {
  const profile = path.join(home, 'verified-profile'); fs.mkdirSync(profile);
  const modelsPath = path.join(profile, 'models.json'); fs.writeFileSync(modelsPath, encode(config), { mode: 0o600 });
  const credentials = new InMemoryCredentialStore();
  for (const [provider, credential] of Object.entries(seed)) await credentials.modify(provider, () => copy(credential));
  memorySnapshots.push({ credentials, seed: copy(seed) });
  credentials.modify = forbidden('requestAuthCalls');
  credentials.delete = forbidden('requestAuthCalls');
  const modelsStore = new InMemoryModelsStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath, modelsStore, refreshOnCreate: false, allowModelNetwork: false });
  // Fail-closed interlocks on request/auth entrypoints only; metadata composition
  // and refresh below remain the actual installed SDK implementation.
  for (const name of ['getAuth', 'login', 'logout', 'setRuntimeApiKey', 'removeRuntimeApiKey']) runtime[name] = forbidden('requestAuthCalls');
  for (const name of ['stream', 'streamSimple', 'complete', 'completeSimple', 'generateImages', 'classify', 'fetchDeferred', 'cancelDeferred']) runtime[name] = forbidden('networkAttempts');
  const registry = new ModelRegistry(runtime);
  const store = new PickerStore(profile, [NATIVE, 'sdk-static', 'sdk-native', 'sdk-oauth'], createSyntheticProtection(), modelsPath);
  const raw = () => fs.readFileSync(modelsPath, 'utf8');
  const configNow = () => JSON.parse(raw());
  const physical = (provider, id) => {
    const value = runtime.getPhysicalModel(provider, id);
    assert.ok(value, `Expected exact physical chat model ${provider}/${id}`);
    assert.deepEqual(registry.find(provider, id), value); return value;
  };
  const catalog = (provider, id, hasLocalDefinition = false, version = piVersion) => {
    const before = { ...counters }; const reads = fileReads;
    const result = readLimitCatalog(registry, provider, id, version, hasLocalDefinition);
    assert.equal(fileReads, reads, 'catalog reference must not read the profile');
    assert.deepEqual(counters, before, 'catalog reference must not resolve auth/network'); return result;
  };
  const targetGuard = (provider, id) => () => {
    if (isVirtualLimitTarget(registry, provider, id, piVersion)) throw new StoreError('PROTECTED');
    if (!runtime.getPhysicalModel(provider, id)) throw new StoreError('NOT_FOUND');
  };
  const put = (provider, id, patch) => store.putModelLimitsOverride(provider, id, patch,
    store.modelLimitsOverride(provider, id).revision, { recheck: () => ({ busy: false }) }, targetGuard(provider, id));
  const refresh = async () => {
    const result = await registry.refresh({ allowNetwork: false });
    assert.equal(result.aborted, false); assert.equal(result.errors.size, 0);
    assert.equal(registry.getError(), undefined);
    await new Promise(resolve => setImmediate(resolve));
  };
  return { profile, modelsPath, modelsStore, credentials, runtime, registry, store, raw, configNow, physical, catalog, targetGuard, put, refresh };
}
function nativeConfig() {
  return { rootFuture: { keep: true }, providers: { [NATIVE]: {
    headers: { 'X-Synthetic-Keep': 'opaque' }, providerFuture: { keep: true },
    modelOverrides: { [ID]: { futureOverride: { keep: true }, name: 'Keep local name' },
      'synthetic-unknown': { futureOverride: ['opaque'] } },
  } } };
}
function checkPreserved(f, provider, id, original) {
  const actual = copy(f.configNow());
  delete actual.providers[provider].modelOverrides[id].contextWindow;
  delete actual.providers[provider].modelOverrides[id].maxTokens;
  assert.deepEqual(actual, original, 'only the two reviewed override fields may change');
}
const cases = {
  async builtin() {
    const original = nativeConfig(); const f = await fixture(original);
    const baseline = copy(f.physical(NATIVE, ID)); const otherId = 'gpt-6-sol';
    assert.ok(f.runtime.getPhysicalModel(NATIVE, otherId));
    const allIds = f.runtime.getModels(NATIVE).map(m => m.id);
    const other = copy(f.physical(NATIVE, otherId));
    f.put(NATIVE, ID, { contextWindow: baseline.contextWindow + 1234 }); await f.refresh();
    assert.deepEqual(pair(f.physical(NATIVE, ID)), { contextWindow: baseline.contextWindow + 1234, maxTokens: baseline.maxTokens });
    f.put(NATIVE, ID, { maxTokens: 6000 }); await f.refresh();
    assert.deepEqual(pair(f.physical(NATIVE, ID)), { contextWindow: baseline.contextWindow + 1234, maxTokens: 6000 });
    f.put(NATIVE, ID, { contextWindow: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(NATIVE, ID)), { contextWindow: baseline.contextWindow, maxTokens: 6000 });
    f.put(NATIVE, ID, { contextWindow: null, maxTokens: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(NATIVE, ID)), pair(baseline));
    assert.deepEqual(f.runtime.getModels(NATIVE).map(m => m.id), allIds);
    assert.deepEqual(f.physical(NATIVE, otherId), other);
    assert.deepEqual(f.configNow(), original); assert.equal(f.configNow().providers[NATIVE].models, undefined);
    assert.deepEqual(f.catalog(NATIVE, ID).catalog, pair(baseline));
  },
  async directory() {
    const original = nativeConfig(); const f = await fixture(original);
    const baseline = copy(f.physical(NATIVE, ID)); const allIds = f.runtime.getModels(NATIVE).map(m => m.id);
    f.put(NATIVE, ID, { contextWindow: baseline.contextWindow + 1000, maxTokens: 4000 }); await f.refresh();
    const writeDirectory = async (contextWindow, maxTokens) => {
      await f.modelsStore.write(NATIVE, { models: [{ ...baseline, contextWindow, maxTokens }],
        lastModified: Date.UTC(2099, 0, 1), checkedAt: Date.now(), etag: 'synthetic-offline-only' });
      await f.refresh();
    };
    const newer = { contextWindow: baseline.contextWindow + 50000, maxTokens: baseline.maxTokens + 3000 };
    await writeDirectory(newer.contextWindow, newer.maxTokens);
    assert.deepEqual(pair(f.physical(NATIVE, ID)), { contextWindow: baseline.contextWindow + 1000, maxTokens: 4000 }, 'local override beats newer cached directory');
    assert.deepEqual(f.catalog(NATIVE, ID).catalog, newer, 'helper reads loaded base, not overridden or bundled values');
    assert.equal(f.catalog(NATIVE, ID, true).catalog, null, 'a local model definition makes builtin reference unsafe');
    assert.equal(f.catalog(NATIVE, ID, false, '1.4.1').catalog, null, 'unknown SDK version stays unknown');
    f.put(NATIVE, ID, { contextWindow: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(NATIVE, ID)), { contextWindow: newer.contextWindow, maxTokens: 4000 });
    f.put(NATIVE, ID, { contextWindow: null, maxTokens: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(NATIVE, ID)), newer); assert.deepEqual(f.configNow(), original);
    const newest = { contextWindow: newer.contextWindow + 50000, maxTokens: newer.maxTokens + 3000 };
    await writeDirectory(newest.contextWindow, newest.maxTokens);
    assert.deepEqual(pair(f.physical(NATIVE, ID)), newest, 'reset keeps inheriting subsequent directory updates');
    assert.deepEqual(f.catalog(NATIVE, ID).catalog, newest);
    assert.deepEqual(f.runtime.getModels(NATIVE).map(m => m.id), allIds);
  },
  async legacy() {
    const provider = 'sdk-static', id = 'registered/chat';
    const original = { rootFuture: { keep: true }, providers: { [provider]: {
      baseUrl: 'https://synthetic.invalid/v1', api: 'openai-responses',
      models: [model(id, 10000, 1000)], modelOverrides: { [id]: { futureOverride: { keep: true } } },
    } } };
    const f = await fixture(original); const registration = { api: 'openai-responses', baseUrl: 'https://synthetic.invalid/v1',
      apiKey: 'SYNTHETIC-UNUSED', models: [model(id), model('other/chat')] };
    f.registry.registerProvider(provider, registration); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 18000, maxTokens: 2000 }, 'extension replacement beats models.json definition');
    assert.deepEqual(f.catalog(provider, id, true).catalog, { contextWindow: 18000, maxTokens: 2000 });
    f.put(provider, id, { contextWindow: 36000 }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 36000, maxTokens: 2000 });
    f.put(provider, id, { maxTokens: 4000 }); await f.refresh();
    f.registry.registerProvider(provider, { models: [model(id, 24000, 3000), model('other/chat')] }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 36000, maxTokens: 4000 });
    f.put(provider, id, { contextWindow: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 24000, maxTokens: 4000 });
    f.put(provider, id, { contextWindow: null, maxTokens: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 24000, maxTokens: 3000 });
    assert.deepEqual(f.runtime.getModels(provider).map(m => m.id), [id, 'other/chat']);
    assert.deepEqual(f.catalog(provider, id, true).catalog, { contextWindow: 24000, maxTokens: 3000 });
    checkPreserved(f, provider, id, original);
  },
  async native() {
    const provider = 'sdk-native', id = 'native/chat';
    const original = { rootFuture: { keep: true }, providers: { [provider]: { modelOverrides: { [id]: { futureOverride: true } } } } };
    const f = await fixture(original); let reads = 0; let next = { contextWindow: 24000, maxTokens: 2000 };
    let live = [model(id, next.contextWindow, next.maxTokens), model('native/other')].map(m => ({ ...m, provider, api: 'openai-responses', baseUrl: 'https://synthetic.invalid/v1' }));
    const providerObject = { id: provider, name: 'Synthetic native provider', getModels() { reads++; return live; },
      auth: { apiKey: { name: 'Synthetic availability only', check: async () => ({ source: 'synthetic', type: 'api_key' }), resolve: forbidden('requestAuthCalls') } },
      refreshModels: async context => { assert.equal(context.allowNetwork, false); await context.publish({ update: () => {
        live = live.map(m => m.id === id ? { ...m, ...next } : m);
      } }); }, stream: forbidden('networkAttempts'), streamSimple: forbidden('networkAttempts') };
    f.registry.registerProvider(providerObject); await f.refresh();
    const before = reads; assert.equal(f.catalog(provider, id).catalog, null);
    assert.equal(reads, before, 'catalog helper must not invoke native extension callbacks');
    f.put(provider, id, { contextWindow: 48000 }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 48000, maxTokens: 2000 });
    f.put(provider, id, { maxTokens: 4000 }); next = { contextWindow: 32000, maxTokens: 3000 }; await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 48000, maxTokens: 4000 });
    f.put(provider, id, { maxTokens: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 48000, maxTokens: 3000 });
    f.put(provider, id, { contextWindow: null, maxTokens: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), next);
    assert.deepEqual(f.runtime.getModels(provider).map(m => m.id), [id, 'native/other']);
    checkPreserved(f, provider, id, original);
  },
  async oauth() {
    const provider = 'sdk-oauth', id = 'oauth/chat';
    const oauth = { type: 'oauth', access: 'SYNTHETIC-ACCESS', refresh: 'SYNTHETIC-REFRESH', expires: Date.now() + 86400000, future: { keep: true } };
    const original = { rootFuture: { keep: true }, providers: { [provider]: { modelOverrides: { [id]: { futureOverride: { keep: true } } } } } };
    const f = await fixture(original, { [provider]: oauth }); let projections = 0; let projected = { contextWindow: 24000, maxTokens: 3000 };
    f.registry.registerProvider(provider, { api: 'openai-responses', baseUrl: 'https://synthetic.invalid/v1', models: [model(id), model('oauth/other')],
      oauth: { name: 'Synthetic legacy OAuth', login: forbidden('requestAuthCalls'), refreshToken: forbidden('requestAuthCalls'), getApiKey: forbidden('requestAuthCalls'),
        modifyModels(models, credential) {
          projections++; assert.deepEqual(credential, oauth);
          return models.map(m => m.id === id ? { ...m, ...projected } : m);
        } },
    });
    await f.refresh(); assert.ok(projections > 0, 'real SDK invoked legacy OAuth projection');
    assert.deepEqual(pair(f.physical(provider, id)), projected);
    const before = projections; assert.equal(f.catalog(provider, id).catalog, null);
    assert.equal(projections, before, 'reference reader must not invoke OAuth projection');
    f.put(provider, id, { contextWindow: 48000 }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 48000, maxTokens: 3000 });
    f.put(provider, id, { maxTokens: 5000 }); projected = { contextWindow: 32000, maxTokens: 4000 }; await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 48000, maxTokens: 5000 }, 'modelOverrides applied after OAuth projection');
    f.put(provider, id, { contextWindow: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), { contextWindow: 32000, maxTokens: 5000 });
    f.put(provider, id, { contextWindow: null, maxTokens: null }); await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), projected);
    projected = { contextWindow: 40000, maxTokens: 6000 }; await f.refresh();
    assert.deepEqual(pair(f.physical(provider, id)), projected, 'reset continues inheriting future account projection');
    assert.deepEqual(f.runtime.getModels(provider).map(m => m.id), [id, 'oauth/other']);
    checkPreserved(f, provider, id, original);
  },
  async unknown() {
    const missing = 'synthetic-does-not-exist'; const original = nativeConfig();
    original.providers[NATIVE].modelOverrides[missing] = { contextWindow: 1234567, maxTokens: 1234, future: { keep: true } };
    const f = await fixture(original); const allIds = f.runtime.getModels(NATIVE).map(m => m.id); await f.refresh();
    assert.equal(f.registry.find(NATIVE, missing), undefined); assert.equal(f.runtime.getPhysicalModel(NATIVE, missing), undefined);
    assert.equal(f.catalog(NATIVE, missing).catalog, null);
    assert.equal(isVirtualLimitTarget(f.registry, NATIVE, missing, piVersion), false, 'unknown is not mislabelled virtual');
    const before = f.raw(); assert.throws(() => f.put(NATIVE, missing, { maxTokens: 5000 }), { code: 'NOT_FOUND' });
    assert.equal(f.raw(), before); assert.deepEqual(f.runtime.getModels(NATIVE).map(m => m.id), allIds);
    assert.equal(fs.existsSync(path.join(f.profile, 'model-pick-data')), false, 'refusal happens before any lock/history write');
  },
  async virtual() {
    const alias = 'synthetic-auto'; const original = nativeConfig();
    // Direct fixture config deliberately contains an ignored alias override. The
    // authorized store path below must refuse this alias, never claim success.
    original.providers[NATIVE].modelOverrides[alias] = { contextWindow: 999999, maxTokens: 9999 };
    const f = await fixture(original);
    f.registry.registerVirtualModel({ provider: NATIVE, id: alias, name: 'Synthetic alias', contextWindow: 42000, maxTokens: 4000,
      route: forbidden('routeCalls') }); await f.refresh();
    assert.deepEqual(pair(f.registry.find(NATIVE, alias)), { contextWindow: 42000, maxTokens: 4000 });
    assert.equal(f.registry.find(NATIVE, alias).api, 'pi-virtual');
    assert.equal(f.runtime.getPhysicalModel(NATIVE, alias), undefined);
    assert.equal(isVirtualLimitTarget(f.registry, NATIVE, alias, piVersion), true);
    assert.equal(isVirtualLimitTarget(f.registry, NATIVE, ID, piVersion), false);
    assert.equal(isVirtualLimitTarget(f.registry, NATIVE, ID, 'unverified-version'), true, 'unknown version fails closed');
    assert.equal(f.catalog(NATIVE, alias).catalog, null);
    const before = f.raw(); assert.throws(() => f.put(NATIVE, alias, { contextWindow: 80000 }), { code: 'PROTECTED' });
    assert.equal(f.raw(), before);
    assert.equal(fs.existsSync(path.join(f.profile, 'model-pick-data')), false);
    assert.ok(f.runtime.getModels(NATIVE).some(m => m.id === ID), 'alias does not replace physical catalog');
  },
};
const scenario = process.argv[2]; assert.ok(Object.hasOwn(cases, scenario), 'Unknown proof scenario');
await cases[scenario]();
// Let SDK fire-and-forget registration refreshes settle before the final safety
// accounting; none is permitted to access credentials, route, or the network.
await new Promise(resolve => setImmediate(resolve));
for (const { credentials, seed } of memorySnapshots) {
  const actual = {};
  for (const info of await credentials.list()) actual[info.providerId] = await credentials.read(info.providerId);
  assert.deepEqual(actual, seed);
}
assert.equal(fs.readdirSync(home).includes(path.basename(defaultProfile)), false, 'SDK default profile remains absent');
for (const value of Object.values(counters)) assert.equal(value, 0);
console.log(JSON.stringify({ scenario, status: 'PASS', piVersion, offline: true, sanitizedEnvironment: true, ...counters,
  unusedCliProfileUntouched: true, memoryCredentialsUnchanged: true }));
