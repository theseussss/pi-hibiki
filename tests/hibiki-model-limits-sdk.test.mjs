import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { root, piRoot, typescriptPath } from '../scripts/tooling.mjs';

// Never import/create the SDK runtime in this parent. Each proof runs in its own
// allowlisted environment, fresh HOME/profile, offline and network-denied child.
const scenarios = [
  ['builtin', 'actual verified Pi builtin openai-codex overrides are topmost without replacing the catalog'],
  ['directory', 'actual Pi offline cached directory changes are inherited after resetting one/both fields'],
  ['legacy', 'actual Pi registered legacy extension overrides beat local definitions and inherit fresh registrations'],
  ['native', 'actual Pi registered native extension metadata receives overrides and fresh reset inheritance'],
  ['oauth', 'actual Pi legacy OAuth modifyModels runs below the override layer without resolving request auth'],
  ['unknown', 'actual Pi ignores unknown override IDs and the live physical-target guard refuses them'],
  ['virtual', 'actual Pi virtual aliases ignore modelOverrides and the canonical helper excludes them'],
];
for (const [scenario, title] of scenarios) test(title, t => {
  const home = fs.mkdtempSync('/tmp/model-pick-limits-sdk-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: home, TMPDIR: '/tmp',
    PI_CODING_AGENT_DIR: path.join(home, 'unused-cli-profile'), PI_OFFLINE: '1',
    HIBIKI_PACKAGE_ROOT: root, MODEL_PICK_PRODUCTION_ROOT: root, HIBIKI_PI_ROOT: piRoot(),
    HIBIKI_TYPESCRIPT_ROOT: path.dirname(path.dirname(typescriptPath())),
    NODE_OPTIONS: `--require=${path.join(root, 'scripts/isolation.cjs')}`,
  };
  assert.ok(!Object.keys(env).some(key => /API.?KEY|TOKEN|SECRET|CREDENTIAL/i.test(key)));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./hibiki-model-limits-sdk-worker.mjs', import.meta.url)), scenario], {
    env, cwd: home, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.equal(result.signal, null);
  const proof = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(proof.scenario, scenario); assert.equal(proof.status, 'PASS');
  assert.equal(proof.piVersion, JSON.parse(fs.readFileSync(path.join(piRoot(), 'package.json'), 'utf8')).version);
  assert.equal(proof.offline, true); assert.equal(proof.sanitizedEnvironment, true);
  for (const counter of ['networkAttempts', 'requestAuthCalls', 'credentialFileAccesses', 'childProcessAttempts', 'routeCalls']) assert.equal(proof[counter], 0, counter);
  assert.equal(proof.unusedCliProfileUntouched, true); assert.equal(proof.memoryCredentialsUnchanged, true);
  t.diagnostic(JSON.stringify(proof));
});
