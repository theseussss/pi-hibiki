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

// Read only the source and an existing TypeScript cache. No config, credentials,
// sessions, temporary files, commands, network, models, or dependency installation.
const require = createRequire(import.meta.url);
const sourcePath = fileURLToPath(new URL('../lib/model-pick/vault.ts', import.meta.url));
const ts = require(typescriptPath());
const compilation = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
  fileName: sourcePath,
  reportDiagnostics: true,
});
assert.equal(compilation.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0);
const compiled = vm.compileFunction(compilation.outputText, ['exports', 'require', 'module', 'JSON'], { filename: sourcePath });

function loadVault(cryptoModule = crypto, utilModule = util, jsonModule = JSON) {
  const module = { exports: {} };
  const imports = [];
  compiled(module.exports, (id) => {
    imports.push(id);
    if (id === 'node:crypto') return cryptoModule;
    if (id === 'node:util') return utilModule;
    throw new Error('Unexpected runtime import.');
  }, module, jsonModule);
  return { api: module.exports, imports };
}

const { api: vault, imports } = loadVault();
const { VaultError, sealJson, openJson, assertEnvelope, containsSecretMaterial } = vault;
const PASSWORD = 'synthetic-unlock-phrase-2026';
const FAKE_SECRET = 'FAKE_SECRET_NOT_A_REAL_CREDENTIAL_7b90';
const MAX = 4 * 1024 * 1024;
const AAD = Buffer.from('model-pick.vault/json;version=1;kdf=scrypt;cipher=aes-256-gcm');
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function rejects(operation, api = vault) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof api.VaultError);
    assert.equal(error.name, 'VaultError');
    assert.equal(error.message, 'Vault operation failed.');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    const printable = `${String(error)}\n${error.stack}\n${JSON.stringify(error)}`;
    for (const secret of [FAKE_SECRET, PASSWORD]) assert.equal(printable.includes(secret), false);
    return true;
  });
}

function changeBytes(base64) {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 1;
  return bytes.toString('base64');
}

// Independent crypto fixture for authenticated but unsupported JSON/UTF-8/schema.
function sealRaw(value, aad = AAD) {
  const plaintext = Buffer.from(value);
  const password = Buffer.from(PASSWORD);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT);
  let first;
  let last;
  let data;
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad);
    first = cipher.update(plaintext);
    last = cipher.final();
    data = Buffer.concat([first, last]);
    return {
      version: 1, kdf: 'scrypt', cipher: 'aes-256-gcm',
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
    };
  } finally {
    for (const buffer of [plaintext, password, key, first, last, data]) buffer?.fill(0);
  }
}

