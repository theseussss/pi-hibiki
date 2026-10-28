import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
const { mergeVisibleOrder } = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/order.ts', import.meta.url)));
const plain = (v) => [...v];
test('visible model moves retain archived model slots', () => {
  assert.deepEqual(plain(mergeVisibleOrder(['m0', 'archived', 'm1', 'm2'], ['m1', 'm0', 'm2'])), ['m1', 'archived', 'm0', 'm2']);
});
test('provider row moves retain archived suppliers', () => {
  assert.deepEqual(plain(mergeVisibleOrder(['p0', 'archived', 'p1'], ['p1', 'p0'])), ['p1', 'archived', 'p0']);
});
test('new visible IDs append and duplicates do not erase hidden identities', () => {
  assert.deepEqual(plain(mergeVisibleOrder(['hidden', 'm1', 'm1'], ['m2', 'm1', 'm2'])), ['hidden', 'm2', 'm1']);
});
test('empty and entirely hidden lists are non-destructive', () => {
  assert.deepEqual(plain(mergeVisibleOrder(['archive'], [])), ['archive']);
  assert.deepEqual(plain(mergeVisibleOrder([], ['a', 'b'])), ['a', 'b']);
});
