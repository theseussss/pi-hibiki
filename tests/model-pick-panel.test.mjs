import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { harness, baseConfig, fakeSecret, password, seedLegacy, tui } from './model-pick-ui-harness.mjs';

const recorded = (p) => p.protection.open(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-data/records.auto.json'), 'utf8')).sealed, 'records').events;

test('Alt+M opens contextual actions and Esc preserves search, grid and current model', async (t) => {
  const p = await harness(t);
  p.type('p0'); p.send('down');
  const original = p.screen();
  p.send('menu');
  assert.match(p.screen(), / B \/ m1/);
  assert.match(p.screen(), /更多…/);
  p.send('esc');
  assert.equal(p.screen(), original);
  assert.equal(p.selections.length, 0); assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0);
  assert.ok(p.refreshes.every((o) => o.allowNetwork === false));
});

test('empty matrix still permits global actions and cancelled provider form has no side effects', async (t) => {
  const p = await harness(t, { config: { providers: {} } });
  assert.match(p.screen(), /暂无供应商/);
  p.send('menu'); p.select('添加供应商…');
  assert.match(p.screen(), /添加供应商/); assert.match(p.screen(), /名称:/);
  p.type('cancelled-provider'); p.send('esc'); p.send('esc');
  assert.deepEqual(p.config(), { providers: {} });
  assert.equal(p.calls.length, 0);
});

test('/models manage enters the same panel, without selecting or switching', async (t) => {
  const p = await harness(t, { args: 'manage' });
  assert.match(p.screen(), /更多…/);
  p.send('esc'); assert.match(p.screen(), /Hibiki · 模型工作台/);
  assert.equal(p.selections.length, 0);
});

test('provider add uses env reference, encrypted history, and keeps active search unchanged', async (t) => {
  const p = await harness(t);
  p.type('m0'); p.send('left'); p.send('left'); p.send('menu'); p.select('添加供应商…');
  p.type('new-channel'); p.send('tab'); p.type('https://new.test/v1');
  p.send('tab'); p.send('tab'); p.type('SYNTHETIC_NEW_KEY'); p.send('save');
  assert.ok(!p.config().providers['new-channel']);
  p.type('new-first-model'); p.send('enter'); assert.ok(!p.config().providers['new-channel']); p.send('save');
  await p.settled();
  assert.match(p.screen(), /供应商及模型已添加/);
  assert.match(p.screen(), /Hibiki · 模型工作台/);
  assert.match(p.screen(), /› m0/);
  assert.equal(p.config().providers['new-channel'].apiKey, '$SYNTHETIC_NEW_KEY');
  assert.deepEqual(p.config().futureRoot, { keep: true });
  assert.equal(p.calls.length, 0); assert.equal(p.authCalls(), 0);
  const vault = fs.readFileSync(path.join(p.root, 'model-pick-data/vault.auto.json'), 'utf8');
  assert.ok(!vault.includes(fakeSecret)); assert.ok(!vault.includes(password));
  assert.equal(fs.statSync(path.join(p.root, 'model-pick-data/vault.auto.json')).mode & 0o777, 0o600);
  p.send('backspace'); p.send('backspace');
  assert.match(p.screen(), /new-channel/);
  assert.equal(p.config().providers['new-channel'].models[0].id, 'new-first-model');
});

test('model add fills parameters, records fallback provenance and returns to its supplier row', async (t) => {
  const p = await harness(t);
  p.send('down'); p.send('menu'); p.select('添加模型…');
  p.type('new-model'); p.send('enter'); p.send('down');
  assert.match(p.screen(), /规格待确认/);
  p.select('参数 · new-model');
  assert.match(p.screen(), /上下文窗口/);
  p.replace('新增模型'); p.send('tab'); p.replace('4096'); p.send('tab'); p.replace('1024');
  p.send('save'); assert.match(p.screen(), /4096 \/ 1024/); p.send('save'); await p.settled();
  assert.match(p.screen(), /模型已添加/);
  assert.match(p.screen(), /Hibiki · 模型工作台/);
  const m = p.config().providers.p01.models.find((item) => item.id === 'new-model');
  assert.equal(m.contextWindow, 4096); assert.equal(m.maxTokens, 1024); assert.equal(m.name, '新增模型');
  assert.equal(p.config().providers.p00.models[0].advanced.untouched, true);
  assert.equal(p.selections.length, 0);
  assert.ok(!fs.readFileSync(path.join(p.root, 'model-pick-data/records.auto.json'), 'utf8').includes('new-model'));
  const resolution = recorded(p).find((e) => e.kind === 'resolution' && e.modelId === 'new-model');
  assert.equal(resolution.provenance.contextWindow.source, 'default');
  assert.equal(resolution.fields.contextWindow, 4096); assert.equal(resolution.fields.maxTokens, 1024);
});

