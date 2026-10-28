import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
const file = fileURLToPath(new URL('../lib/model-pick/records.ts', import.meta.url));
const password = 'SYNTHETIC-records-master-1234';
function fixture(t, fakeFs = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-records-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = loadTypeScript(file, { 'node:fs': fakeFs });
  return { root, module, ledger: new module.PickerRecords(root), output: path.join(root, 'model-pick-data/records.json') };
}
const report = () => ({ kind: 'probe', report: {
  id: 'synthetic-run', scope: { provider: 'p', modelId: 'm', endpoint: 'https://example.test/v1', api: 'openai-completions', credentialVersion: 'opaque' },
  testedAt: 1, expiresAt: 2, status: 'passed', fields: {}, verifiedFields: [], checks: { text: 'passed' }, code: 'ok', elapsedMs: 1,
} });

test('safe report ledger is encrypted, private, and readable with the same unlock secret', (t) => {
  const f = fixture(t);
  assert.equal(f.ledger.hasData(), false);
  f.ledger.append(f.module.__json(report()), password);
  assert.equal(f.ledger.hasData(), true);
  assert.equal(f.ledger.tests(password)[0].scope.provider, 'p');
  const bytes = fs.readFileSync(f.output, 'utf8');
  assert.ok(!bytes.includes(password)); assert.ok(!bytes.includes('example.test')); assert.ok(!bytes.includes('synthetic-run'));
  assert.equal(fs.statSync(f.output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.output)).mode & 0o777, 0o700);
});

test('fallback provenance survives separate events; not exposed as a tested specification', (t) => {
  const f = fixture(t);
  f.ledger.append(f.module.__json({ kind: 'resolution', provider: 'p', modelId: 'm', fields: { contextWindow: 128000 }, provenance: { contextWindow: { source: 'default', history: [{ source: 'provider', reason: 'missing' }, { source: 'default', reason: 'selected' }] } } }), password);
  assert.equal(f.ledger.tests(password).length, 0);
  f.ledger.append(f.module.__json(report()), password);
  assert.equal(f.ledger.tests(password).length, 1);
});

test('wrong password and corrupted ciphertext do not overwrite the ledger or leak input', (t) => {
  const f = fixture(t);
  f.ledger.append(f.module.__json(report()), password);
  const before = fs.readFileSync(f.output, 'utf8');
  assert.throws(() => f.ledger.append(f.module.__json(report()), 'SYNTHETIC-wrong-password-1234'), (e) => !e.message.includes('SYNTHETIC'));
  assert.equal(fs.readFileSync(f.output, 'utf8'), before);
  const data = JSON.parse(before); data.tag = Buffer.alloc(16).toString('base64');
  fs.writeFileSync(f.output, JSON.stringify(data), { mode: 0o600 });
  assert.throws(() => f.ledger.tests(password), (e) => !e.message.includes(password));
});

test('symlink and broad permissions are refused', (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside.json'); fs.writeFileSync(outside, '{}');
  fs.mkdirSync(path.dirname(f.output), { mode: 0o700 });
  fs.symlinkSync(outside, f.output);
  assert.throws(() => f.ledger.hasData());
  fs.unlinkSync(f.output);
  f.ledger.append(f.module.__json(report()), password);
  fs.chmodSync(f.output, 0o644);
  assert.throws(() => f.ledger.hasData());
});

test('existing writer lock fails closed and preserves history', (t) => {
  const f = fixture(t); f.ledger.append(f.module.__json(report()), password);
  const before = fs.readFileSync(f.output, 'utf8');
  fs.writeFileSync(path.join(path.dirname(f.output), 'records.lock'), 'another writer');
  assert.throws(() => f.ledger.append(f.module.__json(report()), password));
  assert.equal(fs.readFileSync(f.output, 'utf8'), before);
});

test('failed encrypted write leaves original ledger intact and cleans its own temporary lock', (t) => {
  let fail = false;
  const fake = new Proxy(fs, { get(target, key) {
    if (key === 'writeFileSync') return (...args) => { if (fail && String(args[0]).endsWith('.tmp')) throw new Error('SYNTHETIC-secret-exception'); return fs.writeFileSync(...args); };
    return target[key];
  } });
  const f = fixture(t, fake); f.ledger.append(f.module.__json(report()), password);
  const before = fs.readFileSync(f.output, 'utf8'); fail = true;
  assert.throws(() => f.ledger.append(f.module.__json(report()), password), (e) => !e.message.includes('SYNTHETIC'));
  assert.equal(fs.readFileSync(f.output, 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(path.dirname(f.output), 'records.lock')));
  assert.ok(!fs.readdirSync(path.dirname(f.output)).some((name) => name.endsWith('.tmp')));
});

test('batched provenance is encrypted once and preserves individual ledger events', (t) => {
  let renames = 0;
  const fake = new Proxy(fs, { get(target, key) {
    if (key === 'renameSync') return (...args) => { renames++; return fs.renameSync(...args); };
    return target[key];
  } });
  const f = fixture(t, fake);
  const events = Array.from({ length: 100 }, (_, i) => ({ kind: 'resolution', modelId: `synthetic-${i}`, fields: { contextWindow: 128000 }, provenance: { contextWindow: { source: 'default' } } }));
  f.ledger.appendMany(f.module.__json(events), password);
  assert.equal(renames, 1);
  assert.equal(f.ledger.tests(password).length, 0);
  const vault = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/vault.ts', import.meta.url)));
  const decoded = vault.openJson(vault.__json(JSON.parse(fs.readFileSync(f.output, 'utf8'))), password);
  assert.equal(decoded.events.length, 100);
  assert.equal(decoded.events[99].modelId, 'synthetic-99');
  assert.ok(!fs.readFileSync(f.output, 'utf8').includes('synthetic-99'));
  f.ledger.append(f.module.__json(report()), password);
  assert.equal(f.ledger.tests(password).length, 1);
});

test('invalid batched lists and executable fields cannot partially replace the ledger', (t) => {
  const f = fixture(t); f.ledger.append(f.module.__json(report()), password);
  const before = fs.readFileSync(f.output, 'utf8'); let invoked = false;
  const getter = [f.module.__json(report())]; Object.defineProperty(getter, '0', { get() { invoked = true; throw new Error('secret'); } });
  const proxy = new Proxy([], { get() { invoked = true; throw new Error('secret'); } });
  for (const batch of [[], Array(101).fill(null), [,], getter, proxy, [f.module.__json(report()), { toJSON() { invoked = true; } }]]) {
    assert.throws(() => f.ledger.appendMany(batch, password), (e) => e.name === 'RecordError' && !e.message.includes('secret'));
    assert.equal(fs.readFileSync(f.output, 'utf8'), before);
    assert.ok(!fs.existsSync(path.join(path.dirname(f.output), 'records.lock')));
  }
  assert.equal(invoked, false);
});
