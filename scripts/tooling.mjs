import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
export const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
// The package is ordinary editable TypeScript. The override is test-only,
// allowing the same native component test to check an unpacked distribution.
export function variantRoots() {
  return { productionRoot: path.resolve(process.env.MODEL_PICK_PRODUCTION_ROOT || root) };
}
export function piRoot() {
  const value = process.env.HIBIKI_PI_ROOT || process.env.MODEL_PICK_PI_ROOT || path.resolve(path.dirname(process.execPath), '../lib/node_modules/@earendil-works/pi-coding-agent');
  assert.ok(fs.existsSync(path.join(value, 'dist/core/extensions/loader.js')), `Installed Pi not found: ${value}; set HIBIKI_PI_ROOT`);
  return path.resolve(value);
}
export function typescriptPath() {
  const override = process.env.HIBIKI_TYPESCRIPT_ROOT || process.env.MODEL_PICK_TYPESCRIPT;
  const candidates = override ? [override] : [
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/typescript'),
    path.join(piRoot(), 'node_modules/typescript'),
  ];
  // Discover an already installed compiler cache; never invoke npx or install.
  const cache = path.join(os.homedir(), '.npm/_npx');
  if (!override && fs.existsSync(cache)) for (const name of fs.readdirSync(cache).sort()) candidates.push(path.join(cache, name, 'node_modules/typescript'));
  for (let candidate of candidates) {
    candidate = path.resolve(candidate);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'lib/typescript.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Installed TypeScript not found; set HIBIKI_TYPESCRIPT_ROOT or MODEL_PICK_TYPESCRIPT (no installation performed)');
}
export const typescript = () => require(typescriptPath());
export const direct = (url) => process.argv[1] && fileURLToPath(url) === path.resolve(process.argv[1]);
export function runNode(name, args, { extraEnv = {}, timeout = 300000 } = {}) {
  const home = fs.mkdtempSync('/tmp/model-pick-tooling-');
  const run = path.join(root, '.cache', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, '.pi/agent'), { recursive: true, mode: 0o700 });
  const variants = variantRoots();
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: home, TMPDIR: '/tmp',
    PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
    HIBIKI_PI_ROOT: piRoot(), MODEL_PICK_PI_ROOT: piRoot(),
    HIBIKI_TYPESCRIPT_ROOT: path.dirname(path.dirname(typescriptPath())), MODEL_PICK_TYPESCRIPT: typescriptPath(),
    MODEL_PICK_PRODUCTION_ROOT: variants.productionRoot,
    HIBIKI_PACKAGE_ROOT: root,
    NODE_OPTIONS: `--require=${path.join(root, 'scripts/isolation.cjs')}`,
    ...extraEnv,
  };
  if (process.env.WSL_INTEROP) env.WSL_INTEROP = process.env.WSL_INTEROP;
  const log = fs.openSync(path.join(run, 'output.log'), 'w', 0o600);
  let result;
  try { result = spawnSync(process.execPath, args, { cwd: root, env, stdio: ['ignore', log, log], timeout, maxBuffer: 1024 * 1024 }); }
  finally { fs.closeSync(log); fs.rmSync(home, { recursive: true, force: true }); }
  const summary = { name, exit: result.status, signal: result.signal, error: result.error?.code ?? null, log: path.join(run, 'output.log'), syntheticOnly: true };
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
  assert.equal(result.status, 0, `${name} failed; see ${summary.log}`);
  return { ...summary, output: fs.readFileSync(summary.log, 'utf8') };
}
