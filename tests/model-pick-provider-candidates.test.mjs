import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
import { tui, paint, mountActions, enterManualIds, harness as extensionHarness, baseConfig } from './model-pick-ui-harness.mjs';

const source = process.env.MODEL_PICK_SCOPE_PANEL || fileURLToPath(new URL('../lib/model-pick/panel.ts', import.meta.url));
const clone = v => JSON.parse(JSON.stringify(v));
const own = id => ({ provider: 'own', id, contextWindow: 32000, maxTokens: 1024 });
const foreign = (count = 1200) => Array.from({ length: count }, (_, i) => ({ provider: 'foreign', id: `foreign-${i}`, contextWindow: 64000, maxTokens: 4096 }));
const tick = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
function rig(t, { catalog = foreign(), providers = [{ id: 'own', name: 'Own', endpoint: 'https://own.test/v1', api: 'openai-completions', models: [{ id: 'configured' }] }], replies = [{ data: [{ id: 'upstream-only' }] }], failCompletion = false } = {}) {
  const requests = [], auth = [], events = [], commits = [];
  const api = loadTypeScript(source, { '@earendil-works/pi-tui': tui, 'node:fs': {} }, {
    fetch: async (url, options) => { requests.push([url, options]); const body = replies.shift(); return new Response(JSON.stringify(body?.body ?? body), { status: body?.status ?? 200, headers: { 'content-type': 'application/json' } }); },
  });
  const actions = new api.PickerActions({
    store: { snapshot: () => ({ revision: 'r0', providers: clone(providers) }), retained: () => ({ providers: [], models: [] }), lock() {}, hasPending: () => false,
      putModels(provider, models) { commits.push({ kind: 'models', provider, models: clone(models) }); } },
    providerCommit: { async snapshotCredential() { return { revision: 'credential-r0' }; }, async commit({ change }) { assert.equal(change.kind, 'add'); commits.push({ kind: 'provider', provider: clone(change.provider), models: clone(change.models) }); return { status: 'committed' }; } },
    records: { hasData: () => false, tests: () => [], credentialVersion: () => 'synthetic', append(value) { if (value.kind === 'discovery' && failCompletion) throw new Error('synthetic completion failure'); events.push(clone(value)); }, appendMany(values) { events.push(...clone(values)); } },
    catalog: () => catalog, guard: () => ({}), changed: async () => {}, requestRender() {}, paint,
    auth: async provider => { auth.push(provider); const p = providers.find(p => p.id === provider); assert.ok(p); return { scope: { provider, modelId: 'catalog', endpoint: p.endpoint, api: p.api, credentialVersion: 'synthetic' }, headers: {} }; },
    authDraft: async p => { auth.push(p.id); return { scope: { provider: p.id, modelId: 'catalog', endpoint: p.endpoint, api: p.api, credentialVersion: 'synthetic' }, headers: {} }; },
  });
  const driver = mountActions(actions); t.after(() => { driver.dispose(); actions.dispose(); });
  return { ...driver, actions, requests, auth, events, commits,
    snapshot() { return clone(actions.taskSnapshot()); },
    open(provider = 'own') { actions.open({ kind: 'model', provider, modelId: 'configured' }, 'add'); driver.render(); },
    async draft() { actions.open({}, 'new-provider'); driver.render(); this.type('New Supplier'); this.send('tab'); this.type('https://new.test/v1'); this.choose('manual-connection'); await tick(); driver.render(); },
    async discover() { this.choose('read-list'); this.choose('connect'); await tick(); driver.render(); },
    async commit() { this.choose('next-models'); this.choose('skip'); this.choose('commit'); assert.equal(this.commits.length, 0); this.choose('commit'); await tick(); },
  };
}

test('foreign catalog 1200 cannot become candidates when this provider has no unconfigured models', t => {
  const p = rig(t, { catalog: [own('configured'), ...foreign()] }); p.open();
  assert.equal(p.snapshot().candidates.length, 0); assert.equal(p.snapshot().selected.length, 0); assert.doesNotMatch(p.screen(), /foreign-/);
  assert.deepEqual(p.auth, []); assert.deepEqual(p.requests, []); assert.deepEqual(p.events, []); assert.deepEqual(p.commits, []);
});