function nested(depth) {
  let value = null;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

test('fixed public API; the runtime imports only memory-only Node builtins', () => {
  assert.deepEqual(Object.keys(vault).sort(), [
    'VaultError', 'assertEnvelope', 'containsSecretMaterial', 'openJson', 'sealJson',
  ]);
  assert.deepEqual(imports.sort(), ['node:crypto', 'node:util']);
  rejects(() => { throw new VaultError(FAKE_SECRET, { cause: new Error(FAKE_SECRET) }); });
});

test('Chinese and nested provider/model parameters round-trip without mutating the input', () => {
  const value = {
    provider: '合成渠道', apiKey: FAKE_SECRET, headers: { Authorization: `Bearer ${FAKE_SECRET}` },
    models: [{ id: '测试模型', name: '中文 𠀀', contextWindow: 128000, maxTokens: 8192,
      reasoning: true, input: ['text', 'image'], parameters: { temperature: 0.4, stops: ['结束', '\n'] } }],
    empty: null, enabled: false,
  };
  const before = JSON.stringify(value);
  const envelope = sealJson(value, PASSWORD);
  assert.equal(assertEnvelope(envelope), undefined);
  assert.deepEqual(openJson(envelope, PASSWORD), value);
  assert.equal(JSON.stringify(value), before);
  const serialized = JSON.stringify(envelope);
  for (const plaintext of [FAKE_SECRET, PASSWORD, '合成渠道', '测试模型', 'Authorization']) {
    assert.equal(serialized.includes(plaintext), false);
  }
  const restored = openJson(JSON.parse(serialized), PASSWORD);
  assert.deepEqual(restored, value);
});

test('JSON primitives, dense arrays, null-prototype records and escaped Unicode are supported', () => {
  const record = Object.assign(Object.create(null), { ordinary: 'safe', nested: [null, true, false, 1.25] });
  const value = [record, '\b\t\n\f\r\u0000"\\', '\ud800', '\udc00', '𠀀汉字', '"}[false,\\"', -0];
  assert.deepEqual(openJson(sealJson(value, PASSWORD), PASSWORD), JSON.parse(JSON.stringify(value)));
  for (const primitive of [null, false, 23, '中文']) {
    assert.deepEqual(openJson(sealJson(primitive, PASSWORD), PASSWORD), primitive);
  }
});

test('fresh salt/IV change ciphertext and all crypto field lengths are fixed', () => {
  const first = sealJson({ apiKey: FAKE_SECRET }, PASSWORD);
  const second = sealJson({ apiKey: FAKE_SECRET }, PASSWORD);
  assert.deepEqual(Object.keys(first).sort(), ['cipher', 'data', 'iv', 'kdf', 'salt', 'tag', 'version']);
  assert.equal(first.version, 1);
  assert.equal(first.kdf, 'scrypt');
  assert.equal(first.cipher, 'aes-256-gcm');
  assert.equal(Buffer.from(first.salt, 'base64').length, 16);
  assert.equal(Buffer.from(first.iv, 'base64').length, 12);
  assert.equal(Buffer.from(first.tag, 'base64').length, 16);
  for (const field of ['salt', 'iv', 'data']) assert.notEqual(first[field], second[field]);
});

test('independent Node scrypt/AES-GCM implementation opens the envelope with the fixed AAD', () => {
  const envelope = sealJson({ apiKey: FAKE_SECRET, unicode: '密钥' }, PASSWORD);
  const password = Buffer.from(PASSWORD);
  const key = crypto.scryptSync(password, Buffer.from(envelope.salt, 'base64'), 32, SCRYPT);
  let first;
  let last;
  let plaintext;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    first = decipher.update(Buffer.from(envelope.data, 'base64'));
    last = decipher.final();
    plaintext = Buffer.concat([first, last]);
    assert.deepEqual(JSON.parse(plaintext.toString('utf8')), { apiKey: FAKE_SECRET, unicode: '密钥' });
  } finally {
    for (const buffer of [password, key, first, last, plaintext]) buffer?.fill(0);
  }
});

test('wrong passphrase and authenticated-field tampering have one non-leaking error', () => {
  const envelope = sealJson({ apiKey: FAKE_SECRET }, PASSWORD);
  rejects(() => openJson(envelope, `${PASSWORD}-wrong`));
  for (const field of ['salt', 'iv', 'tag', 'data']) {
    const changed = { ...envelope, [field]: changeBytes(envelope[field]) };
    assertEnvelope(changed); // Structure is not proof of authentication.
    rejects(() => openJson(changed, PASSWORD));
  }
  rejects(() => openJson(sealRaw('{"ok":true}', Buffer.from('different-schema/version')), PASSWORD));
});

test('strict envelope field set rejects unknown/missing fields and caller-selected algorithms/KDF work', () => {
  const envelope = sealJson('safe', PASSWORD);
  const missing = { ...envelope }; delete missing.tag;
  const inherited = Object.create(envelope);
  const symbol = { ...envelope, [Symbol('unknown')]: FAKE_SECRET };
  const nonEnumerable = { ...envelope };
  Object.defineProperty(nonEnumerable, 'extra', { value: FAKE_SECRET });
  const hiddenTag = { ...envelope };
  Object.defineProperty(hiddenTag, 'tag', { value: envelope.tag, enumerable: false });
  for (const value of [null, false, [], '', missing, inherited, symbol, nonEnumerable, hiddenTag,
    { ...envelope, extra: FAKE_SECRET }, { ...envelope, N: 1 }, { ...envelope, version: '1' },
    { ...envelope, version: 2 }, { ...envelope, kdf: 'pbkdf2' }, { ...envelope, cipher: 'aes-128-gcm' }]) {
    rejects(() => assertEnvelope(value));
    rejects(() => openJson(value, PASSWORD));
  }
  assertEnvelope(Object.assign(Object.create(null), envelope));
  assert.deepEqual(openJson(Object.freeze(envelope), PASSWORD), 'safe');
});

