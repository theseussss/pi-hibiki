import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { harness, tui, enterManualIds } from './model-pick-ui-harness.mjs';

// Real extension/controller/native Input, closed synthetic HOME and synthetic GET.
// Every action below is driven through real keys/geometry, never private setters
// or fabricated review proofs. Integration/final-commit coverage is QA-owned.
const extra = id => ({ provider: 'p00', id, name: id, contextWindow: 64000, maxTokens: 4096, reasoning: false, input: ['text'] });
const read = async p => { p.action('read-list'); assert.equal(p.calls.length, 0); p.action('connect'); await p.waitForView('basket'); };
const basket = p => { p.action('add-model'); assert.equal(p.debug().view, 'basket'); };
const selected = p => p.readContent().match(/已选 (\d+) 个/)?.[1];

for (const width of [32, 80, 120]) {
  test(`unread empty basket has no hidden filter and explicit manual form at ${width}`, async t => {
    const p = await harness(t, { terminalColumns: width, terminalRows: 44 });
    const before = p.config(); basket(p);
    const content = p.readContent();
    assert.match(content, /尚未读取上游清单/);
    assert.doesNotMatch(content, /筛选候选ID|本家模型 0/);
    assert.equal(p.debug().selectedAction, 'read-list');
    p.type('123'); p.send('\x1b[200~paste,456\r\x1b3\x1b[201~');
    assert.equal(p.debug().view, 'basket'); assert.equal(selected(p), '0');
    assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
    enterManualIds(p, ['manual-one', 'manual-two']);
    assert.equal(p.debug().view, 'basket'); assert.equal(selected(p), '2');
    assert.equal(p.debug().selectedAction, 'manual-id');
    p.send('enter');
    assert.equal(p.debug().view, 'edit', 'second Enter opens manual again, never Next');
    assert.match(p.readContent(), /手动输入模型ID/);
    assert.deepEqual(p.config(), before); assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
    assert.equal(fs.existsSync(path.join(p.root, 'auth.json')), false);
    p.action('back'); p.send('cancel'); assert.equal(p.debug().view, 'matrix');
    basket(p); p.send('esc'); assert.equal(p.debug().view, 'matrix', 'an action-only empty basket must have a working contextual Escape');
  });

  test(`query is one raw candidate filter; Enter only moves focus at ${width}`, async t => {
    const p = await harness(t, { terminalColumns: width, terminalRows: 44, catalogEntries: [extra('alpha'), extra('beta'), extra('123')] });
    const before = p.config(); basket(p); p.type('alpha');
    assert.match(p.readContent(), /筛选候选ID · 1\/3/);
    p.send('enter'); assert.equal(p.debug().zone, 'candidates'); assert.equal(selected(p), '0');
    p.send('enter'); assert.equal(selected(p), '1');
    p.send('up'); p.send('clear'); p.type('no-match');
    assert.match(p.readContent(), /筛选候选ID · 0\/3/);
    assert.match(p.readContent(), /没有匹配的候选ID/);
    p.send('enter'); assert.equal(p.debug().zone, 'query'); assert.equal(selected(p), '1');
    p.send('clear'); p.send('\x1b[200~123\x1b[201~');
    assert.match(p.readContent(), /筛选候选ID · 1\/3/);
    assert.equal(selected(p), '1');
    p.send('enter'); assert.equal(selected(p), '1'); p.send('enter'); assert.equal(selected(p), '2');
    assert.deepEqual(p.config(), before); assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
  });
}

