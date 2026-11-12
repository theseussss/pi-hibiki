import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, plain, tui } from './model-pick-ui-harness.mjs';
import { homeConfig, homeModelCounts, homeShape, homeCurrent, homeDefault, homeFavorites, homeFixtureFiles } from './hibiki-home-fixtures.mjs';

const open = (t, options = {}) => harness(t, { config: homeConfig(), currentRef: homeCurrent, terminalColumns: 120, terminalRows: 44, ...options,
  fixtureFiles: { ...homeFixtureFiles(), ...options.fixtureFiles } });
const json = (p, file) => JSON.parse(fs.readFileSync(path.join(p.root, file), 'utf8'));
const viewport = p => p.debug().matrixViewport ?? { top: p.debug().offset, page: p.debug().page, total: p.debug().total };
// This is the documented logical-body geometry contract, checked against actual
// painted text before using a hit. No private cursor setters or controller calls.
function point(p, rect) {
  const rule = p.lines().findIndex(line => /^\s*─+\s*$/.test(line));
  assert.ok(rule >= 0);
  return { x: rect.x + 1, y: rule + 1 + rect.y - p.debug().offset };
}
function columns(text, start, length) {
  let at = 0, out = '';
  for (const ch of plain(text)) { const width = tui.visibleWidth(ch); if (at >= start && at < start + length) out += ch; at += width; }
  return out;
}
function cellText(p, cell) { const pt = point(p, cell); return columns(p.lines()[pt.y] ?? '', pt.x, cell.width); }
function foregroundAt(text, column) {
  let x = 0, color;
  for (const token of text.match(/\x1b\[[0-9;]*m|[^\x1b]+/gu) ?? []) {
    if (token.startsWith('\x1b[')) {
      const rgb = token.match(/38;2;(\d+);(\d+);(\d+)/u);
      if (rgb) color = rgb.slice(1).map(Number);
      else if (/\x1b\[(?:0|39)?m/u.test(token)) color = undefined;
    } else { const width = tui.visibleWidth(token); if (column >= x && column < x + width) return color; x += width; }
  }
}
function cellColor(p, cell) { const pt = point(p, cell); return foregroundAt(p.raw().split('\n')[pt.y], pt.x + 2); }
function candidate(p) {
  p.lines(); return p.debug().matrixCells.find(cell => /^›/.test(cellText(p, cell).trimStart()));
}
function expectCandidate(p, pid, mid) {
  const cell = candidate(p); assert.ok(cell, `missing painted candidate ${pid}/${mid}\n${p.screen()}`);
  assert.deepEqual([cell.pid, cell.mid], [pid, mid]); return cell;
}
function click(p, rect) {
  const pt = point(p, rect);
  assert.ok(pt.y >= 0 && pt.y < p.lines().length, 'geometry must identify a physical visible row');
  const result = p.component.handleMouse({ type: 'click', button: 'left', ...pt, shift: false, alt: false, ctrl: false });
  p.lines(); return result;
}
function rail(p) {
  const lines = p.lines(), slots = p.debug().actionSlots;
  const actionY = Math.min(...slots.filter(s => s.actionIndex !== null).map(s => point(p, s).y));
  const rules = lines.flatMap((line, i) => /^\s*─+\s*$/.test(line) ? [i] : []);
  const detailRule = rules.filter(i => i < actionY).at(-1);
  assert.notEqual(detailRule, undefined);
  return { lines, detailY: detailRule + 1, actionY, slots: slots.map(s => ({ key: s.key, x: s.x, y: point(p, s).y, width: s.width })) };
}
function noEffects(p) { assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.selections.length, 0); assert.deepEqual(p.config(), homeConfig()); }

test('anonymous HOME fixture has the exact independent 22 supplier / 104 model shape', () => {
  const config = homeConfig(); assert.equal(Object.keys(config.providers).length, 22);
  assert.equal(Object.values(config.providers).reduce((n, p) => n + p.models.length, 0), 104);
  assert.deepEqual(Object.values(config.providers).map(p => p.models.length), [...homeModelCounts]);
  assert.equal(homeShape.models, 104); assert.equal(homeShape.providers, 22);
  for (const [i, [pid, provider]] of Object.entries(config.providers).entries()) {
    assert.equal(pid, `p${String(i).padStart(2, '0')}`); assert.equal(new URL(provider.baseUrl).hostname.endsWith('.invalid'), true);
    assert.equal('apiKey' in provider, false); assert.deepEqual(provider.models.map(m => m.id), provider.models.map((_, j) => `m${j}`));
  }
  config.providers.p00.models[0].name = 'changed'; assert.notEqual(homeConfig().providers.p00.models[0].name, 'changed');
});

for (const [width, height] of [[80, 24], [120, 44], [160, 44]]) test(`HOME fixed query/detail/ALL first-layer actions and one row per supplier at ${width}x${height}`, async t => {
  const p = await open(t, { terminalColumns: width, terminalRows: height });
  const { lines, detailY, actionY, slots } = rail(p), d = p.debug(), v = viewport(p);
  assert.ok(lines.length <= height); assert.ok(lines.every(line => tui.visibleWidth(line) < width));
  assert.match(lines[0], /Pi Models.*104.*默认.*m8/); assert.ok(lines[2].trim().length > 0, 'native search stays on screen');
  assert.ok(v.page > 0 && v.page <= 18); assert.equal(v.total, 22);
  if (height === 44) { assert.equal(v.page, 18); assert.ok(lines.length >= 26, 'HOME must not use task .55-height budget'); }
  const byProvider = new Map();
  for (const cell of d.matrixCells) {
    const ys = byProvider.get(cell.pid) ?? new Set(); ys.add(point(p, cell).y); byProvider.set(cell.pid, ys);
    assert.ok(point(p, cell).y < detailY - 1); assert.ok(cellText(p, cell).trim().length > 0, 'debug exposes actual painted model only');
  }
  assert.equal(byProvider.size, v.page);
  assert.ok([...byProvider.values()].every(ys => ys.size === 1), 'model count never wraps a provider into extra physical rows');
  const ys = [...byProvider.values()].map(ys => [...ys][0]).sort((a, b) => a - b);
  assert.ok(ys.every((y, i) => i === 0 || y === ys[i - 1] + 1), 'no blank separators or cards between providers');
  const first = d.matrixCells.filter(c => c.pid === 'p00');
  if (width === 120) assert.ok(first.length >= 6 && first.length <= 7, `expected >=6 compact cells, got ${first.length}`);
  if (width === 80) assert.ok(first.length >= 4, `expected >=4 compact cells, got ${first.length}`);
  assert.match(lines[point(p, first[0]).y], new RegExp(`\\+${7 - first.length}\\s*$`), 'overflow count must be physically painted');
  assert.equal(actionY, detailY + 1, 'detail is one compact line, not a wrapped paragraph');
  const keys = d.actionSlots.filter(s => s.actionIndex !== null).map(s => s.key);
  for (const id of ['favorite', 'edit', 'inspect', 'default', 'move-left', 'move-right', 'add-model', 'remove', 'new-provider', 'archives', 'undo', 'locate']) {
    // Stable templates use a semantic alias for edit/remove in some versions.
    assert.ok(keys.some(key => key === id || (id === 'edit' && key === 'edit-model') || (id === 'remove' && key === 'remove-model')), `missing first-layer ${id}: ${keys}`);
  }
  for (const slot of slots) assert.ok(slot.y >= actionY && slot.y < lines.length - 1, `${slot.key} must remain physically visible`);
  expectCandidate(p, 'p00', 'm0'); noEffects(p);
});

for (const [width, height] of [[80, 24], [120, 44]]) test(`HOME absolute action Y is stable through left-arm/markers/palette feedback at ${width}x${height}`, async t => {
  const p = await open(t, { terminalColumns: width, terminalRows: height });
  const physical = () => {
    const { lines, detailY, slots } = rail(p);
    return { rows: lines.length, detailY, slots };
  };
  const model = physical();
  p.send('left'); assert.deepEqual(physical(), model, 'first deliberate Left feedback must not move the dock');
  p.send('right'); expectCandidate(p, 'p00', 'm1'); assert.deepEqual(physical(), model);
  p.send('\x1b1'); assert.deepEqual(physical(), model, 'favorite caption/host feedback keeps absolute geometry');
  p.send('\x1bd'); assert.equal(json(p, 'settings.json').defaultModel, 'm1'); assert.deepEqual(physical(), model, 'default feedback keeps absolute geometry');
  p.send('\x1bt'); assert.match(p.screen(), /配色/); assert.deepEqual(physical(), model, 'palette message cannot consume a provider row');
  p.send('left'); p.send('left'); assert.deepEqual(physical(), model, 'armed hint after feedback keeps absolute geometry');
  p.send('left'); assert.ok(!p.debug().actionSlots.some(s => s.key === 'favorite'), 'second boundary Left changes to provider template');
  const provider = physical(); // Different template has its own dock allocation.
  p.send('\x1bt'); assert.deepEqual(physical(), provider, 'provider palette feedback keeps provider dock fixed');
  p.send('tab'); assert.equal(p.debug().actionMode, true); assert.deepEqual(physical(), provider, 'provider action focus does not add a row');
  assert.equal(p.calls.length, 0); assert.equal(p.selections.length, 0); assert.equal(p.current().id, 'm0');
});

test('HOME provider paging and wheel keep header/query/details/actions fixed without retargeting', async t => {
  const p = await open(t); const before = rail(p), initial = candidate(p);
  p.send('pgdn'); const after = rail(p); assert.ok(viewport(p).top > 0);
  assert.deepEqual(after.lines.slice(0, 4), before.lines.slice(0, 4)); assert.deepEqual(after.slots, before.slots);
  assert.equal(after.detailY, before.detailY); assert.equal(after.lines[after.detailY], before.lines[before.detailY]);
  assert.ok(!p.debug().matrixCells.some(c => c.pid === 'p00'), 'offscreen rows must not have mouse geometry');
  const top = viewport(p).top;
  p.component.handleMouse({ type: 'wheel', wheelDelta: -1, x: 5, y: 5, shift: false, alt: false, ctrl: false }); p.lines();
  assert.ok(viewport(p).top < top); assert.deepEqual(rail(p).slots, before.slots);
  p.send('pgup'); expectCandidate(p, initial.pid, initial.mid);
  p.send('pgdn'); p.send('tab'); assert.equal(p.debug().actionMode, true);
  assert.ok(p.debug().matrixCells.some(c => c.pid === initial.pid && c.mid === initial.mid), 'entering actions reveals selected provider');
  assert.match(rail(p).lines[rail(p).detailY], new RegExp(`操作 模型 ${initial.pid}/${initial.mid}`));
  p.send('backTab'); expectCandidate(p, initial.pid, initial.mid);
  noEffects(p);
});

for (const steps of [0, 11, 21]) test(`HOME keyboard reveals provider ${steps}, including first/middle/last, without effects`, async t => {
  const p = await open(t); for (let i = 0; i < steps; i++) p.send('down');
  expectCandidate(p, `p${String(steps).padStart(2, '0')}`, 'm0');
  if (steps === 21) { assert.ok(viewport(p).top > 0); p.send('down'); expectCandidate(p, 'p00', 'm0'); }
  noEffects(p);
});

for (const width of [80, 120, 160]) test(`row-local window exposes every model, seventh/last, with honest +N and ‹ indicators at ${width}`, async t => {
  const p = await open(t, { terminalColumns: width }); const initial = p.debug().matrixCells.filter(c => c.pid === 'p00');
  assert.ok(initial.length < 7); assert.match(p.lines()[point(p, initial[0]).y], new RegExp(`\\+${7 - initial.length}\\s*$`));
  for (let i = 1; i < 7; i++) { p.send('right'); expectCandidate(p, 'p00', `m${i}`); }
  let selected = expectCandidate(p, 'p00', 'm6'); assert.match(p.lines()[point(p, selected).y], /‹/);
  assert.ok(p.debug().matrixCells.filter(c => c.pid === 'p00').length >= (width === 80 ? 4 : 6), 'seventh selection keeps the maximal compact segment, not one lone cell');
  for (let i = 0; i < 3; i++) p.send('down'); // ordinal clamped by the one-model second provider
  for (let i = 0; i < 12; i++) p.send('right'); selected = expectCandidate(p, 'p03', 'm8');
  assert.match(p.lines()[point(p, selected).y], /‹/); assert.doesNotMatch(p.lines()[point(p, selected).y], /\+\d+\s*$/);
  for (let i = 7; i >= 0; i--) { p.send('left'); expectCandidate(p, 'p03', `m${i}`); }
  assert.doesNotMatch(p.lines()[point(p, candidate(p)).y], /‹/); noEffects(p);
});

test('marker changes keep cell origins/widths stable and preserve distinguishing name suffixes', async t => {
  const p = await open(t); const before = p.debug().matrixCells.filter(c => c.pid === 'p00').map(c => ({ ...c }));
  const first = before[0]; assert.match(cellText(p, first), /›/); assert.match(cellText(p, first), /★/);
  // Compact middle ellipsis should retain at least the identifying numeric suffix.
  for (const cell of before) assert.match(cellText(p, cell), new RegExp(`${cell.mid.slice(1)}[★◆ ]*$`));
  p.send('right'); p.send('\x1b1'); p.send('\x1bd');
  assert.deepEqual(p.debug().matrixCells.filter(c => c.pid === 'p00').map(c => ({ ...c })), before);
  expectCandidate(p, 'p00', 'm1'); assert.deepEqual(p.current().id, 'm0');
  assert.equal(json(p, 'settings.json').defaultModel, 'm1'); assert.ok(json(p, 'model-pick-favorites.json').includes('p00/m1'));
  assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('current/favorite/candidate/default colors retain original precedence without shifting cells', async t => {
  const p = await open(t, { fixtureFiles: { 'model-pick-theme.json': { theme: 'sakura' }, 'model-pick-favorites.json': ['p00/m0'] } });
  const cell = id => p.debug().matrixCells.find(c => c.pid === 'p00' && c.mid === id);
  const geometry = () => p.debug().matrixCells.filter(c => c.pid === 'p00').map(c => ({ ...c }));
  const before = geometry();
  assert.deepEqual(cellColor(p, cell('m0')), [232, 93, 158], 'current beats favorite and candidate');
  p.send('right'); assert.deepEqual(cellColor(p, cell('m1')), [127, 196, 232], 'candidate uses selection color');
  p.send('\x1b1'); p.send('\x1bd'); assert.deepEqual(cellColor(p, cell('m1')), [199, 184, 245], 'favorite beats candidate and default');
  p.send('right'); p.send('\x1bd'); assert.deepEqual(cellColor(p, cell('m2')), [127, 196, 232], 'candidate beats default');
  p.send('right'); assert.deepEqual(cellColor(p, cell('m2')), [242, 167, 198], 'unselected default remains distinct');
  assert.deepEqual(geometry(), before); assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('representative HOME Fast is trailing/current-only, with live callback scope and unchanged current/default', async t => {
  let tier = 'off'; const calls = [];
  const fastController = {
    snapshot: ctx => ({ supported: true, tier, active: tier !== 'off', ultrafastEnabled: false, modelLabel: `${ctx.model.provider}/${ctx.model.id}` }),
    describe: () => 'synthetic session policy', subscribe: () => () => {},
    setTier(next, ctx) { calls.push([next, ctx.model.provider, ctx.model.id]); tier = next; },
  };
  const p = await open(t, { fastController }); const settings = json(p, 'settings.json');
  const shape = () => p.debug().actionSlots.map(s => ({ key: s.key, x: s.x, y: s.y, width: s.width }));
  const before = shape(), fast = p.debug().actionSlots.at(-1); assert.equal(fast.key, 'fast'); assert.notEqual(fast.actionIndex, null);
  p.action('fast'); assert.deepEqual(calls, [['priority', 'p00', 'm0']]); assert.match(p.screen(), /关闭会话 Fast/);
  p.send('tab'); p.send('right'); expectCandidate(p, 'p00', 'm1');
  assert.equal(p.debug().actionSlots.at(-1).actionIndex, null); assert.deepEqual(shape(), before);
  assert.doesNotMatch(p.screen(), /开启会话 Fast|关闭会话 Fast/); assert.equal(p.selections.length, 0);
  assert.deepEqual(json(p, 'settings.json'), settings); assert.equal(p.current().id, 'm0'); assert.equal(p.calls.length, 0);
});

test('physical model/action mouse hits use the right origin after provider scrolling', async t => {
  const p = await open(t); p.send('up'); const selected = expectCandidate(p, 'p21', 'm0'); assert.ok(viewport(p).top > 0);
  const other = p.debug().matrixCells.find(c => c.pid === 'p21' && c.mid === 'm1'); assert.ok(other); assert.ok(click(p, other)?.handled);
  expectCandidate(p, 'p21', 'm1'); assert.equal(p.debug().actionMode, false);
  const slot = p.debug().actionSlots.find(s => s.key === 'favorite'), rect = p.debug().actionRects.find(r => r.index === slot.actionIndex);
  const pt = point(p, rect); assert.match(columns(p.lines()[pt.y], pt.x, rect.width), /收藏/);
  assert.ok(click(p, rect)?.handled); assert.equal(p.debug().actionMode, true);
  assert.ok(json(p, 'model-pick-favorites.json').includes('p21/m1'), 'fixed-bottom physical hit must affect the displayed candidate');
  assert.deepEqual(p.current().id, 'm0'); assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('object/action Tab and ShiftTab keep the target; action arrows do not select another model', async t => {
  const p = await open(t); p.send('down'); const before = candidate(p), favorites = json(p, 'model-pick-favorites.json');
  p.send('tab'); assert.equal(p.debug().actionMode, true);
  for (const k of ['right', 'down', 'left', 'up', 'right']) p.send(k);
  p.send('backTab'); assert.equal(p.debug().actionMode, false); expectCandidate(p, before.pid, before.mid);
  assert.deepEqual(json(p, 'model-pick-favorites.json'), favorites); noEffects(p);
});

test('action focus paints exactly one active cursor; matrix anchor/current remain non-active and target stays fixed', async t => {
  const p = await open(t); const target = candidate(p), favorites = json(p, 'model-pick-favorites.json');
  p.send('tab'); p.send('right'); assert.equal(p.debug().selectedAction, 'favorite');
  for (const key of ['down', 'left', 'up', 'right']) p.send(key);
  const { lines, detailY } = rail(p), matrixLines = lines.slice(4, detailY - 1);
  assert.ok(matrixLines.every(line => !/[›▸]/u.test(line)), 'action focus suppresses both matrix navigation cursors');
  assert.ok(matrixLines.some(line => line.includes('●')), 'current model marker remains visible');
  assert.equal((lines.slice(4).join('\n').match(/›/gu) ?? []).length, 1, 'only focused action owns the active arrow (native query prompt is static)');
  const slot = p.debug().actionSlots.find(s => s.key === 'favorite');
  const rect = p.debug().actionRects.find(r => r.index === slot.actionIndex);
  click(p, rect); const after = json(p, 'model-pick-favorites.json');
  assert.equal(after.includes(`${target.pid}/${target.mid}`), !favorites.includes(`${target.pid}/${target.mid}`));
  p.send('backTab'); expectCandidate(p, target.pid, target.mid); assert.equal(p.current().id, 'm0'); assert.equal(p.selections.length, 0);
});

test('native typing/IME/paste filter and first arrow immediately navigates, Enter switches exact candidate', async t => {
  const p = await open(t); p.send('p0'); const first = candidate(p); assert.ok(first);
  p.send('down'); const second = candidate(p); assert.notEqual(second.pid, first.pid);
  // Pi's newer fuzzy scorer can match p21 across p02 + a model suffix and
  // retain that still-valid candidate. Use this provider's unique display label
  // to test IME/paste/navigation, not an unrelated fuzzy-ranking assumption.
  p.send('clear'); p.send('\x1b[200~终点\x1b[201~'); const pasted = candidate(p); assert.equal(pasted.pid, 'p21');
  p.send('right'); const target = candidate(p); assert.equal(target.pid, 'p21'); assert.notEqual(target.mid, pasted.mid);
  p.send('enter'); await p.finished;
  assert.deepEqual(p.selections.map(m => [m.provider, m.id]), [[target.pid, target.mid]]); assert.equal(p.calls.length, 0);
});

test('filtered/zero/empty catalogs keep the native search and distinguish no match from no configuration', async t => {
  const p = await open(t); p.send('北辰'); assert.deepEqual([...new Set(p.debug().matrixCells.map(c => c.pid))], ['p00']);
  p.replace('zzzzzzzz-no-synthetic-match'); assert.match(p.screen(), /没有匹配/); assert.equal(p.debug().matrixCells.length, 0);
  for (const k of ['up', 'down', 'left', 'right', 'enter']) p.send(k);
  assert.equal(p.selections.length, 0); assert.doesNotMatch(p.screen(), /还没有供应商/); p.send('clear'); expectCandidate(p, 'p00', 'm0'); noEffects(p);
  const empty = await open(t, { config: { providers: {} } }); assert.match(empty.screen(), /还没有供应商|暂无供应商/);
  empty.action('new-provider'); assert.equal(empty.debug().view, 'connection'); empty.send('cancel'); assert.equal(empty.debug().view, 'matrix');
  const config = homeConfig(); config.providers.p00.models = [];
  const zeroModels = await open(t, { config }); assert.match(zeroModels.screen(), /添加模型/); assert.ok(!zeroModels.debug().matrixCells.some(c => c.pid === 'p00'));
  zeroModels.send('right'); zeroModels.send('enter'); assert.equal(zeroModels.selections.length, 0);
});

test('render/search/navigation/resize on representative HOME do no FS, decrypt, registry or network work', async t => {
  const p = await open(t);
  const counts = () => ({ reads: p.reads.length, opens: p.protection.state.opens.length, seals: p.protection.state.seals.length, catalog: p.catalogCalls(), refresh: p.refreshes.length, auth: p.authCalls() });
  const before = counts();
  for (const width of [80, 120, 160]) p.lines(width);
  p.type('p'); p.send('up'); p.send('right'); p.send('pgdn'); p.send('pgup'); p.send('clear');
  assert.deepEqual(counts(), before); noEffects(p);
});

test('edit return retains query, provider viewport, object and semantic action across resize', async t => {
  const p = await open(t); p.type('p');
  for (let i = 0; i < 22 && viewport(p).top === 0; i++) p.send('down');
  const target = candidate(p), top = viewport(p).top; assert.ok(top > 0);
  p.action('edit-model'); assert.equal(p.debug().view, 'edit');
  p.send('esc'); assert.equal(p.debug().view, 'matrix'); const before = viewport(p).top;
  assert.equal(before, top); assert.equal(p.debug().actionMode, true); assert.equal(p.debug().selectedAction, 'edit-model');
  for (const width of [80, 160, 120]) { p.lines(width); assert.equal(p.debug().selectedAction, 'edit-model'); assert.equal(p.lines()[2].trim().replace(/^› /u, ''), 'p'); }
  p.send('tab'); expectCandidate(p, target.pid, target.mid); noEffects(p);
});

test('narrow/tiny HOME is honest fail-closed, not hidden active geometry', async t => {
  for (const width of [1, 2, 8, 20, 27]) {
    const p = await open(t, { terminalColumns: width }); const lines = p.lines();
    assert.ok(lines.every(line => tui.visibleWidth(line) < width)); assert.equal(p.debug().ready, false);
    assert.equal(p.debug().matrixCells.length, 0); assert.equal(p.debug().actionRects.length, 0);
    p.send('\x1b1'); p.send('enter'); assert.deepEqual(json(p, 'model-pick-favorites.json'), [...homeFavorites]); noEffects(p);
  }
  const p = await open(t, { terminalRows: 6 }); assert.ok(p.lines().length <= 6); assert.equal(p.debug().ready, false);
  p.send('\x1bd'); p.send('enter'); assert.equal(json(p, 'settings.json').defaultProvider, homeDefault.provider); noEffects(p);
});
