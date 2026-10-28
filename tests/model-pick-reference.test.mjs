import assert from 'node:assert/strict';
import { typescriptPath } from '../scripts/tooling.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Same offline TypeScript cache convention as model-pick-navigation.test.mjs.
// Only this source and the cached compiler/standard libraries are read. No
// registry, real configuration, sessions, dependencies install, or requests.
const require = createRequire(import.meta.url);
const referencePath = fileURLToPath(new URL('../lib/model-pick/reference.ts', import.meta.url));
const tsPath = typescriptPath();
const ts = require(tsPath);
assert.equal(ts.version, '5.6.3');
const compiled = ts.transpileModule(fs.readFileSync(referencePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true },
  fileName: referencePath,
  reportDiagnostics: true,
});
assert.deepEqual(compiled.diagnostics ?? [], []);
const forbidden = () => { throw new Error('pure module attempted a host side effect'); };
const module = { exports: {} };
const sandbox = {
  module,
  exports: module.exports,
  require: forbidden,
  fetch: forbidden,
  setTimeout: forbidden,
  setInterval: forbidden,
  setImmediate: forbidden,
  clearTimeout: forbidden,
  clearInterval: forbidden,
  clearImmediate: forbidden,
  console: { log: forbidden, warn: forbidden, error: forbidden, info: forbidden, debug: forbidden },
  Date: class { constructor() { forbidden(); } static now = forbidden; },
};
Object.defineProperty(sandbox, 'process', { get: forbidden });
vm.runInNewContext(compiled.outputText, sandbox, {
  filename: referencePath,
  contextCodeGeneration: { strings: false, wasm: false },
});
const api = module.exports;
// Convert VM objects to host objects for strict assertions. Aliasing tests below
// deliberately use the raw API rather than this convenience clone.
const resolve = (input) => structuredClone(api.resolveModelFields(input));
const template = (...args) => structuredClone(api.findModelTemplate(...args));
const NOW = 1700000000000;
const SCOPE = Object.freeze({
  provider: 'synthetic-provider', modelId: 'exact-model', endpoint: 'https://example.invalid/v1',
  api: 'synthetic-api', credentialVersion: 'opaque-version-1',
});
const allFields = () => ({
  name: 'Reference model', contextWindow: 32000, maxTokens: 4096, reasoning: true, input: ['text', 'image'],
});
const base = (overrides = {}) => ({ scope: SCOPE, now: NOW, ...overrides });
const record = (fields, overrides = {}) => ({
  id: 'synthetic-test', scope: { ...SCOPE }, testedAt: NOW - 100, expiresAt: NOW + 100,
  fields, verifiedFields: Object.keys(fields), status: 'passed', ...overrides,
});
const reasons = (result, field, source) => result.provenance[field].history
  .filter((entry) => entry.source === source).map((entry) => entry.reason);
const hasReason = (result, field, source, reason) => assert.ok(
  reasons(result, field, source).some((value) => value === reason || value.endsWith(`:${reason}`)),
  `${field}/${source} lacks ${reason}: ${JSON.stringify(reasons(result, field, source))}`,
);

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('source passes strict TS 5.6.3 without discovering or reading project configs', () => {
  const program = ts.createProgram([referencePath], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\n',
  }));
});

test('missing specs yield explicit unconfirmed defaults and per-layer history', () => {
  const result = resolve(base());
  assert.deepEqual(result.fields, {
    name: SCOPE.modelId, contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ['text'],
  });
  assert.deepEqual(result.needsReview, ['contextWindow', 'maxTokens', 'reasoning', 'input']);
  for (const field of Object.keys(result.fields)) {
    assert.equal(result.provenance[field].source, 'default');
    for (const source of ['tested', 'manual', 'provider', 'generic']) hasReason(result, field, source, 'missing');
  }
  hasReason(result, 'maxTokens', 'default', 'unconfirmed-conservative-default');
});

test('verified tests beat manual, then provider, then generic, independently per field', () => {
  const result = resolve(base({
    tests: [record({ reasoning: false, contextWindow: 64000, name: 'Not attested' }, {
      verifiedFields: ['reasoning', 'contextWindow'],
    })],
    manual: { name: 'Manual name', maxTokens: 2048, reasoning: true },
    providerModel: { ...allFields(), input: ['text'] },
    generic: { ...allFields(), contextWindow: 256000 },
  }));
  assert.deepEqual(result.fields, {
    name: 'Manual name', contextWindow: 64000, maxTokens: 2048, reasoning: false, input: ['text'],
  });
  assert.equal(result.provenance.reasoning.source, 'tested');
  assert.equal(result.provenance.contextWindow.source, 'tested');
  assert.equal(result.provenance.name.source, 'manual');
  assert.equal(result.provenance.input.source, 'provider');
  hasReason(result, 'name', 'tested', 'not-verified');
  hasReason(result, 'reasoning', 'manual', 'lower-priority');
  hasReason(result, 'input', 'generic', 'lower-priority');
  assert.deepEqual(result.needsReview, []);
});

