import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadTypeScript } from './model-pick-loader.mjs';
const source = fileURLToPath(new URL('../lib/model-pick/auth-file.ts', import.meta.url));
function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-auth-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = loadTypeScript(source, { 'node:fs': fs });
  if (initial !== undefined) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(initial, null, 2), { mode: 0o600 });
  return { dir, api, store: new api.AuthFile(dir), file: path.join(dir, 'auth.json') };
}
// Independent writes are intentionally retired. Native lease/commit/rollback
// coverage now lives in hibiki-provider-safety.test.mjs, not a fake owner protocol.
test('legacy independent key writer fails closed before any file or lock creation', t => {
  const f = fixture(t);
  assert.throws(() => f.store.setApiKey('relay', 'SYNTHETIC-KEY'), { name: 'AuthFileError', code: 'coordinated' });
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
test('legacy independent writer cannot replace an existing key or OAuth', t => {
  const f = fixture(t, { keep: { type: 'api_key', key: 'SYNTHETIC-OLD' }, oauth: { type: 'oauth', access: 'SYNTHETIC-A', refresh: 'SYNTHETIC-R', expires: 1 } });
  const before = fs.readFileSync(f.file, 'utf8');
  for (const id of ['keep', 'oauth']) assert.throws(() => f.store.setApiKey(id, 'SYNTHETIC-NEW'), { code: 'coordinated' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
test('literal encoding handles all dollars and leading exclamation without resolving them', t => {
  const f = fixture(t);
  const cases = [['abc', 'abc'], ['$NAME', '$$NAME'], ['${NAME}', '$${NAME}'], ['!command', '$!command'], ['$!literal', '$$!literal'], ['a$b$$', 'a$$b$$$$']];
  for (const [raw, encoded] of cases) assert.equal(f.api.encodeLiteralKey(raw), encoded);
  for (const raw of ['', 'has space', 'line\nbreak', 'x'.repeat(4097)]) assert.throws(() => f.api.encodeLiteralKey(raw), { code: 'invalid' });
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
test('key entry preparation preserves unknown metadata and refuses OAuth, without writing', t => {
  const initial = { type: 'api_key', key: '$LEGACY_REFERENCE', env: { ACCOUNT: 'synthetic' }, future: { retain: true } };
  const f = fixture(t, { relay: initial }); const before = fs.readFileSync(f.file, 'utf8');
  const next = f.store.literalEntry(f.store.entry('relay'), '!SYNTHETIC');
  assert.deepEqual(JSON.parse(JSON.stringify(next)), { ...initial, key: '$!SYNTHETIC' });
  assert.throws(() => f.store.literalEntry({ type: 'oauth' }, 'SYNTHETIC'), { code: 'oauth' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
test('read-only snapshot does not create auth.json and rejects dangerous provider ids', t => {
  const f = fixture(t); assert.equal(f.store.entry('relay'), null); assert.equal(f.store.has('relay'), false);
  for (const id of ['', '__proto__', 'constructor', 'bad id']) assert.throws(() => f.store.entry(id), { code: 'invalid' });
  assert.deepEqual(fs.readdirSync(f.dir), []);
});
test('BOM is read without repair writes; encoded long keys remain configured', t => {
  const f = fixture(t); const raw = '\ufeff' + JSON.stringify({ relay: { type: 'api_key', key: '$$'.repeat(4096) } });
  fs.writeFileSync(f.file, raw, { mode: 0o600 }); assert.equal(f.store.has('relay'), true); assert.equal(fs.readFileSync(f.file, 'utf8'), raw);
});
test('malformed credentials and unsafe symlink/hardlink/mode fail closed without repair', t => {
  const f = fixture(t, { relay: { type: 'api_key', key: 'SYNTHETIC' } });
  fs.chmodSync(f.file, 0o644); assert.throws(() => f.store.entry('relay'), { code: 'unsafe' }); fs.chmodSync(f.file, 0o600);
  fs.linkSync(f.file, path.join(f.dir, 'hard')); assert.throws(() => f.store.entry('relay'), { code: 'unsafe' }); fs.unlinkSync(path.join(f.dir, 'hard'));
  fs.renameSync(f.file, path.join(f.dir, 'real')); fs.symlinkSync(path.join(f.dir, 'real'), f.file);
  assert.throws(() => f.store.entry('relay'), { code: 'unsafe' }); fs.unlinkSync(f.file);
  fs.writeFileSync(f.file, '{"relay":', { mode: 0o600 }); assert.throws(() => f.store.entry('relay'), { code: 'invalid' });
});
