import assert from 'node:assert/strict';
import { typescriptPath } from '../scripts/tooling.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Source-only transpilation in memory. The standard suite cannot run a native
// process: every child_process import is replaced by a synthetic transport.
const require = createRequire(import.meta.url);
const ts = require(typescriptPath());
function compile(name) {
  const filename = fileURLToPath(new URL(`../lib/model-pick/${name}.ts`, import.meta.url));
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
    fileName: filename, reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0);
  return vm.compileFunction(result.outputText, ['exports', 'require', 'module'], { filename });
}
const vaultCompiled = compile('vault');
const protectionCompiled = compile('protection');
function load({ spawn, exists = () => true, keyBuffers = [] } = {}) {
  const vaultModule = { exports: {} };
  vaultCompiled(vaultModule.exports, (id) => {
    if (id === 'node:crypto') return crypto;
    if (id === 'node:util') return util;
    throw new Error('Unexpected vault import');
  }, vaultModule);
  const module = { exports: {} };
  let probes = 0;
  let calls = 0;
  const imports = [];
  protectionCompiled(module.exports, (id) => {
    imports.push(id);
    if (id === './vault.js') return vaultModule.exports;
    if (id === 'node:util') return util;
    if (id === 'node:crypto') return { randomBytes: (size) => {
      assert.equal(size, 32);
      const key = crypto.randomBytes(size);
      keyBuffers.push(key);
      return key;
    } };
    if (id === 'node:fs') return { existsSync: (filename) => { probes++; return exists(filename); } };
    if (id === 'node:child_process') return { spawnSync: (...args) => {
      calls++;
      if (!spawn) throw new Error('Standard suite MUST NOT launch native helper');
      return spawn(...args);
    } };
    throw new Error('Unexpected protection import');
  }, module);
  return { api: module.exports, vault: vaultModule.exports, imports, keyBuffers, counts: () => ({ probes, calls }) };
}
const SECRET = 'SYNTHETIC_API_SECRET_NEVER_REAL_9d0d';
function safeFailure(operation, api) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof api.ProtectionError);
    assert.equal(error.message, 'Record protection failed.');
    assert.equal(error.name, 'ProtectionError');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const forbidden of [SECRET, '/synthetic/secret/path', 'ETIMEDOUT', 'ORIGINAL_FAILURE']) {
      assert.equal(`${error}\n${error.stack}\n${JSON.stringify(error)}`.includes(forbidden), false);
    }
    return true;
  });
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function mutate(text) {
  const bytes = Buffer.from(text, 'base64');
  bytes[bytes.length - 1] ^= 1;
  return bytes.toString('base64');
}
function fakeDpapi() {
  const wrappingKey = crypto.randomBytes(32);
  const calls = [];
  const io = [];
  function transport(request) {
    const command = Buffer.from(request.args[3], 'base64').toString('utf16le');
    const purpose = /purpose=(models|records|settings)'/.exec(command)?.[1];
    assert.ok(purpose);
    const operation = command.includes('::Protect(') ? 'protect' : 'unprotect';
    const input = Buffer.from(request.input.toString('ascii'), 'base64');
    calls.push({ purpose, operation, executable: request.executable, args: [...request.args],
      env: { ...request.env }, timeout: request.timeout, maxBuffer: request.maxBuffer,
      windowsHide: request.windowsHide, shell: request.shell, inputSize: input.length });
    assert.equal(command.includes(SECRET), false);
    let result;
    try {
      if (operation === 'protect') {
        assert.equal(input.length, 32);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
        cipher.setAAD(Buffer.from(purpose));
        const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
        result = Buffer.concat([iv, cipher.getAuthTag(), encrypted, Buffer.alloc(32)]);
      } else {
        const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, input.subarray(0, 12));
        decipher.setAAD(Buffer.from(purpose));
        decipher.setAuthTag(input.subarray(12, 28));
        result = Buffer.concat([decipher.update(input.subarray(28, 60)), decipher.final()]);
        assert.equal(result.length, 32);
      }
      const stdout = Buffer.from(result.toString('base64'));
      const stderr = Buffer.alloc(0);
      io.push({ input: request.input, stdout, stderr });
      return { status: 0, signal: null, stdout, stderr };
    } finally {
      input.fill(0);
      result?.fill(0);
    }
  }
  return { transport, calls, io };
}
function setup(extra = {}) {
  const loaded = load(extra);
  const fake = fakeDpapi();
  const options = { platform: 'linux', wsl: true, exists: () => true, transport: fake.transport };
  return { ...loaded, ...fake, options, protector: loaded.api.createRecordProtection(options) };
}

