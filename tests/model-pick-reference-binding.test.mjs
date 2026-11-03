import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadTypeScript } from './model-pick-loader.mjs';
import { createSyntheticProtection } from './model-pick-synthetic-protection.mjs';
const file = fileURLToPath(new URL('../lib/model-pick/records.ts', import.meta.url));
test('concurrent initializers serialize binding-key creation and converge on one key', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-reference-race-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const protector = createSyntheticProtection(); let trigger = false; let nestedVersion;
  let other;
  const proxy = new Proxy(fs, { get(target, key) {
    if (key === 'openSync') return (...args) => {
      if (!trigger && String(args[0]).endsWith('/records.lock')) { trigger = true; nestedVersion = other.credentialVersion(otherModule.__json({ authorization: 'synthetic-key' })); }
      return fs.openSync(...args);
    };
    return target[key];
  } });
  const otherModule = loadTypeScript(file, { 'node:fs': fs });
  const otherAdapter = { seal: (v,p) => otherModule.__json(protector.seal(v,p)), open: (v,p) => otherModule.__json(protector.open(v,p)), clear: () => {} };
  other = new otherModule.PickerRecords(root, otherAdapter);
  const firstModule = loadTypeScript(file, { 'node:fs': proxy });
  const adapter = { seal: (v,p) => firstModule.__json(protector.seal(v,p)), open: (v,p) => firstModule.__json(protector.open(v,p)), clear: () => {} };
  const first = new firstModule.PickerRecords(root, adapter);
  assert.equal(first.credentialVersion(firstModule.__json({ authorization: 'synthetic-key' })), nestedVersion);
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'model-pick-data/records.auto.json'), 'utf8'));
  assert.equal(protector.open(raw.sealed, 'records').events.filter(e => e.kind === 'binding-key').length, 1);
});

test('stable encrypted credential binding and scope/expiry-limited suite lookup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-reference-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = loadTypeScript(file, { 'node:fs': fs }); const protector = createSyntheticProtection();
  const adapter = { seal: (v,p) => api.__json(protector.seal(v,p)), open: (v,p) => api.__json(protector.open(v,p)), clear: () => protector.clear() };
  const ledger = new api.PickerRecords(root, adapter); const headers = api.__json({ Authorization: 'Bearer SYNTHETIC-SECRET', 'x-other': 'a' });
  const first = ledger.credentialVersion(headers); assert.match(first, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(new api.PickerRecords(root, adapter).credentialVersion(api.__json({ 'x-other': 'a', authorization: 'Bearer SYNTHETIC-SECRET' })), first);
  assert.notEqual(ledger.credentialVersion(api.__json({ authorization: 'Bearer DIFFERENT', 'x-other': 'a' })), first);
  const scope = { provider: 'p', modelId: 'm', endpoint: 'https://synthetic.invalid/v1', api: 'openai-completions', credentialVersion: first };
  ledger.append(api.__json({ kind: 'probe', report: { id: 'r', scope, testedAt: 10, expiresAt: 100, status: 'inconclusive', fields: {}, verifiedFields: [], suiteVersion: 1, checks: { text: { status: 'passed' } } } }));
  assert.equal(ledger.recentSuite(api.__json(scope), 50).id, 'r');
  for (const key of Object.keys(scope)) assert.equal(ledger.recentSuite(api.__json({ ...scope, [key]: scope[key] + '-changed' }), 50), undefined);
  assert.equal(ledger.recentSuite(api.__json(scope), 100), undefined);
  const raw = fs.readFileSync(path.join(root, 'model-pick-data/records.auto.json'), 'utf8');
  assert.ok(!raw.includes('SYNTHETIC-SECRET')); assert.ok(!raw.includes(first));
  assert.equal(ledger.tests().length, 1);
});
