import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { piRoot } from '../scripts/tooling.mjs';

// Actual installed Pi model helpers and provider adapters, synthetic configuration.
// onPayload stops before HTTP; no credentials, real agent config or network.
const root = path.join(piRoot(), 'node_modules/@earendil-works/pi-ai/dist');
const { getSupportedThinkingLevels } = await import(pathToFileURL(path.join(root, 'models.js')));
const context = { messages: [{ role: 'user', content: 'synthetic', timestamp: 1 }] };
for (const [api, file, field] of [
  ['openai-completions', 'openai-completions.js', 'reasoning_effort'],
  ['openai-responses', 'openai-responses.js', 'reasoning'],
]) {
  test(`Pi ${api} exposes and sends configured xhigh/max mapping`, async () => {
    const { streamSimple } = await import(pathToFileURL(path.join(root, 'api', file)));
    const model = { id: 'synthetic-thinking-model', name: 'Synthetic', provider: 'synthetic', api,
      baseUrl: 'https://synthetic.invalid/v1', reasoning: true, input: ['text'], contextWindow: 8192,
      maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { minimal: null, xhigh: 'vendor-xhigh', max: 'vendor-max' } };
    assert.deepEqual(getSupportedThinkingLevels(model), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    for (const level of ['xhigh', 'max']) {
      let payload;
      const result = await streamSimple(model, context, { apiKey: 'synthetic', reasoning: level,
        onPayload(value) { payload = value; throw new Error('stop before HTTP'); },
        fetch() { throw new Error('network forbidden'); } }).result();
      assert.equal(result.stopReason, 'error');
      assert.ok(payload);
      assert.equal(field === 'reasoning' ? payload.reasoning.effort : payload[field], `vendor-${level}`);
    }
  });
}
