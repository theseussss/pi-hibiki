import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';

const source = fileURLToPath(new URL('../lib/fast.ts', import.meta.url));
const failIO = () => { throw new Error('IO/network/timers forbidden'); };
const fixedTime = '2026-10-28T00:00:00.000Z';
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
}
const plain = value => JSON.parse(JSON.stringify(value));
const model = (overrides = {}) => ({
  provider: 'clf-responses', api: 'openai-responses', id: 'gpt-6-astra',
  baseUrl: 'https://fixture.invalid/v1', ...overrides,
});
const state = data => ({ type: 'custom', customType: 'gpt-fast-mode-state', data });
const payload = (m, extra = {}) => ({ model: m.id, input: 'synthetic input', ...extra });

function harness({ currentModel = model(), branch = [], options, start = true } = {}) {
  const hooks = new Map();
  const commands = new Map();
  const entries = [];
  const statuses = [];
  const notifications = [];
  let branchReads = 0;
  let branchValue = branch;
  const api = loadTypeScript(source, {}, {
    fetch: failIO, setTimeout: failIO, clearTimeout: failIO,
    setInterval: failIO, clearInterval: failIO, queueMicrotask: failIO,
    WebSocket: failIO, XMLHttpRequest: failIO, Date: FixedDate,
  });
  const pi = new Proxy({
    on(event, handler) {
      const list = hooks.get(event) || [];
      list.push(handler);
      hooks.set(event, list);
      return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1); };
    },
    registerCommand(name, command) {
      assert.equal(commands.has(name), false, 'no duplicate commands');
      commands.set(name, command);
    },
    appendEntry(type, data) {
      entries.push({ type, data: plain(data) });
      branchValue = [...branchValue, { type: 'custom', customType: type, data: plain(data) }];
    },
  }, { get(target, key) {
    if (key in target) return target[key];
    throw new Error(`forbidden Pi capability ${String(key)}`);
  } });
  const ctx = {
    model: currentModel,
    sessionManager: new Proxy({ getBranch() { branchReads++; return branchValue; } }, {
      get(target, key) {
        if (key in target) return target[key];
        throw new Error(`forbidden session read ${String(key)}`);
      },
    }),
    ui: {
      setStatus(key, value) { statuses.push([key, value]); },
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  const controller = api.registerFastPolicy(pi, options);
  const h = {
    api, pi, hooks, commands, entries, statuses, notifications, ctx, controller,
    get branchReads() { return branchReads; },
    setBranch(value) { branchValue = value; },
    emit(type, event = {}, context = ctx) {
      let result;
      for (const handler of hooks.get(type) || []) result = handler({ type, ...event }, context);
      return result;
    },
    command(args, context = ctx) { return commands.get('fast').handler(args, context); },
    request(...values) { return h.emit('before_provider_request', { payload: values.length ? values[0] : payload(ctx.model) }); },
    raw(data, overrides = {}, context = ctx) {
      return h.emit('provider_stream_event', {
        provider: context.model?.provider, api: context.model?.api, model: context.model?.id,
        data, ...overrides,
      }, context);
    },
    snapshot() { return plain(controller.snapshot(ctx)); },
    describe() { return controller.describe(ctx); },
    select(next) { ctx.model = next; h.emit('model_select'); },
  };
  if (start) h.emit('session_start', { reason: 'startup' });
  return h;
}

test('registration is lazy, source-only, no runtime imports/IO/timers or host reads', () => {
  let configCalls = 0;
  const h = harness({ start: false, options: { ultrafastEnabled() { configCalls++; return true; } } });
  assert.equal(configCalls, 0);
  assert.equal(h.branchReads, 0);
  assert.deepEqual(h.statuses, []);
  assert.deepEqual(h.entries, []);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual([...h.commands.keys()], ['fast']);
  assert.equal(h.hooks.get('before_provider_request').length, 1);
  assert.equal(h.hooks.get('provider_stream_event').length, 1);
  assert.deepEqual([...h.hooks.keys()].sort(), [
    'before_provider_request', 'model_select', 'provider_stream_event',
    'session_shutdown', 'session_start', 'session_tree',
  ]);
  assert.equal(h.snapshot().ultrafastEnabled, true);
  assert.equal(configCalls, 1);
  h.emit('session_start');
  assert.equal(configCalls, 2);
  assert.equal(h.controller.setTier('ultrafast', h.ctx), true);
  assert.equal(configCalls, 3);
});

test('default snapshot and original status key; no selection does not claim activation', () => {
  const h = harness();
  assert.deepEqual(h.snapshot(), {
    tier: 'off', supported: true, active: false, ultrafastEnabled: false,
    modelLabel: 'clf-responses/gpt-6-astra',
  });
  assert.deepEqual(h.statuses, [['gpt-fast-mode', undefined]]);
  assert.deepEqual(h.entries, []);
  assert.match(h.describe(), /不发送 service_tier/);
  assert.match(h.describe(), /尚无请求记录/);
});

test('pure restore retains exact v2 and legacy enabled compatibility', () => {
  const { restoreTier } = harness().api;
  for (const value of [undefined, null, false, 1, 'priority', [], {},
    { enabled: 1 }, { enabled: 'true' }, { tier: 'priority' },
    { version: 2, enabled: true }, { version: 2, tier: 'auto', enabled: true }]) {
    assert.equal(restoreTier(value), 'off', JSON.stringify(value));
  }
  assert.equal(restoreTier({ enabled: true, probeSucceeded: false }), 'priority');
  assert.equal(restoreTier({ version: 1, enabled: true }), 'priority');
  assert.equal(restoreTier({ version: 2, tier: 'priority', enabled: false }), 'priority');
  assert.equal(restoreTier({ version: 2, tier: 'ultrafast' }), 'ultrafast');
  assert.equal(restoreTier({ version: 2, tier: 'off', enabled: true }), 'off');
});

for (const provider of ['clf-responses', 'clf-completions', 'openai', 'openai-codex']) {
  test(`provider ${provider} preserves all three eligible APIs`, () => {
    const h = harness();
    for (const api of ['openai-responses', 'openai-completions', 'openai-codex-responses']) {
      const m = model({ provider, api });
      assert.equal(h.api.supportsFastMode(m), true);
      h.select(m);
      assert.equal(h.controller.setTier('priority', h.ctx), true);
      assert.equal(h.request().service_tier, 'priority');
    }
  });
}

test('provider and API allowlists are exact, independent gates', () => {
  const h = harness();
  for (const provider of ['anthropic', 'azure-openai', 'custom', 'OPENAI', 'openai-compatible', '']) {
    h.select(model({ provider }));
    assert.equal(h.snapshot().supported, false, provider);
    assert.equal(h.request(), undefined);
  }
  for (const api of ['anthropic-messages', 'google-generative-ai', 'openai', 'OpenAI-responses', '']) {
    h.select(model({ api }));
    assert.equal(h.snapshot().supported, false, api);
    assert.equal(h.request(), undefined);
  }
  h.select(undefined);
  assert.deepEqual(h.snapshot(), {
    tier: 'off', supported: false, active: false, ultrafastEnabled: false, modelLabel: '未选择模型',
  });
  assert.equal(h.emit('before_provider_request', { payload: {} }), undefined);
});

test('model regex preserves exact future-model scope and delimiter behavior', () => {
  const { supportsFastMode } = harness().api;
  for (const id of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.9', 'GPT-6', 'GPT-6-ASTRA',
    'gpt-7.1', 'gpt-9', 'gpt-10', 'gpt-99-a', 'gpt-123.0']) {
    assert.equal(supportsFastMode(model({ id })), true, id);
  }
  for (const id of ['gpt-4.1', 'gpt-5', 'gpt-5.1', 'gpt-5.3', 'gpt-5.10',
    'gpt-5.40', 'gpt-6foo', 'gpt-6_preview', 'gpt-06', 'gpt-0', 'gpt-100x',
    'o3', 'gpt-4o', 'claude-gpt-6', ' gpt-6', 'gpt-5.4x', 'gpt-6/mini']) {
    assert.equal(supportsFastMode(model({ id })), false, id);
  }
});

