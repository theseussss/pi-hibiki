import assert from 'node:assert/strict';
import { variantRoots } from '../scripts/tooling.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadTypeScript } from './model-pick-loader.mjs';
import { baseConfig, harness, tui, enterManualIds } from './model-pick-ui-harness.mjs';

const { productionRoot } = variantRoots();
const entry = (root) => path.join(root, 'extensions/model-pick.ts');
const logicalHome = '/home/model-pick-synthetic-production-user';
const settings = (p) => fs.readFileSync(path.join(p.root, 'settings.json'), 'utf8');
const query = p => p.lines()[2].trim().replace(/^› /u, '');
const production = (t, options = {}) => harness(t, { entryFile: entry(productionRoot), logicalHome, ...options });

function factory(root) {
  const calls = []; const commands = []; const shortcuts = [];
  const forbidden = (name) => (...args) => { calls.push([name, ...args]); assert.fail(`factory attempted runtime access: ${name}`); };
  const boundedFs = new Proxy({}, { get(_target, name) { return name === 'constants' ? fs.constants : forbidden(`fs.${String(name)}`); } });
  const api = loadTypeScript(entry(root), {
    'node:fs': boundedFs, 'node:os': { homedir: forbidden('HOME') }, '@earendil-works/pi-tui': tui,
    '@earendil-works/pi-coding-agent': { getAgentDir: forbidden('agentDir'), getPackageDir: forbidden('packageDir') },
    '@earendil-works/pi-ai/providers/all': { getBuiltinProviders: forbidden('catalog') },
    '../lib/model-pick/protection.js': { createRecordProtection: forbidden('native protection') },
  }, { process: { pid: 1, getuid: () => 1000, env: {} }, fetch: forbidden('network') });
  api.default({ registerCommand: (name, command) => commands.push([name, command]), registerShortcut: (name) => shortcuts.push(name) });
  return { calls, commands, shortcuts };
}

function assertSyntheticOnly(p) {
  assert.equal(p.logicalHome, logicalHome); assert.doesNotMatch(p.logicalHome, /^\/tmp\//);
  assert.match(p.home, /^\/tmp\/model-pick-[^/]+$/); assert.notEqual(p.home, logicalHome);
  assert.ok(p.physicalIo.length > 0, 'the actual production entry must reach its synthetic store');
  for (const [_method, ...files] of p.physicalIo) for (const file of files) assert.ok(file === p.home || file.startsWith(p.home + path.sep), 'physical IO escaped the /tmp fixture');
  assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.selections.length, 0);
  assert.ok(p.refreshes.length > 0); assert.ok(p.refreshes.every((options) => options.allowNetwork === false));
}

