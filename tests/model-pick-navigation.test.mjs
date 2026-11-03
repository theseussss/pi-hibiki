import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, tui } from './model-pick-ui-harness.mjs';

// All navigation runs through the production host + real task controller + formal
// component. Selection is observed in rendered text/geometry, never private state.
async function open(t, counts, currentIndex = 0, options = {}) {
  const models = counts.flatMap((count, index) => Array.from({ length: count }, (_, col) => ({
    provider: `p${String(index).padStart(2, '0')}`, id: `model-${index}-${col}`, name: `model-${index}-${col}`,
    contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ['text'],
  })));
  const config = { futureRoot: { keep: true }, providers: Object.fromEntries(counts.map((_, index) => {
    const provider = `p${String(index).padStart(2, '0')}`;
    return [provider, { name: provider, api: 'openai-completions', baseUrl: 'https://example.test/v1', models: models.filter(m => m.provider === provider) }];
  })) };
  const p = await harness(t, { config, currentRef: models[currentIndex], ...options, fixtureFiles: {
    'settings.json': {}, 'model-pick-favorites.json': [], 'model-pick-order.json': {}, ...options.fixtureFiles,
  } });
  p.selectedLabel = () => {
    const lines = p.lines(), rules = lines.flatMap((line, i) => /^\s*─+\s*$/u.test(line) ? [i] : []);
    // Native query has a static › prompt; only matrix rows carry selection.
    const matrix = lines.slice(rules[1] + 1, rules[2]).join('\n');
    const match = matrix.match(/›\s+(?:●\s+)?(model-\d+-\d+|p\d+)|▸\s+\[(p\d+)\]/);
    return match?.[1] ?? match?.[2];
  };
  p.provider = () => { const label = p.selectedLabel(); return label?.startsWith('model-') ? `p${label.split('-')[1].padStart(2, '0')}` : label; };
  p.focus = () => p.selectedLabel()?.startsWith('model-') ? 'model' : p.selectedLabel()?.startsWith('p') ? 'provider' : 'none';
  const files = () => {
    const result = new Map();
    const visit = relative => {
      for (const entry of fs.readdirSync(path.join(p.root, relative), { withFileTypes: true })) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) visit(name); else result.set(name, fs.readFileSync(path.join(p.root, name)));
      }
    };
    visit(''); return result;
  };
  const initialFiles = files();
  p.noEffects = (allowedFiles = []) => {
    assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.selections.length, 0); assert.deepEqual(p.config(), config);
    const after = files();
    for (const name of new Set([...initialFiles.keys(), ...after.keys()])) {
      if (!allowedFiles.includes(name)) assert.deepEqual(after.get(name), initialFiles.get(name), `unexpected file effect: ${name}`);
    }
  };
  return p;
}
const json = (p, name) => JSON.parse(fs.readFileSync(path.join(p.root, name), 'utf8'));
const activeActions = p => p.debug().actionSlots.filter(s => s.actionIndex !== null).map(s => s.key);

