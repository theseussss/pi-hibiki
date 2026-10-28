import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
import { tui, paint, plain, focusedNativeRow, baseConfig, harness as extensionHarness } from './model-pick-ui-harness.mjs';

const { ModelBasket } = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/controls.ts', import.meta.url)), { '@earendil-works/pi-tui': tui });
const keys = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r', save: '\x13', clear: '\x15', esc: '\x1b', remove: '\x1b[3~' };
function basket(options = {}) {
  const calls = { changes: [], edits: [], saves: [], backs: 0, cancels: 0, discovery: 0, descriptions: 0 };
  const control = new ModelBasket({ candidates: ['alpha', 'beta'], paint, ...options,
    onChange: (ids) => calls.changes.push([...ids]), onEdit: (id) => calls.edits.push(id), onSubmit: (ids) => calls.saves.push([...ids]),
    onBack: () => calls.backs++, onCancel: () => calls.cancels++, requestRender() {},
    describe(id) { calls.descriptions++; return `规格 ${id}`; },
    ...(options.discover ? { onDiscover: () => calls.discovery++ } : {}),
  });
  return { control, calls,
    send(key) { control.handleInput(keys[key] ?? key); },
    lines(width = 90, height = 16) { return control.render(width, height); },
    screen() { return this.lines().map(plain).join('\n'); },
    selected() { return focusedNativeRow(this.lines()); },
    search() { return this.lines().join('').includes(tui.CURSOR_MARKER); },
  };
}
const row = (h, text) => { assert.equal(h.search(), false); assert.ok(h.selected()?.includes(text), `${text}\n${h.screen()}`); };
const input = (h) => { assert.equal(h.search(), true); assert.equal(h.selected(), undefined); };

test('Up/Down traverse search, every candidate and every action in both directions, without a Tab island', () => {
  const h = basket({ discover: true }); input(h);
  for (const [key, expected] of [['down','[ ] alpha'],['down','[ ] beta'],['down','手动输入'],['down','读取模型']]) { h.send(key); row(h, expected); }
  h.send('down'); input(h);
  for (const [key, expected] of [['up','读取模型'],['up','手动输入'],['up','[ ] beta'],['up','[ ] alpha']]) { h.send(key); row(h, expected); }
  h.send('up'); input(h);
  assert.deepEqual(h.calls.changes, []); assert.deepEqual(h.calls.saves, []); assert.equal(h.calls.discovery, 0);
});

test('arrows plus fresh Enter can pick, edit and explicitly save; navigation never commits', () => {
  const h = basket(); h.send('down'); h.send('enter'); assert.deepEqual(h.calls.changes, [['alpha']]);
  h.send('right'); row(h, '参数 · alpha'); h.send('enter'); assert.deepEqual(h.calls.edits, ['alpha']);
  h.send('down'); row(h, '添加1个模型'); assert.deepEqual(h.calls.saves, []);
  h.send('enter'); assert.deepEqual(h.calls.saves, [['alpha']]);
});

test('Left/Right switch candidate and picked panes, preserving both independent native cursors', () => {
  const h = basket({ candidates: ['alpha', 'beta', 'gamma'], selected: ['alpha', 'beta', 'gamma'] });
  h.send('down'); h.send('down'); row(h, '[x] beta'); h.send('right'); row(h, '参数 · alpha');
  h.send('down'); row(h, '参数 · beta'); h.send('left'); row(h, '[x] beta');
  h.send('right'); row(h, '参数 · beta'); assert.deepEqual(h.calls.changes, []); assert.deepEqual(h.calls.saves, []);
});

test('empty filtered candidates are skipped; Left from picked returns to the same search input', () => {
  const h = basket({ selected: ['alpha'], query: 'no-match' }); h.send('down'); row(h, '参数 · alpha');
  h.send('left'); input(h); assert.equal(h.control.query, 'no-match'); h.send('down'); row(h, '参数 · alpha');
  h.send('up'); input(h); h.send('down'); row(h, '参数 · alpha');
  assert.deepEqual(h.calls.changes, []); assert.deepEqual(h.calls.saves, []);
});

test('a true empty basket still has reversible arrow access to input/manual/discovery with no phantom model focus', () => {
  const h = basket({ candidates: [], discover: true });
  for (let i = 0; i < 4; i++) {
    h.send('down'); row(h, '手动输入'); h.send('down'); row(h, '读取模型'); h.send('down'); input(h);
    h.send('up'); row(h, '读取模型'); h.send('up'); row(h, '手动输入'); h.send('up'); input(h);
  }
  assert.deepEqual(h.calls.changes, []); assert.deepEqual(h.calls.saves, []); assert.equal(h.calls.discovery, 0);
});

test('all 100 picked items and the pinned save remain reachable with only arrows at narrow/short sizes', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `picked-${i}`); const h = basket({ candidates: [], selected: ids, query: 'keep' });
  h.send('up'); row(h, '手动输入'); h.send('up'); row(h, '添加100个模型'); h.send('up'); row(h, '参数 · picked-99');
  for (let i = 99; i >= 0; i--) { row(h, `参数 · picked-${i}`); h.send('enter'); if (i) h.send('up'); }
  assert.deepEqual(h.calls.edits, [...ids].reverse());
  for (const width of [24, 32, 80]) for (const height of [8, 10, 24]) {
    const lines = h.lines(width, height); assert.ok(lines.length <= height); assert.ok(lines.every((line) => tui.visibleWidth(line) <= width));
    assert.match(lines.map(plain).join('\n'), /添加100个模型/);
  }
  h.send('up'); input(h); h.send('up'); h.send('up'); row(h, '添加100个模型');
  h.send('enter'); assert.deepEqual(h.calls.saves, [ids]); assert.equal(h.control.query, 'keep'); assert.deepEqual(h.calls.changes, []);
});