test('public TypeScript entry has all runtime libraries and no private development brake', () => {
  for (const name of ['controls', 'order', 'panel', 'probe', 'protection', 'records', 'reference', 'store', 'vault']) {
    assert.ok(fs.readFileSync(path.join(productionRoot, `lib/model-pick/${name}.ts`)).length > 0, name);
  }
  const released = fs.readFileSync(entry(productionRoot), 'utf8');
  assert.doesNotMatch(released, /candidateProfileAllowed/);
  for (const name of ['store', 'records', 'protection', 'panel', 'probe', 'order', 'component', 'provider-commit', 'storage-context']) assert.ok(new RegExp(`from ['"]\\.\\./lib/model-pick/${name}\\.js['"]`).test(released), `runtime import: ${name}`);
  assert.doesNotMatch(released, /from ['"][^'"]*\.cache\//);
});

test('actual production factory registers in an ordinary logical HOME without reading a profile or initializing helpers', () => {
  const p = factory(productionRoot);
  assert.deepEqual(p.commands.map(([name]) => name), ['models']); assert.deepEqual(p.shortcuts, ['ctrl+l']); assert.deepEqual(p.calls, []);
  assert.match(p.commands[0][1].description, /Tab.*Alt\+数字/); assert.doesNotMatch(p.commands[0][1].description, /Alt\+A/);
});

test('actual production Alt+N adds a model through real controls/store, retaining query, current/default and existing data', async (t) => {
  const p = await production(t); const before = p.config(); const defaultBefore = settings(p); const currentBefore = p.current();
  assert.match(p.screen(), /Pi Models · 模型管理/); assert.match(p.screen(), /添加模型 \[7\]/); assert.doesNotMatch(p.screen(), /Alt\+A/);
  p.type('p0'); p.send('down'); const matrix = p.raw();
  p.send('\x1bn'); assert.equal(p.debug().view, 'basket'); p.type('cancelled-draft'); p.action('back'); assert.equal(p.raw(), matrix);
  assert.deepEqual(p.config(), before);
  p.send('\x1bn'); enterManualIds(p, 'production-model'); assert.match(p.screen(), /已选 1/);
  assert.deepEqual(p.config(), before, 'picking is not save consent'); p.action('next-models'); p.action('skip'); p.action('commit'); p.action('commit'); await p.settled();
  const after = p.config(); assert.equal(after.providers.p01.models.at(-1).id, 'production-model');
  assert.deepEqual(after.providers.p01.models.slice(0, -1), before.providers.p01.models); assert.deepEqual(after.providers.p00, before.providers.p00); assert.deepEqual(after.futureRoot, before.futureRoot);
  assert.match(p.screen(), /Pi Models · 模型管理/); assert.equal(query(p), 'p0'); assert.equal(settings(p), defaultBefore); assert.deepEqual(p.current(), currentBefore);
  assert.ok(p.protection.state.seals.length > 0, 'actual store writes use mocked protection, not a stubbed mutation');
  assert.ok(fs.existsSync(path.join(p.root, 'model-pick-data/vault.auto.json'))); assertSyntheticOnly(p);
});

test('actual production provider-focus Alt+N creates a supplier and models without losing query or changing current/default', async (t) => {
  const p = await production(t); const before = p.config(); const defaultBefore = settings(p); const currentBefore = p.current();
  p.type('p0'); p.send('down'); p.send('left'); p.send('left'); const matrix = p.raw();
  assert.match(p.screen(), /添加供应商 \[9\]/); p.send('\x1bn'); assert.equal(p.debug().view, 'connection');
  p.type('cancelled'); p.send('esc'); assert.equal(p.raw(), matrix); assert.deepEqual(p.config(), before);
  p.send('\x1bn'); p.type('Production Bridge'); p.send('tab'); p.type('https://production-synthetic.test/v1'); p.send('tab'); p.send('tab'); p.type('SYNTHETIC_PRODUCTION_KEY'); p.action('manual-connection'); await p.waitForView('basket');
  assert.equal(Object.keys(p.config().providers).length, 2, 'connection state is only a draft');
  enterManualIds(p, 'production-first,production-second'); assert.match(p.screen(), /已选 2/); assert.deepEqual(p.config(), before);
  p.action('next-models'); p.action('skip'); p.action('commit'); p.action('commit'); await p.settled(); const after = p.config(); const created = after.providers['production-bridge'];
  assert.equal(created.name, 'Production Bridge'); assert.equal(created.baseUrl, 'https://production-synthetic.test/v1'); assert.equal('apiKey' in created, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'auth.json'), 'utf8'))['production-bridge'].key, 'SYNTHETIC_PRODUCTION_KEY');
  assert.deepEqual(created.models.map((model) => model.id), ['production-first', 'production-second']); assert.deepEqual(after.providers.p00, before.providers.p00); assert.deepEqual(after.providers.p01, before.providers.p01); assert.deepEqual(after.futureRoot, before.futureRoot);
  assert.match(p.screen(), /Pi Models · 模型管理/); assert.equal(query(p), 'p0'); assert.equal(settings(p), defaultBefore); assert.deepEqual(p.current(), currentBefore); assertSyntheticOnly(p);
});

test('production has no Alt+A fallback alias in either model or supplier focus, including enhanced keys', async (t) => {
  const p = await production(t); const before = p.config(); const defaultBefore = settings(p);
  for (const providerFocus of [false, true]) {
    if (providerFocus) { p.send('left'); p.send('left'); }
    const matrix = p.raw();
    for (const key of ['\x1ba', '\x1b[97;3u']) { p.send(key); assert.equal(p.raw(), matrix); }
    assert.match(p.screen(), /Pi Models · 模型管理/); assert.doesNotMatch(p.screen(), /搜索或输入模型 ID|名称:/); assert.deepEqual(p.config(), before);
  }
  assert.equal(settings(p), defaultBefore); assert.equal(p.protection.state.seals.length, 0); assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data'))); assertSyntheticOnly(p);
});

