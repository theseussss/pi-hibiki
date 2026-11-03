import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTypeScript } from './model-pick-loader.mjs';
const api = loadTypeScript(fileURLToPath(new URL('../lib/model-pick/probe-suite.ts', import.meta.url)));
const scope = apiName => ({ provider: 'synthetic', modelId: 'model', endpoint: 'https://synthetic.invalid/v1', api: apiName, credentialVersion: 'synthetic-version' });
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
for (const protocol of ['openai-completions', 'openai-responses']) {
  test(`${protocol} suite runs bounded sequential fixed requests with explicit acceptance only`, async () => {
    const requests = []; const progress = [];
    const report = await api.probeSuite(scope(protocol), { headers: { authorization: 'Bearer SYNTHETIC_SECRET' }, onProgress: p => progress.push(JSON.parse(JSON.stringify(p))), fetcher: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, body, options });
      if (body.stream) {
        const chunks = protocol === 'openai-completions'
          ? [{ choices: [{ delta: { content: 'HIBIKI_' } }] }, { choices: [{ delta: { content: 'PROBE_OK' }, finish_reason: 'stop' }] }]
          : [{ type: 'response.output_text.delta', delta: 'HIBIKI_PROBE_OK' }, { type: 'response.completed' }];
        return new Response(chunks.map(v => `data: ${JSON.stringify(v)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (body.tools) return response(protocol === 'openai-completions'
        ? { choices: [{ message: { tool_calls: [{ id: 'test-call', type: 'function', function: { name: 'hibiki_probe', arguments: '{}' } }] } }] }
        : { output: [{ type: 'function_call', call_id: 'test-call', name: 'hibiki_probe', arguments: '{}' }] });
      if (body.reasoning_effort || body.reasoning) return response(protocol === 'openai-completions' ? { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } : { status: 'completed', output: [] });
      return response(protocol === 'openai-completions' ? { choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] } : { output: [{ content: [{ type: 'output_text', text: 'HIBIKI_PROBE_OK' }] }] });
    } });
    assert.equal(requests.length, 8); assert.equal(api.SUITE_MAX_REQUESTS, 9); assert.equal(api.SUITE_MAX_OUTPUT_TOKENS, 576);
    assert.equal(report.checks.text.status, 'passed'); assert.equal(report.checks.tools.status, 'passed');
    assert.equal(report.checks.thinking.max.status, 'passed'); assert.equal(report.checks.stream.status, 'passed'); assert.equal(report.checks.image.status, 'not-tested');
    assert.equal(progress.at(-1).completed, 8); assert.ok(!JSON.stringify(report).includes('SYNTHETIC_SECRET'));
    assert.ok(requests.every(r => r.options.redirect === 'error' && r.options.credentials === 'omit'));
    assert.deepEqual(requests.slice(3).map(r => r.body.reasoning_effort ?? r.body.reasoning.effort), ['low','medium','high','xhigh','max']);
  });
}
test('optional synthetic image is sent only on explicit opt-in and reported separately', async () => {
  for (const protocol of ['openai-completions', 'openai-responses']) {
    const sent = [];
    const result = await api.probeSuite(scope(protocol), { includeImage: true, fetcher: async (_url, options) => {
      const body = JSON.parse(options.body); sent.push(body);
      if (body.stream) return new Response(protocol === 'openai-completions'
        ? `data: ${JSON.stringify({ choices: [{ delta: { content: 'HIBIKI_PROBE_OK' }, finish_reason: 'stop' }] })}\n\n`
        : `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'HIBIKI_PROBE_OK' })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      if (body.tools) return response(protocol === 'openai-completions' ? { choices: [{ message: { tool_calls: [{ id: 'test-call', type: 'function', function: { name: 'hibiki_probe', arguments: '{}' } }] } }] } : { output: [{ type: 'function_call', call_id: 'test-call', name: 'hibiki_probe', arguments: '{}' }] });
      if (body.reasoning_effort || body.reasoning) return response(protocol === 'openai-completions' ? { choices: [{ message: {}, finish_reason: 'stop' }] } : { status: 'completed', output: [] });
      const answer = JSON.stringify(body).includes('data:image/png;base64,') ? 'RED' : 'HIBIKI_PROBE_OK';
      return response(protocol === 'openai-completions' ? { choices: [{ message: { content: answer } }] } : { output: [{ content: [{ type: 'output_text', text: answer }] }] });
    } });
    assert.equal(sent.length, 9); assert.equal(result.checks.image.status, 'passed');
    assert.match(JSON.stringify(sent[3]), /data:image\/png;base64,/);
    assert.ok(sent.filter(body => JSON.stringify(body).includes('data:image/png;base64,')).length === 1);
  }
});