test('only explicitly owned unconfigured IDs appear, deduplicated; overlapping foreign IDs do not erase valid own entries', t => {
  const p = rig(t, { catalog: [own('configured'), own('own-a'), own('own-a'), own('own-b'), { provider: 'foreign', id: 'own-a' }, ...foreign()] }); p.open();
  assert.deepEqual(p.snapshot().candidates.map(m => m.id), ['own-a', 'own-b']); assert.match(p.screen(), /own-a/); assert.match(p.screen(), /own-b/);
  assert.doesNotMatch(p.screen(), /□ configured|foreign-/); assert.deepEqual(p.requests, []);
});

test('opening another provider builds a separate list instead of retaining the previous provider cache', t => {
  const providers = ['own', 'second'].map(id => ({ id, endpoint: `https://${id}.test/v1`, api: 'openai-completions', models: [{ id: 'configured' }] }));
  const p = rig(t, { providers, catalog: [own('only-own'), { provider: 'second', id: 'only-second' }, ...foreign()] });
  p.open(); assert.match(p.screen(), /only-own/); assert.doesNotMatch(p.screen(), /only-second|foreign-/);
  p.open('second'); assert.match(p.screen(), /only-second/); assert.doesNotMatch(p.screen(), /only-own|foreign-/); assert.deepEqual(p.requests, []);
});

test('successful discovery uses only this response, excludes configured IDs, and retains the exact filter', async t => {
  const p = rig(t, { catalog: [own('local-but-not-returned'), ...foreign()], replies: [{ data: [{ id: 'returned-one' }, { id: 'returned-two' }, { id: 'configured' }, { id: 'returned-one' }] }] });
  p.open(); p.type('kept-filter'); await p.discover(); assert.match(p.screen(), /› kept-filter/);
  p.send('esc'); p.send('clear'); assert.deepEqual(p.snapshot().candidates.map(m => m.id), ['returned-one', 'returned-two']); assert.match(p.screen(), /returned-one/); assert.match(p.screen(), /returned-two/);
  assert.doesNotMatch(p.screen(), /local-but-not-returned|foreign-|□ configured/);
  assert.equal(p.requests.length, 1); assert.equal(p.requests[0][0], 'https://own.test/v1/models'); assert.equal(p.requests[0][1].method, 'GET');
  assert.deepEqual(p.auth, ['own']); assert.deepEqual(p.commits, []);
});

test('a successful empty response stays empty rather than falling back to local or global templates', async t => {
  const p = rig(t, { catalog: [own('local-stale'), ...foreign()], replies: [{ data: [] }] }); p.open(); await p.discover();
  assert.equal(p.snapshot().candidates.length, 0); assert.doesNotMatch(p.screen(), /local-stale|foreign-/);
  assert.equal(p.events.at(-1).count, 0); assert.equal(p.requests.length, 1); assert.deepEqual(p.commits, []);
});

test('failed refresh preserves the last successful list, never silently restores templates', async t => {
  const p = rig(t, { catalog: [own('local-stale'), ...foreign()], replies: [{ data: [{ id: 'previous-result' }] }, { status: 503, body: {} }] }); p.open(); await p.discover();
  p.send('esc'); p.send('clear'); assert.match(p.screen(), /previous-result/); await p.discover(); p.send('esc'); p.send('clear');
  assert.equal(p.snapshot().candidates.length, 1); assert.match(p.screen(), /previous-result/); assert.doesNotMatch(p.screen(), /local-stale|foreign-/);
  assert.equal(p.requests.length, 2); assert.equal(p.events.at(-1).code, 'server'); assert.deepEqual(p.commits, []);
});

test('an unrecorded completion does not publish new response candidates or change the previous list', async t => {
  const p = rig(t, { catalog: [own('owned-before'), ...foreign()], replies: [{ data: [{ id: 'must-not-publish' }] }], failCompletion: true }); p.open(); await p.discover();
  assert.match(p.screen(), /owned-before/); assert.doesNotMatch(p.screen(), /must-not-publish|foreign-/); assert.match(p.readContent(), /record-failed/);
  assert.equal(p.events.length, 1); assert.equal(p.events[0].kind, 'discovery-start'); assert.deepEqual(p.commits, []);
});

