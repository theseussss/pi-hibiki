import assert from 'node:assert/strict';
import { piRoot as resolvePiRoot } from '../scripts/tooling.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
import { createSyntheticProtection } from './model-pick-synthetic-protection.mjs';
import { plain as stripAnsi, paint } from './model-pick-ui-harness.mjs';

// Execute the isolated candidate against synthetic registry/files only. No session,
// credentials, network request, or live settings are read by the extension here.
const extensionPath = fileURLToPath(new URL('../extensions/model-pick.ts', import.meta.url));
const piRoot = resolvePiRoot();
const tui = await import(pathToFileURL(path.join(piRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js')));
const keys = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r' };

function makeModels(counts) {
  return counts.flatMap((count, index) => Array.from({ length: count }, (_, col) => ({
    provider: `p${String(index).padStart(2, '0')}`,
    id: `model-${index}-${col}`,
    name: `model-${index}-${col}`,
    api: 'openai-completions',
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })));
}

async function open(counts, currentIndex = 0, options = {}) {
  const models = makeModels(counts);
  const commands = new Map();
  const notifications = [];
  const mutations = [];
  const selected = [];
  const actionCalls = [];
  const root = '/synthetic-model-pick-home/.pi/agent';
  const files = new Map([
    [path.join(root, 'settings.json'), '{}'],
    [path.join(root, 'models.json'), JSON.stringify({
      providers: Object.fromEntries(counts.map((count, index) => [
        `p${String(index).padStart(2, '0')}`,
        { api: 'openai-completions', baseUrl: 'https://example.test/v1', models: models.filter((m) => m.provider === `p${String(index).padStart(2, '0')}`) },
      ])),
    })],
  ]);
  const checkPath = (p) => {
    assert.ok(String(p) === root || String(p).startsWith(`${root}/`), `unexpected file access: ${p}`);
    return String(p);
  };
  const descriptors = new Map();
  const stat = (key) => ({ isFile: () => key !== root, isDirectory: () => key === root, isSymbolicLink: () => false, size: Buffer.byteLength(files.get(key) ?? ''), mode: key === root ? 0o40700 : 0o100600, nlink: 1, ino: [...files.keys()].indexOf(key) + 10, dev: 1, mtimeMs: 0, ctimeMs: 0 });
  const fakeFs = {
    constants: fs.constants,
    existsSync(p) { return files.has(checkPath(p)) || p === root; },
    lstatSync(p) {
      if (p === '/' || root.startsWith(String(p) + '/')) return { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, size: 0, mode: 0o40700, nlink: 1 };
      const key = checkPath(p);
      if (key !== root && !files.has(key)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return stat(key);
    },
    openSync(p) {
      const key = checkPath(p);
      if (!files.has(key)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      const fd = descriptors.size + 100; descriptors.set(fd, key); return fd;
    },
    fstatSync(fd) { assert.ok(descriptors.has(fd)); return stat(descriptors.get(fd)); },
    closeSync(fd) { assert.ok(descriptors.delete(fd)); },
    readFileSync(p) {
      const key = typeof p === 'number' ? descriptors.get(p) : checkPath(p);
      if (!files.has(key)) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      return typeof p === 'number' ? Buffer.from(files.get(key)) : files.get(key);
    },
    readdirSync(p) {
      assert.equal(checkPath(p), `${root}/sessions`);
      return [];
    },
    writeFileSync(p, value) { mutations.push(['write', checkPath(p), value]); },
    copyFileSync(a, b) { mutations.push(['copy', checkPath(a), checkPath(b)]); },
    renameSync(a, b) { mutations.push(['rename', checkPath(a), checkPath(b)]); },
  };
  class RecordingActions {
    active = false;
    undoLabel = null;
    setFocused() {}
    dispose() {}
    open(target, intent) { actionCalls.push({ target: { ...target }, intent }); }
    undoLast() { actionCalls.push({ undo: true }); }
  }
  const extension = loadTypeScript(extensionPath, {
    'node:fs': fakeFs,
    'node:os': { homedir: () => '/synthetic-model-pick-home' },
    '@earendil-works/pi-tui': tui,
    '@earendil-works/pi-ai/providers/all': { getBuiltinProviders: () => [] },
    '../lib/model-pick/protection.js': { createRecordProtection: createSyntheticProtection },
    ...(options.recordActions ? { '../lib/model-pick/panel.js': { PickerActions: RecordingActions } } : {}),
  }, {
    setTimeout() { throw new Error('navigation must not create timers'); },
    clearTimeout() { throw new Error('navigation must not create timers'); },
  });
  extension.default({
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {},
    async setModel(model) { selected.push(model); return true; },
  });
  let panel;
  let finish;
  let signalOpened;
  const opened = new Promise((resolve) => { signalOpened = resolve; });
  let renders = 0;
  const running = commands.get('models').handler('', {
    hasUI: true,
    model: models[currentIndex],
    modelRegistry: { async refresh() {}, getAvailable: () => models },
    ui: {
      notify(...args) { notifications.push(args); },
      custom(factory) {
        return new Promise((resolve) => {
          finish = resolve;
          panel = factory({ terminal: options.terminalRows ? { rows: options.terminalRows } : undefined, requestRender() { renders++; } }, { bold: (s) => s, fg: paint }, {}, resolve);
          signalOpened();
        });
      },
    },
  });
  // Wait for the actual panel callback, not a guessed number of microtasks.
  await Promise.race([opened, running.then(() => { throw new Error('picker exited before opening'); })]);
  assert.ok(panel);
  return {
    send(key) { panel.handleInput(keys[key] ?? key); },
    lines: (width = 180) => panel.render(width).map(stripAnsi),
    raw: (width = 180) => panel.render(width),
    focus() { return /^ 供应商「/.test(this.detail()) ? 'provider' : 'model'; },
    provider() {
      const line = this.lines().find((s) => s.startsWith(' ▸ '));
      return line?.match(/p\d+/)?.[0];
    },
    detail() { return this.lines().at(-2); },
    async close() { finish(null); await running; },
    async confirm() { this.send('enter'); await running; return selected[0]; },
    mutations, notifications, selected, actionCalls,
    renders: () => renders,
  };
}

test('top Up wraps to last provider and keeps its model selected', async () => {
  const p = await open([1, 1, 1]);
  assert.equal(p.provider(), 'p00');
  p.send('up');
  assert.equal(p.provider(), 'p02');
  assert.match(p.detail(), /model-2-0/);
  assert.equal((await p.confirm()).id, 'model-2-0');
  assert.equal(p.mutations.length, 0);
});

test('last Down wraps to first provider', async () => {
  const p = await open([1, 1, 1], 2);
  p.send('down');
  assert.equal(p.provider(), 'p00');
  await p.close();
});

test('more than PAGE rows scrolls wrapped selection into view in either direction', async () => {
  const p = await open(Array(23).fill(1));
  p.send('up');
  assert.equal(p.provider(), 'p22');
  assert.equal(p.lines().filter((s) => /p\d+/.test(s)).length, 18);
  assert.ok(p.lines().some((s) => s.includes('p05')));
  assert.ok(!p.lines().some((s) => s.includes('p00')));
  p.send('down');
  assert.equal(p.provider(), 'p00');
  assert.ok(p.lines().some((s) => s.includes('p17')));
  assert.ok(!p.lines().some((s) => s.includes('p22')));
  assert.equal(p.mutations.length, 0);
  await p.close();
});

test('Up wrap clamps the model column for a shorter destination row', async () => {
  const p = await open([4, 1, 2]);
  p.send('right'); p.send('right'); p.send('right');
  assert.match(p.detail(), /model-0-3/);
  p.send('up');
  assert.equal(p.provider(), 'p02');
  assert.match(p.detail(), /model-2-1/);
  await p.close();
});

test('non-edge navigation retains normal row and column behavior', async () => {
  const p = await open([3, 3, 3], 3);
  p.send('right');
  p.send('down');
  assert.equal(p.provider(), 'p02');
  assert.match(p.detail(), /model-2-1/);
  p.send('up');
  assert.equal(p.provider(), 'p01');
  assert.match(p.detail(), /model-1-1/);
  await p.close();
});

test('search navigation wraps only among matching providers', async () => {
  const p = await open(Array(23).fill(1));
  for (const c of 'p1') p.send(c);
  const matchingRows = p.lines().filter((line) => /\bp\d+/.test(line));
  assert.ok(matchingRows.length > 1 && matchingRows.length < 23);
  assert.ok(!matchingRows.some((line) => line.includes('p00')));
  const first = p.provider();
  const expectedLast = matchingRows.at(-1).match(/p\d+/)[0];
  p.send('up');
  assert.equal(p.provider(), expectedLast);
  assert.notEqual(p.provider(), first);
  p.send('down');
  assert.equal(p.provider(), first);
  await p.close();
});

test('single-row navigation stays on its only row', async () => {
  const p = await open([2]);
  for (const key of ['up', 'down', 'up', 'down']) {
    p.send(key);
    assert.equal(p.provider(), 'p00');
  }
  await p.close();
});

test('empty search results ignore arrows and Enter without selecting or writing', async () => {
  const p = await open([2, 1]);
  for (const c of 'zzzzzzzzzz') p.send(c);
  for (const key of ['up', 'down', 'left', 'right', 'enter']) p.send(key);
  assert.equal(p.provider(), undefined);
  assert.ok(p.lines().some((s) => s.includes('无匹配模型')));
  assert.equal(p.selected.length, 0);
  assert.equal(p.mutations.length, 0);
  await p.close();
});

test('enhanced CSI Up/Down follow the same wrapping path', async () => {
  const p = await open([1, 1]);
  p.send('\x1b[1;1A');
  assert.equal(p.provider(), 'p01');
  p.send('\x1b[1;1B');
  assert.equal(p.provider(), 'p00');
  await p.close();
});

test('Alt reordering remains non-circular at a provider boundary', async () => {
  const p = await open([1, 1]);
  p.send('\x1b[1;3A');
  assert.equal(p.provider(), 'p00');
  assert.equal(p.mutations.length, 0);
  await p.close();
});

test('two boundary Left presses focus the existing provider column; Right returns to model zero', async () => {
  const p = await open([2, 1]);
  assert.equal(p.focus(), 'model');
  p.send('left');
  assert.equal(p.focus(), 'model');
  assert.match(p.lines().at(-1), /再按.*←/);
  p.send('left');
  assert.equal(p.focus(), 'provider');
  assert.match(p.lines().find((line) => line.startsWith(' ▸ ')), /\[p00\]/);
  assert.ok(!p.lines().some((line) => /› model-0-0/.test(line)));
  p.send('right');
  assert.equal(p.focus(), 'model');
  assert.match(p.detail(), /model-0-0/);
  assert.equal(p.mutations.length, 0);
  await p.close();
});

test('arriving at the first model does not count as a boundary Left press', async () => {
  const p = await open([3]);
  p.send('right'); p.send('right');
  p.send('left'); p.send('left');
  assert.equal(p.focus(), 'model');
  assert.ok(!p.lines().at(-1).includes('再按'));
  p.send('left'); assert.equal(p.focus(), 'model');
  p.send('left'); assert.equal(p.focus(), 'provider');
  await p.close();
});

test('other navigation cancels the pending second Left without a timer', async () => {
  const p = await open([1, 1]);
  p.send('left'); p.send('down'); p.send('left');
  assert.equal(p.focus(), 'model');
  assert.equal(p.provider(), 'p01');
  p.send('right'); p.send('left');
  assert.equal(p.focus(), 'model');
  p.send('left'); assert.equal(p.focus(), 'provider');
  await p.close();
});

test('Kitty repeat events may move left but never arm or enter the provider column', async () => {
  const p = await open([3]);
  p.send('right'); p.send('right');
  for (let i = 0; i < 8; i++) p.send('\x1b[1;1:2D');
  assert.equal(p.focus(), 'model');
  assert.match(p.detail(), /model-0-0/);
  p.send('left'); p.send('\x1b[1;1:2D'); p.send('left');
  assert.equal(p.focus(), 'model');
  p.send('left'); assert.equal(p.focus(), 'provider');
  await p.close();
});

test('Kitty Left key releases neither navigate nor cancel two intentional presses', async () => {
  const p = await open([1]);
  p.send('\x1b[1;1:1D'); p.send('\x1b[1;1:3D');
  assert.equal(p.focus(), 'model');
  p.send('\x1b[1;1:1D'); assert.equal(p.focus(), 'provider');
  p.send('\x1b[1;1:3C'); assert.equal(p.focus(), 'provider');
  p.send('right'); assert.equal(p.focus(), 'model');
  await p.close();
});

test('provider focus preserves circular row navigation and scrolls its target into view', async () => {
  const p = await open(Array(23).fill(1));
  p.send('left'); p.send('left'); p.send('up');
  assert.equal(p.focus(), 'provider'); assert.equal(p.provider(), 'p22');
  assert.match(p.detail(), /p22/);
  p.send('down'); assert.equal(p.provider(), 'p00');
  p.send('right'); assert.equal(p.focus(), 'model');
  assert.match(p.detail(), /model-0-0/);
  await p.close();
});

test('same add/remove keys dispatch model versus provider intents from visible focus', async () => {
  const p = await open([2, 1], 0, { recordActions: true });
  p.send('\x1bn'); p.send('\x1bx');
  assert.deepEqual(p.actionCalls.map((c) => [c.intent, c.target.kind, c.target.provider, c.target.modelId]), [
    ['add', 'model', 'p00', 'model-0-0'], ['remove', 'model', 'p00', 'model-0-0'],
  ]);
  p.send('left'); p.send('left'); p.send('down');
  p.send('\x1bn'); p.send('\x1bx');
  assert.deepEqual(p.actionCalls.slice(2).map((c) => [c.intent, c.target.kind, c.target.provider, c.target.modelId]), [
    ['add', 'provider', 'p01', undefined], ['remove', 'provider', 'p01', undefined],
  ]);
  p.send('\x1b\x01'); p.send('\x1b\x18');
  assert.equal(p.actionCalls.length, 4, 'no Ctrl+Alt category-specific actions');
  assert.equal(p.mutations.length, 0);
  await p.close();
});

test('an actually empty registry starts in provider focus and permits add without a current row', async () => {
  const p = await open([], 0, { recordActions: true });
  assert.equal(p.focus(), 'provider');
  assert.match(p.lines().join('\n'), /暂无.*供应商|添加供应商/);
  p.send('\x1bn');
  assert.equal(p.actionCalls.length, 1);
  assert.equal(p.actionCalls[0].intent, 'add');
  assert.equal(p.actionCalls[0].target.kind, 'provider');
  assert.equal(p.actionCalls[0].target.provider, undefined);
  p.send('\x1bx'); assert.equal(p.actionCalls.length, 1);
  await p.close();
});

test('zero search matches never masquerade as no configured providers', async () => {
  const p = await open([1, 1], 0, { recordActions: true });
  for (const c of 'zzzzzzzzzz') p.send(c);
  p.send('left'); p.send('left'); p.send('enter');
  assert.equal(p.focus(), 'model');
  assert.equal(p.actionCalls.length, 0);
  assert.match(p.lines().join('\n'), /无匹配模型/);
  await p.close();
});

test('empty providers retain a model-area add placeholder and never acquire column minus one', async () => {
  const p = await open([0], 0, { recordActions: true });
  assert.equal(p.provider(), 'p00'); assert.equal(p.focus(), 'model');
  assert.match(p.lines().join('\n'), /添加模型/);
  p.send('right'); p.send('enter');
  assert.equal(p.actionCalls[0].intent, 'add');
  assert.equal(p.actionCalls[0].target.provider, 'p00');
  assert.equal(p.actionCalls[0].target.kind, 'model');
  p.send('left'); p.send('left'); assert.equal(p.focus(), 'provider');
  p.send('right'); p.send('\x1bn');
  assert.equal(p.actionCalls.at(-1).target.kind, 'model');
  await p.close();
});

test('provider focus cannot favorite, default, or reorder an invisible model', async () => {
  const p = await open([2, 1]);
  p.send('left'); p.send('left');
  for (const k of ['\t', '\x1bd', '\x1b[1;3C', '\x1b[1;3D']) p.send(k);
  assert.equal(p.focus(), 'provider');
  assert.equal(p.mutations.length, 0);
  assert.equal(p.selected.length, 0);
  await p.close();
});

test('Enter on a provider opens its actions instead of switching its hidden first model', async () => {
  const p = await open([1], 0, { recordActions: true });
  p.send('left'); p.send('left'); p.send('enter');
  assert.equal(p.selected.length, 0);
  assert.equal(p.actionCalls.length, 1);
  assert.equal(p.actionCalls[0].target.kind, 'provider');
  assert.equal(p.actionCalls[0].intent, undefined);
  await p.close();
});

test('small terminals retain the focused row and footer without clipping operations offscreen', async () => {
  const p = await open(Array(23).fill(1), 0, { terminalRows: 16 });
  p.send('up');
  assert.equal(p.provider(), 'p22');
  assert.ok(p.lines().length <= 16);
  for (const width of [32, 60, 80, 180]) assert.ok(p.raw(width).every((line) => tui.visibleWidth(line) < width));
  await p.close();
});
