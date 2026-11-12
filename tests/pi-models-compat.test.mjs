import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';

const source = fileURLToPath(new URL('../lib/model-pick/storage-context.ts', import.meta.url));
const binding = { agentDir: '/tmp/model-pick-profile', modelsPath: '/tmp/model-pick-profile/models.json', authPath: '/tmp/model-pick-profile/auth.json' };
const registry = () => ({ runtime: { modelsPath: binding.modelsPath, credentials: { store: { authPath: binding.authPath } } } });
function adapter(version) {
  const forbidden = () => { assert.fail('Profile identity must not import credential locks or guess the CLI profile'); };
  return loadTypeScript(source, { '@earendil-works/pi-coding-agent': { VERSION: version, getAgentDir: forbidden, getPackageDir: forbidden } });
}
const plain = value => JSON.parse(JSON.stringify(value));

for (const version of ['1.4.0', '1.5.2', '1.5.3', 'unknown']) {
  test(`verified file paths remain readable independently of credential-write compatibility (${version})`, async () => {
    const storage = await adapter(version).resolvePickerStorage(registry());
    assert.deepEqual(plain(storage), binding);
  });
}

test('trusted SDK binding stays exact; split roots require an explicit host assertion', async () => {
  const api = adapter('1.5.2');
  assert.deepEqual(plain(await api.resolvePickerStorage({}, binding)), binding);
  const split = { ...binding, authPath: '/tmp/model-pick-other/auth.json' };
  const runtime = { runtime: { modelsPath: split.modelsPath, credentials: { store: { authPath: split.authPath } } } };
  assert.equal(await api.resolvePickerStorage(runtime), null);
  assert.deepEqual(plain(await api.resolvePickerStorage(runtime, split)), split);
  assert.equal(await api.resolvePickerStorage(registry(), split), null);
  assert.equal(await api.resolvePickerStorage({ runtime: { modelsPath: undefined } }, binding), null);
});

test('unknown, memory-only, malformed, accessor and proxy storage cannot fall back to HOME', async () => {
  const api = adapter('1.5.2');
  const forbidden = () => { assert.fail('Do not invoke SDK/profile accessors or proxy traps'); };
  for (const value of [null, {}, { runtime: {} }, { runtime: { modelsPath: undefined } },
    { runtime: { modelsPath: 'relative/models.json', credentials: { store: { authPath: binding.authPath } } } },
    { runtime: Object.defineProperty({}, 'modelsPath', { get: forbidden }) },
    Object.defineProperty({}, 'runtime', { get: forbidden }),
    new Proxy({}, { get: forbidden, getOwnPropertyDescriptor: forbidden }),
    { runtime: new Proxy({}, { get: forbidden, getOwnPropertyDescriptor: forbidden }) },
  ]) assert.equal(await api.resolvePickerStorage(value), null);
  for (const trusted of [null, {}, { ...binding, agentDir: 'relative' }, { ...binding, authPath: 'bad\0path' },
    Object.defineProperty({ ...binding }, 'modelsPath', { get: forbidden }),
    new Proxy(binding, { get: forbidden, getOwnPropertyDescriptor: forbidden }),
  ]) assert.equal(await api.resolvePickerStorage({}, trusted), null);
});

test('equivalent absolute paths are normalized before comparing the asserted profile', async () => {
  const api = adapter('1.5.2');
  const equivalent = { ...binding, modelsPath: path.join(binding.agentDir, 'nested') + '/../models.json' };
  assert.deepEqual(plain(await api.resolvePickerStorage(registry(), equivalent)), binding);
});

test('Pi 1.5.2 metadata compatibility retains physical targets and excludes virtual aliases', () => {
  const api = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/limit-catalog.ts', import.meta.url)));
  const model = { id: 'physical', contextWindow: 128000, maxTokens: 8192 };
  const r = { runtime: { builtins: new Map([['p', { getModels: () => [model] }]]), virtualModels: new Map([['p', new Map([['alias', {}]])]]) } };
  assert.equal(api.isVirtualLimitTarget(r, 'p', 'physical', '1.5.2'), false);
  assert.equal(api.isVirtualLimitTarget(r, 'p', 'alias', '1.5.2'), true);
  assert.deepEqual(plain(api.readLimitCatalog(r, 'p', 'physical', '1.5.2', false).catalog), { contextWindow: 128000, maxTokens: 8192 });
  assert.equal(api.isVirtualLimitTarget(r, 'p', 'physical', '1.5.3'), true);
  assert.equal(api.readLimitCatalog(r, 'p', 'physical', '1.5.3', false).catalog, null);
});