test('fixed runtime API; import and construction do not probe or launch helpers', () => {
  const loaded = load();
  assert.deepEqual(Object.keys(loaded.api).sort(), ['ProtectionError', 'createRecordProtection']);
  assert.deepEqual(loaded.imports.sort(), ['./vault.js', 'node:child_process', 'node:crypto', 'node:fs', 'node:util']);
  const protector = loaded.api.createRecordProtection();
  assert.deepEqual(Object.keys(protector).sort(), ['clear', 'open', 'seal']);
  protector.clear();
  assert.deepEqual(loaded.counts(), { probes: 0, calls: 0 });
  safeFailure(() => { throw new loaded.api.ProtectionError(SECRET, { cause: new Error(SECRET) }); }, loaded.api);
});

test('outer format, strict vault payload and fresh randomness; plaintext never reaches helper/storage', () => {
  const s = setup();
  const value = { apiKey: SECRET, name: '合成模型', nested: [null, true, 42] };
  const first = s.protector.seal(value, 'models');
  const second = s.protector.seal(value, 'models');
  assert.deepEqual(Object.keys(first).sort(), ['payload', 'protectedKey', 'protection', 'purpose', 'version']);
  assert.equal(first.version, 1);
  assert.equal(first.protection, 'windows-dpapi-current-user');
  assert.equal(first.purpose, 'models');
  assert.equal(first.protectedKey, second.protectedKey);
  assert.notEqual(first.payload.salt, second.payload.salt);
  assert.notEqual(first.payload.iv, second.payload.iv);
  assert.notEqual(first.payload.data, second.payload.data);
  s.vault.assertEnvelope(first.payload);
  assert.equal(JSON.stringify(first).includes(SECRET), false);
  assert.equal(JSON.stringify(first).includes('合成模型'), false);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].inputSize, 32);
  assert.deepEqual(s.protector.open(clone(first), 'models'), value);
  assert.equal(s.calls.length, 1);
  for (const buffers of s.io) for (const buffer of Object.values(buffers)) assert.ok(buffer.every((byte) => byte === 0));
  const other = s.api.createRecordProtection(s.options);
  assert.deepEqual(other.open(clone(first), 'models'), value);
  assert.equal(s.calls.at(-1).operation, 'unprotect');
  assert.ok(s.calls.at(-1).inputSize >= 64);
  other.clear();
  s.protector.clear();
});

test('all three purposes use distinct keys and bind DPAPI application/version/purpose entropy', () => {
  const s = setup();
  const envelopes = ['models', 'records', 'settings'].map((purpose) => s.protector.seal({ apiKey: SECRET }, purpose));
  assert.equal(new Set(envelopes.map((envelope) => envelope.protectedKey)).size, 3);
  for (const [i, purpose] of ['models', 'records', 'settings'].entries()) {
    assert.deepEqual(s.protector.open(envelopes[i], purpose), { apiKey: SECRET });
    const command = Buffer.from(s.calls[i].args[3], 'base64').toString('utf16le');
    assert.ok(command.includes(`pi.model-pick.record-key;version=1;purpose=${purpose}`));
    assert.ok(command.includes('DataProtectionScope]::CurrentUser'));
    assert.ok(command.includes('$inputBytes.Length -ne 32'));
  }
  const changed = { ...envelopes[0], purpose: 'records' };
  safeFailure(() => s.protector.open(changed, 'records'), s.api);
  safeFailure(() => s.protector.open(envelopes[0], 'records'), s.api);
  s.protector.clear();
});

test('legacy envelopes, plaintext, schema drift and invalid purpose fail before any helper', () => {
  const s = setup();
  const envelope = s.protector.seal({ apiKey: SECRET }, 'models');
  const before = s.calls.length;
  const candidates = [null, [], 'plaintext', {}, envelope.payload,
    { ...envelope, extra: 1 }, { ...envelope, version: 2 }, { ...envelope, protection: 'plaintext' },
    { ...envelope, purpose: 'records' }, { ...envelope, payload: {} },
    { ...envelope, protectedKey: Buffer.alloc(32).toString('base64') }];
  for (const value of candidates) safeFailure(() => s.protector.open(value, 'models'), s.api);
  for (const purpose of ['Models', '', null, {}, new String('models')]) {
    safeFailure(() => s.protector.seal({}, purpose), s.api);
    safeFailure(() => s.protector.open(envelope, purpose), s.api);
  }
  assert.equal(s.calls.length, before);
  s.protector.clear();
});