for (const shape of [
  { messages: [] }, { input: [] }, { input: '' }, { input: 'text' },
  { input: null, messages: [] }, { input: false, messages: [] },
]) {
  test(`eligible payload shape ${JSON.stringify(shape)} clones and deletes tier while off`, () => {
    const h = harness();
    const original = Object.freeze({ model: h.ctx.model.id, service_tier: 'priority',
      temperature: 0.25, metadata: Object.freeze({ fixture: true }), ...shape });
    const next = h.request(original);
    assert.notEqual(next, original);
    assert.equal(Object.hasOwn(next, 'service_tier'), false);
    assert.equal(original.service_tier, 'priority');
    assert.equal(next.metadata, original.metadata);
    const expected = { ...original };
    delete expected.service_tier;
    assert.deepEqual(plain(next), expected);
    assert.match(h.describe(), /未发送档位字段/);
  });
}

test('malformed and background payloads pass through untouched with no observation', () => {
  const h = harness();
  h.controller.setTier('priority', h.ctx);
  for (const value of [undefined, null, false, 3, 'text', [], {},
    { model: h.ctx.model.id }, { model: h.ctx.model.id, input: {} },
    { model: h.ctx.model.id, input: 3, messages: {} },
    { model: h.ctx.model.id, messages: 'text' },
    { model: 'gpt-6-other', input: [] }, { model: 'gpt-4.1', messages: [] },
    { messages: [], service_tier: 'auto' }]) {
    const before = value === undefined ? undefined : JSON.stringify(value);
    assert.equal(h.request(value), undefined, before);
    assert.equal(value === undefined ? undefined : JSON.stringify(value), before);
    assert.match(h.describe(), /尚无请求记录/);
  }
});