test('unpick the last item returns to search and removes Save without stranding arrow navigation', () => {
  const h = basket({ candidates: [], selected: ['alpha'] }); h.send('down'); h.send('remove'); input(h);
  assert.deepEqual(h.calls.changes, [[]]); assert.doesNotMatch(h.screen(), /添加0个模型|添加1个模型/);
  h.send('down'); row(h, '手动输入'); h.send('down'); input(h); assert.deepEqual(h.calls.saves, []);
});

test('Left/Right remain native caret editing in search; typing/paste from the picked pane cannot navigate or save', () => {
  const h = basket({ selected: ['alpha'], query: 'abcd' }); h.send('left'); h.send('X'); h.send('right'); h.send('\x7f');
  input(h); assert.equal(h.control.query, 'abcX'); h.send('down'); row(h, '参数 · alpha'); h.send('up'); input(h);
  h.send('clear'); h.send('beta'); assert.match(h.screen(), /候选 1 · 已选 1/); h.send('down'); row(h, '[ ] beta');
  h.send('right'); h.send('\x1b[200~pasted'); h.send('down'); h.send('right'); h.send('save'); h.send('\x1b[20'); h.send('1~');
  input(h); assert.ok(h.control.query.includes('pasted')); assert.deepEqual(h.calls.changes, []); assert.deepEqual(h.calls.saves, []);
});

test('refresh preserves the focused model by identity and moves to a real search cursor if all matches disappear', () => {
  const h = basket({ candidates: ['group-a', 'group-b'], selected: ['alpha'], query: 'group' }); h.send('down'); h.send('down');
  h.control.setCandidates(['group-b', 'group-new', 'group-a']); row(h, '[ ] group-b');
  h.control.setCandidates([]); input(h); assert.equal(h.control.query, 'group');
  h.send('down'); row(h, '参数 · alpha'); assert.deepEqual(h.calls.changes, []); assert.deepEqual(h.calls.saves, []);
});