test('top Up wraps to last provider and switches the freshly selected model', async t => {
  const p = await open(t, [1, 1, 1]);
  assert.equal(p.provider(), 'p00'); p.send('up'); assert.equal(p.provider(), 'p02');
  assert.equal(p.selectedLabel(), 'model-2-0'); p.send('enter'); await p.finished;
  assert.equal(p.selections[0].id, 'model-2-0'); assert.equal(p.calls.length, 0);
});
test('last Down wraps to first provider', async t => {
  const p = await open(t, [1, 1, 1], 2); p.send('down'); assert.equal(p.provider(), 'p00'); p.noEffects();
});
test('more than one viewport scrolls wrapped selection into view in both directions', async t => {
  const p = await open(t, Array(23).fill(1));
  p.send('up'); assert.equal(p.provider(), 'p22'); assert.ok(p.debug().offset > 0); assert.ok(!p.lines().some(line => /^\s+p00\s/.test(line)));
  p.send('down'); assert.equal(p.provider(), 'p00'); assert.ok(!p.screen().includes('model-22-0')); p.noEffects();
});
test('Up wrap clamps the selected ordinal for a shorter destination provider', async t => {
  const p = await open(t, [4, 1, 2]);
  p.send('right'); p.send('right'); p.send('right'); assert.equal(p.selectedLabel(), 'model-0-3');
  p.send('up'); assert.equal(p.selectedLabel(), 'model-2-1'); p.noEffects();
});
test('non-edge navigation retains row and ordinal column', async t => {
  const p = await open(t, [3, 3, 3], 3);
  p.send('right'); p.send('down'); assert.equal(p.selectedLabel(), 'model-2-1');
  p.send('up'); assert.equal(p.selectedLabel(), 'model-1-1'); p.noEffects();
});
test('search navigation wraps only among fuzzy matching providers', async t => {
  const p = await open(t, Array(23).fill(1)); p.type('p1');
  const providers = [...new Set(p.debug().matrixCells.map(c => c.pid))];
  assert.ok(providers.length > 1 && providers.length < 23); assert.ok(!providers.includes('p00'));
  const first = p.provider(); // Native query owns text cursor, arrows navigate immediately.
  p.send('up'); assert.equal(p.provider(), providers.at(-1)); assert.notEqual(p.provider(), first);
  p.send('down'); assert.equal(p.provider(), first); p.noEffects();
});
test('single-provider navigation stays on its only row', async t => {
  const p = await open(t, [2]); for (const key of ['up', 'down', 'up', 'down']) { p.send(key); assert.equal(p.provider(), 'p00'); } p.noEffects();
});
test('empty search ignores arrows and Enter without selecting, publishing drafts or writing', async t => {
  const p = await open(t, [2, 1]); p.type('zzzzzzzzzz'); p.send('enter');
  for (const key of ['up', 'down', 'left', 'right', 'enter']) p.send(key);
  assert.equal(p.provider(), undefined); assert.match(p.screen(), /没有匹配/); assert.equal(p.debug().view, 'matrix'); p.noEffects();
});
test('enhanced CSI Up and Down follow the same wrap path', async t => {
  const p = await open(t, [1, 1]); p.send('\x1b[1;1A'); assert.equal(p.provider(), 'p01'); p.send('\x1b[1;1B'); assert.equal(p.provider(), 'p00'); p.noEffects();
});
test('Alt reordering remains non-circular at a provider boundary', async t => {
  const p = await open(t, [1, 1]); p.send('\x1b[1;3A'); assert.equal(p.provider(), 'p00'); assert.deepEqual(json(p, 'model-pick-order.json'), {}); p.noEffects();
});
test('two deliberate boundary Left presses focus provider; Right returns to model zero', async t => {
  const p = await open(t, [2, 1]); p.send('left'); assert.equal(p.focus(), 'model');
  p.send('left'); assert.equal(p.focus(), 'provider'); assert.match(p.screen(), /▸\s+\[p00\]/);
  p.send('right'); assert.equal(p.selectedLabel(), 'model-0-0'); p.noEffects();
});
test('arriving at first model does not count as a boundary Left press', async t => {
  const p = await open(t, [3]); p.send('right'); p.send('right'); p.send('left'); p.send('left');
  assert.equal(p.focus(), 'model'); p.send('left'); assert.equal(p.focus(), 'model'); p.send('left'); assert.equal(p.focus(), 'provider'); p.noEffects();
});
test('other navigation cancels pending second Left without a timer', async t => {
  const p = await open(t, [1, 1]); p.send('left'); p.send('down'); p.send('left'); assert.equal(p.focus(), 'model'); assert.equal(p.provider(), 'p01');
  p.send('right'); p.send('left'); assert.equal(p.focus(), 'model'); p.send('left'); assert.equal(p.focus(), 'provider'); p.noEffects();
});
test('Kitty repeat may move Left but cannot arm or enter the provider column', async t => {
  const p = await open(t, [3]); p.send('right'); p.send('right');
  for (let i = 0; i < 8; i++) p.send('\x1b[1;1:2D');
  assert.equal(p.selectedLabel(), 'model-0-0'); p.send('left'); p.send('\x1b[1;1:2D'); p.send('left');
  assert.equal(p.focus(), 'model'); p.send('left'); assert.equal(p.focus(), 'provider'); p.noEffects();
});
test('Kitty releases neither navigate nor cancel two deliberate Left presses', async t => {
  const p = await open(t, [1]); p.send('\x1b[1;1:1D'); p.send('\x1b[1;1:3D'); assert.equal(p.focus(), 'model');
  p.send('\x1b[1;1:1D'); assert.equal(p.focus(), 'provider'); p.send('\x1b[1;1:3C'); assert.equal(p.focus(), 'provider');
  p.send('right'); assert.equal(p.focus(), 'model'); p.noEffects();
});
test('provider focus preserves circular row navigation and reveals its target', async t => {
  const p = await open(t, Array(23).fill(1)); p.send('left'); p.send('left'); p.send('up');
  assert.equal(p.focus(), 'provider'); assert.equal(p.provider(), 'p22'); p.send('down'); assert.equal(p.provider(), 'p00');
  p.send('right'); assert.equal(p.selectedLabel(), 'model-0-0'); p.noEffects();
});
test('same add/remove keys use real model versus provider workspaces', async t => {
  const p = await open(t, [2, 1]); p.send('\x1bn'); assert.equal(p.debug().view, 'basket'); p.send('cancel');
  p.send('\x1bx'); assert.equal(p.debug().view, 'confirm'); assert.match(p.readContent(), /model-0-0/); p.action('cancel-confirm');
  p.send('left'); p.send('left'); p.send('down'); p.send('\x1bn'); assert.equal(p.debug().view, 'connection'); p.send('cancel');
  p.send('\x1bx'); assert.equal(p.debug().view, 'confirm'); assert.match(p.readContent(), /p01/); p.action('cancel-confirm');
  p.send('\x1b\x01'); p.send('\x1b\x18'); assert.equal(p.debug().view, 'matrix'); p.noEffects();
});
test('an actually empty registry permits new-provider action without an existing row', async t => {
  const p = await open(t, []); assert.match(p.screen(), /还没有供应商|暂无供应商/);
  p.action('new-provider'); assert.equal(p.debug().view, 'connection'); p.send('cancel');
  p.send('\x1bx'); assert.equal(p.debug().view, 'matrix'); p.noEffects();
  p.send('\x1bn'); assert.equal(p.debug().view, 'connection', 'legacy add must remain reachable with an empty registry');
});
test('zero matches never masquerade as no configured providers', async t => {
  const p = await open(t, [1, 1]); p.type('zzzzzzzzzz'); p.send('enter'); p.send('left'); p.send('left'); p.send('enter');
  assert.equal(p.debug().view, 'matrix'); assert.match(p.screen(), /没有匹配/); assert.doesNotMatch(p.screen(), /还没有供应商/); p.noEffects();
});
test('empty providers expose add-model action and never select a hidden or minus-one model', async t => {
  const p = await open(t, [0]); assert.equal(p.provider(), 'p00'); assert.equal(p.focus(), 'provider'); assert.match(p.screen(), /添加模型/);
  p.send('right'); assert.equal(p.focus(), 'provider'); p.action('add-model'); assert.equal(p.debug().view, 'basket'); p.send('cancel'); p.noEffects();
});
test('provider template cannot favorite, default or reorder an invisible model', async t => {
  const p = await open(t, [2, 1]); p.send('left'); p.send('left'); p.send('tab');
  assert.equal(p.debug().actionMode, true); assert.ok(!activeActions(p).includes('favorite')); assert.ok(!activeActions(p).includes('default'));
  for (const k of ['\x1b1', '\x1bd', '\x1b[1;3C', '\x1b[1;3D']) p.send(k);
  assert.deepEqual(json(p, 'model-pick-order.json'), {}); assert.deepEqual(json(p, 'model-pick-favorites.json'), []); assert.deepEqual(json(p, 'settings.json'), {}); p.noEffects();
});
test('Enter on provider focuses the scoped workspace; action Enter edits without switching its hidden model', async t => {
  const p = await open(t, [1]); p.send('left'); p.send('left'); p.send('enter');
  assert.equal(p.debug().view, 'matrix'); assert.equal(p.debug().actionMode, true); assert.equal(p.debug().selectedAction, 'edit-provider'); p.noEffects();
  p.send('enter'); assert.equal(p.debug().view, 'edit'); assert.match(p.readContent(), /p00|example.test/); p.noEffects();
});
test('small terminals retain focused row and operations at every tested width', async t => {
  const p = await open(t, Array(23).fill(1), 0, { terminalRows: 16 }); p.send('up'); assert.equal(p.provider(), 'p22');
  for (const width of [1, 2, 4, 8, 20, 28, 32, 42, 48, 60, 64, 80, 120, 140, 160, 180]) {
    const lines = p.lines(width); assert.ok(lines.length <= 16); assert.ok(lines.every(line => tui.visibleWidth(line) <= Math.max(0, width - 1)), `width ${width}`);
  }
  p.noEffects();
});