test('priority and ultrafast override only service_tier, never mutate the input', () => {
  const h = harness({ options: { ultrafastEnabled: () => true } });
  for (const tier of ['priority', 'ultrafast']) {
    assert.equal(h.controller.setTier(tier, h.ctx), true);
    const input = Object.freeze(payload(h.ctx.model, { service_tier: 'auto', other: 1 }));
    const output = h.request(input);
    assert.equal(output.service_tier, tier);
    assert.equal(input.service_tier, 'auto');
    assert.deepEqual(plain(output), { ...input, service_tier: tier });
    assert.equal(h.snapshot().active, true);
    assert.deepEqual(h.statuses.at(-1), ['gpt-fast-mode', tier === 'priority' ? '\u26a1 FAST↑' : '\u26a1 ULTRAFAST↑']);
  }
  assert.deepEqual(h.entries, [
    { type: 'gpt-fast-mode-state', data: { version: 2, tier: 'priority' } },
    { type: 'gpt-fast-mode-state', data: { version: 2, tier: 'ultrafast' } },
  ]);
});

test('every enabling alias, whitespace/case normalization, toggle, and off persist compatible state', async () => {
  const h = harness({ options: { ultrafastEnabled: () => true } });
  for (const alias of ['on', 'fast', 'priority', '  ON  ', '']) {
    await h.command('off');
    await h.command(alias);
    assert.equal(h.snapshot().tier, 'priority', alias);
    assert.equal(h.entries.at(-1).data.tier, 'priority');
    await h.command('');
    assert.equal(h.snapshot().tier, 'off');
  }
  await h.command(' ULTRAFAST ');
  assert.equal(h.snapshot().tier, 'ultrafast');
  await h.command('');
  assert.equal(h.snapshot().tier, 'off');
  for (const entry of h.entries) {
    assert.equal(entry.type, 'gpt-fast-mode-state');
    assert.equal(entry.data.version, 2);
  }
  assert.match(h.notifications.find(n => n.message.includes('service_tier=priority')).message, /费用以站方为准/);
});

test('disabled ultrafast and unknown actions do not persist or change selection; new guidance only', async () => {
  const h = harness();
  await h.command('on');
  const before = h.entries.length;
  await h.command('ultrafast');
  assert.equal(h.snapshot().tier, 'priority');
  assert.equal(h.entries.length, before);
  assert.equal(h.notifications.at(-1).level, 'warning');
  assert.match(h.notifications.at(-1).message, /pi-hibiki\.json 的 fast\.enableUltrafast/);
  assert.doesNotMatch(h.notifications.at(-1).message, /gpt-fast-mode\.json/);
  for (const action of ['wat', 'enabled', 'priority extra', 'check now']) {
    await h.command(action);
    assert.match(h.notifications.at(-1).message, /^用法：/);
    assert.doesNotMatch(h.notifications.at(-1).message, /、\/fast ultrafast/);
  }
  assert.equal(h.controller.setTier('auto', h.ctx), false);
  assert.equal(h.entries.length, before);
  const enabled = harness({ options: { ultrafastEnabled: () => true } });
  await enabled.command('wat');
  assert.match(enabled.notifications.at(-1).message, /、\/fast ultrafast/);
});