test('enhanced arrow repeats may navigate across boundaries, while releases/confirm/save/cancel repeats cannot act', () => {
  const h = basket({ selected: ['alpha'] }); h.send('\x1b[1;1:3B'); input(h);
  h.send('down'); h.send('\x1b[1;1:2B'); row(h, '[ ] beta'); h.send('\x1b[1;1:2B'); row(h, '添加1个模型');
  for (const key of ['\x1b[13;1:2u', '\x1b[13;1:3u', '\x1b[115;5:2u', '\x1b[99;5:2u', '\x1b[27;1:2u']) h.send(key);
  row(h, '添加1个模型'); assert.deepEqual(h.calls.saves, []); assert.equal(h.calls.backs, 0); assert.equal(h.calls.cancels, 0);
  h.send('enter'); assert.deepEqual(h.calls.saves, [['alpha']]);
});

test('direction routing uses the actual in-memory native Up/Down bindings, without loading user keybindings', () => {
  const original = tui.getKeybindings();
  try {
    tui.setKeybindings(new tui.KeybindingsManager(tui.TUI_KEYBINDINGS, { 'tui.select.down': 'ctrl+j', 'tui.select.up': 'ctrl+k' }));
    const h = basket(); h.send('\x0a'); row(h, '[ ] alpha'); h.send('\x0a'); row(h, '[ ] beta');
    h.send('\x0a'); row(h, '手动输入'); h.send('\x0b'); row(h, '[ ] beta');
    assert.deepEqual(h.calls.saves, []); assert.deepEqual(h.calls.changes, []);
  } finally { tui.setKeybindings(original); }
});

test('arrow/render loops keep one real keyboard owner and do not resolve descriptions, select, discover or submit', () => {
  const h = basket({ selected: ['alpha', 'beta'], discover: true }); const count = h.calls.descriptions;
  for (let i = 0; i < 160; i++) {
    h.send(['down','down','right','down','left','up'][i % 6]);
    for (const width of [32, 80]) {
      const lines = h.lines(width, 10); const cursor = lines.join('').split(tui.CURSOR_MARKER).length - 1;
      const native = focusedNativeRow(lines) ? 1 : 0; assert.equal(cursor + native, 1);
    }
  }
  assert.equal(h.calls.descriptions, count); assert.deepEqual(h.calls.changes, []); assert.deepEqual(h.calls.edits, []); assert.deepEqual(h.calls.saves, []); assert.equal(h.calls.discovery, 0);
});

test('production add-model task supports arrows/Enter from search through parameters to one explicit save', async (t) => {
  const p = await extensionHarness(t, { catalogEntries: [{ ...baseConfig().providers.p00.models[0], provider: 'p00', id: 'arrow-candidate' }] });
  p.send('\x1bn'); p.type('arrow-model'); p.send('enter');
  p.send('down'); p.send('right'); assert.match(p.screen(), /参数 · arrow-model/);
  const before = p.raw(); p.send('enter'); assert.match(p.screen(), /arrow-model · 调整参数/); p.send('esc'); assert.equal(p.raw(), before);
  p.send('left'); p.send('down'); assert.match(focusedNativeRow(p.raw().split('\n')), /添加1个模型/);
  assert.ok(!p.config().providers.p00.models.some((m) => m.id === 'arrow-model'));
  p.send('enter'); await p.settled(); assert.ok(p.config().providers.p00.models.some((m) => m.id === 'arrow-model'));
  assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.selections.length, 0);
});

test('production new-supplier model page requires no Tab even to edit the second pick and commit both', async (t) => {
  const p = await extensionHarness(t); p.send('left'); p.send('left'); p.send('\x1bn');
  p.type('Arrow Bridge'); p.send('tab'); p.type('https://arrow.test/v1'); p.send('save'); // Tabs belong only to the connection form.
  p.type('arrow-first,arrow-second'); p.send('enter'); p.send('down'); p.send('down');
  assert.match(focusedNativeRow(p.raw().split('\n')), /参数 · arrow-second/); p.send('enter');
  assert.match(p.screen(), /arrow-second · 调整参数/); p.send('esc'); p.send('down');
  assert.match(focusedNativeRow(p.raw().split('\n')), /添加供应商及模型/); assert.equal(Object.keys(p.config().providers).length, 2);
  p.send('enter'); await p.settled(); assert.deepEqual(p.config().providers['arrow-bridge'].models.map((m) => m.id), ['arrow-first', 'arrow-second']);
  assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.selections.length, 0);
});