test('production paste cannot turn the new dangerous Alt+N key into add/remove/cancel commands', async (t) => {
  const p = await production(t); const before = p.config(); const defaultBefore = settings(p); let finished = false;
  p.finished.then(() => { finished = true; }); p.send('\x1b[200~synthetic-query'); p.send('\x1bn'); p.send('\x1bx'); p.send('cancel'); p.send('\x1b[201~'); await p.flush();
  assert.equal(finished, false); assert.match(p.screen(), /Pi Models · 模型管理/); assert.doesNotMatch(p.screen(), /搜索或输入模型 ID|名称:/); assert.deepEqual(p.config(), before); assert.equal(settings(p), defaultBefore);
  assert.equal(p.protection.state.seals.length, 0); assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data'))); assertSyntheticOnly(p);
});

test('production draft own-list authorization selects two actual returned IDs and commits independently', async t => {
  const p = await production(t, { fetcher: async () => new Response(JSON.stringify({ data: [{ id: 'upstream-first' }, { id: 'upstream-second' }] }), { headers: { 'content-type': 'application/json' } }) });
  const before = p.config(), defaults = settings(p), current = p.current();
  p.action('new-provider'); p.type('Own List'); p.send('tab'); p.type('https://own-list-synthetic.test/v1'); p.send('tab'); p.send('tab'); p.type('SYNTHETIC_OWN_LIST_KEY');
  assert.equal(p.calls.length, 0); assert.deepEqual(p.config(), before); assert.ok(!fs.existsSync(path.join(p.root, 'auth.json')));
  assert.doesNotMatch(p.screen() + JSON.stringify(p.debug()), /SYNTHETIC_OWN_LIST_KEY/);
  p.action('connect'); await p.waitForView('basket');
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0][0], 'https://own-list-synthetic.test/v1/models');
  assert.equal(p.calls[0][1].method, 'GET'); assert.equal(new Headers(p.calls[0][1].headers).get('authorization'), 'Bearer SYNTHETIC_OWN_LIST_KEY');
  assert.equal(p.authCalls(), 0); assert.deepEqual(p.config(), before); assert.ok(!fs.existsSync(path.join(p.root, 'auth.json')));
  p.send('down'); p.send('enter'); p.send('down'); p.send('enter'); assert.match(p.screen(), /已选 2/);
  p.action('next-models'); p.action('skip'); assert.equal(p.debug().view, 'report'); assert.deepEqual(p.config(), before);
  p.action('commit'); assert.equal(p.debug().view, 'confirm'); assert.deepEqual(p.config(), before); assert.ok(!fs.existsSync(path.join(p.root, 'auth.json')));
  p.action('commit'); await p.waitForView('matrix');
  assert.deepEqual(p.config().providers['own-list'].models.map(m => m.id), ['upstream-first', 'upstream-second']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'auth.json'), 'utf8'))['own-list'].key, 'SYNTHETIC_OWN_LIST_KEY');
  assert.deepEqual(p.config().providers.p00, before.providers.p00); assert.deepEqual(p.config().providers.p01, before.providers.p01);
  assert.equal(settings(p), defaults); assert.deepEqual(p.current(), current); assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 1);
});

test('production current model metadata edit uses real rendered review and canonical local rebind', async t => {
  const config = baseConfig(); config.providers.p00.models[0].baseUrl = 'https://model-override-synthetic.test/v2';
  const p = await production(t, { config }); const before = p.config(), defaults = settings(p);
  assert.equal(p.current().baseUrl, 'https://model-override-synthetic.test/v2');
  p.type('p00'); p.action('edit-model'); assert.equal(p.debug().view, 'edit');
  p.replace('Production renamed current'); p.send('tab'); p.replace('256000'); p.action('save-form');
  assert.equal(p.debug().view, 'confirm'); assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0);
  p.action('apply-inspect'); await p.waitForView('matrix');
  assert.equal(p.config().providers.p00.models[0].name, 'Production renamed current');
  assert.equal(p.config().providers.p00.models[0].contextWindow, 256000);
  assert.deepEqual(p.config().providers.p00.models[0].advanced, { untouched: true }); assert.deepEqual(p.config().futureRoot, before.futureRoot);
  assert.equal(p.current().id, 'm0'); assert.equal(p.current().contextWindow, 256000); assert.equal(p.current().baseUrl, 'https://model-override-synthetic.test/v2'); assert.equal(p.selections.length, 1);
  assert.equal(settings(p), defaults); assert.equal(query(p), 'p00'); assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
});