test('option reads are lazy/current when restoring, setting and snapshotting', () => {
  let enabled = false;
  const h = harness({ branch: [state({ version: 2, tier: 'ultrafast' })],
    options: { ultrafastEnabled: () => enabled } });
  assert.equal(h.snapshot().tier, 'off');
  assert.equal(h.controller.setTier('ultrafast', h.ctx), false);
  enabled = true;
  assert.equal(h.snapshot().ultrafastEnabled, true);
  h.emit('session_tree');
  assert.equal(h.snapshot().tier, 'ultrafast');
  enabled = false;
  h.emit('session_tree');
  assert.equal(h.snapshot().tier, 'off');
  assert.equal(h.entries.length, 0, 'permission changes do not migrate history');
});

test('unsupported model preserves latent tier and observations on switches; off allowed anywhere', async () => {
  const h = harness();
  await h.command('on');
  const original = h.ctx.model;
  h.request();
  h.raw({ type: 'response.completed', response: { service_tier: 'priority', id: 'fixture-A' } });
  h.select(model({ id: 'gpt-4.1' }));
  assert.equal(h.snapshot().tier, 'priority');
  assert.equal(h.snapshot().active, false);
  assert.equal(h.snapshot().supported, false);
  assert.match(h.describe(), /不会注入参数。会话选择：Fast（priority）/);
  assert.deepEqual(h.statuses.at(-1), ['gpt-fast-mode', undefined]);
  assert.equal(h.request(), undefined);
  assert.equal(h.controller.setTier('priority', h.ctx), false);
  assert.equal(h.entries.length, 1);
  h.select(original);
  assert.equal(h.snapshot().active, true);
  assert.match(h.describe(), /fixture-A/);
  h.select(undefined);
  assert.equal(h.controller.setTier('off', h.ctx), true);
  assert.equal(h.snapshot().tier, 'off');
  assert.equal(h.entries.length, 2);
});

test('restore reads last compatible custom entry on current branch only; no writes/migration', () => {
  const h = harness({ branch: Object.freeze([
    state({ version: 2, tier: 'off' }),
    { type: 'custom', customType: 'unrelated', data: { tier: 'ultrafast' } },
    state(Object.freeze({ enabled: true, probeSucceeded: false })),
    { type: 'message', data: { enabled: false } },
  ]) });
  assert.equal(h.snapshot().tier, 'priority');
  assert.equal(h.branchReads, 1);
  assert.equal(h.entries.length, 0);
  h.setBranch([state({ enabled: true }), state({ version: 2, tier: 'off' })]);
  h.emit('session_tree', { newLeafId: 'sibling-B' });
  assert.equal(h.snapshot().tier, 'off');
  h.setBranch([state({ version: 2, tier: 'priority' })]);
  h.emit('session_tree', { newLeafId: 'branch-A' });
  assert.equal(h.snapshot().tier, 'priority');
  h.setBranch([]);
  h.emit('session_start', { reason: 'resume' });
  assert.equal(h.snapshot().tier, 'off');
  assert.equal(h.branchReads, 4);
  assert.equal(h.entries.length, 0);
});

test('tree/session restoration clears only in-memory observations and restores unsupported latent choice', () => {
  const h = harness({ branch: [state({ version: 2, tier: 'priority' })] });
  h.request();
  h.raw({ type: 'response.completed', response: { service_tier: 'priority' } });
  assert.match(h.describe(), /上游service_tier=priority/);
  h.emit('session_tree');
  assert.match(h.describe(), /尚无请求记录/);
  h.request();
  h.select(model({ provider: 'other' }));
  h.emit('session_start', { reason: 'resume' });
  assert.equal(h.snapshot().tier, 'priority');
  assert.equal(h.snapshot().active, false);
  h.select(model());
  assert.match(h.describe(), /尚无请求记录/);
  assert.equal(h.entries.length, 0);
});