test('home Tab/ShiftTab changes regions only; Alt1 persists favorite for selected identity', async t => {
  const p = await open(t, [2, 1]); p.send('tab'); assert.equal(p.debug().actionMode, true); p.send('backTab'); assert.equal(p.debug().actionMode, false);
  assert.deepEqual(json(p, 'model-pick-favorites.json'), []); p.noEffects(); p.send('\x1b1'); assert.deepEqual(json(p, 'model-pick-favorites.json'), ['p00/model-0-0']);
  p.send('\x1b1'); assert.deepEqual(json(p, 'model-pick-favorites.json'), []); p.noEffects(['model-pick-favorites.json']);
});
test('legacy provider AltUp/Down from model focus reorder providers without changing target', async t => {
  const p = await open(t, [2, 1, 1]); p.send('\x1b[1;3B'); assert.equal(p.selectedLabel(), 'model-0-0');
  assert.deepEqual(json(p, 'model-pick-order.json').providers, ['p01', 'p00', 'p02']); p.send('\x1b[1;3A');
  assert.deepEqual(json(p, 'model-pick-order.json').providers, ['p00', 'p01', 'p02']); p.noEffects(['model-pick-order.json']);
});
test('search disables order writes rather than persisting a filtered subset', async t => {
  const p = await open(t, [3, 2]); p.type('model');
  for (const k of ['\x1b[1;3B', '\x1b[1;3C', '\x1b5', '\x1b6']) p.send(k);
  assert.deepEqual(json(p, 'model-pick-order.json'), {}); p.noEffects();
});
test('custom order outranks default, favorite, usage, then stable config order', async t => {
  const p = await open(t, [6], 0, { fixtureFiles: {
    'settings.json': { defaultProvider: 'p00', defaultModel: 'model-0-1' },
    'model-pick-order.json': { models: { p00: ['model-0-4'] }, futureOrder: true },
    'model-pick-favorites.json': ['p00/model-0-2'],
    'sessions/synthetic/synthetic.jsonl': [0, 1, 2].map(() => JSON.stringify({ message: { role: 'assistant', provider: 'p00', model: 'model-0-3' }, timestamp: '2026-01-01T00:00:00Z' })).join('\n'),
  } });
  assert.deepEqual(Array.from(p.debug().matrixCells, c => c.mid), ['model-0-4', 'model-0-1', 'model-0-2', 'model-0-3', 'model-0-0', 'model-0-5']);
  p.send('\x1b[1;3C'); assert.equal(json(p, 'model-pick-order.json').futureOrder, true); p.noEffects(['model-pick-order.json']);
});
test('setting default preserves unknown settings and backs up without switching current', async t => {
  const p = await open(t, [2], 0, { fixtureFiles: { 'settings.json': { future: { keep: true } } } });
  p.send('right'); p.action('default'); assert.deepEqual(json(p, 'settings.json'), { future: { keep: true }, defaultProvider: 'p00', defaultModel: 'model-0-1' });
  assert.ok(fs.existsSync(path.join(p.root, 'settings.json.bak-model-pick.sealed'))); assert.equal(p.current().id, 'model-0-0'); p.noEffects(['settings.json', 'settings.json.bak-model-pick.sealed']);
});
test('configured unavailable models remain visible but cannot switch or become default', async t => {
  const p = await open(t, [2], 0, { available: m => m.id !== 'model-0-1' }); p.send('right');
  assert.equal(p.selectedLabel(), 'model-0-1'); assert.match(p.screen(), /未就绪/); p.send('enter'); p.send('\x1bd'); await p.flush();
  assert.deepEqual(json(p, 'settings.json'), {}); p.noEffects();
});
test('six palettes use real theme style and persist without data mutation', async t => {
  const p = await open(t, [1]); const keys = new Set(); const screens = new Set();
  for (let i = 0; i < 6; i++) { p.send('\x1bt'); keys.add(json(p, 'model-pick-theme.json').theme); screens.add(p.raw()); }
  assert.equal(keys.size, 6); assert.equal(screens.size, 6); p.noEffects(['model-pick-theme.json']);
});
test('manage/providers commands focus real visible actions with distinct templates', async t => {
  for (const args of ['manage', 'providers']) {
    const p = await open(t, [2], 0, { args }); assert.equal(p.debug().actionMode, true);
    assert.match(p.screen(), args === 'manage' ? /收藏 \[1\]/ : /编辑连接 \[2\]/); p.send('esc');
    assert.equal(p.focus(), args === 'manage' ? 'model' : 'provider'); p.noEffects();
  }
});
test('unknown SDK storage is readonly and performs zero filesystem reads, including default HOME', async t => {
  const p = await open(t, [2], 0, { registryRuntime: null });
  assert.deepEqual(p.reads, []); assert.match(p.screen(), /未读取默认 profile/);
  for (const k of ['\x1b1', '\x1bd', '\x1bn', '\x1bx', '\x1bt']) p.send(k);
  assert.deepEqual(p.reads, []); p.action('edit-model'); assert.equal(p.debug().view, 'info'); assert.match(p.readContent(), /model-0-0/);
  assert.deepEqual(p.reads, []); p.send('cancel'); p.noEffects();
});
test('real fuzzy search includes Chinese provider display labels and noncontiguous model names', async t => {
  const config = { providers: { p00: { name: '星河云', api: 'openai-completions', baseUrl: 'https://example.test/v1', models: [{ id: 'alpha-one', name: 'A long phoenix model' }] }, empty: { name: '空供应商', api: 'openai-completions', baseUrl: 'https://empty.test/v1', models: [] } } };
  const p = await harness(t, { config }); p.type('星河'); assert.deepEqual([...new Set(p.debug().matrixCells.map(c => c.pid))], ['p00']);
  p.replace('Alphx'); assert.equal(p.debug().matrixCells[0]?.mid, 'alpha-one');
  p.replace('空供应商'); assert.match(p.screen(), /添加模型/); assert.doesNotMatch(p.screen(), /没有匹配/); assert.equal(p.calls.length, 0);
});

