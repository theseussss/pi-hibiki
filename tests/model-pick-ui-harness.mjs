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
export const key = { pgdn: '\x1b[6~', pgup: '\x1b[5~', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', tab: '\t', backTab: '\x1b[Z', esc: '\x1b', cancel: '\x03', menu: '\x1bm', save: '\x13', clear: '\x15', backspace: '\x7f' };
export const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b_pi:[^\x07]*\x07/g, '');
const colors = { accent: '\x1b[38;2;1;211;101m', text: '\x1b[38;2;211;212;213m', dim: '\x1b[38;2;91;92;93m', error: '\x1b[38;2;233;51;61m' };
export const paint = (kind, value) => `${colors[kind === 'muted' ? 'dim' : kind] ?? colors.text}${value}\x1b[39m`;
// Compatibility assertion for isolated legacy control unit tests only.
// Formal picker drivers below use safe component geometry/action identities.
// NativeMenu suppresses the arrow in unfocused regions. Detect that semantic
// marker after stripping ANSI, so palette changes cannot break keyboard tests.
export function focusedNativeRow(lines) {
  const active = lines.filter((line) => plain(line).startsWith('→ '));
  assert.ok(active.length <= 1, `multiple focused native rows:\n${lines.map(plain).join('\n')}`);
  return active[0] === undefined ? undefined : plain(active[0]);
}
/** Test-only native adapter: bounded FS + exact host paths, never real SDK IO.
 * Real lease/literal/CAS coverage lives in the native backend safety suites. */
export function syntheticNativeAuth(boundedFs, agentDir) {
  // Match the native adapter's runtime exports as well as its resolver. The real
  // coordinator uses instanceof before classifying StoreError/AuthFileError;
  // an omitted constructor would mask those failures as generic IO_ERROR.
  class NativeAuthError extends Error {
    constructor(code) { super(code); this.code = code; this.name = 'NativeAuthError'; }
  }
  return { NativeAuthError, async resolveNativeAuth(registry, override) {
    const expected = { agentDir, modelsPath: path.join(agentDir, 'models.json'), authPath: path.join(agentDir, 'auth.json') };
    assert.deepEqual({ ...override }, expected, 'VM native fixture must match the host storage binding');
    assert.equal(registry.runtime.modelsPath, expected.modelsPath);
    assert.equal(registry.runtime.credentials.store.authPath, expected.authPath);
    return { storage: expected, native: { async withLockAsync(fn, options) {
      options?.signal?.throwIfAborted();
      if (!boundedFs.existsSync(expected.authPath)) boundedFs.writeFileSync(expected.authPath, '{}', { mode: 0o600 });
      const lock = `${expected.authPath}.lock`;
      boundedFs.mkdirSync(lock, { mode: 0o700 });
      try {
        const outcome = await fn(boundedFs.readFileSync(expected.authPath, 'utf8'));
        assert.equal(Object.hasOwn(outcome, 'next'), false, 'Hibiki must own its atomic writer');
        return outcome.result;
      } finally { boundedFs.rmdirSync(lock); }
    } } };
  } };
}
export const fixtureTheme = { appearance: 'dark', bold: s => s, fg: paint,
  style: (text, options) => {
    const color = options?.fg;
    return color?.kind === 'rgb' ? `\x1b[38;2;${color.r};${color.g};${color.b}m${text}\x1b[39m` : paint('text', text);
  } };

export function readComponentContent(component, render) {
  const pages = [];
  for (let i = 0; i < 500; i++) {
    pages.push(render().map(plain).join('\n'));
    const d = component.debug();
    if (d.offset + d.page >= d.total) break;
    component.handleInput(key.pgdn);
  }
  for (let i = 0; i < 500 && component.debug().offset > 0; i++) { component.handleInput(key.pgup); render(); }
  return pages.join('\n');
}

/** Only ordinary keyboard input, geometry and safe action identities. No controller
 * dispatch, private cursor access, synthetic review proofs, or string remapping.
 * Direct send()/component.handleInput() intentionally bypass this reading helper. */
export function driveAction(component, id, render) {
  readComponentContent(component, render);
  const matches = () => { const d = component.debug(); return d.actionMode && (d.selectedAction === id || d.selectedActionIdentity === id); };
  const send = name => { component.handleInput(key[name] ?? name); render(); };
  if (component.debug().view === 'matrix') {
    if (!component.debug().actionMode) send('tab');
    // Home Tab changes regions, not actions. Traverse actual shared-column rows.
    for (let i = 0; i < 16; i++) send('up');
    for (let row = 0; row < 16; row++) {
      for (let i = 0; i < 16; i++) send('left');
      for (let col = 0; col < 16; col++) {
        if (matches()) { component.handleInput(key.enter); render(); return; }
        const before = component.debug().selectedActionIdentity; send('right');
        if (before === component.debug().selectedActionIdentity) break;
      }
      const before = component.debug().selectedActionIdentity; send('down');
      if (before === component.debug().selectedActionIdentity) break;
    }
  } else {
    for (let i = 0; i < 180; i++) {
      if (matches()) { component.handleInput(key.enter); render(); return; }
      send('tab');
    }
  }
  assert.fail(`visible action not reachable: ${id}\n${render().map(plain).join('\n')}`);
}

const { PickerComponent: TaskComponent } = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/component.ts', import.meta.url)), { '@earendil-works/pi-tui': tui });
/** Mount real formal renderer around a real controller for isolated task rigs. */
export function mountActions(actions, { width = 180, height = 24 } = {}) {
  const terminal = { columns: width, rows: height };
  const matrix = { kind: 'matrix', viewId: 'fixture-matrix', reviewToken: null, actions: [], providers: [], visible: [], query: '', selected: { kind: 'none' }, current: null, default: null, defaultKnown: true, busy: false, configReadable: true,
    palette: { id: 'fixture', name: 'Fixture', colors: Object.fromEntries(['current','default','favorite','selection','text','dim','accent','blue','success','warning','error'].map(k => [k, '#abcdef'])), gradient: ['#abcdef'], stepped: false },
    fast: { current: null, modelLabel: '', tier: 'off', supported: false, active: false, ultrafastEnabled: false }, undo: null, locate: null };
  const workspace = { snapshot: () => ({ matrix, task: actions.taskSnapshot() }), subscribe: fn => actions.subscribe(fn), formFields: id => actions.formFields(id), dispatch: command => actions.dispatch(command), dispose() {} };
  const component = new TaskComponent(workspace, { terminal, requestRender() {} }, fixtureTheme, () => {});
  component.focused = true;
  const render = () => component.render(terminal.columns);
  return { component, render, send(value) { component.handleInput(key[value] ?? value); render(); }, unsafeSend(value) { component.handleInput(key[value] ?? value); }, type(value) { for (const c of value) { this.send(c); render(); } },
    raw: render, screen: () => render().map(plain).join('\n'), choose: id => driveAction(component, id, render), readContent: () => readComponentContent(component, render), dispose: () => component.dispose() };
}

/** Deliberate draft join through the real private form, never the filter input. */
export function enterManualIds(ui, ids) {
  const choose = id => ui.action ? ui.action(id) : ui.choose(id);
  choose('manual-id');
  const component = ui.component;
  assert.equal(component.debug().view, 'edit');
  assert.match(ui.screen(), /手动输入模型ID/);
  ui.send('clear');
  ui.type(Array.isArray(ids) ? ids.join(',') : ids);
  choose('add-ids');
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
  const pathOps = new Set(['existsSync', 'lstatSync', 'statSync', 'readFileSync', 'writeFileSync', 'readdirSync', 'mkdirSync', 'rmdirSync', 'rmSync', 'openSync', 'unlinkSync', 'renameSync']);
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

export async function harness(t, { config = baseConfig(), includeNative = false, fetcher, args = '', available = () => true, existingHome, authResolver, shortDeadline = false, monotonicClock, idle = () => true, switcher, fsFault, protectionState = {}, catalogEntries = [], terminalRows = 24, terminalColumns = 180, agentDir, tuiRenderer, nativeTheme, entryFile = extension, logicalHome, syntheticEnv = {}, fastController, authStatus, currentRef, fixtureFiles = {}, registryRuntime = 'file-backed', registryVersion = '1.4.0', onRefresh, profileRelativePath = '.pi/agent' } = {}) {
  const home = existingHome || fs.mkdtempSync(path.join(os.tmpdir(), 'model-pick-panel-'));
  assert.match(home, /^\/tmp\/model-pick-[^/]+$/, 'test harness requires a synthetic /tmp/model-pick-* HOME');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = agentDir ?? path.resolve(home, profileRelativePath);
  assert.ok(root.startsWith(home + path.sep), 'explicit profile must stay inside the synthetic HOME');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const configFile = path.join(root, 'models.json');
  if (!existingHome) {
    fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'p00', defaultModel: 'm0' }));
    fs.writeFileSync(path.join(root, 'model-pick-favorites.json'), JSON.stringify(['p01/m1']));
    fs.writeFileSync(path.join(root, 'model-pick-order.json'), JSON.stringify({ providers: ['p00', 'p01'], models: { p01: ['m1'] } }));
  }
  for (const [relative, value] of Object.entries(fixtureFiles)) {
    const file = path.resolve(root, relative);
    assert.ok(file.startsWith(root + path.sep), 'seed files must stay inside the fixture profile');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
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
  const logicalRoot = logicalHome ? path.join(logicalHome, path.relative(home, root)) : root;
  const modules = loadTypeScript(entryFile, {
    'node:fs': boundedFs, 'node:os': { homedir: () => logicalHome ?? home }, '@earendil-works/pi-tui': tui,
    '@earendil-works/pi-coding-agent': { getAgentDir: () => logicalRoot, VERSION: registryVersion },
    './native-auth.js': syntheticNativeAuth(boundedFs, logicalRoot),
    '@earendil-works/pi-ai/providers/all': { getBuiltinProviders: () => ['native-provider'] },
    '../lib/model-pick/protection.js': { createRecordProtection: () => ({
      seal: (value, purpose) => modules.__json(protection.seal(value, purpose)),
      open: (envelope, purpose) => modules.__json(protection.open(envelope, purpose)),
      clear: () => protection.clear(),
    }) },
  }, {
    process: { pid: 1, getuid: () => process.getuid?.() ?? 1000, env: { ...syntheticEnv } },
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
  } }, { fast: fastController });
  // Native metadata follows SDK snapshot semantics: file overrides become
  // effective only on registry.refresh, not halfway through a store journal.
  let nativeOverrideSnapshot = JSON.parse(fs.readFileSync(configFile,'utf8')).providers?.['native-provider']?.modelOverrides ?? {};
  const catalog = () => {
    catalogCalls++;
    const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const models = Object.entries(data.providers ?? {}).flatMap(([provider, p]) => (p.models ?? []).map((m) => ({ ...m, provider, api: m.api ?? p.api, baseUrl: m.baseUrl ?? p.baseUrl, contextWindow: m.contextWindow ?? 128000, maxTokens: m.maxTokens ?? 8192, reasoning: m.reasoning ?? false, input: m.input ?? ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })));
    if (includeNative) models.push({ provider: 'native-provider', id: 'native-m', name: 'Native', api: 'openai-completions', baseUrl: 'https://native.test/v1', contextWindow: 128000, maxTokens: 8192, input: ['text'], reasoning: false });
    // Closed metadata-only fixture projection. Actual SDK overlay ordering,
    // OAuth projection and catalog preservation are tested in the SDK worker.
    for (const model of models) {
      const override = model.provider==='native-provider' ? nativeOverrideSnapshot[model.id] : data.providers?.[model.provider]?.modelOverrides?.[model.id];
      for (const field of ['contextWindow', 'maxTokens']) if (override?.[field] !== undefined) model[field] = override[field];
    }
    return models;
  };
  currentModel = currentRef ? catalog().find(m => m.provider === currentRef.provider && m.id === currentRef.id) : catalog().find((m) => m.provider === 'p00') ?? undefined;
  let panel; let opened; let done; let overlayOptions;
  const terminal = tuiRenderer?.terminal ?? { rows: terminalRows, columns: terminalColumns };
  terminal.columns ??= terminalColumns;
  let renderWidth = terminal.columns;
  const render = (width = renderWidth) => { terminal.columns = renderWidth = width; return panel.render(width); };
  const ready = new Promise((resolve) => { opened = resolve; });
  const running = commands.get('models').handler(args, {
    hasUI: true, mode: 'tui', isIdle: idle,
    get model() { return currentModel; },
    modelRegistry: {
      // Explicit SDK file-backed storage assertion. No HOME inference in runtime.
      ...(registryRuntime === 'file-backed' ? { runtime: { modelsPath: path.join(logicalRoot, 'models.json'), credentials: { store: { authPath: path.join(logicalRoot, 'auth.json') } } } } : registryRuntime === null ? {} : { runtime: registryRuntime }),
      async refresh(options) { refreshes.push(options); await onRefresh?.(options, refreshes.length); nativeOverrideSnapshot=JSON.parse(fs.readFileSync(configFile,'utf8')).providers?.['native-provider']?.modelOverrides ?? {}; },
      getAvailable: () => catalog().filter(available), getAll: () => [...catalog(), ...catalogEntries], getRegisteredProviderIds: () => [],
      find: (p, id) => catalog().find((m) => m.provider === p && m.id === id),
      getProviderAuthStatus: provider => authStatus?.(provider) ?? { configured: false },
      async getApiKeyAndHeaders() { authCalls++; return authResolver ? authResolver() : { ok: true, apiKey: fakeSecret, headers: {} }; },
    },
    ui: { notify: (...v) => notices.push(v), custom(factory, options) { overlayOptions = options; return new Promise((resolve) => {
      done = resolve;
      panel = factory(tuiRenderer ?? { terminal, requestRender() {}, renderNow() { frames.push(render().map(plain).join('\n')); } }, nativeTheme ?? fixtureTheme, {}, resolve);
      panel.focused = true; opened();
    }); } },
  });
  await Promise.race([ready, running.then(() => { throw new Error('panel exited before construction'); })]);
  const p = {
    home, logicalHome: logicalHome ?? home, root, configFile, calls,
    overlayOptions: () => overlayOptions, debug: () => panel.debug(), selections, notices, refreshes, reads, physicalIo, protection, frames, component: panel, finished: running,
    authCalls: () => authCalls, catalogCalls: () => catalogCalls,
    current: () => currentModel,
    setCurrent(provider, id) { currentModel = catalog().find((m) => m.provider === provider && m.id === id); assert.ok(currentModel); },
    setFocused(value) { panel.focused = value; },
    send(s) { panel.handleInput(key[s] ?? s); render(); },
    unsafeSend(s) { panel.handleInput(key[s] ?? s); },
    type(s) { for (const c of s) { this.send(c); render(); } },
    replace(s) { this.send('clear'); this.type(s); },
    raw(width = renderWidth) { return render(width).join('\n'); },
    lines(width = renderWidth) { return render(width).map(plain); },
    screen(width = renderWidth) { return this.lines(width).join('\n'); },
    readContent() { return readComponentContent(panel, render); },
    select(id) { return driveAction(panel, id, render); },
    action(id) { return driveAction(panel, id, render); },
    async flush() { await new Promise(setImmediate); },
    async waitForView(view, attempts = 100) {
      for (let i = 0; i < attempts && panel.debug().view !== view; i++) await this.flush();
      assert.equal(panel.debug().view, view, `expected ${view}, got:\n${this.screen()}`);
      render();
    },
    async settled() {
      assert.doesNotMatch(this.screen(), /主密码|解锁并继续|再次输入/);
      await this.flush();
      assert.doesNotMatch(this.screen(), /主密码|解锁并继续|再次输入/);
    },
    config: () => JSON.parse(fs.readFileSync(configFile, 'utf8')),
    async close() { done(null); await running; },
  };
  render(); // The real host paints the newly mounted overlay before ordinary input.
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