test('manual false is a valid value, not a missing field', () => {
  const result = resolve(base({ manual: { reasoning: false }, providerModel: allFields() }));
  assert.equal(result.fields.reasoning, false);
  assert.equal(result.provenance.reasoning.source, 'manual');
  hasReason(result, 'reasoning', 'manual', 'selected');
});

for (const [label, value] of [
  ['zero', 0], ['negative', -1], ['fraction', 1.5], ['NaN', NaN], ['infinity', Infinity],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['numeric string', '1024'], ['null', null],
]) {
  for (const field of ['contextWindow', 'maxTokens']) {
    test(`${field}: ${label} is invalid, not absent, and falls back with history`, () => {
      const result = resolve(base({ manual: { [field]: value }, providerModel: allFields() }));
      assert.equal(result.fields[field], allFields()[field]);
      assert.equal(result.provenance[field].source, 'provider');
      hasReason(result, field, 'manual', 'invalid-value');
      assert.ok(result.needsReview.includes(field));
    });
  }
}

test('invalid names/booleans/modalities fall through; valid arrays are normalized as sets', () => {
  const result = resolve(base({
    manual: { name: '  ', reasoning: 0, input: [] }, providerModel: allFields(),
  }));
  for (const field of ['name', 'reasoning', 'input']) {
    assert.equal(result.provenance[field].source, 'provider');
    hasReason(result, field, 'manual', 'invalid-value');
  }
  assert.equal(resolve(base({ manual: { input: ['image', 'text', 'image'] } })).fields.input.join(','), 'text,image');
  assert.equal(resolve(base({ manual: { input: ['image'] } })).fields.input.join(','), 'image');
  hasReason(resolve(base({ manual: { input: ['audio'] } })), 'input', 'manual', 'invalid-value');
});

for (const key of ['provider', 'modelId', 'endpoint', 'api', 'credentialVersion']) {
  test(`a changed ${key} invalidates the whole test scope`, () => {
    const result = resolve(base({
      tests: [record({ reasoning: false }, { scope: { ...SCOPE, [key]: `${SCOPE[key]}-changed` } })],
      manual: allFields(),
    }));
    assert.equal(result.fields.reasoning, true);
    assert.equal(result.provenance.reasoning.source, 'manual');
    for (const field of Object.keys(result.fields)) hasReason(result, field, 'tested', 'scope-mismatch');
  });
}

test('scope matching is exact: missing/inherited fields or endpoint slash changes do not match', () => {
  const incomplete = { ...SCOPE };
  delete incomplete.credentialVersion;
  for (const scope of [incomplete, Object.create(SCOPE), { ...SCOPE, endpoint: `${SCOPE.endpoint}/` }]) {
    const result = resolve(base({ tests: [record({ reasoning: false }, { scope })], manual: allFields() }));
    assert.equal(result.provenance.reasoning.source, 'manual');
    hasReason(result, 'reasoning', 'tested', 'scope-mismatch');
  }
});

for (const [label, times, reason] of [
  ['expired', { expiresAt: NOW - 1 }, 'expired'],
  ['expires exactly now', { expiresAt: NOW }, 'expired'],
  ['future', { testedAt: NOW + 1, expiresAt: NOW + 200 }, 'future'],
  ['inverted lifetime', { expiresAt: NOW - 101 }, 'invalid-time'],
  ['zero lifetime', { expiresAt: NOW - 100 }, 'invalid-time'],
  ['nonfinite test date', { testedAt: NaN }, 'invalid-time'],
  ['infinite expiration', { expiresAt: Infinity }, 'invalid-time'],
  ['negative test date', { testedAt: -1 }, 'invalid-time'],
]) {
  test(`${label} records never acquire tested priority`, () => {
    const result = resolve(base({ tests: [record({ reasoning: false }, times)], manual: allFields() }));
    assert.equal(result.fields.reasoning, true);
    assert.equal(result.provenance.reasoning.source, 'manual');
    hasReason(result, 'reasoning', 'tested', reason);
  });
}