test('current/default model archive is blocked, not silently switched or deleted', async (t) => {
  const p = await harness(t); const before = p.config();
  p.send('menu'); p.select('移除模型…');
  assert.match(p.screen(), /当前模型.*默认模型/);
  assert.ok(!p.screen().includes('主密码'));
  assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0);
});

test('model archive and restore happen within the matrix and preserve favorite/order metadata', async (t) => {
  const p = await harness(t);
  p.send('down'); p.send('menu'); p.select('移除模型…'); p.select('确认移除');
  await p.settled();
  assert.match(p.screen(), /已移除/);
  assert.equal(p.config().providers.p01.models.length, 0);
  p.send('menu'); p.select('已移除的项目…');
  p.select('模型 · p01 / m1'); p.send('save'); await p.flush();
  assert.match(p.screen(), /已恢复到模型列表/);
  assert.equal(p.config().providers.p01.models[0].id, 'm1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-favorites.json'))), ['p01/m1']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-order.json'))).models.p01, ['m1']);
});

test('native model is inspectable but not replaced by an editable custom config', async (t) => {
  const p = await harness(t, { includeNative: true });
  p.send('up'); p.send('menu'); p.select('查看模型参数…');
  assert.match(p.screen(), /只读/); assert.match(p.screen(), /由 Pi 或扩展管理/);
  assert.ok(!p.config().providers['native-provider']);
  assert.equal(p.calls.length, 0);
});

test('maintenance has no lock/unlock task or master-password input; cancellation creates no private store', async (t) => {
  const p = await harness(t);
  p.send('menu'); p.select('更多…');
  for (const width of [32, 60, 80, 180]) {
    assert.doesNotMatch(p.screen(width), /主密码|解锁|锁定安全存档|再次输入/);
    assert.ok(!p.raw(width).includes(fakeSecret));
    assert.ok(p.lines(width).every((line) => tui.visibleWidth(line) < width));
    assert.ok(p.lines(width).length <= 24);
  }
  p.send('esc'); p.send('esc');
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data')));
});

test('probe cancellation before consent resolves no credentials and sends no request', async (t) => {
  const p = await harness(t);
  p.send('menu'); p.select('测试连接…');
  assert.match(p.screen(), /example.test/);
  p.send('esc');
  assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0);
});

test('explicit bounded text test saves only encrypted evidence, not model metadata or raw response', async (t) => {
  const p = await harness(t); const before = p.config();
  p.send('menu'); p.select('测试连接…'); p.select('确认文本测试');
  await p.settled(); await p.flush();
  assert.match(p.screen(), /连接检查/);
  assert.match(p.screen(), /文本连通性通过/);
  assert.equal(p.calls.length, 1); assert.equal(p.authCalls(), 1);
  assert.equal(JSON.parse(p.calls[0][1].body).max_tokens, 32);
  assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0);
  assert.ok(!p.screen().includes(fakeSecret));
  const ledger = fs.readFileSync(path.join(p.root, 'model-pick-data/records.auto.json'), 'utf8');
  assert.ok(!ledger.includes(fakeSecret)); assert.ok(!ledger.includes('MODEL_PICK_OK'));
  const events = p.protection.open(JSON.parse(ledger).sealed, 'records').events;
  assert.deepEqual(events.map((e) => e.kind), ['probe-start', 'probe']);
  assert.equal(events[0].attemptId, events[1].attemptId);
  assert.deepEqual(events[1].report.verifiedFields, []); assert.deepEqual(events[1].report.fields, {});
  assert.ok(!JSON.stringify(events).includes(fakeSecret)); assert.ok(!JSON.stringify(events).includes('MODEL_PICK_OK'));
});

test('invalid model numeric values stay in the form, with no config write', async (t) => {
  const p = await harness(t); const before = p.config();
  p.send('menu'); p.select('编辑模型…');
  p.send('tab'); p.replace('1000'); p.send('tab'); p.replace('2000'); p.send('save');
  assert.match(p.screen(), /输出不能大于窗口/);
  assert.deepEqual(p.config(), before);
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data/vault.auto.json')));
});

test('Chinese display names preserve equal grid-cell widths', async (t) => {
  const config = baseConfig();
  config.providers.p01.models[0].name = '这是一个很长的中文模型显示名称需要按列宽截断';
  config.providers.p01.models.push({ ...config.providers.p01.models[0], id: 'm2', name: 'ASCII_TWO' });
  const p = await harness(t, { config });
  const row = p.lines().find((line) => line.includes('ASCII_TWO'));
  assert.match(row, /^   B\s/); assert.ok(row.includes('ASCII_TWO'));
  assert.equal(tui.visibleWidth(row.slice(0, row.indexOf('ASCII_TWO'))), 42);
});

