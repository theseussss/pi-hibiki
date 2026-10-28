import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, direct } from './tooling.mjs';

// Check what will ship, without creating or reading any user configuration.
export function checkPackage(base = root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'pi-hibiki'); assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.author, 'Wang Jiacong (theseussss)');
  assert.deepEqual(pkg.pi, { extensions: ['./extensions/hibiki-models.ts'], themes: [] });
  assert.equal(pkg.dependencies, undefined, 'Pi supplies the runtime peer packages');
  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']);
  assert.ok(Object.values(pkg.peerDependencies).every(value => value === '*'));
  assert.ok(!Object.keys(pkg.scripts ?? {}).some(name => /^(?:preinstall|install|postinstall|prepare|prepack|postpack)$/.test(name)), 'No install/pack lifecycle scripts');
  for (const name of ['auth.json', 'models.json', 'settings.json', '.env', '.npmrc']) assert.ok(!fs.existsSync(path.join(base, name)), 'Private configuration must not be in the repository');
  const included = new Set(['package.json']);
  function visit(rel) {
    assert.ok(!path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..'), 'Unsafe package path');
    const file = path.join(base, rel), stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), 'Do not ship symlinks');
    const name = path.basename(rel);
    assert.ok(!['.git', '.cache', 'cache', 'audit', 'node_modules', 'release', '__pycache__'].includes(name), 'Do not ship caches or internal directories');
    assert.ok(!/^(?:auth|models|settings)\.json$|^\.env(?:\.|$)|^\.npmrc$/.test(name), 'Do not ship private configuration');
    if (stat.isDirectory()) for (const child of fs.readdirSync(file)) visit(path.join(rel, child));
    else {
      assert.ok(stat.isFile(), 'Only regular files may ship');
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/.test(text), 'Possible secret in distributable files');
      included.add(rel);
    }
  }
  for (const item of pkg.files) visit(item);
  for (const name of ['README.md', 'README.zh-CN.md', 'LICENSE', 'NOTICE.md', 'licenses/pi-sakura-cyberdeck-MIT.txt', 'licenses/pi-zentui-MIT.txt', 'extensions/hibiki-models.ts']) assert.ok(included.has(name), `Missing package file: ${name}`);
  assert.match(fs.readFileSync(path.join(base, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Wang Jiacong \(theseussss\)/);
  return { check: 'PASS', packageFiles: included.size, files: [...included].sort() };
}
if (direct(import.meta.url)) console.log(JSON.stringify(checkPackage()));
