import { piRoot as resolvePiRoot } from '../scripts/tooling.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('official Pi 1.4 loader imports the multi-file picker with isolated HOME and network blocked', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-loader-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../extensions/model-pick.ts', import.meta.url));
  const piRoot = resolvePiRoot();
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import http from 'node:http';
    import https from 'node:https';
    import { syncBuiltinESMExports } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const realAgentDir = ${JSON.stringify(path.resolve(path.dirname(source), '..'))};
    const forbiddenNames = new Set(['auth.json', 'models.json', 'settings.json', 'keybindings.json', 'model-pick-order.json', 'model-pick-favorites.json', 'model-pick-theme.json']);
    const forbidden = (file) => typeof file === 'string' && file.startsWith(realAgentDir + '/') && (file.startsWith(realAgentDir + '/sessions/') || forbiddenNames.has(file.split('/').at(-1)));
    for (const method of ['readFileSync', 'openSync', 'createReadStream']) {
      const original = fs[method];
      fs[method] = function(file, ...args) { assert.ok(!forbidden(file), 'real configuration access forbidden'); return original.call(this, file, ...args); };
    }
    for (const module of [http, https]) for (const method of ['request', 'get']) module[method] = () => { throw new Error('network forbidden'); };
    globalThis.fetch = () => { throw new Error('network forbidden'); };
    syncBuiltinESMExports();
    const { loadExtensions } = await import(pathToFileURL(${JSON.stringify(path.join(piRoot, 'dist/core/extensions/loader.js'))}));
    const result = await loadExtensions([${JSON.stringify(source)}], ${JSON.stringify(home)});
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.ok(extension.commands.has('models'));
    assert.ok(extension.shortcuts.has('ctrl+l'));
    console.log('MODEL_PICK_LOADER_OK');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), NODE_OPTIONS: process.env.NODE_OPTIONS, HIBIKI_PACKAGE_ROOT: process.env.HIBIKI_PACKAGE_ROOT, HIBIKI_PI_ROOT: piRoot, HIBIKI_TYPESCRIPT_ROOT: process.env.HIBIKI_TYPESCRIPT_ROOT },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /MODEL_PICK_LOADER_OK/);
});