test('editing only supplier name preserves unsupported protocol and original secret-bearing URL', async (t) => {
  const config = baseConfig();
  config.providers.p01.api = 'openai-codex-responses';
  config.providers.p01.baseUrl = 'https://example.test/v1?api_key=SYNTHETIC_URL_SECRET';
  const p = await harness(t, { config });
  p.send('down'); p.send('menu'); p.select('编辑供应商…');
  assert.ok(!p.raw().includes('SYNTHETIC_URL_SECRET'));
  p.replace('B-renamed'); p.send('save'); await p.settled();
  assert.match(p.screen(), /供应商配置已保存/);
  assert.equal(p.config().providers.p01.name, 'B-renamed');
  assert.equal(p.config().providers.p01.api, 'openai-codex-responses');
  assert.equal(p.config().providers.p01.baseUrl, config.providers.p01.baseUrl);
  assert.equal(p.config().providers.p01.apiKey, config.providers.p01.apiKey);
  assert.match(p.screen(), /▸ B-renamed/);
  p.type('B-renamed'); assert.match(p.screen(), /Hibiki · 模型工作台 \(1\/2\)/); assert.match(p.screen(), /› M1/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-favorites.json'))), ['p01/m1']);
});

test('an unready model cannot become default or be switched to', async (t) => {
  const p = await harness(t, { available: (m) => m.provider === 'p00' });
  const before = fs.readFileSync(path.join(p.root, 'settings.json'), 'utf8');
  p.send('down'); assert.match(p.screen(), /未就绪/);
  p.send('\x1bd');
  assert.match(p.screen(), /不能设为默认/);
  assert.equal(fs.readFileSync(path.join(p.root, 'settings.json'), 'utf8'), before);
  p.send('enter'); assert.equal(p.selections.length, 0);
});

test('archiving a model then moving its active neighbors preserves the archived order slot', async (t) => {
  const config = baseConfig();
  config.providers.p01.models.push({ ...config.providers.p01.models[0], id: 'm2', name: 'M2' }, { ...config.providers.p01.models[0], id: 'm3', name: 'M3' });
  const p = await harness(t, { config });
  p.send('down'); p.send('menu'); p.select('移除模型…'); p.select('确认移除'); await p.settled();
  p.send('\x1b[1;3C');
  const order = JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-order.json'), 'utf8'));
  assert.deepEqual(order.models.p01, ['m1', 'm3', 'm2']);
});

test('archived supplier keeps its row-order slot across moves, reopening and restore', async (t) => {
  const config = baseConfig(); config.providers.p02 = { ...config.providers.p01, name: 'C', models: [{ ...config.providers.p01.models[0], id: 'm2' }] };
  const p = await harness(t, { config });
  p.send('down'); p.send('left'); p.send('left'); p.send('menu'); p.select('移除供应商…'); p.select('确认移除'); await p.settled();
  p.send('\x1b[1;3A');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-order.json'))).providers, ['p02', 'p01', 'p00']);
  await p.close();
  const reopened = await harness(t, { existingHome: p.home });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-favorites.json'))), ['p01/m1']);
  reopened.send('menu'); reopened.select('已移除的项目…'); await reopened.settled();
  reopened.select('整行 · p01'); reopened.send('save'); await reopened.flush();
  assert.equal(reopened.config().providers.p01.models[0].id, 'm1');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-order.json'))).providers, ['p02', 'p01', 'p00']);
});

test('Basic credential reflection never appears even in raw ANSI candidate rendering', async (t) => {
  const payload = Buffer.from('usr:secretxy').toString('base64');
  for (const prefix of ['Basic ', ' Basic ', '\tBasic\t']) {
    const p = await harness(t, {
      authResolver: async () => ({ ok: true, headers: { authorization: `${prefix}${payload}\t` } }),
      fetcher: async () => new Response(JSON.stringify({ data: [{ id: payload }, { id: 'secretxy' }, { id: 'model-safe' }] })),
    });
    p.send('menu'); p.select('添加模型…'); p.send('backTab'); p.select('读取模型清单…'); p.select('确认读取清单'); await p.settled(); await p.flush();
    assert.match(p.screen(), /model-safe/);
    assert.ok(!p.raw().includes(payload)); assert.ok(!p.raw().includes('secretxy'));
    assert.equal(p.calls.length, 1);
  }
});

test('a failed upstream list still offers manual model entry without another request', async (t) => {
  const p = await harness(t, { fetcher: async () => new Response(fakeSecret, { status: 503 }) });
  p.send('menu'); p.select('添加模型…'); p.send('backTab'); p.select('读取模型清单…'); p.select('确认读取清单'); await p.settled(); await p.flush();
  assert.match(p.screen(), /可继续手输/); assert.ok(!p.raw().includes(fakeSecret));
  p.send('tab'); p.type('manual-model'); p.send('enter'); p.send('down');
  assert.match(p.screen(), /参数 · manual-model/); assert.match(p.screen(), /规格待确认/); assert.equal(p.calls.length, 1);
  assert.equal(p.config().providers.p00.models.length, 1);
});

test('Esc cancels a stalled credential resolver, records cancellation and rejects late requests', async (t) => {
  let release;
  const auth = new Promise((resolve) => { release = resolve; });
  const p = await harness(t, { authResolver: () => auth });
  p.send('menu'); p.select('测试连接…'); p.select('确认文本测试'); await p.settled();
  assert.match(p.screen(), /文本测试中/);
  p.send('esc'); await p.flush();
  assert.match(p.screen(), /已取消/); assert.equal(recorded(p).at(-1).report.code, 'cancelled');
  p.send('esc'); p.send('esc'); const before = p.raw();
  release({ ok: true, apiKey: fakeSecret, headers: {} }); await p.flush();
  assert.equal(p.calls.length, 0); assert.equal(p.raw(), before);
});

test('an auth resolver returning beyond the absolute deadline cannot beat the timer microtask', async (t) => {
  const clock = { value: 0 };
  const p = await harness(t, { monotonicClock: clock, authResolver: async () => { clock.value = 11000; return { ok: true, apiKey: fakeSecret, headers: {} }; } });
  p.send('menu'); p.select('测试连接…'); p.select('确认文本测试'); await p.settled(); await p.flush();
  assert.match(p.screen(), /请求超时/); assert.equal(recorded(p).at(-1).report.code, 'timeout');
  assert.equal(p.authCalls(), 1); assert.equal(p.calls.length, 0);
});

test('whole-stage timeout includes credential resolution, without starting a late request', async (t) => {
  let release;
  const auth = new Promise((resolve) => { release = resolve; });
  const p = await harness(t, { authResolver: () => auth, shortDeadline: true });
  p.send('menu'); p.select('测试连接…'); p.select('确认文本测试'); await p.settled();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(p.screen(), /请求超时/); assert.equal(recorded(p).at(-1).report.code, 'timeout');
  release({ ok: true, apiKey: fakeSecret, headers: {} }); await p.flush();
  assert.equal(p.calls.length, 0);
});

test('direct shortcuts preserve matrix and query on cancelling add or remove, without a root detour', async (t) => {
  const p = await harness(t); p.type('p0'); p.send('down'); const before = p.screen();
  p.send('\x1bn'); assert.match(p.screen(), /搜索或输入模型 ID/);
  p.type('cancelled'); p.send('\x1bx'); assert.equal(p.config().providers.p01.models.length, 1);
  p.send('esc'); assert.equal(p.screen(), before);
  p.send('\x1bx'); assert.match(p.screen(), /移除模型 p01 \/ m1/);
  p.send('esc'); assert.equal(p.screen(), before);
  assert.equal(p.calls.length, 0); assert.equal(p.selections.length, 0);
});

test('provider-column shortcuts are contextual and cancelling leaves provider focus intact', async (t) => {
  const p = await harness(t); p.send('left'); p.send('left'); p.send('down'); const before = p.screen();
  p.send('\x1bn'); assert.match(p.screen(), /添加供应商/); assert.match(p.screen(), /名称:/); assert.ok(!p.screen().includes('供应商 ID:'));
  p.send('esc'); assert.equal(p.screen(), before);
  p.send('\x1bx'); assert.match(p.screen(), /整行 1 个模型/);
  assert.match(p.screen(), /整个|整家/); p.send('esc'); assert.equal(p.screen(), before);
  assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('failed undo while busy retains the valid retry and succeeds when idle again', async (t) => {
  let idle = true;
  const p = await harness(t, { idle: () => idle }); p.send('down');
  p.send('\x1bx'); p.select('确认移除'); await p.settled();
  assert.equal(p.config().providers.p01.models.length, 0); assert.match(p.screen(), /Alt\+Z/);
  idle = false; p.send('\x1bz'); await p.flush();
  assert.match(p.screen(), /修改未确认完成/); assert.equal(p.config().providers.p01.models.length, 0);
  p.send('esc'); assert.match(p.screen(), /Alt\+Z/);
  idle = true; p.send('\x1bz'); await p.flush();
  assert.equal(p.config().providers.p01.models[0].id, 'm1');
  assert.equal(p.calls.length, 0);
});

test('live context changes, not the opening snapshot, protect the active model', async (t) => {
  const p = await harness(t); p.setCurrent('p01', 'm1'); p.send('down'); p.send('\x1bx');
  assert.match(p.screen(), /先替换当前模型/); assert.ok(!p.screen().includes('主密码'));
  assert.equal(p.config().providers.p01.models[0].id, 'm1'); assert.equal(p.selections.length, 0);
});

test('invalid or partial default settings fail closed before destructive confirmation', async (t) => {
  for (const bad of ['{invalid', 'null', '[]', '{"defaultProvider":"p01"}']) {
    const p = await harness(t); const before = p.config();
    fs.writeFileSync(path.join(p.root, 'settings.json'), bad); p.send('down'); p.send('\x1bx');
    assert.match(p.screen(), /无法确认默认模型/); assert.ok(!p.screen().includes('主密码'));
    assert.deepEqual(p.config(), before); assert.equal(p.selections.length, 0);
    assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data')));
  }
});

test('unreadable default settings do not erase deletion protection', async (t) => {
  let refuse = false;
  const p = await harness(t, { fsFault(op, args) { if (refuse && op === 'readFileSync' && String(args[0]).endsWith('/settings.json')) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' }); } });
  refuse = true; p.send('down'); p.send('\x1bx'); assert.match(p.screen(), /无法确认默认模型/);
  assert.equal(p.config().providers.p01.models.length, 1); assert.equal(p.calls.length, 0);
});

test('explicit in-flow replacement updates current/default only after confirmation, then separately archives', async (t) => {
  const p = await harness(t); p.send('\x1bx'); p.select('p01 / m1');
  assert.equal(p.selections.length, 0); p.select('确认替换'); await p.flush();
  assert.match(p.screen(), /移除模型 p00 \/ m0/); assert.equal(p.current().id, 'm1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm1');
  assert.equal(p.config().providers.p00.models.length, 1, 'replacement is not archive consent');
  p.select('确认移除'); await p.settled(); assert.equal(p.config().providers.p00.models.length, 0);
  assert.equal(p.current().provider, 'p01'); assert.equal(p.calls.length, 0);
});

test('an external default edit during async model replacement is preserved, never overwritten', async (t) => {
  let release; const deferred = new Promise((resolve) => { release = resolve; });
  const config = baseConfig(); config.providers.p02 = { ...config.providers.p01, models: [{ ...config.providers.p01.models[0], id: 'm2' }] };
  const p = await harness(t, { config, switcher: () => deferred });
  p.send('\x1bx'); p.select('p01 / m1'); p.select('确认替换'); await p.flush();
  assert.equal(p.selections.length, 1);
  const external = JSON.stringify({ defaultProvider: 'p02', defaultModel: 'm2', keepExternal: true });
  fs.writeFileSync(path.join(p.root, 'settings.json'), external);
  release(true); await p.flush();
  assert.match(p.screen(), /替换未完整完成/);
  assert.equal(fs.readFileSync(path.join(p.root, 'settings.json'), 'utf8'), external);
  assert.equal(p.current().id, 'm1'); assert.equal(p.config().providers.p00.models.length, 1);
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data')));
});

test('changed current selection between replacement choice and confirmation is not silently replaced', async (t) => {
  const config = baseConfig(); config.providers.p02 = { ...config.providers.p01, models: [{ ...config.providers.p01.models[0], id: 'm2' }] };
  const p = await harness(t, { config }); p.send('\x1bx'); p.select('p01 / m1');
  p.setCurrent('p02', 'm2'); p.select('确认替换'); await p.flush();
  assert.match(p.screen(), /使用状态已变化/); assert.equal(p.current().id, 'm2');
  assert.equal(p.selections.length, 0); assert.equal(p.config().providers.p00.models.length, 1);
});

test('default write failure after explicit switch is reported honestly and temporary files are cleaned', async (t) => {
  const p = await harness(t, { fsFault(op, args) { if (op === 'renameSync' && String(args[1]).endsWith('/settings.json')) throw new Error('SYNTHETIC settings rename failure'); } });
  p.send('\x1bx'); p.select('p01 / m1'); p.select('确认替换'); await p.flush();
  assert.match(p.screen(), /替换未完整完成/); assert.equal(p.current().id, 'm1');
  assert.equal(p.config().providers.p00.models.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm0');
  assert.ok(!fs.readdirSync(p.root).some((name) => name.endsWith('.tmp')));
});

test('supplier removal always confirms the full configured count, including filtered-out models', async (t) => {
  const config = baseConfig(); config.providers.p01.models.push({ ...config.providers.p01.models[0], id: 'hidden-second', name: 'Hidden' });
  const p = await harness(t, { config }); p.type('m1'); p.send('left'); p.send('left'); p.send('\x1bx');
  assert.match(p.screen(), /整行 2 个模型/); assert.match(p.screen(), /含搜索未显示/);
  assert.equal(p.config().providers.p01.models.length, 2); p.send('esc'); assert.match(p.screen(), /› m1/);
});

test('locating a newly added model is explicit; saving alone preserves query and current session', async (t) => {
  const p = await harness(t); p.type('m0'); p.send('\x1bn'); p.type('hidden-new'); p.send('enter');
  p.send('save'); await p.settled();
  assert.match(p.screen(), /› m0/); assert.match(p.screen(), /Alt\+L/); assert.equal(p.selections.length, 0);
  p.send('\x1bl'); assert.match(p.screen(), /hidden-new/); assert.ok(!p.screen().includes('› m0'));
  assert.equal(p.current().id, 'm0'); assert.equal(p.selections.length, 0);
});

test('losing UI focus cancels the armed boundary press without changing normal navigation', async (t) => {
  const p = await harness(t); p.send('left'); p.setFocused(false); p.setFocused(true); p.send('left');
  assert.ok(!p.screen().includes('供应商「A」')); p.send('left'); assert.match(p.screen(), /供应商「A」.*p00/);
});

test('default becoming unreadable after removal confirmation still blocks before storage changes', async (t) => {
  const p = await harness(t); p.send('down'); p.send('\x1bx'); assert.match(p.screen(), /确认移除/);
  fs.writeFileSync(path.join(p.root, 'settings.json'), '{invalid'); p.select('确认移除');
  assert.match(p.screen(), /无法确认默认模型/); assert.ok(!p.screen().includes('主密码'));
  assert.equal(p.config().providers.p01.models.length, 1);
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data')));
});

test('unreadable custom declarations never prune existing favorite/order identities', async (t) => {
  const p = await harness(t); await p.close();
  const favorites = JSON.stringify(['p01/m1', 'unknown/missing']);
  const order = JSON.stringify({ providers: ['p00', 'unknown', 'p01'], models: { unknown: ['missing'] } });
  fs.writeFileSync(path.join(p.root, 'model-pick-favorites.json'), favorites);
  fs.writeFileSync(path.join(p.root, 'model-pick-order.json'), order);
  const reopened = await harness(t, { existingHome: p.home, fsFault(op, args) { if (op === 'openSync' && String(args[0]).endsWith('/models.json')) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' }); } });
  assert.equal(fs.readFileSync(path.join(p.root, 'model-pick-favorites.json'), 'utf8'), favorites);
  assert.equal(fs.readFileSync(path.join(p.root, 'model-pick-order.json'), 'utf8'), order);
  assert.equal(reopened.calls.length, 0);
});

test('synthetic rendered task screens fit narrow and normal terminals without exposing secrets', async (t) => {
  const p = await harness(t);
  const capture = (label) => {
    for (const width of [32, 60, 80, 180]) {
      const raw = p.raw(width); assert.ok(!raw.includes(password)); assert.ok(!raw.includes(fakeSecret));
      assert.ok(p.lines(width).length <= 24); assert.ok(p.lines(width).every((line) => tui.visibleWidth(line) < width));
      if (process.env.MODEL_PICK_SNAPSHOT_DIR) {
        fs.mkdirSync(process.env.MODEL_PICK_SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(process.env.MODEL_PICK_SNAPSHOT_DIR, `${label}-${width}.ansi`), raw + '\n', { mode: 0o600 });
        fs.writeFileSync(path.join(process.env.MODEL_PICK_SNAPSHOT_DIR, `${label}-${width}.txt`), p.screen(width) + '\n', { mode: 0o600 });
      }
    }
  };
  capture('matrix'); p.send('left'); capture('armed'); p.send('left'); capture('provider');
  p.send('\x1bn'); capture('supplier-form'); p.send('esc'); p.send('right'); p.send('down');
  p.send('\x1bn'); p.type('synthetic-new'); capture('candidates'); p.send('enter'); p.send('down'); capture('picked');
  p.select('参数 · synthetic-new'); capture('parameters'); p.send('esc'); p.send('save');
  capture('protected-save'); await p.settled(); capture('saved-without-password');
  p.send('\x1bx'); capture('remove-confirmation'); assert.equal(p.calls.length, 0);
});

test('restore conflicts offer a generated supplier copy without ID entry or overwriting current configuration', async (t) => {
  const p = await harness(t); p.send('down'); p.send('left'); p.send('left'); p.send('\x1bx');
  p.select('确认移除'); await p.settled(); assert.ok(!p.config().providers.p01);
  const current = p.config(); current.providers.p01 = { ...baseConfig().providers.p01, name: 'Replacement', models: [{ ...baseConfig().providers.p01.models[0], id: 'fresh' }] };
  fs.writeFileSync(p.configFile, JSON.stringify(current));
  p.send('menu'); p.select('已移除的项目…'); p.select('整行 · p01');
  assert.match(p.screen(), /作为新供应商恢复/); assert.ok(!p.screen().includes('供应商 ID:'));
  p.send('save'); await p.flush();
  assert.equal(p.config().providers.p01.models[0].id, 'fresh');
  assert.equal(p.config().providers['p01-restored'].models[0].id, 'm1');
  p.send('\x1bl'); assert.match(p.screen(), /▸ B\s/); assert.match(p.screen(), /› M1/);
  p.type('p01-restored'); assert.match(p.screen(), /Hibiki · 模型工作台 \(1\/3\)/); assert.match(p.screen(), /▸ B\s/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-favorites.json'))), ['p01/m1']);
  assert.equal(p.selections.length, 0); assert.equal(p.calls.length, 0);
});

test('opening an empty removed-items list does not demand a new master password', async (t) => {
  const p = await harness(t); p.send('menu'); p.select('已移除的项目…');
  assert.match(p.screen(), /没有可恢复记录/); assert.ok(!p.screen().includes('主密码'));
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data')));
});

test('default settings backup is protected, preserves private fields and leaves old plaintext backups untouched', async (t) => {
  const p = await harness(t); const settings = path.join(p.root, 'settings.json');
  const original = JSON.stringify({ defaultProvider: 'p00', defaultModel: 'm0', privateExtensionValue: fakeSecret });
  fs.writeFileSync(settings, original);
  const oldBackup = path.join(p.root, 'settings.json.bak-model-pick'); fs.writeFileSync(oldBackup, 'SYNTHETIC-legacy-copy', { mode: 0o600 });
  p.send('down'); p.send('\x1bd');
  assert.equal(JSON.parse(fs.readFileSync(settings)).defaultModel, 'm1');
  assert.equal(JSON.parse(fs.readFileSync(settings)).privateExtensionValue, fakeSecret);
  const backupFile = path.join(p.root, 'settings.json.bak-model-pick.sealed');
  const backup = fs.readFileSync(backupFile, 'utf8'); assert.ok(!backup.includes(fakeSecret));
  const restored = p.protection.open(JSON.parse(backup), 'settings'); assert.equal(restored.before, original);
  assert.equal(restored.kind, 'model-pick-settings-backup'); assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(oldBackup, 'utf8'), 'SYNTHETIC-legacy-copy');
  assert.ok(!fs.readdirSync(p.root).some((name) => name.endsWith('.tmp')));
  assert.doesNotMatch(p.screen(), /主密码|解锁/); assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0);
});

test('unavailable protection refuses a save without plaintext fallback and retains the exact task for retry', async (t) => {
  const protectionState = { failSeal: true }; const p = await harness(t, { protectionState }); const original = p.config();
  p.send('\x1bn'); p.type('retry-safe-model'); p.send('enter'); p.send('down'); const before = p.screen(); p.send('save'); await p.settled();
  assert.match(p.screen(), /无法安全保存.*当前输入已保留/); assert.deepEqual(p.config(), original);
  assert.deepEqual(fs.readdirSync(path.join(p.root, 'model-pick-data')), []);
  assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0); assert.ok(!p.raw().includes(fakeSecret));
  p.send('esc'); assert.equal(p.screen(), before); assert.match(p.screen(), /retry-safe-model/);
  protectionState.failSeal = false; p.send('save'); await p.settled();
  assert.ok(p.config().providers.p00.models.some((m) => m.id === 'retry-safe-model')); assert.match(p.screen(), /模型已添加/);
});

test('failed secure preflight prevents credential resolution and both kinds of network request', async (t) => {
  for (const discovery of [false, true]) {
    const p = await harness(t, { protectionState: { failSeal: true } }); const original = p.config();
    p.send('menu');
    if (discovery) { p.select('添加模型…'); p.send('backTab'); p.select('读取模型清单…'); }
    else p.select('测试连接…');
    p.select(discovery ? '确认读取清单' : '确认文本测试'); await p.settled();
    assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0); assert.deepEqual(p.config(), original);
    assert.doesNotMatch(p.screen(), /主密码|解锁/); assert.ok(!p.raw().includes(fakeSecret));
    assert.deepEqual(fs.readdirSync(path.join(p.root, 'model-pick-data')), []);
    assert.match(p.screen(), discovery ? /未能保存检查记录，可继续手输/ : /测试未开始.*\n.*无法安全保存.*当前输入已保留/);
  }
});

test('completed legacy records are preserved, clearly separated and do not lock ordinary automatic writes', async (t) => {
  const first = await harness(t); const unchanged = seedLegacy(first);
  fs.writeFileSync(path.join(first.root, 'model-pick-favorites.json'), JSON.stringify(['p01/m1', 'legacy/legacy-m']));
  await first.close(); const p = await harness(t, { existingHome: first.home });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.root, 'model-pick-favorites.json'))), ['p01/m1', 'legacy/legacy-m']);
  p.send('menu'); p.select('已移除的项目…'); assert.match(p.screen(), /旧版记录仍保留.*迁移/);
  assert.doesNotMatch(p.screen(), /主密码|解锁/); unchanged();
  p.send('esc'); p.send('esc'); p.send('esc'); p.send('\x1bn'); p.type('automatic-beside-legacy'); p.send('enter');
  p.send('save'); await p.settled(); assert.ok(p.config().providers.p00.models.some((m) => m.id === 'automatic-beside-legacy'));
  assert.ok(fs.existsSync(path.join(p.root, 'model-pick-data/vault.auto.json'))); unchanged();
  assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0);
});

test('genuine unfinished legacy transaction blocks writes and recovery without an automatic password or migration', async (t) => {
  const p = await harness(t); const unchanged = seedLegacy(p, true); const original = p.config();
  p.send('\x1bn'); p.type('not-applied'); p.send('enter'); p.send('save'); await p.settled();
  assert.match(p.screen(), /旧版修改尚未完成.*单独处理.*旧记录已保留/); assert.deepEqual(p.config(), original); unchanged();
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data/vault.auto.json')));
  p.send('esc'); p.send('esc'); p.send('menu'); p.select('完成上次修改…'); p.select('确认完成上次修改'); await p.settled();
  assert.match(p.screen(), /旧版修改尚未完成.*单独处理.*旧记录已保留/); assert.deepEqual(p.config(), original); unchanged();
  assert.equal(p.authCalls(), 0); assert.equal(p.calls.length, 0);
});

test('production guard callback rechecks a default changed during protected archive preflight', async (t) => {
  let p; let hit = false;
  const protectionState = { sealHook(_value, purpose) { if (purpose === 'models' && !hit) { hit = true; fs.writeFileSync(path.join(p.root, 'settings.json'), JSON.stringify({ defaultProvider: 'p01', defaultModel: 'm1' })); } } };
  p = await harness(t, { protectionState }); const original = p.config();
  p.send('down'); p.send('\x1bx'); p.select('确认移除'); await p.settled();
  assert.equal(hit, true); assert.deepEqual(p.config(), original); assert.match(p.screen(), /默认模型.*先更换默认/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm1');
  assert.ok(!fs.existsSync(path.join(p.root, 'model-pick-data/vault.auto.json'))); assert.equal(p.calls.length, 0);
});

test('pending after-image failure cannot set a stale archived row as default and recovery retains a valid default', async (t) => {
  let vaultRenames = 0;
  const p = await harness(t, { fsFault(op, args) { if (op === 'renameSync' && String(args[1]).endsWith('/vault.auto.json') && ++vaultRenames === 2) throw new Error('Synthetic finish failure'); } });
  p.send('down'); p.send('\x1bx'); p.select('确认移除'); await p.settled();
  assert.equal(p.config().providers.p01.models.length, 0); assert.match(p.screen(), /修改未确认完成/);
  const vaultFile = path.join(p.root, 'model-pick-data/vault.auto.json'); assert.equal(JSON.parse(fs.readFileSync(vaultFile)).pending, true);
  p.send('esc'); p.send('esc'); assert.match(p.screen(), /M1/); p.send('\x1bd');
  assert.match(p.screen(), /模型配置已变化或上次修改未完成/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm0');
  assert.ok(!fs.existsSync(path.join(p.root, 'settings.json.bak-model-pick.sealed')));
  p.send('menu'); p.select('完成上次修改…'); p.select('确认完成上次修改'); await p.settled();
  assert.equal(JSON.parse(fs.readFileSync(vaultFile)).pending, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm0'); assert.equal(p.current().id, 'm0');
  assert.equal(p.calls.length, 0);
});

test('external deletion without a journal cannot make a stale available row the default', async (t) => {
  const p = await harness(t); p.send('down'); const changed = p.config(); changed.providers.p01.models = [];
  fs.writeFileSync(p.configFile, JSON.stringify(changed)); p.send('\x1bd');
  assert.match(p.screen(), /模型配置已变化/); assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm0');
  assert.ok(!fs.existsSync(path.join(p.root, 'settings.json.bak-model-pick.sealed'))); assert.deepEqual(p.protection.state.seals, []);
});

test('settings protection failure is caught before an explicit current/default replacement', async (t) => {
  const p = await harness(t, { protectionState: { failSeal: 'settings' } });
  p.send('\x1bx'); p.select('p01 / m1'); p.select('确认替换'); await p.settled();
  assert.match(p.screen(), /替换未完整完成/); assert.equal(p.selections.length, 0); assert.equal(p.current().id, 'm0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm0');
  assert.ok(!fs.readdirSync(p.root).some((name) => name.endsWith('.tmp') || name.endsWith('.sealed'))); assert.equal(p.calls.length, 0);
});

test('default target removed during protection is revalidated before any settings or backup write', async (t) => {
  let p; let hit = false;
  const protectionState = { sealHook(_value, purpose) { if (purpose === 'settings' && !hit) { hit = true; const config = p.config(); config.providers.p01.models = []; fs.writeFileSync(p.configFile, JSON.stringify(config)); } } };
  p = await harness(t, { protectionState }); p.send('down'); p.send('\x1bd');
  assert.equal(hit, true); assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, 'settings.json'))).defaultModel, 'm0');
  assert.ok(!fs.existsSync(path.join(p.root, 'settings.json.bak-model-pick.sealed'))); assert.ok(!fs.readdirSync(p.root).some((name) => name.endsWith('.tmp')));
});