test('initial auto is not evidence; terminal tier/id is observational, no payload mutation', () => {
  const h = harness();
  h.controller.setTier('priority', h.ctx);
  h.request();
  const initial = Object.freeze({ type: 'response.created', response: Object.freeze({ id: 'fixture-id', service_tier: 'auto' }) });
  h.raw(initial);
  assert.match(h.describe(), /上游未回显/);
  assert.match(h.describe(), /响应 ID：fixture-id/);
  assert.doesNotMatch(h.describe(), /上游service_tier=auto/);
  const terminal = Object.freeze({ type: 'response.completed', response: Object.freeze({ id: 'fixture-final', service_tier: 'default' }) });
  h.raw(terminal);
  assert.match(h.describe(), /上游service_tier=default/);
  assert.match(h.describe(), /终态：response.completed/);
  assert.match(h.describe(), /响应 ID：fixture-final/);
  assert.match(h.describe(), /不作为实际加速或计费的证明/);
  assert.equal(h.snapshot().tier, 'priority');
  assert.equal(h.request().service_tier, 'priority', 'echo mismatch does not block next request');
  assert.match(h.describe(), /上游未回显/);
  assert.equal(terminal.response.service_tier, 'default');
});

for (const type of ['response.completed', 'response.failed', 'response.incomplete']) {
  test(`terminal ${type} records tier and clears absent/invalid echoes`, () => {
    const h = harness();
    h.request();
    h.raw({ type, response: { service_tier: 'priority' } });
    assert.match(h.describe(), /上游service_tier=priority/);
    assert.match(h.describe(), new RegExp(`终态：${type.replace('.', '\\.')}`));
    h.raw({ type, response: { service_tier: 1 } });
    assert.match(h.describe(), /上游未回显/);
    h.raw({ type, service_tier: 'auto', id: 'flat-response' });
    assert.match(h.describe(), /上游service_tier=auto/);
    assert.match(h.describe(), /响应 ID：flat-response/);
    h.raw({ type, response: {} });
    assert.match(h.describe(), /上游未回显/);
  });
}

test('completions echo uses top-level chunks only, other APIs require terminal events', () => {
  const h = harness({ currentModel: model({ api: 'openai-completions' }) });
  h.request();
  h.raw({ id: 'chat-fixture', service_tier: 'auto', choices: [] });
  assert.match(h.describe(), /上游service_tier=auto/);
  h.raw({ response: { service_tier: 'priority' } });
  assert.match(h.describe(), /上游service_tier=auto/);
  h.raw({ service_tier: 'priority' });
  assert.match(h.describe(), /上游service_tier=priority/);
  h.select(model({ api: 'openai-codex-responses' }));
  h.request();
  h.raw({ service_tier: 'priority' });
  assert.match(h.describe(), /上游未回显/);
});

test('observer rejects malformed data, mismatched provider/API/model, and requests never observed', () => {
  const h = harness();
  h.raw({ type: 'response.completed', service_tier: 'priority' });
  assert.match(h.describe(), /尚无请求记录/);
  h.request();
  for (const data of [undefined, null, 'text', 1, []]) h.raw(data);
  for (const mismatch of [
    { provider: 'other' }, { api: 'openai-completions' }, { model: 'gpt-6-other' },
  ]) h.raw({ type: 'response.completed', service_tier: 'priority' }, mismatch);
  assert.match(h.describe(), /上游未回显/);
  h.raw({ response: [] });
  assert.match(h.describe(), /上游未回显/);
});

test('observations isolated by provider/API/model/baseUrl, survive model switches', () => {
  const h = harness();
  const original = h.ctx.model;
  h.request();
  h.raw({ type: 'response.completed', service_tier: 'priority', id: 'only-original' });
  for (const other of [
    model({ provider: 'openai' }), model({ api: 'openai-completions' }),
    model({ id: 'gpt-7' }), model({ baseUrl: 'https://second.fixture.invalid/v1' }),
  ]) {
    h.select(other);
    assert.match(h.describe(), /尚无请求记录/);
    h.raw({ type: 'response.completed', service_tier: 'auto', id: 'ignored' });
    assert.match(h.describe(), /尚无请求记录/);
    h.request();
    h.raw({ type: 'response.completed', service_tier: 'default', id: 'other-only' });
    assert.match(h.describe(), /other-only/);
    h.select(original);
    assert.match(h.describe(), /only-original/);
    assert.match(h.describe(), /上游service_tier=priority/);
  }
});

