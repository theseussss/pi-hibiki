import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { harness, baseConfig, tui, paint, plain, enterManualIds } from './model-pick-ui-harness.mjs';
import { loadTypeScript } from './model-pick-loader.mjs';

const source = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/presentation.ts', import.meta.url)), { '@earendil-works/pi-tui': tui });
const fastApi = loadTypeScript(fileURLToPath(new URL('../lib/fast.ts', import.meta.url)));
function fastController() {
  return { snapshot: ctx => ({ supported: fastApi.supportsFastMode(ctx.model), tier: 'off', active: false, ultrafastEnabled: false, modelLabel: `${ctx.model?.provider}/${ctx.model?.id}` }),
    describe: ctx => `当前模型 ${ctx.model?.id}`, subscribe: () => () => {}, setTier: () => { throw new Error('presentation must not change tier'); } };
}

test('one compact footer and stable visible object actions replace the menu in both focus modes', async t => {
  const p = await harness(t); const before = p.config();
  for (const width of [32, 40, 80, 120, 180]) {
    const lines = p.lines(width);
    assert.ok(lines.some(line => /^\s*─+$/.test(line)));
    assert.equal((lines.join('\n').match(/Tab 换区域/g) ?? []).length, 1);
    assert.doesNotMatch(lines.join('\n'), /Tab 收藏|Alt\+M 菜单|更多…/);
    const content = p.readContent(); assert.match(content, /收藏 \[1\]/); assert.match(content, /前移 \[5\]/); assert.match(content, /后移 \[6\]/);
    assert.ok(lines.every(line => tui.visibleWidth(line) < width));
  }
  p.send('left'); p.send('left');
  assert.equal(p.debug().actionSlots.find(s => s.key === 'favorite'), undefined);
  assert.match(p.readContent(), /编辑连接 \[2\]/); assert.match(p.readContent(), /上移 \[5\]/);
  p.send('\x1bh'); assert.equal(p.debug().view, 'help'); p.send('esc');
  assert.deepEqual(p.config(), before); assert.equal(p.calls.length, 0);
});

test('Fast never labels arbitrary candidates; contextual entry requires current supported channel', async t => {
  for (const provider of ['maoapi-gpt', 'anthropic']) {
    const config = baseConfig(); config.providers[provider] = { ...config.providers.p00, models: [{ ...config.providers.p00.models[0], id: provider === 'anthropic' ? 'claude-sonnet' : 'gpt-6.1-terra' }] };
    const p = await harness(t, { config, fastController: fastController() }); p.setCurrent(provider, config.providers[provider].models[0].id);
    assert.doesNotMatch(p.screen(), /Fast/); p.send('menu'); assert.doesNotMatch(p.screen(), /Fast/);
    assert.equal(p.debug().actionSlots.find(s => s.key === 'fast')?.actionIndex, null);
    assert.equal(p.selections.length, 0);
  }
  const config = baseConfig(); config.providers['clf-responses'] = { ...config.providers.p00, api: 'openai-responses', models: [{ ...config.providers.p00.models[0], id: 'gpt-6-astra' }] };
  const p = await harness(t, { config, fastController: fastController() }); p.setCurrent('clf-responses', 'gpt-6-astra');
  assert.doesNotMatch(p.screen(), /Fast/); p.send('menu'); assert.doesNotMatch(p.screen(), /Fast/);
  assert.equal(p.debug().actionSlots.find(s => s.key === 'fast')?.actionIndex, null);
  p.send('esc'); p.type('gpt-6-astra'); p.send('down'); p.send('menu');
  assert.notEqual(p.debug().actionSlots.find(s => s.key === 'fast')?.actionIndex, null);
  assert.match(p.readContent(), /开启会话 Fast/);
});

