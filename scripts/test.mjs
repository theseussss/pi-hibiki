import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, direct, runNode } from './tooling.mjs';

export function testPackage(selection = []) {
  const all = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort();
  const names = selection.length ? selection.map(name => path.basename(name)) : all;
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(all.includes(name), `Unknown test: ${name}`);
  const result = runNode('tests', ['--test', '--test-reporter=tap', '--test-concurrency=1', ...names.map(name => path.join(root, 'tests', name))], {
    // These two opt-in tests were reviewed: fresh random keys + synthetic payloads,
    // fixed native DPAPI helper, no real keys/config/session/network. Fail, never skip.
    extraEnv: { MODEL_PICK_NATIVE_DPAPI: '1' }, timeout: 300000,
  });
  const metrics = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, Number(result.output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
  assert.equal(metrics.fail, 0); assert.equal(metrics.cancelled, 0); assert.equal(metrics.skipped, 0); assert.equal(metrics.todo, 0);
  assert.equal(metrics.pass, metrics.tests);
  if (!selection.length) assert.ok(metrics.tests >= 534, 'All applicable picker/Fast regressions plus package checks must execute');
  console.log(JSON.stringify({ tests: 'PASS', metrics, log: result.log }));
  return metrics;
}
if (direct(import.meta.url)) testPackage(process.argv.slice(2));
