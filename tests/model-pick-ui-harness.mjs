import assert from 'node:assert/strict';
import { piRoot as resolvePiRoot } from '../scripts/tooling.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
import { createSyntheticProtection } from './model-pick-synthetic-protection.mjs';

const piRoot = resolvePiRoot();
export const tui = await import(pathToFileURL(path.join(piRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js')));
const extension = fileURLToPath(new URL('../extensions/model-pick.ts', import.meta.url));
export const password = 'SYNTHETIC-master-password-12345';
export const fakeSecret = 'SYNTHETIC-secret-DO-NOT-EXPOSE';
export const key = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', tab: '\t', backTab: '\x1b[Z', esc: '\x1b', cancel: '\x03', menu: '\x1bm', save: '\x13', clear: '\x15', backspace: '\x7f' };
export const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b_pi:[^\x07]*\x07/g, '');
const colors = { accent: '\x1b[38;2;1;211;101m', text: '\x1b[38;2;211;212;213m', dim: '\x1b[38;2;91;92;93m', error: '\x1b[38;2;233;51;61m' };
export const paint = (kind, value) => `${colors[kind === 'muted' ? 'dim' : kind] ?? colors.text}${value}\x1b[39m`;
// Only the synthetic accent prefix proves native keyboard ownership. Background
// browsing/action regions must never be activated by the test driver.
export function focusedNativeRow(lines) {
  const active = lines.filter((line) => line.startsWith(`${colors.accent}→ `));
  assert.ok(active.length <= 1, `multiple focused native rows:\n${lines.map(plain).join('\n')}`);
  return active[0] === undefined ? undefined : plain(active[0]);
}
export const baseConfig = () => ({ futureRoot: { keep: true }, providers: {
  p00: { name: 'A', baseUrl: 'https://example.test/v1', api: 'openai-completions', apiKey: fakeSecret, models: [{ id: 'm0', name: 'M0', contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ['text'], advanced: { untouched: true } }] },
  p01: { name: 'B', baseUrl: 'https://example.test/v1', api: 'openai-completions', apiKey: '$SYNTHETIC_API_KEY', models: [{ id: 'm1', name: 'M1', contextWindow: 64000, maxTokens: 4096, reasoning: false, input: ['text'] }] },
} });

// Production can use an ordinary logical HOME, but no runtime call reaches that
// path on disk. Only explicitly supported sync operations and owned descriptors
// may touch the /tmp fixture; even ancestor metadata is supplied synthetically.
function virtualFixtureFs(t, home, logicalHome, reads, physicalIo, fsFault) {
  assert.ok(path.isAbsolute(logicalHome) && path.resolve(logicalHome) === logicalHome && logicalHome !== '/');
  const pathOps = new Set(['existsSync', 'lstatSync', 'statSync', 'readFileSync', 'writeFileSync', 'readdirSync', 'mkdirSync', 'openSync', 'unlinkSync', 'renameSync']);
  const fdOps = new Set(['fstatSync', 'fchmodSync', 'fsyncSync', 'closeSync', 'readFileSync', 'writeFileSync']);
  const descriptors = new Map(); const violations = [];
  const directoryStat = fs.lstatSync(home);
  const deny = (reason) => { violations.push(reason); assert.fail(reason); };
  t.after(() => {
    const leaked = [...descriptors.keys()];
    for (const fd of leaked) fs.closeSync(fd);
    assert.deepEqual(violations, [], 'runtime attempted to leave the synthetic filesystem');
    assert.deepEqual(leaked, [], 'runtime leaked fixture descriptors');
  });
  const translate = (file) => {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || !(file === logicalHome || file.startsWith(logicalHome + path.sep))) return deny('outside logical synthetic HOME');
    const mapped = path.join(home, path.relative(logicalHome, file));
    let current = home;
    for (const part of ['', ...path.relative(home, mapped).split(path.sep).filter(Boolean)]) {
      current = path.join(current, part);
      try { if (fs.lstatSync(current).isSymbolicLink()) return deny('fixture symlink refused'); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    return mapped;
  };
  return new Proxy({}, { get(_target, property) {
    if (property === 'constants') return fs.constants;
    if (!pathOps.has(property) && !fdOps.has(property)) return deny(`unexpected fixture fs API: ${String(property)}`);
    return (...parameters) => {
      const first = parameters[0];
      if (property === 'lstatSync' && typeof first === 'string' && first !== logicalHome && logicalHome.startsWith(first.endsWith(path.sep) ? first : first + path.sep) && path.resolve(first) === first) {
        reads.push([property, first]); return directoryStat;
      }
      const translated = [...parameters]; let mapped;
      if (typeof first === 'number') {
        if (!fdOps.has(property) || !descriptors.has(first)) return deny('unowned fixture descriptor');
        mapped = descriptors.get(first);
      } else {
        if (!pathOps.has(property)) return deny('fixture API requires an owned descriptor');
        mapped = translated[0] = translate(first); reads.push([property, first]);
      }
      if (property === 'renameSync') translated[1] = translate(parameters[1]);
      fsFault?.(property, parameters);
      physicalIo.push([property, mapped, ...(property === 'renameSync' ? [translated[1]] : [])]);
      const result = fs[property](...translated);
      if (property === 'openSync') descriptors.set(result, mapped);
      if (property === 'closeSync') descriptors.delete(first);
      return result;
    };
  } });
}

export async function harness(t, { config = baseConfig(), includeNative = false, fetcher, args = '', available = () => true, existingHome, authResolver, shortDeadline = false, monotonicClock, idle = () => true, switcher, fsFault, protectionState = {}, catalogEntries = [], terminalRows = 24, tuiRenderer, nativeTheme, entryFile = extension, logicalHome } = {}) {
  const home = existingHome || fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-panel-'));
  assert.match(home, /^\/tmp\/model-pick-[^/]+$/, 'test harness requires a synthetic /tmp/model-pick-* HOME');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.pi/agent'); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const configFile = path.join(root, 'models.json');
  if (!existingHome) {
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'p00', defaultModel: 'm0' }));
    fs.writeFileSync(path.join(root, 'model-pick-favorites.json'), JSON.stringify(['p01/m1']));
    fs.writeFileSync(path.join(root, 'model-pick-order.json'), JSON.stringify({ providers: ['p00', 'p01'], models: { p01: ['m1'] } }));
  }
  const reads = []; const physicalIo = [];
  const boundedFs = logicalHome ? virtualFixtureFs(t, home, logicalHome, reads, physicalIo, fsFault) : new Proxy(fs, { get(target, property) {
    if (typeof target[property] !== 'function') return target[property];
    return (...parameters) => {
      if (typeof parameters[0] === 'string') {
        const file = path.resolve(parameters[0]);
        assert.ok(file === home || file.startsWith(home + path.sep) || (property === 'lstatSync' && (file === path.parse(home).root || home.startsWith(file + path.sep))), `outside synthetic home: ${property}`);
        reads.push([property, file]);
      }
      if (['renameSync', 'copyFileSync', 'linkSync', 'symlinkSync'].includes(property) && typeof parameters[1] === 'string') assert.ok(path.resolve(parameters[1]).startsWith(home + path.sep));
      fsFault?.(property, parameters);
      return target[property](...parameters);
    };
  } });
  const calls = []; let authCalls = 0; let catalogCalls = 0; const selections = []; const notices = []; const refreshes = []; const frames = [];
  const protection = createSyntheticProtection(protectionState);
  const modules = loadTypeScript(entryFile, {
    'node:fs': boundedFs, 'node:os': { homedir: () => logicalHome ?? home }, '@earendil-works/pi-tui': tui,
    '@earendil-works/pi-ai/providers/all': { getBuiltinProviders: () => ['native-provider'] },
    '../lib/model-pick/protection.js': { createRecordProtection: () => ({
      seal: (value, purpose) => modules.__json(protection.seal(value, purpose)),
      open: (envelope, purpose) => modules.__json(protection.open(envelope, purpose)),
      clear: () => protection.clear(),
    }) },
  }, {
    performance: monotonicClock ? { now: () => monotonicClock.value } : performance,
    setTimeout: (fn, ms, ...args) => setTimeout(fn, shortDeadline && ms === 10000 ? 5 : ms, ...args),
    fetch: async (url, options) => {
      calls.push([url, options]);
      return fetcher ? fetcher(url, options) : new Response(JSON.stringify({ choices: [{ message: { content: 'MODEL_PICK_OK' } }] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const commands = new Map();
  let currentModel;
  modules.default({ registerCommand: (name, command) => commands.set(name, command), registerShortcut() {}, async setModel(m) {
    selections.push(m); const ok = switcher ? await switcher(m) : true;
    if (ok) currentModel = m; return ok;
  } });
  const catalog = () => {
    catalogCalls++;
    const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const models = Object.entries(data.providers ?? {}).flatMap(([provider, p]) => (p.models ?? []).map((m) => ({ ...m, provider, api: p.api, baseUrl: p.baseUrl, contextWindow: m.contextWindow ?? 128000, maxTokens: m.maxTokens ?? 8192, reasoning: m.reasoning ?? false, input: m.input ?? ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })));
    if (includeNative) models.push({ provider: 'native-provider', id: 'native-m', name: 'Native', api: 'openai-completions', baseUrl: 'https://native.test/v1', contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoning: false });
    return models;
  };
  currentModel = catalog().find((m) => m.provider === 'p00') ?? undefined;
  let panel; let opened; let done;
  const ready = new Promise((resolve) => { opened = resolve; });
  const running = commands.get('models').handler(args, {
    hasUI: true, mode: 'tui', isIdle: idle,
    get model() { return currentModel; },
    modelRegistry: {
      async refresh(options) { refreshes.push(options); },
      getAvailable: () => catalog().filter(available), getAll: () => [...catalog(), ...catalogEntries], getRegisteredProviderIds: () => [],
      find: (p, id) => catalog().find((m) => m.provider === p && m.id === id),
      async getApiKeyAndHeaders() { authCalls++; return authResolver ? authResolver() : { ok: true, apiKey: fakeSecret, headers: {} }; },
    },
    ui: { notify: (...v) => notices.push(v), custom(factory) { return new Promise((resolve) => {
      done = resolve;
      panel = factory(tuiRenderer ?? { terminal: { rows: terminalRows }, requestRender() {}, renderNow() { frames.push(panel.render(80).map(plain).join('\n')); } }, nativeTheme ?? { bold: (s) => s, fg: paint }, {}, resolve);
      panel.focused = true; opened();
    }); } },
  });
  await Promise.race([ready, running.then(() => { throw new Error('panel exited before construction'); })]);
  const p = {
    home, logicalHome: logicalHome ?? home, root, configFile, calls, selections, notices, refreshes, reads, physicalIo, protection, frames, component: panel, finished: running,
    authCalls: () => authCalls, catalogCalls: () => catalogCalls,
    current: () => currentModel,
    setCurrent(provider, id) { currentModel = catalog().find((m) => m.provider === provider && m.id === id); assert.ok(currentModel); },
    setFocused(value) { panel.focused = value; },
    send(s) { panel.handleInput(key[s] ?? s); },
    type(s) { for (const c of s) this.send(c); },
    replace(s) { this.send('clear'); this.type(s); },
    raw(width = 180) { return panel.render(width).join('\n'); },
    lines(width = 180) { return panel.render(width).map(plain); },
    screen(width = 180) { return this.lines(width).join('\n'); },
    select(label) {
      if (!this.screen().includes(label) && this.screen().includes('更多…')) this.select('更多…');
      for (let i = 0; i < 80; i++) {
        const selected = focusedNativeRow(this.raw().split('\n'));
        assert.ok(selected, `native list does not own focus; use Tab/ShiftTab first: ${label}\n${this.screen()}`);
        if (selected.includes(label)) { this.send('enter'); return; }
        this.send('down');
      }
      assert.fail(`action not reachable: ${label}\n${this.screen()}`);
    },
    async flush() { await new Promise(setImmediate); },
    async settled() {
      assert.doesNotMatch(this.screen(), /主密码|解锁并继续|再次输入/);
      await this.flush();
      assert.doesNotMatch(this.screen(), /主密码|解锁并继续|再次输入/);
    },
    config: () => JSON.parse(fs.readFileSync(configFile, 'utf8')),
    async close() { done(null); await running; },
  };
  t.after(() => p.close());
  return p;
}

// Valid encrypted legacy fixtures, never opened or migrated by the production UI.
export function seedLegacy(p, pending = false) {
  const api = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/vault.ts', import.meta.url)));
  const before = fs.readFileSync(p.configFile, 'utf8'); const after = JSON.parse(before);
  after.providers.p01.models = [];
  const archive = pending
    ? { id: 'legacy-a', kind: 'model', provider: 'p01', modelId: 'm1', createdAt: 1, payload: baseConfig().providers.p01.models[0], binding: { baseUrl: 'https://example.test/v1', api: 'openai-completions' } }
    : { id: 'legacy-a', kind: 'provider', provider: 'legacy', createdAt: 1, payload: { ...baseConfig().providers.p01, apiKey: fakeSecret, models: [{ ...baseConfig().providers.p01.models[0], id: 'legacy-m' }] } };
  const afterRaw = JSON.stringify(after);
  const revision = (raw) => createHash('sha256').update(`file\0${raw}`).digest('hex');
  const journal = pending ? { id: 'legacy-tx', createdAt: 1, before, after: afterRaw, beforeRevision: revision(before), afterRevision: revision(afterRaw), operation: { kind: 'archive-model', provider: 'p01', modelId: 'm1', archiveId: archive.id }, archivesAfter: [archive] } : null;
  const sealed = api.sealJson(api.__json({ version: 1, archives: pending ? [] : [archive], history: [], pending: journal }), password);
  const dir = path.join(p.root, 'model-pick-data'); fs.mkdirSync(dir, { mode: 0o700 });
  const files = {
    'vault.json': JSON.stringify({ version: 1, pending, sealed }),
    'retention-index.json': JSON.stringify({ providers: [archive.provider], models: [pending ? 'p01/m1' : 'legacy/legacy-m'] }),
    'records.json': JSON.stringify(api.sealJson(api.__json({ version: 1, kind: 'model-pick-records', events: [{ kind: 'discovery', when: 1, provider: 'legacy', code: 'ok', count: 1 }] }), password)),
  };
  for (const [name, raw] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), raw, { mode: 0o600 });
  return () => { for (const [name, raw] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), raw); };
}