test('scrollable consent reads all wrapped content before executing, including after a resize', () => {
  let paid = 0, viewport = { width: 42, height: 12 };
  const sheet = new source.ReviewSheet({ stage: '02 确认检查', title: '模型', sections: [{ title: '请求范围与费用', lines: ['目标 https://example.invalid/' + 'route/'.repeat(24), '可能计费 · 最多9次请求 · 576输出token', '检查90秒 · 无重试', '合成内容，不发送当前对话'] }] }, paint,
    [{ label: '开始检查', requiresReview: true, run: () => paid++ }], () => {}, () => {}, () => viewport);
  sheet.handleInput('\r'); assert.equal(paid, 0);
  let frame = sheet.render(42, 12).map(plain).join('\n'); assert.match(frame, /未读完/);
  sheet.handleInput('\r'); assert.equal(paid, 0);
  for (let i = 0; i < 40; i++) { sheet.handleInput('\x1b[6~'); frame = sheet.render(42, 12).map(plain).join('\n'); }
  sheet.handleInput('\r'); assert.equal(paid, 1);
  viewport = { width: 32, height: 12 }; sheet.handleInput('\r'); assert.equal(paid, 1);
  sheet.render(32, 12); sheet.handleInput('\r'); assert.equal(paid, 1);
});

test('fullscreen input routing leaves left/right paging available until all consent content has been read', t => {
  let input, paid = 0; const terminal = { columns: 42, rows: 16, write() {}, hideCursor() {}, showCursor() {}, start(fn) { input = fn; }, stop() {} };
  const native = new tui.TuiAltScreen(terminal); native.requestRender = () => {};
  const sheet = new source.ReviewSheet({ stage: '02 确认检查', title: '合成模型', sections: [{ title: '请求范围与费用', lines: Array.from({ length: 18 }, (_, i) => `说明 ${i + 1} · 可能计费 · 合成内容`) }] }, paint,
    [{ label: '开始检查', requiresReview: true, run: () => paid++ }], () => {}, () => {}, () => ({ width: 42, height: 16 }));
  const component = { render: width => sheet.render(width, 16), invalidate() {}, handleInput: data => sheet.handleInput(data) };
  native.addChild(component); native.setFocus(component); native.start(); t.after(() => native.stop());
  component.render(42); input('\r'); assert.equal(paid, 0);
  // Feed raw keys through the real fullscreen host, not directly to the sheet.
  for (let i = 0; i < 30; i++) { input('\x1b[C'); component.render(42); }
  input('\r'); assert.equal(paid, 1);
});

test('truly short narrow HOME fails closed without a hidden menu; scrollable help remains reachable', async t => {
  const p = await harness(t, { terminalRows: 12 });
  const screen = p.screen(32); assert.match(screen, /窗口太小|请放大|请扩大/); assert.ok(p.lines(32).length <= 12);
  assert.ok((screen.match(/Tab 换区域/g) ?? []).length <= 1); assert.equal(p.debug().ready, false);
  assert.equal(p.debug().actionRects.length, 0); assert.equal(p.debug().matrixCells.length, 0);
  p.send('\x1b1'); assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
  p.send('\x1bh'); assert.equal(p.debug().view, 'help');
  assert.match(p.readContent(), /任务|矩阵/);
  for (let i=0; i<30; i++) p.send('down');
  assert.match(p.screen(32), /任务|Ctrl\+C|返回/);
});

test('progress shows completed, active and pending items; report groups values and sources', async t => {
  let release; const paused = new Promise(resolve => { release = resolve; });
  const p = await harness(t, { fetcher: async (_url, options) => JSON.parse(options.body).stream ? paused : new Response(JSON.stringify({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] })) });
  p.send('\x1bn'); enterManualIds(p, 'synthetic-model'); p.send('save'); p.select('run'); await p.flush();
  const progress = p.readContent(); assert.equal(p.debug().view, 'progress'); assert.match(progress, /text.*通过/); assert.match(progress, /stream.*正在检查/); assert.match(progress, /tools.*等待中/);
  p.send('esc'); await p.flush(); await p.flush();
  const report = p.readContent(); assert.equal(p.debug().view, 'report'); assert.match(report, /模型报告/); assert.match(report, /上下文窗口/); assert.match(report, /能力检查/); assert.match(report, /推理|thinking/); assert.match(report, /待确认|核对/);
  release(new Response('{}')); await p.flush(); assert.equal(p.calls.length, 2);
});