test('status/check never send probes, change state, persist or require a capability beyond UI', async () => {
  const h = harness();
  const beforeReads = h.branchReads;
  for (const action of ['status', 'check', ' STATUS ', ' CHECK ']) {
    await h.command(action);
    assert.match(h.notifications.at(-1).message, /尚无请求记录/);
    assert.equal(h.notifications.at(-1).level, 'info');
  }
  assert.equal(h.entries.length, 0);
  assert.equal(h.branchReads, beforeReads);
  assert.match(h.commands.get('fast').description, /不发探针/);
  h.request();
  h.raw({ type: 'response.completed', service_tier: 'priority' });
  await h.command('check');
  assert.match(h.notifications.at(-1).message, /最近请求（2026-10-28T00:00:00.000Z）/);
  assert.match(h.notifications.at(-1).message, /未发送档位字段；上游service_tier=priority/);
  assert.equal(h.snapshot().tier, 'off');
  assert.equal(h.snapshot().active, false, 'echo cannot enable a selection');
});

test('subscriptions redraw on restore/selection/request/observation; unsubscribe is idempotent', () => {
  const h = harness();
  let count = 0;
  const unsubscribe = h.controller.subscribe(() => { count++; });
  assert.equal(count, 0);
  h.emit('session_tree');
  h.controller.setTier('priority', h.ctx);
  h.select(model({ id: 'gpt-7' }));
  h.request();
  h.raw({ type: 'response.completed', service_tier: 'priority' });
  assert.equal(count, 5);
  unsubscribe();
  unsubscribe();
  h.emit('session_tree');
  h.request();
  assert.equal(count, 5);
});

test('throwing UI/listener/notifications cannot interrupt request policy or other listeners', async () => {
  const h = harness();
  h.ctx.ui.setStatus = () => { throw new Error('status unavailable'); };
  h.ctx.ui.notify = () => { throw new Error('notify unavailable'); };
  h.controller.subscribe(() => { throw new Error('redraw unavailable'); });
  let redraws = 0;
  h.controller.subscribe(() => { redraws++; });
  await h.command('on');
  assert.equal(h.snapshot().tier, 'priority');
  assert.equal(h.request().service_tier, 'priority');
  h.raw({ type: 'response.completed', service_tier: 'priority' });
  assert.equal(redraws, 3);
  await h.command('check');
  await h.command('wat');
  await h.command('ultrafast');
  assert.equal(h.entries.length, 1);
  h.ctx.ui = undefined;
  h.controller.setTier('off', h.ctx);
  assert.equal(h.snapshot().tier, 'off');
});

test('rejected asynchronous presentation callbacks are contained without timers', async () => {
  const h = harness();
  h.ctx.ui.setStatus = async () => { throw new Error('async status unavailable'); };
  h.ctx.ui.notify = async () => { throw new Error('async notify unavailable'); };
  h.controller.subscribe(async () => { throw new Error('async redraw unavailable'); });
  await h.command('on');
  assert.equal(h.request().service_tier, 'priority');
  h.raw({ type: 'response.completed', service_tier: 'priority' });
  await h.command('status');
  h.emit('session_shutdown', { reason: 'quit' });
  await Promise.resolve();
  assert.equal(h.snapshot().active, false);
});

test('policy errors from configuration, branch and persistence are not masked by UI guards', async () => {
  const h = harness({ start: false, options: { ultrafastEnabled() { throw new Error('config policy failure'); } } });
  assert.throws(() => h.snapshot(), /config policy failure/);
  assert.throws(() => h.emit('session_start'), /config policy failure/);
  await assert.rejects(h.command('on'), /config policy failure/);
  const p = harness();
  p.pi.appendEntry = () => { throw new Error('persistence failure'); };
  assert.throws(() => p.controller.setTier('priority', p.ctx), /persistence failure/);
  assert.equal(p.snapshot().tier, 'off', 'failed persistence must not silently change live request policy');
  assert.equal(p.notifications.length, 0, 'no false success notification');
  const q = harness();
  q.ctx.sessionManager.getBranch = () => { throw new Error('branch failure'); };
  assert.throws(() => q.emit('session_tree'), /branch failure/);
});