test('tool calls must include one ID, name and valid empty JSON arguments', async () => {
  for (const call of [
    { type: 'function', function: { name: 'hibiki_probe', arguments: '{}' } },
    { id: 'x', type: 'function', function: { name: 'hibiki_probe', arguments: '{broken' } },
    { id: 'x', type: 'function', function: { name: 'hibiki_probe', arguments: '{"extra":1}' } },
  ]) {
    const report = await api.probeSuite(scope('openai-completions'), { fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.tools) return response({ choices: [{ message: { tool_calls: [call] } }] });
      if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'HIBIKI_PROBE_OK' }, finish_reason: 'stop' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      if (body.reasoning_effort) return new Response('', { status: 429 });
      return response({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] });
    } });
    assert.equal(report.checks.tools.status, 'inconclusive');
  }
});

test('malformed reasoning responses cannot become passing evidence', async () => {
  let calls = 0; const report = await api.probeSuite(scope('openai-completions'), { fetcher: async (_url, options) => {
    calls++; const body = JSON.parse(options.body);
    if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'HIBIKI_PROBE_OK' }, finish_reason: 'stop' }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    if (body.tools) return response({ choices: [{ message: { tool_calls: [{ id: 'x', type: 'function', function: { name: 'hibiki_probe', arguments: '{}' } }] } }] });
    if (body.reasoning_effort) return response({ choices: [{ message: [], finish_reason: 'not-a-real-reason' }] });
    return response({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] });
  } });
  assert.equal(calls, 8); assert.equal(report.checks.thinking.max.status, 'inconclusive');
});

test('limit and auth stop the suite without inferring unsupported', async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0; const report = await api.probeSuite(scope('openai-completions'), { fetcher: async () => { calls++; return new Response('SYNTHETIC_SECRET', { status }); } });
    assert.equal(calls, 1); assert.equal(report.checks.text.status, 'inconclusive'); assert.equal(report.checks.tools.status, 'not-tested');
    assert.ok(!JSON.stringify(report).includes('SYNTHETIC_SECRET'));
  }
});
test('cancellation preserves completed outcomes and sends no later request', async () => {
  const controller = new AbortController(); let calls = 0;
  const report = await api.probeSuite(scope('openai-completions'), { signal: controller.signal, fetcher: async () => {
    calls++; if (calls === 2) { controller.abort(); return new Promise(() => {}); }
    return response({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] });
  } });
  assert.equal(calls, 2); assert.equal(report.cancelled, true); assert.equal(report.checks.text.status, 'passed');
  assert.equal(report.checks.stream.status, 'not-tested');
});
test('cancellation of a stalled streaming body releases its reader and never starts a later request', async () => {
  const controller = new AbortController(); let calls = 0; let released = false; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const pending = api.probeSuite(scope('openai-completions'), { signal: controller.signal, fetcher: async (_url, options) => {
    calls++; const body = JSON.parse(options.body);
    if (!body.stream) return response({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] });
    const stream = new ReadableStream({ start() { started(); }, cancel() { released = true; } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  } });
  await ready; await new Promise(setImmediate); controller.abort(); const report = await pending;
  await new Promise(setImmediate); assert.equal(released, true); assert.equal(calls, 2);
  assert.equal(report.cancelled, true); assert.equal(report.checks.text.status, 'passed'); assert.equal(report.checks.stream.status, 'not-tested');
});

test('stream requires real event stream, intact text and completion; malformed output is never passed', async () => {
  for (const responseFactory of [
    () => response({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] }),
    () => new Response('data: {not json}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'HIBIKI_PROBE_OK' } }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
  ]) {
    let calls = 0;
    const report = await api.probeSuite(scope('openai-completions'), { fetcher: async (_url, options) => {
      calls++; const body = JSON.parse(options.body);
      if (body.stream) return responseFactory();
      if (calls > 2) return new Response('', { status: 429 });
      return response({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] });
    } });
    assert.equal(report.checks.stream.status, 'inconclusive'); assert.equal(report.checks.stream.code, 'protocol');
  }
});

test('whole-suite deadline aborts stalled request, preserves completed checks, and stops later requests', async () => {
  let calls = 0; let aborted = false;
  const report = await api.probeSuite(scope('openai-completions'), { totalTimeoutMs: 15, fetcher: async (_url, options) => {
    calls++;
    if (calls === 1) return response({ choices: [{ message: { content: 'HIBIKI_PROBE_OK' } }] });
    options.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } });
  assert.equal(calls, 2); assert.equal(aborted, true); assert.equal(report.timedOut, true); assert.equal(report.cancelled, false);
  assert.equal(report.checks.text.status, 'passed'); assert.equal(report.checks.stream.status, 'not-tested');
});

test('unsupported protocols and unsafe targets do not lead to arbitrary requests', async () => {
  let calls = 0; const fetcher = async () => { calls++; return response({}); };
  const unsupported = await api.probeSuite(scope('anthropic-messages'), { fetcher });
  assert.equal(calls, 0); assert.equal(unsupported.checks.text.status, 'not-tested');
  const unsafe = await api.probeSuite({ ...scope('openai-completions'), endpoint: 'http://synthetic.invalid' }, { fetcher });
  assert.equal(calls, 0); assert.equal(unsafe.checks.text.status, 'inconclusive');
});
