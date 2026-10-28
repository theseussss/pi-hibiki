import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { root, piRoot } from '../scripts/tooling.mjs';
import { checkPackage } from '../scripts/check.mjs';
const temp = t => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-package-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };

test('ordinary editable package has one entry and no snapshot or source-restoration prerequisite', () => {
  const result = checkPackage(); assert.ok(result.packageFiles > 15);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(pkg.private, true); assert.equal(pkg.scripts['build:production'], undefined); assert.equal(pkg.scripts['restore:source'], undefined);
  for (const file of ['build-receipt.json', 'SOURCE-PROVENANCE.json', 'scripts/restore-source.mjs', 'tests/fixtures/guarded-source']) assert.equal(fs.existsSync(path.join(root, file)), false);
});

test('installed Pi resolves exactly the package entry without installing or persisting settings', async t => {
  const home = temp(t), agentDir = path.join(home, '.pi/agent'); fs.mkdirSync(agentDir, { recursive: true });
  const sdk = await import(pathToFileURL(path.join(piRoot(), 'dist/index.js')));
  const { DefaultPackageManager } = await import(pathToFileURL(path.join(piRoot(), 'dist/core/package-manager.js')));
  const settingsManager = sdk.SettingsManager.inMemory({});
  const manager = new DefaultPackageManager({ cwd: home, agentDir, settingsManager, builtinExtensions: [] });
  manager.setProgressCallback(() => assert.fail('No package operations during discovery'));
  const found = await manager.resolveExtensionSources([root], { temporary: true });
  assert.deepEqual(found.extensions.filter(r => r.enabled).map(r => r.path), [path.join(root, 'extensions/hibiki-models.ts')]);
  assert.deepEqual(found.skills, []); assert.deepEqual(found.prompts, []); assert.deepEqual(found.themes, []);
  assert.deepEqual(settingsManager.getGlobalSettings(), {}); assert.deepEqual(fs.readdirSync(agentDir), []);
});

test('original third-party notices are retained byte-for-byte', () => {
  const expected = {
    'pi-sakura-cyberdeck-MIT.txt': 'f2375c005cfcf301ae1d7778fbb0d20a851514e0a9ae10de6ef938949ce382e0',
    'pi-zentui-MIT.txt': '44c0fd9e9c599031cbcc0723aebbced5a68835a5d9253a651c2e496dca37fd93',
  };
  for (const [name, digest] of Object.entries(expected)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, 'licenses', name))).digest('hex'), digest);
});

test('distribution check refuses private files, nested caches and symlinks instead of silently skipping them', t => {
  const copy = temp(t);
  for (const rel of checkPackage().files) {
    const target = path.join(copy, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, fs.readFileSync(path.join(root, rel)));
  }
  assert.equal(checkPackage(copy).check, 'PASS');
  for (const name of ['cache', 'audit', 'release', '.cache', 'node_modules', '.git', '__pycache__']) {
    const dir = path.join(copy, 'lib', name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'sentinel.txt'), 'synthetic');
    assert.throws(() => checkPackage(copy), /caches or internal/); fs.rmSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(copy, 'auth.json'), '{"synthetic":true}'); assert.throws(() => checkPackage(copy), /Private configuration/); fs.unlinkSync(path.join(copy, 'auth.json'));
  const link = path.join(copy, 'lib', 'unexpected.ts'); fs.symlinkSync(path.join(copy, 'LICENSE'), link); assert.throws(() => checkPackage(copy), /symlinks/);
});