test('global templates still fill explicitly typed model specs without advertising foreign candidates', async t => {
  const p = rig(t, { catalog: [{ provider: 'foreign', id: 'typed-reference', contextWindow: 64000, maxTokens: 4096, apiKey: 'SYNTHETIC-NOT-TRANSFERABLE', baseUrl: 'https://foreign.test/v1', cost: { input: 99 } }] }); p.open();
  assert.equal(p.snapshot().candidates.length, 0); assert.doesNotMatch(p.screen(), /typed-reference/);
  enterManualIds(p, 'typed-reference'); assert.equal(p.snapshot().selected.length, 1); assert.deepEqual(p.commits, []);
  await p.commit(); const model = p.commits[0].models[0];
  assert.equal(p.commits[0].provider, 'own'); assert.equal(model.contextWindow, 64000); assert.equal(model.maxTokens, 4096);
  assert.ok(!('apiKey' in model)); assert.ok(!('baseUrl' in model)); assert.ok(!('api' in model)); assert.ok(!('cost' in model));
  assert.equal(p.events.find(e => e.kind === 'resolution').provenance.contextWindow.source, 'generic'); assert.deepEqual(p.requests, []);
});

test('a new supplier draft offers own-list discovery with no invented catalog; manual IDs still require independent commit', async t => {
  const p = rig(t); await p.draft();
  assert.equal(p.snapshot().candidates.length, 0); assert.equal(p.snapshot().selected.length, 0); assert.doesNotMatch(p.screen(), /foreign-/); assert.ok(p.snapshot().actions.some(a => a.id === 'read-list')); assert.deepEqual(p.auth, []);
  enterManualIds(p, 'new-exact-id'); assert.deepEqual(p.commits, []); await p.commit();
  assert.equal(p.commits[0].kind, 'provider'); assert.equal(p.commits[0].models[0].id, 'new-exact-id'); assert.deepEqual(p.requests, []);
});

test('returning to change a supplier connection cannot populate draft candidates from other providers', async t => {
  const p = rig(t); await p.draft();
  enterManualIds(p, 'kept-draft'); p.choose('back'); assert.equal(p.snapshot().kind, 'connection');
  // Back retains the actual private form. Navigate with ordinary keys, not Inputs.
  p.send('tab'); p.send('clear'); p.type('https://changed.test/v2'); p.choose('manual-connection'); await tick();
  assert.equal(p.snapshot().candidates.length, 0); assert.equal(p.snapshot().selected.length, 1); assert.match(p.screen(), /kept-draft/); assert.doesNotMatch(p.screen(), /foreign-/);
  assert.deepEqual(p.auth, []); assert.deepEqual(p.requests, []); assert.deepEqual(p.commits, []);
});

test('manual picks survive an authoritative empty response and still require a separate save', async t => {
  const p = rig(t, { replies: [{ data: [] }] }); p.open(); enterManualIds(p, 'manual-kept'); await p.discover();
  assert.equal(p.snapshot().candidates.length, 0); assert.equal(p.snapshot().selected.length, 1); assert.match(p.screen(), /manual-kept/); assert.deepEqual(p.commits, []);
  await p.commit(); assert.equal(p.commits[0].models[0].id, 'manual-kept'); assert.equal(p.requests.length, 1);
});

test('actual extension discovery routes to the focused supplier endpoint, not the current model or a foreign catalog', async t => {
  const config = baseConfig(); config.providers.p00.baseUrl = 'https://current-model.test/v1'; config.providers.p01.baseUrl = 'https://focused-provider.test/custom/v2';
  const p = await extensionHarness(t, { config, fetcher: async () => new Response(JSON.stringify({ data: [{ id: 'focused-only' }] }), { headers: { 'content-type': 'application/json' } }) });
  const before = p.config(); p.send('down'); p.send('\x1bn'); p.select('read-list'); p.select('connect'); await p.settled(); await p.flush();
  p.send('clear'); assert.match(p.screen(), /focused-only/); assert.equal(p.calls.length, 1); assert.equal(p.calls[0][0], 'https://focused-provider.test/custom/v2/models');
  assert.equal(p.calls[0][1].method, 'GET'); assert.equal(p.authCalls(), 1); assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0);
});