test('Ctrl+C ends a remove-confirm task without any file or model effect', async t => {
  const p = await open(t, [2, 1]); p.send('down'); p.send('\x1bx'); assert.equal(p.debug().view, 'confirm');
  p.unsafeSend('cancel'); assert.equal(p.debug().view, 'matrix'); p.noEffects();
});
test('unpainted selected target cannot switch; fresh paint authorizes only that target', async t => {
  const p = await open(t, [2]); p.unsafeSend('right'); p.unsafeSend('enter'); await p.flush();
  assert.equal(p.selections.length, 0); assert.equal(p.debug().view, 'matrix');
  assert.equal(p.selectedLabel(), 'model-0-1'); p.send('enter'); await p.finished;
  assert.deepEqual(p.selections.map(m => m.id), ['model-0-1']); assert.equal(p.calls.length, 0);
});
test('switch revalidates availability after refresh instead of using a stale row object', async t => {
  let ready = true;
  const p = await open(t, [2], 0, { available: m => ready || m.id !== 'model-0-1', onRefresh(_options, count) { if (count > 1) ready = false; } });
  p.send('right'); p.send('enter'); await p.flush(); assert.equal(p.selections.length, 0);
  assert.match(p.screen(), /未切换/); p.noEffects();
});
test('split, memory, accessor and proxy SDK storage never read a fallback profile', async t => {
  for (const runtime of [
    { modelsPath: '/unknown/models.json', credentials: { store: { authPath: '/elsewhere/auth.json' } } },
    { modelsPath: undefined, credentials: { store: {} } },
    Object.defineProperty({}, 'modelsPath', { get() { assert.fail('storage adapter invoked SDK getter'); } }),
    new Proxy({}, { get() { assert.fail('storage adapter dereferenced proxy'); } }),
  ]) {
    const p = await open(t, [1], 0, { registryRuntime: runtime });
    assert.deepEqual(p.reads, []); assert.match(p.screen(), /未读取默认 profile/); p.send('\x1b1'); assert.deepEqual(p.reads, []); p.noEffects();
  }
});
test('explicit nondefault profile owns all picker state, usage and palette paths', async t => {
  // harness constructs this exact profile within its fresh fixture HOME.
  const p = await open(t, [1], 0, { logicalHome: '/home/synthetic-host-profile', profileRelativePath: 'embedded/profile' });
  p.send('\x1b1'); p.send('\x1bt');
  assert.ok(p.reads.every(([_method, file]) => file === '/' || '/home/synthetic-host-profile/embedded/profile'.startsWith(file + '/') || file.startsWith('/home/synthetic-host-profile/embedded/profile')));
  p.noEffects(['model-pick-favorites.json', 'model-pick-theme.json']);
});
test('matrix render, resize, query and selection perform no filesystem, crypto or registry refresh work', async t => {
  const p = await open(t, [4, 3]);
  const counts = () => ({ reads: p.reads.length, opens: p.protection.state.opens.length, catalog: p.catalogCalls(), refresh: p.refreshes.length });
  const before = counts();
  for (const width of [32, 80, 120, 180]) p.lines(width);
  p.type('p0'); p.send('down'); p.send('right'); p.lines();
  assert.deepEqual(counts(), before); p.noEffects();
});
test('usage count and then recency outrank stable config order within an uncustomized provider', async t => {
  const message = (model, timestamp) => JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', provider: 'p00', model } });
  const p = await open(t, [5], 0, { fixtureFiles: { 'sessions/fixture/2026.jsonl': [
    message('model-0-2', '2026-01-01T00:00:00Z'), message('model-0-2', '2026-01-02T00:00:00Z'),
    message('model-0-3', '2026-01-03T00:00:00Z'), message('model-0-4', '2026-01-04T00:00:00Z'),
  ].join('\n') } });
  assert.deepEqual(Array.from(p.debug().matrixCells, c => c.mid), ['model-0-2', 'model-0-4', 'model-0-3', 'model-0-0', 'model-0-1']); p.noEffects();
});
test('custom provider order keeps current identity and is not overwritten by search or display ordering', async t => {
  const p = await open(t, [2, 1, 1], 0, { fixtureFiles: { 'model-pick-order.json': { providers: ['p02', 'p00', 'p01'], models: { p00: ['model-0-1', 'model-0-0'] }, future: { keep: true } } } });
  assert.deepEqual([...new Set(Array.from(p.debug().matrixCells, c => c.pid))], ['p02', 'p00', 'p01']); assert.equal(p.selectedLabel(), 'model-0-0');
  p.type('p00'); p.send('right'); assert.equal(p.current().id, 'model-0-0'); p.noEffects();
});
test('malformed default, favorites and order files fail closed without repair or fallback writes', async t => {
  for (const [file, key] of [['settings.json', '\x1bd'], ['model-pick-favorites.json', '\x1b1'], ['model-pick-order.json', '\x1b[1;3C']]) {
    const p = await open(t, [2], 0, { fixtureFiles: { [file]: '{SYNTHETIC-invalid' } });
    p.send('right'); p.send(key); p.noEffects();
  }
});
test('busy host blocks switching, favorite/default/order/add/remove while retaining view/navigation', async t => {
  const p = await open(t, [2, 1], 0, { idle: () => false }); p.send('right');
  for (const key of ['enter', '\x1b1', '\x1bd', '\x1b[1;3D', '\x1bn', '\x1bx']) p.send(key);
  await p.flush(); assert.equal(p.debug().view, 'matrix'); assert.equal(p.selectedLabel(), 'model-0-1'); p.noEffects();
});