test('envelope accessors and proxies are rejected without executing user code', () => {
  const envelope = sealJson('safe', PASSWORD);
  let calls = 0;
  const accessor = { ...envelope };
  Object.defineProperty(accessor, 'data', { enumerable: true, get() { calls++; throw new Error(FAKE_SECRET); } });
  const proxy = new Proxy(envelope, {
    get() { calls++; throw new Error(FAKE_SECRET); },
    ownKeys() { calls++; throw new Error(FAKE_SECRET); },
    getPrototypeOf() { calls++; throw new Error(FAKE_SECRET); },
  });
  for (const value of [accessor, proxy]) {
    rejects(() => assertEnvelope(value));
    rejects(() => openJson(value, PASSWORD));
  }
  assert.equal(calls, 0);
});

test('only canonical bounded standard Base64 is accepted, including zero pad bits', () => {
  const envelope = sealJson('safe', PASSWORD);
  const salt = Buffer.alloc(16).toString('base64');
  const malformed = [
    { salt: '' }, { salt: salt.slice(0, -2) }, { salt: `${salt}\n` },
    { salt: `-${salt.slice(1)}` }, { salt: `${salt.slice(0, -3)}B==` },
    { iv: Buffer.alloc(11).toString('base64') }, { tag: Buffer.alloc(15).toString('base64') },
    { data: '' }, { data: 'AA' }, { data: 'AA===' }, { data: 'A===' }, { data: '====' },
    { data: 'A A=' }, { data: 'AA\n=' }, { data: 'AA-=' }, { data: 'AA_=' },
    { data: 'AB==' }, { data: 'AAB=' }, { data: FAKE_SECRET }, { data: 42 },
  ];
  for (const replacement of malformed) rejects(() => assertEnvelope({ ...envelope, ...replacement }));
  for (const data of ['AA==', 'AAA=', 'AAAA', Buffer.alloc(MAX).toString('base64')]) {
    assertEnvelope({ ...envelope, data });
  }
  // MAX and MAX+1 can have the same encoded length; check decoded size too.
  rejects(() => assertEnvelope({ ...envelope, data: Buffer.alloc(MAX + 1).toString('base64') }));
  rejects(() => assertEnvelope({ ...envelope, data: 'A'.repeat(Math.ceil(MAX / 3) * 4 + 4) }));
});

test('passphrases require 12..1024 well-formed Unicode code points, at most 4096 UTF-8 bytes', () => {
  for (const password of ['', 'a'.repeat(11), '密'.repeat(11), '𠀀'.repeat(6), 'a'.repeat(1025),
    '𠀀'.repeat(1025), '\ud800'.repeat(12), null, undefined, 42, Buffer.alloc(12), new String(PASSWORD)]) {
    rejects(() => sealJson(FAKE_SECRET, password));
    rejects(() => openJson({}, password));
  }
  for (const password of ['密'.repeat(12), '𠀀'.repeat(1024)]) {
    assert.equal(openJson(sealJson('中文', password), password), '中文');
  }
});

test('exact 4 MiB serialized-JSON boundary round-trips', () => {
  const value = 'x'.repeat(MAX - 2); // JSON quotes consume two bytes.
  const envelope = sealJson(value, PASSWORD);
  assert.equal(Buffer.from(envelope.data, 'base64').length, MAX);
  assert.equal(openJson(envelope, PASSWORD), value);
});

test('oversized/too-deep/too-many-node values and malformed envelopes fail before entropy or scrypt', () => {
  let expensive = 0;
  const { api } = loadVault({ ...crypto,
    randomBytes() { expensive++; throw new Error(FAKE_SECRET); },
    scryptSync() { expensive++; throw new Error(FAKE_SECRET); },
  });
  for (const value of ['x'.repeat(MAX - 1), '\0'.repeat(Math.floor(MAX / 6) + 1),
    { payload: 'x'.repeat(MAX - 2) }, '汉'.repeat(Math.floor(MAX / 3) + 1),
    nested(65), Array(100_000).fill(null)]) {
    rejects(() => api.sealJson(value, PASSWORD), api);
  }
  rejects(() => api.openJson({ data: 'x'.repeat(MAX * 2) }, PASSWORD), api);
  assert.equal(expensive, 0);
  assert.equal(containsSecretMaterial(nested(65)), true);
  assert.equal(containsSecretMaterial('x'.repeat(MAX)), true);
  assert.deepEqual(openJson(sealJson(nested(64), PASSWORD), PASSWORD), nested(64));
});

