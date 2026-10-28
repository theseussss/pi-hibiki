import assert from 'node:assert/strict';
import { piRoot as resolvePiRoot } from '../scripts/tooling.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';

const piRoot = resolvePiRoot();
const tui = await import(pathToFileURL(path.join(piRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js')));
const source = fileURLToPath(new URL('../lib/model-pick/controls.ts', import.meta.url));
const key = { up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', end: '\x1b[F', enter: '\r', tab: '\t', backTab: '\x1b[Z', esc: '\x1b', cancel: '\x03', save: '\x13', clear: '\x15', home: '\x01', kill: '\x0b', backspace: '\x7f' };
const kitty = (code, modifier = 1, event = 1) => `\x1b[${code};${modifier}:${event}u`;
const plain = (s) => tui.stripTerminalSequences(s).replace(/\x1b_pi:[^\x07]*\x07/g, '');
const paint = (_kind, s) => s;
const theme = { selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s, noMatch: () => '  暂无选项' };

function load(modules = tui) {
  return loadTypeScript(source, { '@earendil-works/pi-tui': modules }, {
    setTimeout() { throw new Error('controls must not start timers'); },
    clearTimeout() { throw new Error('controls must not use timers'); },
  });
}
const { NativeMenu, ModelBasket } = load();

function basket(options = {}) {
  const calls = { changes: [], edits: [], submits: [], backs: 0, discoveries: 0, renders: 0, descriptions: 0, labels: 0 };
  const control = new ModelBasket({
    candidates: ['alpha', 'beta', 'gamma'], paint,
    ...options,
    describe(id) { calls.descriptions++; return options.describe?.(id) ?? `说明 ${id}`; },
    ...(options.saveLabel ? { saveLabel(count) { calls.labels++; return options.saveLabel(count); } } : {}),
    onChange(ids) { calls.changes.push([...ids]); options.onChange?.(ids); },
    onEdit(id) { calls.edits.push(id); options.onEdit?.(id); },
    onSubmit(ids) { calls.submits.push([...ids]); options.onSubmit?.(ids); },
    onBack() { calls.backs++; },
    ...(options.onDiscover ? { onDiscover() { calls.discoveries++; } } : {}),
    requestRender() { calls.renders++; },
  });
  const h = {
    control, calls,
    send(data) { control.handleInput(key[data] ?? data); },
    raw(width = 100, height = 16) { return control.render(width, height); },
    lines(width = 100, height = 16) { return this.raw(width, height).map(plain); },
    screen(width = 100, height = 16) { return this.lines(width, height).join('\n'); },
    search(value) {
      for (let i = 0; i < 4 && !this.raw().join('').includes(tui.CURSOR_MARKER); i++) this.send('tab');
      assert.ok(this.raw().join('').includes(tui.CURSOR_MARKER));
      this.send('home'); this.send('kill');
      if (value) this.send(value);
    },
  };
  return h;
}

function fits(lines, width, height) {
  assert.ok(lines.length <= height, `${lines.length} rows > ${height}`);
  for (const line of lines) assert.ok(tui.visibleWidth(line) <= width, `${tui.visibleWidth(line)} columns > ${width}: ${plain(line)}`);
}

test('exports only the two runtime controls and uses no private cursor/list API', () => {
  assert.deepEqual(Object.keys(load()).sort(), ['ModelBasket', 'NativeMenu']);
  const code = fs.readFileSync(source, 'utf8'); // Source read only; no runtime file access.
  assert.doesNotMatch(code, /\.(?:cursor|selectedIndex|maxVisible|filteredItems)\s*=/);
  assert.doesNotMatch(code, /from\s+["'](?:node:|\.\/|\.\.\/)/);
});

test('NativeMenu renders exactly the installed SelectList and delegates public navigation', () => {
  const observed = { inputs: [], renders: 0, constructed: 0 };
  class ObservedList extends tui.SelectList {
    constructor(...args) { super(...args); observed.constructed++; }
    handleInput(data) { observed.inputs.push(data); super.handleInput(data); }
    render(width) { observed.renders++; return super.render(width); }
  }
  const { NativeMenu: Menu } = load({ ...tui, SelectList: ObservedList });
  const ran = [];
  const actions = Array.from({ length: 8 }, (_, i) => ({ label: `选项 ${i}`, description: `说明 ${i}`, run: () => ran.push(i) }));
  const menu = new Menu(actions, paint, () => {}, 3);
  const native = new tui.SelectList(actions.map((a, i) => ({ ...a, value: String(i) })), 3, theme);
  native.setSelectedIndex(3);
  assert.deepEqual([...menu.render(70, 4)], native.render(70));
  menu.handleInput(key.down); native.handleInput(key.down);
  assert.equal(menu.selected, Number(native.getSelectedItem().value));
  assert.deepEqual([...menu.render(70, 4)], native.render(70));
  assert.match(menu.render(70, 4).map(plain).join('\n'), /→ 选项 4/);
  assert.equal(observed.constructed, 2); // Initial viewport, then a public reconstruction.
  assert.deepEqual(observed.inputs, [key.down]);
  assert.ok(observed.renders >= 3);
  menu.handleInput(key.enter);
  assert.deepEqual(ran, [4]);
});

test('NativeMenu resize retains selected identity, native wrapping and inclusive scroll bounds', () => {
  let back = 0;
  const chosen = [];
  const menu = new NativeMenu(Array.from({ length: 30 }, (_, i) => ({ label: `model-${i}`, run: () => chosen.push(i) })), paint, () => back++, 17);
  for (const width of [1, 3, 24, 31, 70]) for (const height of [0, 1, 2, 3, 7, 31]) {
    fits(menu.render(width, height), width, height);
    assert.equal(menu.selected, 17);
  }
  assert.deepEqual([...menu.render(32, 0)], []);
  menu.handleInput(key.enter);
  assert.deepEqual(chosen, [17]);
  for (let i = 0; i < 13; i++) menu.handleInput(key.down);
  assert.equal(menu.selected, 0);
  menu.handleInput(key.up);
  assert.equal(menu.selected, 29);
  assert.match(menu.render(32, 2).map(plain).join('\n'), /→ model-29\n  \(30\/30\)/);
  menu.handleInput(key.esc); menu.handleInput(key.cancel);
  assert.equal(back, 2);
});

test('NativeMenu press activates once; repeat/release cannot activate or cancel', () => {
  let runs = 0, backs = 0;
  const menu = new NativeMenu([{ label: '添加', run: () => runs++ }], paint, () => backs++);
  menu.handleInput(kitty(13, 1, 2)); menu.handleInput(kitty(13, 1, 3));
  assert.equal(runs, 0);
  menu.handleInput(kitty(13));
  menu.handleInput(kitty(13, 1, 2)); menu.handleInput(kitty(13, 1, 3));
  assert.equal(runs, 1);
  menu.handleInput(kitty(27, 1, 2)); menu.handleInput(kitty(99, 5, 3));
  assert.equal(backs, 0);
  menu.handleInput(kitty(99, 5));
  assert.equal(backs, 1);
  const empty = new NativeMenu([], paint, () => backs++);
  fits(empty.render(10, 1), 10, 1);
  empty.handleInput(key.enter);
  assert.equal(runs, 1);
});

test('native menu respects in-memory Pi keybindings, without reading user config', () => {
  const original = tui.getKeybindings();
  try {
    tui.setKeybindings(new tui.KeybindingsManager(tui.TUI_KEYBINDINGS, { 'tui.select.down': 'ctrl+j' }));
    const menu = new NativeMenu([{ label: 'one', run() {} }, { label: 'two', run() {} }], paint, () => {});
    menu.handleInput('\x0a');
    assert.equal(menu.selected, 1);
    assert.match(menu.render(30, 3).map(plain).join('\n'), /→ two/);
  } finally { tui.setKeybindings(original); }
});

test('candidate Enter toggles only; selection survives successive searches', () => {
  const h = basket();
  h.search('alpha');
  assert.equal(h.calls.changes.length, 0);
  h.send('down'); h.send('enter');
  assert.deepEqual([...h.control.selectedIds], ['alpha']);
  assert.equal(h.calls.submits.length, 0);
  h.search('BETA'); h.send('down'); h.send('enter');
  assert.deepEqual([...h.control.selectedIds], ['alpha', 'beta']);
  h.search('alpha'); h.send('tab'); h.send('enter');
  assert.deepEqual([...h.control.selectedIds], ['beta']);
  assert.deepEqual(h.calls.changes, [['alpha'], ['alpha', 'beta'], ['beta']]);
  assert.equal(h.calls.submits.length, 0);
  h.search('no matching candidate');
  assert.deepEqual([...h.control.selectedIds], ['beta']);
});

test('manual exact IDs accept ASCII/Chinese commas atomically once, never implicitly save', () => {
  const h = basket();
  h.search('vendor/model:1@beta+q， Another_2.0-4, third');
  h.send('enter');
  const expected = ['vendor/model:1@beta+q', 'Another_2.0-4', 'third'];
  assert.deepEqual([...h.control.selectedIds], expected);
  assert.deepEqual(h.calls.changes, [expected]);
  assert.equal(h.control.query, '');
  h.send('enter');
  assert.equal(h.calls.changes.length, 1);
  assert.equal(h.calls.submits.length, 0);
  const exposed = h.control.selectedIds; exposed.push('must-not-leak');
  assert.deepEqual([...h.control.selectedIds], expected);
});

for (const [name, input, message] of [
  ['wrong character', 'fresh,wrong%id', /准确模型 ID/],
  ['wrong first character', 'fresh,.wrong', /准确模型 ID/],
  ['Unicode ID', 'fresh,中文', /准确模型 ID/],
  ['empty batch member', 'fresh,,other', /准确模型 ID/],
  ['trailing comma', 'fresh,', /准确模型 ID/],
  ['overlong ID', `fresh,${'a'.repeat(257)}`, /准确模型 ID/],
  ['duplicate within batch', 'fresh,fresh', /重复/],
  ['already picked duplicate', 'fresh,kept', /重复/],
  ['oversize batch', Array.from({ length: 101 }, (_, i) => `batch-${i}`).join(','), /最多选择100/],
]) test(`manual ${name} rejects the complete batch without a partial onChange`, () => {
  const h = basket({ selected: ['kept'] });
  h.search(input); h.send('enter');
  assert.deepEqual([...h.control.selectedIds], ['kept']);
  assert.equal(h.control.query, input);
  assert.match(h.screen(100, 10), message);
  assert.equal(h.calls.changes.length, 0);
  assert.equal(h.calls.submits.length, 0);
});

test('blocked existing models reject the entire manual batch and cannot be picked as candidates', () => {
  const blocked = ['already-exists'];
  const h = basket({ selected: ['kept'], candidates: ['already-exists', 'fresh'], blockedIds: blocked });
  blocked.length = 0; // The parent's mutable array cannot silently change the guard.
  h.search('fresh，already-exists'); h.send('enter');
  assert.deepEqual([...h.control.selectedIds], ['kept']);
  assert.match(h.screen(), /模型已存在，本次未添加/);
  assert.equal(h.calls.changes.length, 0);
  h.search('already-exists'); h.send('down'); h.send('enter');
  assert.deepEqual([...h.control.selectedIds], ['kept']);
  assert.equal(h.calls.changes.length, 0);
  assert.equal(h.calls.submits.length, 0);
  h.search('fresh'); h.send('enter');
  assert.deepEqual(h.calls.changes, [['kept', 'fresh']]);
});

test('100 picked is supported; both manual and candidate overflow reject atomically', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `picked-${i}`);
  const h = basket({ candidates: ['overflow', ids[0]], selected: ids });
  h.search('manual-overflow'); h.send('enter');
  assert.equal(h.control.selectedIds.length, 100);
  assert.equal(h.calls.changes.length, 0);
  h.search('overflow'); h.send('down'); h.send('enter');
  assert.equal(h.calls.changes.length, 0);
  h.search(ids[0]); h.send('down'); h.send('enter');
  assert.equal(h.control.selectedIds.length, 99);
  h.search('replacement'); h.send('enter');
  assert.equal(h.control.selectedIds.length, 100);
  assert.equal(h.calls.changes.length, 2);
  const full = basket({ candidates: [] });
  full.search(ids.join(',')); full.send('enter');
  assert.deepEqual([...full.control.selectedIds], ids);
  assert.equal(full.calls.changes.length, 1);
  const longest = basket(); longest.search('a'.repeat(256)); longest.send('enter');
  assert.equal(longest.control.selectedIds[0].length, 256);
});

test('Ctrl+S submits a copy of explicit picks only, leaving the filter untouched', () => {
  const h = basket({ selected: ['chosen'], query: 'not-a-picked-model', onSubmit(ids) { ids.push('callback-mutation'); } });
  h.send('save');
  assert.deepEqual(h.calls.submits, [['chosen']]);
  assert.deepEqual([...h.control.selectedIds], ['chosen']);
  assert.equal(h.control.query, 'not-a-picked-model');
  assert.equal(h.calls.changes.length, 0);
  const empty = basket({ query: 'valid-but-only-a-filter' });
  empty.send('save');
  assert.equal(empty.calls.submits.length, 0);
  assert.equal(empty.calls.changes.length, 0);
  assert.match(empty.screen(), /至少一个模型/);
  assert.equal(empty.control.query, 'valid-but-only-a-filter');
});

test('manual and Ctrl+S press dispatch once; repeat and release dispatch no callbacks', () => {
  const h = basket({ query: 'manual' });
  h.send(kitty(13, 1, 2)); h.send(kitty(13, 1, 3));
  assert.equal(h.calls.changes.length, 0);
  h.send(kitty(13));
  h.send(kitty(13, 1, 2)); h.send(kitty(13, 1, 3));
  assert.deepEqual(h.calls.changes, [['manual']]);
  h.send(kitty(115, 5, 2)); h.send(kitty(115, 5, 3));
  assert.equal(h.calls.submits.length, 0);
  h.send(kitty(115, 5));
  h.send(kitty(115, 5, 2)); h.send(kitty(115, 5, 3));
  assert.deepEqual(h.calls.submits, [['manual']]);
  const candidate = basket(); candidate.send('down');
  candidate.send(kitty(13, 1, 2)); candidate.send(kitty(13, 1, 3));
  assert.equal(candidate.calls.changes.length, 0);
  candidate.send(kitty(13));
  assert.deepEqual(candidate.calls.changes, [['alpha']]);
  assert.equal(candidate.calls.submits.length, 0);
  candidate.send('\x1b[1;1:3B');
  candidate.send('enter');
  assert.deepEqual([...candidate.control.selectedIds], []); // Release did not move the native list.
});

test('Tab/ShiftTab focus is reversible, with picked parameters and same-instance return', () => {
  const h = basket({ selected: ['alpha', 'beta'], query: 'alpha' });
  assert.ok(h.raw().join('').includes(tui.CURSOR_MARKER));
  h.send('tab');
  assert.ok(!h.raw().join('').includes(tui.CURSOR_MARKER));
  h.send('tab'); h.send('enter');
  assert.deepEqual(h.calls.edits, ['alpha']);
  assert.equal(h.control.query, 'alpha');
  const original = h.screen();
  h.control.setFocused(false); h.send('tab'); h.send('enter');
  assert.equal(h.calls.edits.length, 1);
  h.control.setFocused(true);
  assert.equal(h.screen(), original);
  h.send('enter');
  assert.deepEqual(h.calls.edits, ['alpha', 'alpha']);
  h.send('tab'); h.send('backTab'); h.send('enter');
  assert.equal(h.calls.edits.length, 3);
  h.send('backTab'); h.send('enter'); // Candidate alpha toggles off, not a save.
  assert.deepEqual([...h.control.selectedIds], ['beta']);
  h.send('backTab');
  assert.ok(h.raw().join('').includes(tui.CURSOR_MARKER));
  h.send('backTab'); h.send('enter');
  assert.deepEqual(h.calls.submits, [['beta']]);
});

test('native Input text editing and IME/CURSOR_MARKER match the actual component', () => {
  const h = basket({ query: 'abc' });
  const native = new tui.Input({ prompt: '› ', placeholder: '搜索或输入模型 ID', placeholderStyle: (s) => s });
  native.setValue('abc'); native.handleInput(key.end); native.focused = true;
  for (const data of [key.left, '中国', key.backspace, 'e\u0301', key.backspace, '长长长长长长', key.home, key.end]) {
    h.send(data); native.handleInput(data);
    assert.equal(h.control.query, native.getValue());
    for (const width of [8, 24, 32]) {
      assert.equal(h.raw(width, 10)[0], native.render(width)[0]);
      assert.equal(h.raw(width, 10)[0].split(tui.CURSOR_MARKER).length, 2);
    }
  }
  assert.equal(h.calls.changes.length, 0);
  assert.equal(h.calls.submits.length, 0);
  h.control.setFocused(false);
  assert.ok(!h.raw().join('').includes(tui.CURSOR_MARKER));
  const before = h.control.query; h.send('ignored');
  assert.equal(h.control.query, before);
  h.control.setFocused(true); h.send('down');
  assert.ok(!h.raw().join('').includes(tui.CURSOR_MARKER));
  h.send(kitty(20013));
  assert.equal(h.control.query, before + '中');
  assert.ok(h.raw().join('').includes(tui.CURSOR_MARKER));
});

test('typing from candidates, picked parameters or actions redirects to the native Input', () => {
  for (const tabs of [1, 2, 3]) {
    const h = basket({ selected: ['alpha'] });
    for (let i = 0; i < tabs; i++) h.send('tab');
    h.send('beta');
    assert.equal(h.control.query, 'beta');
    assert.ok(h.raw().join('').includes(tui.CURSOR_MARKER));
    assert.equal(h.calls.changes.length, 0);
    assert.equal(h.calls.edits.length, 0);
    assert.equal(h.calls.submits.length, 0);
  }
});

test('bracketed paste, even command-looking chunks and split terminators, stays in Input', () => {
  const h = basket(); h.send('down');
  h.send('\x1b[200~fresh,other'); h.send('\r'); h.send('\x13');
  h.send('\x1b[20'); h.send('1~');
  assert.equal(h.control.query, 'fresh,other\x13');
  assert.equal(h.calls.changes.length, 0);
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.calls.backs, 0);
  h.search('fresh，other'); h.send('enter');
  assert.deepEqual(h.calls.changes, [['fresh', 'other']]);
});

test('filtered candidates have a bounded native viewport, total and full page-wrapped navigation', () => {
  const ids = Array.from({ length: 80 }, (_, i) => `series-${i}`);
  const h = basket({ candidates: ids, query: 'SERIES-' });
  let lines = h.lines(100, 80);
  assert.match(lines.join('\n'), /候选 80/);
  assert.ok(lines.filter((line) => /^(?:→ |  )\[[ x]\] series-/.test(line)).length <= 20);
  assert.match(lines.join('\n'), /\(1\/80\)/);
  h.send('down'); h.send('up');
  assert.ok(h.raw().join('').includes(tui.CURSOR_MARKER), 'top edge returns to search, not the bottom of the same list');
  h.send('up'); h.send('up'); // Search -> last action -> last candidate.
  assert.match(h.screen(100, 80), /→ \[ \] series-79/);
  h.send('enter');
  assert.deepEqual([...h.control.selectedIds], ['series-79']);
  assert.equal(h.calls.submits.length, 0);
  h.search('7');
  lines = h.lines(100, 80);
  assert.match(lines.join('\n'), /候选 17/);
  const nativeRows = lines.filter((line) => /^(?:→ |  )\[[ x]\] series-/.test(line));
  assert.equal(nativeRows.length, 17);
  assert.ok(nativeRows.every((line) => /series-\d*7\d*/.test(line)));
  assert.deepEqual([...h.control.selectedIds], ['series-79']);
});

test('setCandidates retains basket, query, native candidate identity and focus', () => {
  const h = basket({ candidates: ['group-a', 'group-b'], selected: ['manual'], query: 'group' });
  h.send('down'); h.send('down'); // Focus list, then select b.
  h.control.setCandidates(['elsewhere', 'group-new', 'group-b', 'group-a']);
  assert.equal(h.control.query, 'group');
  assert.deepEqual([...h.control.selectedIds], ['manual']);
  assert.equal(h.calls.changes.length, 0);
  assert.match(h.screen(), /→ \[ \] group-b/);
  assert.ok(!h.raw().join('').includes(tui.CURSOR_MARKER));
  h.send('enter');
  assert.deepEqual(h.calls.changes, [['manual', 'group-b']]);
  h.control.setCandidates([]);
  assert.deepEqual([...h.control.selectedIds], ['manual', 'group-b']);
  assert.equal(h.calls.changes.length, 1);
});

test('explicit onChange resolves parent cache before summaries are snapshotted', () => {
  const specs = new Map();
  const h = basket({
    describe: (id) => specs.get(id) ?? '',
    onChange(ids) { for (const id of ids) specs.set(id, '窗口64k · 输出8k'); },
  });
  h.send('down'); h.send('enter');
  assert.deepEqual(h.calls.changes, [['alpha']]);
  assert.match(h.screen(31, 8), /窗口64k · 输出8k/);
  const described = h.calls.descriptions;
  h.raw(31, 8); h.raw(80, 10);
  assert.equal(h.calls.descriptions, described);
  h.send('tab');
  specs.set('alpha', '窗口128k · 输出16k');
  h.control.setCandidates(['alpha', 'beta', 'gamma']);
  assert.match(h.screen(31, 8), /窗口128k · 输出16k/);
  assert.equal(h.calls.changes.length, 1);
});

test('all 100 picked parameter actions stay reachable through the real native list', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `picked-${i}`);
  const h = basket({ selected: ids, query: 'retained-query' });
  h.send('up'); h.send('up'); h.send('up'); h.send('enter'); // Search -> manual -> Save -> last picked item, without Tab.
  assert.deepEqual(h.calls.edits, ['picked-99']);
  assert.equal(h.control.query, 'retained-query');
  assert.match(h.screen(31, 8), /参数 · picked-99/);
  h.control.setFocused(false); h.control.setFocused(true); h.send('enter');
  assert.deepEqual(h.calls.edits, ['picked-99', 'picked-99']);
  assert.equal(h.calls.changes.length, 0);
  assert.equal(h.calls.submits.length, 0);
});

test('primary add action stays visible and reachable at 24–32 columns / 8–10 rows with 100 picks', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `picked-${i}`);
  for (const width of [24, 28, 31, 32]) for (const height of [8, 9, 10]) for (const supplier of [false, true]) {
    const h = basket({ candidates: Array.from({ length: 200 }, (_, i) => `candidate-${i}`), selected: ids, query: 'filter-only', onDiscover() {},
      saveLabel: (count) => supplier ? `添加供应商及模型（${count}个）` : `添加${count}个模型`,
    });
    for (let section = 0; section < 3; section++) { // Search has no matches: search / selected / actions.
      const lines = h.raw(width, height);
      fits(lines, width, height);
      assert.match(lines.map(plain).join('\n'), supplier ? /添加供应商及模型/ : /添加100个模型/);
      h.send('tab');
    }
    h.send('backTab'); h.send('enter'); // Direct to pinned actions, first action is Save.
    assert.deepEqual(h.calls.submits, [ids]);
    assert.equal(h.control.query, 'filter-only');
    assert.equal(h.calls.changes.length, 0);
  }
});

test('optional discovery and explicit add-input action are native, explicit actions only', () => {
  const h = basket({ query: 'manual', onDiscover() {} });
  h.send('backTab'); h.send('enter');
  assert.deepEqual(h.calls.changes, [['manual']]);
  assert.equal(h.calls.submits.length, 0);
  h.send('down'); h.send('enter');
  assert.equal(h.calls.discoveries, 1);
  assert.equal(h.calls.submits.length, 0);
  h.send(kitty(13, 1, 2)); h.send(kitty(13, 1, 3));
  assert.equal(h.calls.discoveries, 1);
});

test('Esc/CtrlC back from every field, with no selection/save and no repeat/release dispatch', () => {
  for (const data of [key.esc, key.cancel]) for (let section = 0; section < 4; section++) {
    const h = basket({ selected: ['alpha'] });
    for (let i = 0; i < section; i++) h.send('tab');
    h.send(kitty(27, 1, 2)); h.send(kitty(27, 1, 3));
    assert.equal(h.calls.backs, 0);
    h.send(data);
    assert.equal(h.calls.backs, 1);
    assert.equal(h.calls.submits.length, 0);
    assert.equal(h.calls.changes.length, 0);
  }
});

test('render and typing never resolve specs, change picks, discover or submit; summaries are cached', () => {
  const h = basket({ selected: ['alpha'], onDiscover() {}, saveLabel: (count) => `添加${count}个模型` });
  const callbacksBefore = structuredClone(h.calls);
  for (const width of [24, 32, 80]) for (const height of [0, 1, 3, 8, 10, 50]) fits(h.raw(width, height), width, height);
  assert.deepEqual(h.calls, callbacksBefore);
  h.send('alpha'); h.send('backspace'); h.send('beta');
  assert.equal(h.calls.descriptions, callbacksBefore.descriptions);
  assert.equal(h.calls.labels, callbacksBefore.labels);
  assert.equal(h.calls.changes.length, 0);
  assert.equal(h.calls.submits.length, 0);
  assert.equal(h.calls.discoveries, 0);
  h.control.setStatus('清单已更新\n可继续选择');
  assert.match(h.screen(), /清单已更新 可继续选择/);
  h.control.setError('请检查 ID');
  const afterEvents = structuredClone(h.calls);
  for (let i = 0; i < 10; i++) h.raw(32, 8);
  assert.deepEqual(h.calls, afterEvents);
  assert.match(h.screen(), /请检查 ID/);
  assert.doesNotMatch(h.screen(), /protocol|vault|store|DPAPI|候选对象|事务|主密码/i);
});

test('initial selection rejects blocked/duplicate/unsafe identities; refreshed candidates discard rather than rewrite them', () => {
  for (const selected of [['alpha'], ['beta', 'beta'], ['bad\u0007id']]) {
    assert.throws(() => basket({ blockedIds: ['alpha'], selected }), /准确模型 ID/);
  }
  const h = basket({ blockedIds: ['alpha'], candidates: ['alpha', 'beta', 'bad\u0007id', 'bidi\u202eid'] });
  assert.match(h.screen(), /\[ \] beta/); assert.doesNotMatch(h.screen(), /\[ \] alpha|bad|bidi/);
  h.control.setCandidates(['alpha', 'gamma', 'bad\u001bid']);
  assert.match(h.screen(), /\[ \] gamma/); assert.doesNotMatch(h.screen(), /\[ \] alpha|beta|bad/);
  assert.equal(h.calls.changes.length, 0); assert.equal(h.calls.submits.length, 0);
});

test('focus loss completes only the pending paste and restores one search cursor without swallowing the next key', () => {
  const h = basket(); h.send('\x1b[200~pasted-id'); h.control.setFocused(false);
  assert.ok(!h.raw().join('').includes(tui.CURSOR_MARKER)); h.send('ignored');
  h.control.setFocused(true); assert.equal(h.control.query, 'pasted-id');
  assert.equal(h.raw().join('').split(tui.CURSOR_MARKER).length - 1, 1);
  h.send('enter'); assert.deepEqual(Array.from(h.control.selectedIds), ['pasted-id']);
  assert.equal(h.calls.submits.length, 0); assert.equal(h.calls.backs, 0);
});

test('picked-region Backspace unpicks, while Ctrl+C cancels the task and Escape goes back', () => {
  let cancelled = 0; const h = basket({ selected: ['beta'], onCancel() { cancelled++; } });
  h.send('tab'); h.send('tab'); assert.match(h.screen(), /→ 参数 · beta/);
  h.send('backspace'); assert.deepEqual(Array.from(h.control.selectedIds), []);
  assert.equal(h.calls.backs, 0); h.send('cancel'); assert.equal(cancelled, 1); assert.equal(h.calls.backs, 0);
  h.send('esc'); assert.equal(h.calls.backs, 1); assert.equal(h.calls.submits.length, 0);
});
