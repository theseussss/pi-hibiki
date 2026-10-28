import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { root, piRoot, typescriptPath, variantRoots } from '../scripts/tooling.mjs';

test('real installed loader/runner/SessionManager/TUI compose one Hibiki, preserve matrix/default and branch Fast, fit narrow widths', t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'model-pick-hibiki-native-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  fs.mkdirSync(path.join(home,'.pi/agent'),{recursive:true});
  const variants=variantRoots();
  const env={PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`,LANG:'C.UTF-8',HOME:home,TMPDIR:'/tmp',PI_CODING_AGENT_DIR:path.join(home,'.pi/agent'),
    HIBIKI_PACKAGE_ROOT:root,HIBIKI_PI_ROOT:piRoot(),HIBIKI_TYPESCRIPT_ROOT:path.dirname(path.dirname(typescriptPath())),
    MODEL_PICK_PRODUCTION_ROOT:variants.productionRoot,NODE_OPTIONS:`--require=${path.join(root,'scripts/isolation.cjs')}`};
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./hibiki-native-worker.mjs',import.meta.url))],{encoding:'utf8',env,timeout:45000,maxBuffer:2*1024*1024});
  assert.equal(result.status,0,result.stderr||result.stdout);
  const summary=JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(summary.native,'PASS');assert.equal(summary.authCalls,0);assert.equal(summary.realNetworkRequests,0);
  assert.equal(summary.policyHooks,1);assert.equal(summary.observerHooks,1);assert.equal(summary.currentDefaultUnchanged,true);assert.equal(summary.branchRestore,true);
  assert.ok(summary.frames.every(frame=>frame.lines.length>0));
});