test('manual validation is atomic for empty/invalid/existing/duplicate IDs and preserves parent query on Back/join', async t => {
  const p = await harness(t, { catalogEntries: [extra('alpha'), extra('beta')], terminalRows: 44 });
  const before = p.config(); basket(p); p.type('alpha'); p.send('down');
  const parent = p.debug(); p.action('manual-id');
  for (const value of ['', 'valid,../invalid', 'valid,m0', 'dup,dup', 'valid,', 'constructor', Array.from({ length: 101 }, (_, i) => 'id' + i).join(',')]) {
    p.replace(value); p.action('add-ids');
    assert.equal(p.debug().view, 'edit'); assert.match(p.readContent(), /本次未加入/);
    assert.deepEqual(p.config(), before); assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
  }
  p.action('back'); assert.equal(selected(p), '0'); assert.equal(p.debug().candidateIndex, parent.candidateIndex);
  assert.match(p.readContent(), /筛选候选ID · 1\/2/);
  p.action('manual-id'); p.type('manual-a,manual-b'); p.action('add-ids');
  assert.equal(selected(p), '2'); assert.match(p.readContent(), /筛选候选ID · 1\/2/);
  assert.equal(p.debug().selectedAction, 'manual-id');
  assert.deepEqual(p.config(), before); assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
});

for (const [name, ids, text] of [
  ['upstream-empty', [], /上游返回空清单（0 个 ID）/],
  ['all-already-added', ['m0'], /上游返回 1 个 ID，均已配置/],
  ['loaded-available', ['m0', 'alpha', 'beta'], /上游 3 个 ID · 已配置 1 · 可添加 2/],
]) test(`read state distinguishes ${name} only after consent`, async t => {
  const p = await harness(t, { terminalRows: 44, fetcher: (_url, options) => {
    assert.equal(options.method, 'GET'); return Response.json({ data: ids.map(id => ({ id })) });
  } });
  const before = p.config(); basket(p);
  assert.equal(p.authCalls(), 0); await read(p);
  assert.equal(p.calls.length, 1); assert.equal(p.authCalls(), 1);
  assert.match(p.readContent(), text);
  if (ids.length <= 1) assert.doesNotMatch(p.readContent(), /筛选候选ID/);
  else {
    assert.match(p.readContent(), /筛选候选ID · 2\/2/);
    // Return to query with ordinary controls, then show the full-count denominator.
    while (p.debug().actionMode || p.debug().zone !== 'query') p.send('tab');
    p.type('absent'); assert.match(p.readContent(), /筛选候选ID · 0\/2/);
  }
  assert.deepEqual(p.config(), before);
});

test('failed read retains same-connection local candidates and manual draft, retry can succeed', async t => {
  let fail = true;
  const p = await harness(t, { terminalRows: 44, catalogEntries: [extra('local')], fetcher: () => fail ? new Response('', { status: 429 }) : Response.json({ data: [] }) });
  const before = p.config(); basket(p); enterManualIds(p, 'manual');
  await read(p); assert.match(p.readContent(), /读取未完成/);
  assert.match(p.readContent(), /筛选候选ID · 1\/1/); assert.equal(selected(p), '1');
  fail = false; p.action('read-list'); p.action('connect'); await p.waitForView('basket');
  assert.match(p.readContent(), /上游返回空清单/); assert.equal(selected(p), '1');
  assert.equal(p.calls.length, 2); assert.deepEqual(p.config(), before);
});

test('mouse hits the explicit manual action and joining requires its own second input event', async t => {
  const p = await harness(t, { terminalColumns: 120, terminalRows: 44 }); basket(p);
  const lines = p.lines(), y = lines.findIndex(line => line.includes('手动输入ID'));
  assert.ok(y >= 0); const x = tui.visibleWidth(lines[y].slice(0, lines[y].indexOf('手动输入ID')));
  assert.equal(p.component.handleMouse({ type: 'click', button: 'left', x, y, shift: false, alt: false, ctrl: false })?.handled, true);
  p.raw(); assert.equal(p.debug().view, 'edit');
  p.type('mouse-manual'); p.send('enter'); assert.equal(p.debug().view, 'edit');
  p.send('enter'); assert.equal(p.debug().view, 'basket'); assert.equal(selected(p), '1');
  assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
});
