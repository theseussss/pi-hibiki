import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
const api = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/probe.ts', import.meta.url)));
const scope = (protocol = 'openai-completions') => ({ provider: 'synthetic', modelId: 'demo', endpoint: 'https://example.test/v1', api: protocol, credentialVersion: 'opaque-profile-v1' });
const headers = { authorization: 'Bearer SYNTHETIC_SECRET_NEVER_PRINT' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

for (const endpoint of ['http://example.test', 'https://u:p@example.test', 'https://example.test?key=secret', 'https://example.test#fragment', 'not-a-url']) {
  test(`reject unsafe endpoint form ${endpoint.split(':')[0]}`, () => {
    assert.throws(() => api.validateEndpoint(endpoint), (e) => e.code === 'protocol' && !e.message.includes('secret'));
  });
}

test('list reads one approved endpoint, no auto-enable, filters invalid/echoed IDs', async () => {
  const calls = [];
  const result = await api.discoverModels(scope(), { headers, fetcher: async (url, options) => {
    calls.push([url, options]);
    return json({ data: [{ id: 'demo' }, { id: 'demo' }, { id: 'SYNTHETIC_SECRET_NEVER_PRINT' }, { id: '\u001b[31mattack' }, { id: 'other/model-2' }, { id: 'a'.repeat(300) }] });
  } });
  assert.deepEqual([...result], ['demo', 'other/model-2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://example.test/v1/models');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].body, undefined);
});

test('list bound is explicit and deduplicated', async () => {
  const result = await api.discoverModels(scope(), { fetcher: async () => json({ data: Array.from({ length: 1005 }, (_, i) => ({ id: `m-${i}` })) }) });
  assert.equal(result.length, 1000);
});

for (const [protocol, suffix, output] of [
  ['openai-completions', '/chat/completions', { choices: [{ message: { content: 'MODEL_PICK_OK' } }] }],
  ['openai-responses', '/responses', { output: [{ content: [{ type: 'output_text', text: 'MODEL_PICK_OK' }] }] }],
  ['anthropic-messages', '/messages', { content: [{ type: 'text', text: 'MODEL_PICK_OK' }] }],
  ['google-generative-ai', '/models/demo:generateContent', { candidates: [{ content: { parts: [{ text: 'MODEL_PICK_OK' }] } }] }],
]) {
  test(`${protocol}: bounded synthetic text probe, no unproved metadata promotion`, async () => {
    const calls = [];
    const report = await api.probeText(scope(protocol), { headers, fetcher: async (url, options) => {
      calls.push([url, options]); return json(output);
    } });
    assert.equal(report.code, 'ok');
    assert.equal(report.status, 'passed');
    assert.deepEqual(Object.keys(report.fields), []);
    assert.deepEqual([...report.verifiedFields], []);
    assert.equal(calls.length, 1);
    assert.ok(calls[0][0].endsWith(suffix));
    const body = JSON.parse(calls[0][1].body);
    assert.ok([body.max_tokens, body.max_output_tokens, body.generationConfig?.maxOutputTokens].includes(32));
    assert.ok(!JSON.stringify(report).includes('SYNTHETIC_SECRET'));
    assert.ok(!JSON.stringify(body).includes('SYNTHETIC_SECRET'));
  });
}

for (const [status, expected] of [[401, 'auth'], [403, 'auth'], [429, 'limited'], [500, 'server'], [400, 'protocol']]) {
  test(`HTTP ${status}: error body is neither retained nor classified as unsupported`, async () => {
    const report = await api.probeText(scope(), { fetcher: async () => json({ error: 'Bearer SYNTHETIC_SECRET_NEVER_PRINT' }, status) });
    assert.equal(report.code, expected);
    assert.equal(report.status, 'inconclusive');
    assert.ok(!JSON.stringify(report).includes('SYNTHETIC_SECRET'));
  });
}

test('raw transport exception is redacted', async () => {
  const report = await api.probeText(scope(), { fetcher: async () => { throw new Error('SYNTHETIC_SECRET_NEVER_PRINT'); } });
  assert.equal(report.code, 'network');
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_SECRET'));
});

test('oversized response cannot become evidence or leak body', async () => {
  const report = await api.probeText(scope(), { fetcher: async () => new Response('SYNTHETIC_SECRET_NEVER_PRINT' + 'x'.repeat(300000)) });
  assert.equal(report.code, 'protocol');
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_SECRET'));
});