test('envelope/options/value accessors, proxies and toJSON are not executed', () => {
  const s = setup();
  let invoked = 0;
  const getter = { get apiKey() { invoked++; throw new Error(SECRET); } };
  const proxy = new Proxy({}, { get() { invoked++; throw new Error(SECRET); }, ownKeys() { invoked++; throw new Error(SECRET); } });
  const hooks = { toJSON() { invoked++; throw new Error(SECRET); } };
  for (const value of [getter, proxy, hooks, { child: proxy }, new Date(), [undefined], NaN]) {
    safeFailure(() => s.protector.seal(value, 'models'), s.api);
  }
  assert.equal(s.calls.length, 0);
  const envelope = s.protector.seal({}, 'models');
  const accessorEnvelope = clone(envelope);
  Object.defineProperty(accessorEnvelope, 'protectedKey', { enumerable: true, get() { invoked++; return SECRET; } });
  const accessorPayload = clone(envelope);
  Object.defineProperty(accessorPayload.payload, 'data', { enumerable: true, get() { invoked++; return SECRET; } });
  for (const value of [proxy, accessorEnvelope, accessorPayload, { ...envelope, payload: proxy }]) {
    safeFailure(() => s.protector.open(value, 'models'), s.api);
  }
  const accessorOptions = { get platform() { invoked++; return 'win32'; } };
  safeFailure(() => s.api.createRecordProtection(accessorOptions), s.api);
  safeFailure(() => s.api.createRecordProtection(proxy), s.api);
  assert.equal(invoked, 0);
  s.protector.clear();
});

test('strict canonical base64/size validation precedes native decoder', () => {
  const s = setup();
  const envelope = s.protector.seal({}, 'models');
  const fresh = s.api.createRecordProtection(s.options);
  for (const text of ['', 'abcd\n', 'A'.repeat(120), 'A'.repeat(6000), '-'.repeat(128), 'A'.repeat(126) + 'B=', 'A'.repeat(125) + '===', envelope.protectedKey + '\n']) {
    if (text === 'A'.repeat(120)) continue; // Canonical bytes are structurally valid, authenticity belongs to DPAPI.
    safeFailure(() => fresh.open({ ...envelope, protectedKey: text }, 'models'), s.api);
  }
  assert.equal(s.calls.length, 1);
  fresh.clear();
  s.protector.clear();
});

test('tampering payload/wrapped key and replacing ciphertext fails authentication', () => {
  const s = setup();
  const envelope = s.protector.seal({ apiKey: SECRET }, 'models');
  for (const field of ['salt', 'iv', 'tag', 'data']) {
    const changed = clone(envelope);
    changed.payload[field] = mutate(changed.payload[field]);
    safeFailure(() => s.protector.open(changed, 'models'), s.api);
  }
  const changed = { ...envelope, protectedKey: mutate(envelope.protectedKey) };
  // Mutate an authenticated region, not the synthetic fixture's trailing padding.
  const bytes = Buffer.from(changed.protectedKey, 'base64'); bytes[35] ^= 1;
  changed.protectedKey = bytes.toString('base64');
  safeFailure(() => s.protector.open(changed, 'models'), s.api);
  s.protector.clear();
});

test('safe errors drop thrown errors, timeout, stderr, invalid status, stdout and plaintext-key fallback', () => {
  const s = setup();
  const leaked = Buffer.from(SECRET);
  const cases = [
    () => { throw new Error(`${SECRET} ORIGINAL_FAILURE /synthetic/secret/path`); },
    () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error(SECRET), { code: 'ETIMEDOUT' }), stdout: Buffer.from(SECRET), stderr: Buffer.from(SECRET) }),
    () => ({ status: 1, stdout: Buffer.from(SECRET), stderr: Buffer.from(SECRET) }),
    () => ({ status: 0, stdout: Buffer.from(SECRET), stderr: Buffer.from(SECRET) }),
    () => ({ status: 0, stdout: Buffer.alloc(9000, 65) }),
    () => ({ status: 0, stdout: Buffer.from('not-base64!') }),
    () => ({ status: 0, stdout: Buffer.from(Buffer.alloc(32).toString('base64')) }),
    () => ({ status: 0, stdout: SECRET }),
    () => ({ status: 0, stdout: leaked, error: new Error(SECRET) }),
  ];
  for (const transport of cases) {
    const protector = s.api.createRecordProtection({ ...s.options, transport });
    safeFailure(() => protector.seal({ apiKey: SECRET }, 'models'), s.api);
    protector.clear();
  }
  assert.ok(leaked.every((byte) => byte === 0));
  assert.ok(s.keyBuffers.every((buffer) => buffer.every((byte) => byte === 0)));
});

test('transport result getters/proxies are rejected without execution', () => {
  const s = setup();
  let called = 0;
  const accessor = { status: 0, get stdout() { called++; return Buffer.from(SECRET); } };
  const proxy = new Proxy({}, { ownKeys() { called++; throw new Error(SECRET); } });
  for (const result of [accessor, proxy]) {
    const protector = s.api.createRecordProtection({ ...s.options, transport: () => result });
    safeFailure(() => protector.seal({}, 'models'), s.api);
  }
  assert.equal(called, 0);
});