test('only ordinary JSON is accepted: no silent omissions, coercions, getters, hooks, symbols or cycles', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'apiKey', { enumerable: true, get() { calls++; throw new Error(FAKE_SECRET); } });
  const hook = { toJSON() { calls++; throw new Error(FAKE_SECRET); } };
  const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error(FAKE_SECRET); } });
  const cycle = {}; cycle.self = cycle;
  const indirect = [null]; indirect[0] = { parent: indirect };
  const extraArray = [1]; extraArray.extra = 'not JSON';
  const symbolArray = [1]; symbolArray[Symbol('not JSON')] = 2;
  const hidden = Object.defineProperty({}, 'apiKey', { value: FAKE_SECRET });
  const symbol = { [Symbol('apiKey')]: FAKE_SECRET };
  const values = [undefined, () => FAKE_SECRET, Symbol('value'), 1n, NaN, Infinity, -Infinity,
    { missing: undefined }, [undefined], new Date(0), new Map(), new Set(), /regex/,
    Buffer.from(FAKE_SECRET), new String('value'), Object.create({ inherited: FAKE_SECRET }),
    accessor, hook, proxy, cycle, indirect, Array(1), extraArray, symbolArray, hidden, symbol];
  for (const value of values) {
    rejects(() => sealJson(value, PASSWORD));
    assert.equal(containsSecretMaterial(value), true);
  }
  assert.equal(calls, 0);
  const shared = { value: 'ordinary' };
  assert.deepEqual(openJson(sealJson([shared, shared], PASSWORD), PASSWORD), [shared, shared]);
});

test('prototype-pollution names are rejected recursively on seal and authenticated open', () => {
  const inputs = [
    '{"__proto__":{"vaultTestPolluted":true}}',
    '{"nested":{"constructor":{"prototype":{"vaultTestPolluted":true}}}}',
    '{"array":[{"prototype":{"vaultTestPolluted":true}}]}',
  ];
  for (const json of inputs) {
    const value = JSON.parse(json);
    rejects(() => sealJson(value, PASSWORD));
    assert.equal(containsSecretMaterial(value), true);
    rejects(() => openJson(sealRaw(json), PASSWORD));
    assert.equal({}.vaultTestPolluted, undefined);
  }
  const ordinaryStrings = { name: 'constructor', values: ['__proto__', 'prototype'] };
  assert.deepEqual(openJson(sealJson(ordinaryStrings, PASSWORD), PASSWORD), ordinaryStrings);
});

test('authenticated plaintext is still checked for valid UTF-8, JSON, finite numbers and depth', () => {
  for (const raw of [Buffer.from([0xc3, 0x28]), `invalid JSON ${FAKE_SECRET}`, '1e999',
    '\ufeff{"ok":true}', '{"value":undefined}', '['.repeat(65) + 'null' + ']'.repeat(65)]) {
    rejects(() => openJson(sealRaw(raw), PASSWORD));
  }
});

test('decrypted depth/token bombs are rejected before JSON.parse allocates their object graph', () => {
  let parses = 0;
  const { api } = loadVault(crypto, util, {
    stringify: JSON.stringify,
    parse() { parses++; throw new Error(FAKE_SECRET); },
  });
  for (const raw of ['['.repeat(65) + 'null' + ']'.repeat(65),
    '['.repeat(20_000) + 'null' + ']'.repeat(20_000),
    '[' + Array(200_000).fill('0').join(',') + ']']) {
    rejects(() => api.openJson(sealRaw(raw), PASSWORD), api);
  }
  assert.equal(parses, 0);
  let empty = {};
  for (let i = 0; i < 64; i++) empty = [empty];
  assert.deepEqual(openJson(sealJson(empty, PASSWORD), PASSWORD), empty);
});

