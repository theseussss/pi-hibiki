import fs from 'node:fs';
import { typescriptPath } from '../scripts/tooling.mjs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Explicit opt-in only. Reads implementation source, never config/auth/models,
// sessions/archives/credential environment. Uses only a newly generated random
// record key and a fixed synthetic payload; all native IO is internally piped.
// No plaintext key, native output, original failure or buffer is ever printed.
test('native synthetic DPAPI factory roundtrip, clear/reopen and purpose binding', {
  skip: process.env.MODEL_PICK_NATIVE_DPAPI !== '1' ? 'Explicit native opt-in required.' : false,
}, () => {
  let first;
  let second;
  try {
    const require = createRequire(import.meta.url);
    const ts = require(typescriptPath());
    function load(name, vault) {
      const filename = fileURLToPath(new URL(`../lib/model-pick/${name}.ts`, import.meta.url));
      const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
        fileName: filename, reportDiagnostics: true,
      });
      if (compiled.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) throw new Error();
      const module = { exports: {} };
      vm.compileFunction(compiled.outputText, ['exports', 'require', 'module'], { filename })(
        module.exports, (id) => id === './vault.js' ? vault : require(id), module,
      );
      return module.exports;
    }
    const api = load('protection', load('vault'));
    // Use the actual default factory/backend detection, not an injected transport.
    first = api.createRecordProtection();
    second = api.createRecordProtection();
    for (const purpose of ['models', 'records', 'settings']) {
      const synthetic = { kind: 'fresh-synthetic-dpapi-feasibility', apiKey: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL', purpose };
      const envelope = first.seal(synthetic, purpose);
      if (JSON.stringify(envelope).includes(synthetic.apiKey)) throw new Error();
      first.clear();
      const restored = second.open(JSON.parse(JSON.stringify(envelope)), purpose);
      if (JSON.stringify(restored) !== JSON.stringify(synthetic)) throw new Error();
      second.clear();
      if (JSON.stringify(first.open(envelope, purpose)) !== JSON.stringify(synthetic)) throw new Error();
      const changedPurpose = purpose === 'models' ? 'records' : 'models';
      let rejected = false;
      try { second.open({ ...envelope, purpose: changedPurpose }, changedPurpose); }
      catch (error) { rejected = error instanceof api.ProtectionError && error.message === 'Record protection failed.'; }
      if (!rejected) throw new Error();
      first.clear(); second.clear();
    }
  } catch {
    // Intentionally do not expose original error, native output or asserted data.
    throw new Error('Native synthetic DPAPI verification failed.');
  } finally {
    first?.clear();
    second?.clear();
  }
});