test('fixed executable, static script/argv, piped IO, bounded timeout/output and whitelisted environment', () => {
  const fake = fakeDpapi();
  const seen = [];
  const loaded = load({ spawn: (executable, args, options) => {
    seen.push({ executable, args, ...options });
    return fake.transport({ executable, args, ...options });
  } });
  const protector = loaded.api.createRecordProtection({ platform: 'linux', wsl: true });
  assert.deepEqual(loaded.counts(), { probes: 0, calls: 0 });
  const envelope = protector.seal({ apiKey: SECRET }, 'settings');
  assert.deepEqual(loaded.counts(), { probes: 1, calls: 1 });
  assert.equal(seen[0].executable, '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.deepEqual(seen[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(seen[0].args.length, 4);
  assert.equal(seen[0].timeout, 15000);
  assert.equal(seen[0].maxBuffer, 8192);
  assert.equal(seen[0].shell, false);
  assert.equal(seen[0].windowsHide, true);
  assert.deepEqual(seen[0].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(seen[0].encoding, undefined);
  assert.deepEqual(Object.keys(seen[0].env).sort(), process.env.WSL_INTEROP ? ['SystemRoot', 'WINDIR', 'WSL_INTEROP'] : ['SystemRoot', 'WINDIR']);
  assert.equal(seen[0].env.SystemRoot, 'C:\\Windows');
  assert.equal(seen[0].env.WINDIR, 'C:\\Windows');
  assert.equal(JSON.stringify(seen[0].args).includes(SECRET), false);
  const win = loaded.api.createRecordProtection({ platform: 'win32' });
  win.seal({}, 'settings');
  assert.equal(seen[1].executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(Object.keys(seen[1].env).sort(), ['SystemRoot', 'WINDIR']);
  assert.equal(seen[0].args[3], seen[1].args[3]);
  assert.equal(JSON.stringify(envelope).includes(SECRET), false);
  protector.clear(); win.clear();
});

test('unsupported OS/missing executable fails closed, no arbitrary command or password fallback', () => {
  const loaded = load({ exists: () => false });
  for (const options of [{ platform: 'darwin', wsl: false }, { platform: 'linux', wsl: false }, { platform: 'win32' }, { platform: 'linux', wsl: true }]) {
    const protector = loaded.api.createRecordProtection(options);
    safeFailure(() => protector.seal({ apiKey: SECRET }, 'models'), loaded.api);
    protector.clear();
  }
  safeFailure(() => loaded.api.createRecordProtection({ executable: '/arbitrary/command' }), loaded.api);
  safeFailure(() => loaded.api.createRecordProtection({ password: SECRET }), loaded.api);
  assert.equal(loaded.counts().calls, 0);
  assert.ok(loaded.keyBuffers.every((buffer) => buffer.every((byte) => byte === 0)));
});

test('per-purpose reuse, bounded LRU, failed opens not cached, clear wipes keys and permits fresh use', () => {
  const s = setup();
  const reader = s.api.createRecordProtection(s.options);
  const envelopes = [];
  for (let i = 0; i < 14; i++) {
    s.protector.clear();
    envelopes.push(s.protector.seal({ index: i }, 'records'));
    assert.deepEqual(reader.open(envelopes[i], 'records'), { index: i });
  }
  const before = s.calls.length;
  reader.open(envelopes.at(-1), 'records');
  assert.equal(s.calls.length, before);
  reader.open(envelopes[0], 'records');
  assert.equal(s.calls.length, before + 1); // First key was evicted at the 13th distinct record key.
  reader.clear();
  const corrupt = clone(envelopes[0]); corrupt.payload.tag = mutate(corrupt.payload.tag);
  safeFailure(() => reader.open(corrupt, 'records'), s.api);
  safeFailure(() => reader.open(corrupt, 'records'), s.api);
  assert.equal(s.calls.length, before + 3); // Failed authenticated payloads do not enter cache.
  s.protector.clear(); reader.clear();
  assert.ok(s.keyBuffers.every((buffer) => buffer.every((byte) => byte === 0)));
  const fresh = reader.seal({}, 'records');
  assert.notEqual(fresh.protectedKey, envelopes[0].protectedKey);
  reader.clear();
});

test('failed unprotect output length/canonical encoding never enters key cache', () => {
  const s = setup();
  const envelope = s.protector.seal({}, 'records');
  for (const stdout of [Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), 'A'.repeat(42) + 'B=']) {
    const protector = s.api.createRecordProtection({ ...s.options, transport: () => ({ status: 0, stdout: Buffer.from(stdout) }) });
    safeFailure(() => protector.open(envelope, 'records'), s.api);
    protector.clear();
  }
  s.protector.clear();
});