test('timeout aborts and settles even a fetch double that ignores the signal', async () => {
  let signal;
  const report = await api.probeText(scope(), { timeoutMs: 5, fetcher: async (_url, opts) => { signal = opts.signal; return new Promise(() => {}); } });
  assert.equal(report.code, 'timeout');
  assert.equal(signal.aborted, true);
});

test('cancelled probes do not start another request', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const report = await api.probeText(scope(), { signal: controller.signal, fetcher: async () => { calls++; return json({}); } });
  assert.equal(calls, 0); assert.equal(report.code, 'cancelled');
});

test('unapproved response origin is rejected', async () => {
  const report = await api.probeText(scope(), { fetcher: async () => {
    const response = json({ choices: [{ message: { content: 'MODEL_PICK_OK' } }] });
    Object.defineProperty(response, 'url', { value: 'https://unapproved.test/echo' });
    return response;
  } });
  assert.equal(report.code, 'protocol');
});

test('model ID cannot traverse a request path or inject a query', async () => {
  for (const modelId of ['../secret', 'models/../secret', 'demo?key=secret']) {
    let calls = 0;
    await assert.rejects(() => api.probeText({ ...scope('google-generative-ai'), modelId }, { fetcher: async () => { calls++; return json({}); } }));
    assert.equal(calls, 0);
  }
});

test('Basic credentials, decoded password and short API keys cannot be reflected as IDs', async () => {
  const payload = Buffer.from('usr:secretxy').toString('base64');
  for (const prefix of ['Basic ', ' Basic ', '\tBasic\t', ' \tBasic \t']) {
    const ids = await api.discoverModels(scope(), { headers: { authorization: `${prefix}${payload}\t` }, fetcher: async () => json({ data: [{ id: payload }, { id: 'secretxy' }, { id: 'usr' }, { id: 'model-safe' }] }) });
    assert.deepEqual([...ids], ['model-safe']);
  }
  const short = await api.discoverModels(scope(), { headers: { 'x-api-key': 'abc' }, fetcher: async () => json({ data: [{ id: 'abc' }, { id: 'model-safe' }] }) });
  assert.deepEqual([...short], ['model-safe']);
});

test('whole operation deadline covers a stalled auth resolver and forbids late requests', async () => {
  const controller = new AbortController(); let release; let calls = 0;
  const auth = new Promise((resolve) => { release = resolve; });
  await assert.rejects(() => api.withProbeDeadline(async () => {
    await auth;
    if (controller.signal.aborted) throw new api.ProbeError('cancelled');
    calls++; return 'unexpected';
  }, controller, 5), (e) => e.code === 'timeout');
  release({ fake: true }); await new Promise(setImmediate);
  assert.equal(calls, 0);
});

test('whole operation cancellation returns before late auth and does not start a request', async () => {
  const controller = new AbortController(); let release; let calls = 0;
  const auth = new Promise((resolve) => { release = resolve; });
  const result = api.withProbeDeadline(async () => {
    await auth;
    if (controller.signal.aborted) throw new api.ProbeError('cancelled');
    calls++;
  }, controller);
  controller.abort();
  await assert.rejects(() => result, (e) => e.code === 'cancelled');
  release(); await new Promise(setImmediate); assert.equal(calls, 0);
});

test('synchronously blocked auth cannot outrun the deadline before timers get a turn', async () => {
  const controller = new AbortController(); let requests = 0;
  await assert.rejects(() => api.withProbeDeadline(async (checkDeadline) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 12);
    checkDeadline(); requests++;
  }, controller, 5), (error) => error.code === 'timeout');
  assert.equal(requests, 0);
});

test('the final pre-fetch deadline check also refuses an overdue request', async () => {
  let requests = 0;
  const result = await api.probeText(scope(), { checkDeadline: () => { throw new api.ProbeError('timeout'); }, fetcher: async () => { requests++; return json({}); } });
  assert.equal(result.code, 'timeout'); assert.equal(requests, 0);
});

test('Google list uses name IDs and never returns arbitrary server prose', async () => {
  const ids = await api.discoverModels(scope('google-generative-ai'), { fetcher: async () => json({ models: [{ name: 'models/demo' }, { name: 'model with spaces', description: 'secret' }] }) });
  assert.deepEqual([...ids], ['models/demo']);
});
