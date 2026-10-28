import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { root, piRoot } from '../scripts/tooling.mjs';
import { loadTypeScript } from './model-pick-loader.mjs';
const tui = await import(pathToFileURL(path.join(piRoot(), 'node_modules/@earendil-works/pi-tui/dist/index.js')));

test('ordinary package registration is lazy: no profile, registry or protection access', () => {
  const commands = [], shortcuts = [];
  const forbidden = () => assert.fail('registration must not read user data or initialize helpers');
  const api = loadTypeScript(path.join(root, 'extensions/model-pick.ts'), {
    'node:fs': new Proxy({ constants: fs.constants }, { get(target, name) { return name in target ? target[name] : forbidden; } }),
    'node:os': { homedir: () => '/home/synthetic-user-not-a-real-profile' }, '@earendil-works/pi-tui': tui,
    '@earendil-works/pi-ai/providers/all': { getBuiltinProviders: forbidden },
    '../lib/model-pick/protection.js': { createRecordProtection: forbidden },
  }, { process: { pid: 1, env: {}, getuid: () => 1000 } });
  api.default({ registerCommand: name => commands.push(name), registerShortcut: name => shortcuts.push(name) });
  assert.deepEqual(commands, ['models']); assert.deepEqual(shortcuts, ['ctrl+l']);
});

test('typecheck refers only to package sources and no private profile is bundled', () => {
  const file = path.join(root, 'extensions/model-pick.tsconfig.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(config.files.length);
  assert.ok(config.files.every(name => path.resolve(path.dirname(file), name).startsWith(root + path.sep)));
  assert.equal(fs.existsSync(path.join(root, 'models.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'auth.json')), false);
});