test('secret classification is recursive, conservative for auth/headers, and includes unresolved references', () => {
  const sensitive = [
    { apiKey: FAKE_SECRET }, { api_key: 'env:FAKE_API_KEY' }, { 'API-KEY': '!printf SYNTHETIC' },
    { headers: {} }, { headers: { 'Content-Type': 'application/json' } }, { requestHeaders: null },
    { httpHeaders: {} }, { clientSecretRef: 'synthetic-ref' }, { passwordRef: 'synthetic-ref' },
    { oauth: {} }, { OAuth2: {} }, { clientSecret: FAKE_SECRET }, { access_token: FAKE_SECRET },
    { nested: [{ refreshToken: FAKE_SECRET }] }, { token: '' }, { password: null },
    { authorization: '' }, { credentials: {} }, { privateKey: FAKE_SECRET },
    { apiKeyRef: 'synthetic-credential-reference' }, { cookie: '' },
    { unknownField: 'env:FAKE_API_KEY' }, { unknownField: '!do-not-execute' },
    '${FAKE_API_KEY}', '$FAKE_API_KEY', 'process.env.FAKE_API_KEY', `Bearer ${FAKE_SECRET}`,
    { baseUrl: 'https://synthetic:password@example.invalid/v1' },
    { baseUrl: 'https://example.invalid/v1?api_key=synthetic' },
  ];
  for (const value of sensitive) assert.equal(containsSecretMaterial(value), true);
  const ordinary = {
    provider: 'synthetic', id: 'token-count-model', name: '普通模型', api: 'openai-completions',
    baseUrl: 'https://example.invalid/v1', contextWindow: 128000, maxTokens: 8192,
    inputTokens: 12, outputTokens: 15, tokenLimit: 4096, reasoning: false, input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    parameters: { temperature: 0.4, topP: 0.9 }, enabled: true,
  };
  assert.equal(containsSecretMaterial(ordinary), false);
  for (const value of [null, false, 42, [], {}, 'ordinary text', { arbitraryName: FAKE_SECRET }]) {
    assert.equal(containsSecretMaterial(value), false); // A heuristic cannot identify opaque arbitrary names.
  }
  assert.equal(containsSecretMaterial(sealJson({ apiKey: FAKE_SECRET }, PASSWORD)), false);
});

function instrument({ failFinal = false, failKdf = false } = {}) {
  const buffers = [];
  let decodes = 0;
  const { api } = loadVault({ ...crypto,
    scryptSync(password, ...args) {
      buffers.push(password);
      if (failKdf) throw new Error(FAKE_SECRET);
      const key = crypto.scryptSync(password, ...args);
      buffers.push(key);
      return key;
    },
    createCipheriv(...args) {
      const cipher = crypto.createCipheriv(...args);
      return {
        setAAD: (...values) => cipher.setAAD(...values),
        update(value) { buffers.push(value); return cipher.update(value); },
        final() { if (failFinal) throw new Error(FAKE_SECRET); return cipher.final(); },
        getAuthTag: () => cipher.getAuthTag(),
      };
    },
    createDecipheriv(...args) {
      const decipher = crypto.createDecipheriv(...args);
      return {
        setAAD: (...values) => decipher.setAAD(...values),
        setAuthTag: (...values) => decipher.setAuthTag(...values),
        update(value) { const result = decipher.update(value); buffers.push(result); return result; },
        final() { const result = decipher.final(); buffers.push(result); return result; },
      };
    },
  }, { ...util,
    TextDecoder: class extends util.TextDecoder {
      decode(value, ...args) { decodes++; buffers.push(value); return super.decode(value, ...args); }
    },
  });
  return {
    api, decodes: () => decodes,
    assertCleared() {
      assert.ok(buffers.length > 0);
      for (const buffer of buffers) assert.equal(buffer.every((byte) => byte === 0), true);
    },
  };
}

test('password/key/plaintext buffers are cleared on success and authentication/JSON failure', () => {
  const tracked = instrument();
  const envelope = tracked.api.sealJson({ apiKey: FAKE_SECRET }, PASSWORD);
  tracked.assertCleared();
  assert.deepEqual(tracked.api.openJson(envelope, PASSWORD), { apiKey: FAKE_SECRET });
  tracked.assertCleared();
  assert.equal(tracked.decodes(), 1);
  rejects(() => tracked.api.openJson({ ...envelope, tag: changeBytes(envelope.tag) }, PASSWORD), tracked.api);
  assert.equal(tracked.decodes(), 1); // No UTF-8 decode before authentication succeeds.
  tracked.assertCleared();
  rejects(() => tracked.api.openJson(sealRaw(`invalid JSON ${FAKE_SECRET}`), PASSWORD), tracked.api);
  tracked.assertCleared();
});

test('buffers are also cleared when crypto throws, without exposing the original error/cause', () => {
  for (const options of [{ failFinal: true }, { failKdf: true }]) {
    const tracked = instrument(options);
    rejects(() => tracked.api.sealJson({ apiKey: FAKE_SECRET }, PASSWORD), tracked.api);
    tracked.assertCleared();
  }
});

// These tests assert a bounded in-process crypto API only. They do not establish
// OS keychain integration, same-UID isolation, complete JS-string erasure, storage
// atomicity, Pi credential compatibility, migration, or real upstream security.
