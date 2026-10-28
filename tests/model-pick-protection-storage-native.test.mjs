import assert from 'node:assert/strict';
import { typescriptPath } from '../scripts/tooling.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Explicit opt-in: actual account-bound protector + actual store/records, with
// ONLY freshly generated synthetic files under /tmp. No SDK/auth/network/session.
test('native DPAPI composes with automatic transactions, records, restore and settings snapshots', {
  skip: process.env.MODEL_PICK_NATIVE_DPAPI !== '1' ? 'Explicit native opt-in required.' : false,
}, () => {
  let root; const protectors = [];
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-dpapi-synthetic-'));
    const handles = new Map();
    const nativeExe = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      : '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
    function inside(file, metadata = false) {
      const value = path.resolve(String(file));
      if (value !== root && !value.startsWith(root + path.sep) && !(metadata && root.startsWith((value === path.parse(root).root ? '' : value) + path.sep))) throw new Error();
    }
    const boundedFs = new Proxy(fs, { get(target, op) {
      if (typeof target[op] !== 'function') return target[op];
      return (...args) => {
        if (op === 'existsSync' && args[0] === nativeExe) return fs.existsSync(nativeExe);
        if (typeof args[0] === 'number') { if (!handles.has(args[0])) throw new Error(); }
        else inside(args[0], op === 'lstatSync');
        if (op === 'renameSync') inside(args[1]);
        const result = target[op](...args);
        if (op === 'openSync') handles.set(result, args[0]);
        if (op === 'closeSync') handles.delete(args[0]);
        return result;
      };
    } });
    const require = createRequire(import.meta.url);
    const ts = require(typescriptPath());
    const cache = new Map();
    function load(name) {
      if (!['store', 'records', 'protection', 'vault'].includes(name)) throw new Error();
      if (cache.has(name)) return cache.get(name).exports;
      const filename = fileURLToPath(new URL(`../lib/model-pick/${name}.ts`, import.meta.url));
      const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true }, reportDiagnostics: true });
      if (compiled.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)) throw new Error();
      const module = { exports: {} }; cache.set(name, module);
      vm.compileFunction(compiled.outputText, ['exports', 'require', 'module'], { filename })(module.exports, (id) => {
        if (id === 'node:fs') return boundedFs;
        if (id.startsWith('./') && id.endsWith('.js')) return load(id.slice(2, -3));
        if (['node:path', 'node:crypto', 'node:util', 'node:child_process'].includes(id)) return require(id);
        throw new Error();
      }, module);
      return module.exports;
    }
    const { createRecordProtection } = load('protection'); const { PickerStore } = load('store'); const { PickerRecords } = load('records');
    const make = () => { const p = createRecordProtection(); protectors.push(p); return p; };
    const secret = 'FRESH_SYNTHETIC_CONTENT_NOT_A_REAL_KEY';
    const model = (id) => ({ id, contextWindow: 8192, maxTokens: 2048, reasoning: false, input: ['text'] });
    const original = { preservedRoot: { value: secret }, providers: { custom: { baseUrl: 'https://synthetic.invalid/v1', api: 'openai-completions', apiKey: secret, models: [model('first')] } } };
    fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify(original), { mode: 0o600 });
    let protection = make(); let store = new PickerStore(root, [], protection); let records = new PickerRecords(root, protection);
    assert.equal(store.isUnlocked(), true); assert.equal(records.hasData(), false);
    assert.equal(fs.existsSync(path.join(root, 'model-pick-data')), false);
    store.putModels('custom', [model('second'), model('third')], store.snapshot().revision);
    records.append({ kind: 'resolution', provider: 'custom', modelId: 'second', fields: model('second'), provenance: { input: { source: 'manual' } } });
    records.append({ kind: 'probe-start', attemptId: 'native-synthetic-attempt', when: 1, provider: 'custom', modelId: 'first' });
    records.append({ kind: 'probe', attemptId: 'native-synthetic-attempt', report: { id: 'synthetic-probe', scope: { provider: 'custom', modelId: 'first', endpoint: 'https://synthetic.invalid/v1', api: 'openai-completions', credentialVersion: 'synthetic-reference-only' }, testedAt: 1, expiresAt: 2, fields: {}, verifiedFields: [], status: 'passed' } });
    store.archiveProvider('custom', store.snapshot().revision);
    const archive = store.listArchives()[0]; assert.equal(store.snapshot().providers.length, 0);
    const data = path.join(root, 'model-pick-data');
    assert.deepEqual(fs.readdirSync(data).sort(), ['records.auto.json', 'retention-index.auto.json', 'vault.auto.json']);
    for (const name of fs.readdirSync(data)) {
      assert.equal(fs.readFileSync(path.join(data, name), 'utf8').includes(secret), false);
      assert.equal(fs.statSync(path.join(data, name)).mode & 0o777, 0o600);
    }
    assert.equal(fs.statSync(data).mode & 0o777, 0o700);
    protection.clear(); protection = make(); store = new PickerStore(root, [], protection); records = new PickerRecords(root, protection);
    assert.equal(records.tests().length, 1); assert.deepEqual(records.tests()[0].verifiedFields, []);
    store.restore(archive.id, store.snapshot().revision);
    const restored = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8'));
    assert.deepEqual(restored.preservedRoot, original.preservedRoot); assert.equal(restored.providers.custom.apiKey, secret);
    assert.deepEqual(restored.providers.custom.models.map((m) => m.id), ['first', 'second', 'third']);
    assert.equal(store.hasPending(), false);
    const before = JSON.stringify({ defaultProvider: 'custom', defaultModel: 'first', privateValue: secret });
    const snapshot = protection.seal({ version: 1, kind: 'model-pick-settings-backup', before }, 'settings');
    const backup = path.join(root, 'settings.json.bak-model-pick.sealed'); fs.writeFileSync(backup, JSON.stringify(snapshot), { mode: 0o600 });
    assert.equal(fs.readFileSync(backup, 'utf8').includes(secret), false); protection.clear();
    assert.equal(make().open(JSON.parse(fs.readFileSync(backup, 'utf8')), 'settings').before, before);
    assert.equal(handles.size, 0);
  } catch {
    // No original exception, native output, key, envelope or asserted data escapes.
    throw new Error('Native synthetic storage verification failed.');
  } finally {
    for (const p of protectors) p.clear();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});