test('test timestamp equal to now is valid, but an invalid caller clock disables test priority', () => {
  const tests = [record({ reasoning: false }, { testedAt: NOW })];
  assert.equal(resolve(base({ tests })).provenance.reasoning.source, 'tested');
  for (const now of [NaN, Infinity, -1, 1.5]) {
    const result = resolve(base({ tests, now, manual: allFields() }));
    assert.equal(result.provenance.reasoning.source, 'manual');
    hasReason(result, 'reasoning', 'tested', 'invalid-now');
  }
});

test('failed and inconclusive tests, and malformed attestations, do not override manual', () => {
  for (const status of ['failed', 'inconclusive']) {
    const result = resolve(base({ tests: [record({ reasoning: false }, { status })], manual: allFields() }));
    assert.equal(result.fields.reasoning, true);
    hasReason(result, 'reasoning', 'tested', 'status-not-passed');
  }
  for (const verifiedFields of [undefined, 'reasoning', [42]]) {
    const result = resolve(base({ tests: [record({ reasoning: false }, { verifiedFields })], manual: allFields() }));
    assert.equal(result.fields.reasoning, true);
    hasReason(result, 'reasoning', 'tested', 'invalid-verified-fields');
  }
});

test('only verifiedFields count; measured lower bounds and AI prose are not promoted into maxima', () => {
  const result = resolve(base({
    tests: [record({
      contextWindow: 1000000, maxTokens: 100000, reasoning: false,
      contextWindowLowerBound: 1000000, acceptedTokens: 1000000, aiDescription: 'I support a million tokens',
    }, { verifiedFields: ['reasoning', 'contextWindowLowerBound', 'acceptedTokens', 'aiDescription'] })],
    manual: allFields(),
  }));
  assert.equal(result.fields.contextWindow, 32000);
  assert.equal(result.fields.maxTokens, 4096);
  assert.equal(result.fields.reasoning, false);
  hasReason(result, 'contextWindow', 'tested', 'not-verified');
  assert.deepEqual(Object.keys(result.fields).sort(), ['contextWindow', 'input', 'maxTokens', 'name', 'reasoning']);
});

test('optional proof metadata rejects self-report, inferred values, and lower/observed bounds', () => {
  for (const [kind, reason] of [
    ['self-report', 'not-observed-evidence'], ['inferred', 'not-observed-evidence'],
    ['lower-bound', 'lower-bound-not-exact'], ['observed', 'observation-not-maximum'],
  ]) {
    const result = resolve(base({
      tests: [record({ contextWindow: 64000, maxTokens: 8000 }, {
        evidence: { contextWindow: { kind }, maxTokens: { kind } },
      })],
      manual: allFields(),
    }));
    assert.equal(result.fields.contextWindow, 32000);
    assert.equal(result.fields.maxTokens, 4096);
    hasReason(result, 'contextWindow', 'tested', reason);
    hasReason(result, 'maxTokens', 'tested', reason);
  }
  const result = resolve(base({ tests: [record({ contextWindow: 64000, reasoning: false }, {
    evidence: { contextWindow: { kind: 'exact-limit' }, reasoning: { kind: 'observed' } },
  })] }));
  assert.equal(result.provenance.contextWindow.source, 'tested');
  assert.equal(result.provenance.reasoning.source, 'tested');
});

test('malformed or incomplete optional proof metadata fails closed for the affected attestation', () => {
  for (const [evidence, reason] of [
    [null, 'invalid-evidence'], ['AI said yes', 'invalid-evidence'], [[], 'invalid-evidence'],
    [{}, 'missing-evidence'], [{ reasoning: {} }, 'invalid-evidence'],
  ]) {
    const result = resolve(base({ tests: [record({ reasoning: false }, { evidence })], manual: allFields() }));
    assert.equal(result.fields.reasoning, true);
    hasReason(result, 'reasoning', 'tested', reason);
  }
});

test('newest applicable valid test wins per field; newer invalid/unverified values do not erase older proof', () => {
  const older = record({ contextWindow: 64000, name: 'Older proven name', reasoning: false }, {
    testedAt: NOW - 50,
  });
  const newer = record({ contextWindow: 0, maxTokens: 1024, name: 'Not proven' }, {
    testedAt: NOW - 10, verifiedFields: ['contextWindow', 'maxTokens'],
  });
  const result = resolve(base({ tests: [older, newer], manual: allFields() }));
  assert.equal(result.fields.contextWindow, 64000);
  assert.equal(result.fields.maxTokens, 1024);
  assert.equal(result.fields.name, 'Older proven name');
  assert.equal(result.fields.reasoning, false);
  assert.deepEqual(result.provenance.contextWindow.history.slice(0, 2), [
    { source: 'tested', reason: 'test[1]:invalid-value' },
    { source: 'tested', reason: 'test[0]:selected' },
  ]);
  const tie = resolve(base({ tests: [record({ name: 'First' }), record({ name: 'Second' })] }));
  assert.equal(tie.fields.name, 'First');
  hasReason(tie, 'name', 'tested', 'lower-priority');
});

