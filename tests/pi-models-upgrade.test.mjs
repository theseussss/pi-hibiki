import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './model-pick-ui-harness.mjs';

const fixtureFiles = () => ({
  'model-pick-favorites.json': ['p00/m0', 'p01/m1', 'temporarily-absent/keep-favorite'],
  'model-pick-order.json': { providers: ['p01', 'temporarily-absent', 'p00'], models: { 'temporarily-absent': ['keep-favorite'] }, future: { keep: true } },
  'model-pick-theme.json': { theme: 'dusk', future: { keep: true } },
});
const raw = (p, name) => fs.readFileSync(path.join(p.root, name), 'utf8');
const snapshot = p => Object.fromEntries(['models.json', 'settings.json', ...Object.keys(fixtureFiles())].map(name => [name, raw(p, name)]));
const json = (p, name) => JSON.parse(raw(p, name));
function preferencesVisible(p) {
  assert.match(p.screen(), /Pi Models · 模型管理/);
  assert.match(p.screen(), /默认 m0/);
  assert.match(p.screen(), /★/);
  assert.deepEqual([...new Set(p.debug().matrixCells.map(cell => cell.pid))], ['p01', 'p00']);
  for (const name of ['settings.json', ...Object.keys(fixtureFiles())]) assert.ok(p.reads.some(([, file]) => file === path.join(p.root, name)), `did not read ${name}`);
  assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0);
}

for (const version of ['1.4.0', '1.5.2']) {
  test(`upgrade keeps preferences and absent identities; favorites remain editable on reviewed Pi ${version}`, async t => {
    const p = await harness(t, { registryVersion: version, fixtureFiles: fixtureFiles(), terminalColumns: 120, terminalRows: 30 });
    preferencesVisible(p);
    const before = snapshot(p);
    for (const [name, value] of Object.entries(fixtureFiles())) assert.deepEqual(json(p, name), value, 'opening must not prune saved identities');
    p.send('\x1b1');
    assert.deepEqual(json(p, 'model-pick-favorites.json'), ['p01/m1', 'temporarily-absent/keep-favorite']);
    for (const [name, bytes] of Object.entries(before)) if (name !== 'model-pick-favorites.json') assert.equal(raw(p, name), bytes);
    assert.equal(p.selections.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0);
  });
}

test('unverified write backend still displays saved favorites/order/defaults without writes or pruning', async t => {
  const p = await harness(t, { registryVersion: '1.5.3', fixtureFiles: fixtureFiles(), terminalColumns: 180, terminalRows: 30 });
  preferencesVisible(p);
  const before = snapshot(p);
  assert.match(p.screen(), /兼容性未确认|修改已禁用/);
  for (const key of ['\x1b1', '\x1bd', '\x1bn', '\x1bx', '\x1b[1;3C', '\x1bt']) p.send(key);
  await p.flush();
  assert.deepEqual(snapshot(p), before);
  assert.equal(fs.existsSync(path.join(p.root, 'model-pick-data')), false);
  assert.equal(p.selections.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0);
});

test('Pi 1.5.2 native metadata editor remains available without touching OAuth or resolving auth', async t => {
  const auth = '{"native-provider":{"type":"oauth","access":"SYNTHETIC-A","refresh":"SYNTHETIC-R","expires":1}}\n';
  const p = await harness(t, { registryVersion: '1.5.2', includeNative: true, currentRef: { provider: 'native-provider', id: 'native-m' }, fixtureFiles: { ...fixtureFiles(), 'auth.json': auth }, terminalColumns: 120 });
  const before = snapshot(p), config = p.config();
  p.action('edit-model');
  assert.match(p.readContent(), /本地限制|本地预算/);
  p.action('back');
  assert.deepEqual(p.config(), config); assert.deepEqual(snapshot(p), before); assert.equal(raw(p, 'auth.json'), auth);
  assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0); assert.equal(p.selections.length, 0);
});