test('shutdown is idempotent and terminal: stale events/commands/subscriptions cannot revive state', async () => {
  let enabledCalls = 0;
  const h = harness({ options: { ultrafastEnabled: () => { enabledCalls++; return true; } } });
  h.controller.setTier('ultrafast', h.ctx);
  h.request();
  let redraws = 0;
  h.controller.subscribe(() => { redraws++; });
  h.emit('session_shutdown', { reason: 'resume' });
  const before = { calls: enabledCalls, writes: h.entries.length, statuses: h.statuses.length, notices: h.notifications.length, reads: h.branchReads };
  assert.deepEqual(h.statuses.at(-1), ['gpt-fast-mode', undefined]);
  h.setBranch([state({ version: 2, tier: 'ultrafast' })]);
  h.emit('session_start', { reason: 'resume' });
  h.emit('session_tree');
  h.emit('model_select');
  h.raw({ type: 'response.completed', service_tier: 'priority' });
  assert.equal(h.request(), undefined);
  await h.command('on');
  await h.command('status');
  assert.equal(h.controller.setTier('priority', h.ctx), false);
  const unsubscribe = h.controller.subscribe(() => { redraws++; });
  unsubscribe();
  unsubscribe();
  h.emit('session_shutdown', { reason: 'quit' });
  assert.deepEqual(h.snapshot(), {
    tier: 'off', supported: true, active: false, ultrafastEnabled: false, modelLabel: 'clf-responses/gpt-6-astra',
  });
  assert.match(h.describe(), /尚无请求记录/);
  assert.equal(redraws, 0);
  assert.deepEqual({ calls: enabledCalls, writes: h.entries.length, statuses: h.statuses.length, notices: h.notifications.length, reads: h.branchReads }, before);
  const replacement = harness({ branch: [state({ version: 2, tier: 'priority' })] });
  assert.equal(replacement.snapshot().tier, 'priority', 'fresh runtime restores destination branch');
  assert.equal(h.snapshot().tier, 'off', 'old runtime stays dead');
});

test('shutdown during a lazy option callback cannot revive restore, command or snapshot state', () => {
  for (const operation of ['restore', 'setTier', 'snapshot']) {
    let h;
    const options = { ultrafastEnabled() {
      h.emit('session_shutdown', { reason: 'reload' });
      return true;
    } };
    h = harness({ start: false, branch: [state({ version: 2, tier: 'ultrafast' })], options });
    if (operation === 'restore') h.emit('session_start');
    if (operation === 'setTier') assert.equal(h.controller.setTier('ultrafast', h.ctx), false);
    if (operation === 'snapshot') assert.equal(h.snapshot().active, false);
    assert.equal(h.snapshot().tier, 'off', operation);
    assert.equal(h.snapshot().ultrafastEnabled, false, operation);
    assert.equal(h.entries.length, 0, operation);
    assert.equal(h.request(), undefined, operation);
  }
});

test('shutdown during request redraw prevents a stale transformed payload from escaping', () => {
  const h = harness();
  h.controller.setTier('priority', h.ctx);
  h.controller.subscribe(() => h.emit('session_shutdown', { reason: 'reload' }));
  assert.equal(h.request(), undefined);
  assert.equal(h.snapshot().tier, 'off');
  assert.equal(h.snapshot().active, false);
});

test('UI callbacks can unsubscribe others or shut down without reviving callbacks', () => {
  const h = harness();
  let second = 0;
  let unsubscribeSecond;
  h.controller.subscribe(() => { unsubscribeSecond(); h.emit('session_shutdown', { reason: 'reload' }); });
  unsubscribeSecond = h.controller.subscribe(() => { second++; });
  h.controller.setTier('priority', h.ctx);
  assert.equal(second, 0);
  assert.equal(h.snapshot().tier, 'off');
  assert.equal(h.notifications.length, 0);
  assert.equal(h.request(), undefined);
});