test('all fallback levels retain missing/invalid/selected reasons', () => {
  const result = resolve(base({
    tests: [record({ name: 'Ignored' }, { verifiedFields: [] })],
    manual: { contextWindow: 0 },
    providerModel: { contextWindow: -1 },
    generic: { contextWindow: 48000, reasoning: false },
  }));
  assert.equal(result.fields.contextWindow, 48000);
  assert.equal(result.provenance.contextWindow.source, 'generic');
  hasReason(result, 'contextWindow', 'tested', 'not-verified');
  hasReason(result, 'contextWindow', 'manual', 'invalid-value');
  hasReason(result, 'contextWindow', 'provider', 'invalid-value');
  hasReason(result, 'contextWindow', 'generic', 'selected');
  hasReason(result, 'contextWindow', 'default', 'lower-priority');
  assert.equal(result.provenance.maxTokens.source, 'default');
  assert.ok(result.needsReview.includes('maxTokens'));
});

test('output claims exceeding the selected context fall through, without enlarging context', () => {
  const result = resolve(base({
    tests: [record({ maxTokens: 64000 })],
    manual: { contextWindow: 4096, maxTokens: 8192 },
    providerModel: { maxTokens: 2048 },
    generic: { contextWindow: 128000, maxTokens: 1024 },
  }));
  assert.equal(result.fields.contextWindow, 4096);
  assert.equal(result.fields.maxTokens, 2048);
  assert.equal(result.provenance.maxTokens.source, 'provider');
  hasReason(result, 'maxTokens', 'tested', 'exceeds-context');
  hasReason(result, 'maxTokens', 'manual', 'exceeds-context');
  assert.ok(result.needsReview.includes('maxTokens'));
});

test('default output is clamped to a small valid context and stays an unconfirmed default', () => {
  for (const contextWindow of [1, 4096, 8192, Number.MAX_SAFE_INTEGER]) {
    const result = resolve(base({ manual: { contextWindow, maxTokens: contextWindow + 1 } }));
    assert.equal(result.fields.contextWindow, contextWindow);
    assert.equal(result.fields.maxTokens, Math.min(8192, contextWindow));
    assert.ok(Number.isSafeInteger(result.fields.maxTokens) && result.fields.maxTokens > 0);
    assert.ok(result.fields.maxTokens <= result.fields.contextWindow);
    assert.equal(result.provenance.maxTokens.source, 'default');
    assert.ok(result.needsReview.includes('maxTokens'));
    if (contextWindow < 8192) hasReason(result, 'maxTokens', 'default', 'unconfirmed-default-clamped-to-context');
  }
});

test('template lookup matches exact ID and optional provider only, not names, aliases or prefixes', () => {
  const catalog = [
    { provider: 'first', id: 'model-extra', name: 'model', contextWindow: 200000 },
    { provider: 'first', id: 'model', name: 'Exact first', contextWindow: 32000 },
    { provider: 'second', id: 'model', name: 'Exact second', contextWindow: 64000 },
  ];
  assert.deepEqual(template('model', catalog, 'second'), { name: 'Exact second', contextWindow: 64000 });
  for (const id of ['Model', 'model ', 'mode', 'Exact first', '']) assert.equal(template(id, catalog), undefined);
  assert.equal(template('model', catalog, 'missing'), undefined);
  assert.equal(template('model', catalog, 'First'), undefined);
});

test('cross-provider generic conflicts are ambiguous, never the first matching template', () => {
  for (const [field, value] of [
    ['contextWindow', 64000], ['maxTokens', 1024], ['reasoning', false],
    ['input', ['text']], ['name', 'Different display name'],
  ]) {
    const catalog = [
      { provider: 'a', id: 'model', ...allFields() },
      { provider: 'b', id: 'model', ...allFields(), [field]: value },
    ];
    assert.equal(template('model', catalog), undefined);
    assert.equal(template('model', catalog.slice().reverse()), undefined);
    assert.deepEqual(template('model', catalog, 'a'), allFields());
  }
  assert.equal(template('model', [
    { provider: 'a', id: 'model', reasoning: false },
    { provider: 'a', id: 'model', reasoning: true },
  ], 'a'), undefined);
});

test('equivalent generic specs yield only shared fields, never a channel-specific partial field', () => {
  const catalog = [
    { provider: 'a', id: 'model', contextWindow: 32000, input: ['text', 'image'], reasoning: false },
    { provider: 'b', id: 'model', contextWindow: 32000, input: ['image', 'text'] },
  ];
  assert.deepEqual(template('model', catalog), { contextWindow: 32000, input: ['text', 'image'] });
  assert.deepEqual(template('model', catalog.slice().reverse()), template('model', catalog));
  assert.equal(template('model', [{ provider: 'a', id: 'model', api: 'not-a-model-field' }]), undefined);
});

test('templates validate allowed fields and omit an impossible context/output pair', () => {
  const result = template('model', [{
    provider: 'a', id: 'model', name: '', contextWindow: 1024, maxTokens: 4096, reasoning: false,
    input: ['audio'],
  }]);
  assert.deepEqual(result, { contextWindow: 1024, reasoning: false });
  assert.equal(template('model', [{ provider: 'a', id: 'model', contextWindow: NaN, maxTokens: 0 }]), undefined);
});

test('no API/baseURL/auth/compat/price, test metadata, or raw scope is copied into results', () => {
  const extras = {
    api: 'channel-api', baseUrl: 'https://other.invalid', endpoint: 'https://other.invalid',
    compat: { mode: 'channel-specific' }, price: { input: 99 }, cost: { output: 9 },
    apiKey: 'synthetic-secret-marker', headers: { authorization: 'synthetic-secret-marker' },
    credentialVersion: 'opaque-channel-version', scope: { endpoint: 'synthetic-private-endpoint' },
  };
  const fields = { ...allFields(), ...extras };
  Object.defineProperty(fields, 'unrelatedGetter', { get: forbidden, enumerable: true });
  const catalog = [{ provider: 'a', id: 'model', ...extras, ...allFields() }];
  const expected = allFields();
  assert.deepEqual(template('model', catalog), expected);
  const fromReference = resolve(base({ manual: fields, providerModel: fields, generic: fields }));
  assert.deepEqual(fromReference.fields, expected);
  const fromTest = resolve(base({ tests: [record(fields, { rawResponse: extras, id: 'synthetic-private-id' })] }));
  assert.deepEqual(fromTest.fields, expected);
  const text = JSON.stringify({ fromReference, fromTest });
  for (const marker of ['synthetic-secret-marker', 'synthetic-private-endpoint', 'synthetic-private-id', SCOPE.endpoint, SCOPE.credentialVersion]) {
    assert.ok(!text.includes(marker));
  }
});

test('getters/prototype values and sparse arrays cannot smuggle field values or trigger getters', () => {
  const manual = Object.create({ reasoning: true, contextWindow: 1000000 });
  Object.defineProperty(manual, 'maxTokens', { get: forbidden, enumerable: true });
  const modalities = [];
  Object.defineProperty(modalities, '0', { get: forbidden, enumerable: true });
  modalities.length = 1;
  manual.input = modalities;
  const result = resolve(base({ manual, providerModel: allFields() }));
  assert.equal(result.fields.contextWindow, 32000);
  assert.equal(result.fields.maxTokens, 4096);
  hasReason(result, 'maxTokens', 'manual', 'invalid-value');
  hasReason(result, 'input', 'manual', 'invalid-value');
  hasReason(resolve(base({ manual: { input: new Array(1) } })), 'input', 'manual', 'invalid-value');
  const tests = new Array(1);
  assert.equal(resolve(base({ tests })).provenance.reasoning.source, 'default');
});

test('frozen inputs stay unchanged; selected modality arrays and histories are detached', () => {
  const manual = freezeDeep(allFields());
  const tests = freezeDeep([record({ reasoning: false }), record({ name: 'Newer' }, { testedAt: NOW - 10 })]);
  const input = freezeDeep(base({ manual, tests }));
  const before = JSON.stringify(input);
  const result = api.resolveModelFields(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(result.fields.input, manual.input);
  result.fields.input.push('image');
  result.provenance.input.history.push({ source: 'manual', reason: 'local-only' });
  const again = resolve(input);
  assert.deepEqual(again.fields.input, ['text', 'image']);
  assert.ok(!reasons(again, 'input', 'manual').includes('local-only'));
  const catalog = freezeDeep([{ provider: 'a', id: 'model', ...allFields() }]);
  const found = api.findModelTemplate('model', catalog, 'a');
  assert.notEqual(found.input, catalog[0].input);
  found.input.push('image');
  assert.deepEqual(template('model', catalog).input, ['text', 'image']);
});
