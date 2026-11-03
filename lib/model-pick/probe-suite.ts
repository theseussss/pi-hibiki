import { ProbeError, probeRequest, type ProbeCode, type ProbeOptions } from './probe.js';
import type { Scope } from './reference.js';

/** A bounded fixed suite. This is endpoint acceptance, never proof of internal reasoning. */
export const SUITE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type SuiteLevel = (typeof SUITE_LEVELS)[number];
export type SuiteStatus = 'passed' | 'inconclusive' | 'not-tested';
export type SuiteCheck = { status: SuiteStatus; code?: ProbeCode };
export type SuiteReport = {
  scope: Scope; startedAt: number; finishedAt: number; cancelled: boolean; timedOut: boolean;
  checks: { text: SuiteCheck; stream: SuiteCheck; tools: SuiteCheck; image: SuiteCheck; thinking: Record<SuiteLevel, SuiteCheck> };
};
export type SuiteProgress = { completed: number; total: number; current: string; checks: SuiteReport['checks'] };
const TOKEN_LIMIT = 64;
export const SUITE_MAX_REQUESTS = 9;
export const SUITE_STANDARD_REQUESTS = 8;
export const SUITE_MAX_OUTPUT_TOKENS = SUITE_MAX_REQUESTS * TOKEN_LIMIT;
export const SUITE_MAX_DURATION_MS = 90_000;
const SENTINEL = 'HIBIKI_PROBE_OK';
const TOOL = 'hibiki_probe';
const PROBE_CODES = new Set<ProbeCode>(['ok', 'auth', 'limited', 'server', 'protocol', 'timeout', 'cancelled', 'network', 'unsupported']);
/** Treat persisted observations as untrusted data; return only bounded known fields. */
export function copySuiteChecks(value: unknown): SuiteReport['checks'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const read = (v: unknown): SuiteCheck | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const item = v as Record<string, unknown>;
    if (!['passed', 'inconclusive', 'not-tested'].includes(item.status as string)) return undefined;
    if (item.code !== undefined && !PROBE_CODES.has(item.code as ProbeCode)) return undefined;
    if (item.status === 'passed' && item.code !== 'ok') return undefined;
    return { status: item.status as SuiteStatus, ...(item.code === undefined ? {} : { code: item.code as ProbeCode }) };
  };
  if (!raw.thinking || typeof raw.thinking !== 'object' || Array.isArray(raw.thinking)) return undefined;
  const thinking = raw.thinking as Record<string, unknown>; const result = initialChecks();
  for (const name of ['text', 'stream', 'tools', 'image'] as const) { const check = read(raw[name]); if (!check) return undefined; result[name] = check; }
  for (const name of SUITE_LEVELS) { const check = read(thinking[name]); if (!check) return undefined; result.thinking[name] = check; }
  return result;
}
// Fixed 16×16 red PNG, synthetic sample; never reads a user file.
const SAMPLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP8z0AaYCJR/aiGUQ1DSAMAQC4BH2bjRnMAAAAASUVORK5CYII=';

function cloneChecks(checks: SuiteReport['checks']): SuiteReport['checks'] {
  return JSON.parse(JSON.stringify(checks)) as SuiteReport['checks'];
}
function initialChecks(): SuiteReport['checks'] {
  return { text: { status: 'not-tested' }, stream: { status: 'not-tested' }, tools: { status: 'not-tested' }, image: { status: 'not-tested' },
    thinking: Object.fromEntries(SUITE_LEVELS.map(level => [level, { status: 'not-tested' }])) as Record<SuiteLevel, SuiteCheck> };
}
function prepare(scope: Scope, task: 'text' | 'stream' | 'tools' | 'image' | SuiteLevel): { suffix: string; body: object } | undefined {
  if (scope.api !== 'openai-completions' && scope.api !== 'openai-responses') return undefined;
  const chat = scope.api === 'openai-completions';
  const prompt = task === 'tools' ? 'Call the supplied tool exactly once.'
    : task === 'image' ? 'What is the main color of this image? Reply with one word: RED, BLUE, GREEN, YELLOW, ORANGE, PURPLE, WHITE, or GRAY.' : `Reply with exactly ${SENTINEL}.`;
  const body: Record<string, unknown> = chat
    ? { model: scope.modelId, messages: [{ role: 'user', content: prompt }], max_tokens: TOKEN_LIMIT, stream: false }
    : { model: scope.modelId, input: prompt, max_output_tokens: TOKEN_LIMIT, store: false };
  if (task === 'image') {
    const image = `data:image/png;base64,${SAMPLE_PNG}`;
    if (chat) body.messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] }];
    else body.input = [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: image }] }];
  } else if (task === 'stream') body.stream = true;
  else if (task === 'tools') {
    const schema = { type: 'object', properties: {}, additionalProperties: false };
    body.tools = chat ? [{ type: 'function', function: { name: TOOL, description: 'Synthetic connectivity test', parameters: schema } }]
      : [{ type: 'function', name: TOOL, description: 'Synthetic connectivity test', parameters: schema }];
    body.tool_choice = chat ? { type: 'function', function: { name: TOOL } } : { type: 'function', name: TOOL };
  } else if (task !== 'text') {
    if (chat) body.reasoning_effort = task;
    else body.reasoning = { effort: task };
  }
  return { suffix: chat ? 'chat/completions' : 'responses', body };
}
function validResponse(scope: Scope, task: 'text' | 'stream' | 'tools' | 'image' | SuiteLevel, data: any): boolean {
  if (task === 'stream') return data?.completed === true && typeof data?.text === 'string' && data.text.trim() === SENTINEL;
  if (task === 'tools') {
    const emptyArguments = (raw: unknown) => {
      if (typeof raw !== 'string' || raw.length > 1024) return false;
      try { const value: unknown = JSON.parse(raw); return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0; } catch { return false; }
    };
    if (scope.api === 'openai-completions') {
      const calls = data?.choices?.[0]?.message?.tool_calls;
      return Array.isArray(calls) && calls.length === 1 && calls[0]?.type === 'function' &&
        typeof calls[0]?.id === 'string' && calls[0].id.length > 0 && calls[0]?.function?.name === TOOL && emptyArguments(calls[0]?.function?.arguments);
    }
    const calls = Array.isArray(data?.output) ? data.output.filter((item: any) => item?.type === 'function_call') : [];
    return calls.length === 1 && typeof calls[0]?.call_id === 'string' && calls[0].call_id.length > 0 &&
      calls[0]?.name === TOOL && emptyArguments(calls[0]?.arguments);
  }
  if (task !== 'text' && task !== 'image') {
    // A successful, well-formed model response means the endpoint accepted the
    // parameter; the server may ignore or rewrite it, so do not call it execution.
    if (scope.api === 'openai-completions') return Array.isArray(data?.choices) && data.choices.length > 0
      && data.choices[0]?.message !== null && typeof data.choices[0]?.message === 'object' && !Array.isArray(data.choices[0].message)
      && ['stop', 'length', 'tool_calls', 'content_filter'].includes(data.choices[0]?.finish_reason);
    return Array.isArray(data?.output) && typeof data?.status === 'string'
      && (data.status === 'completed' || data.status === 'incomplete');
  }
  const text = scope.api === 'openai-completions' ? data?.choices?.[0]?.message?.content
    : Array.isArray(data?.output) ? data.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
      .filter((item: any) => item?.type === 'output_text').map((item: any) => item.text).join('') : undefined;
  return typeof text === 'string' && text.trim() === (task === 'image' ? 'RED' : SENTINEL);
}

/** Never stores headers, request or response bodies; caller owns consent and durable protection. */
export async function probeSuite(scope: Scope, options: ProbeOptions & { onProgress?: (progress: SuiteProgress) => void; totalTimeoutMs?: number; includeImage?: boolean } = {}): Promise<SuiteReport> {
  const startedAt = Date.now(); const checks = initialChecks(); let completed = 0;
  const tasks: Array<'text' | 'stream' | 'tools' | 'image' | SuiteLevel> = ['text', 'stream', 'tools', ...(options.includeImage ? ['image' as const] : []), ...SUITE_LEVELS];
  let cancelled = false; let timedOut = false;
  const timeout = options.totalTimeoutMs ?? SUITE_MAX_DURATION_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > SUITE_MAX_DURATION_MS) throw new ProbeError('protocol');
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const deadline = performance.now() + timeout;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const checkDeadline = () => {
    if (performance.now() >= deadline) { timedOut = true; controller.abort(); throw new ProbeError('timeout'); }
    if (controller.signal.aborted) throw new ProbeError(timedOut ? 'timeout' : 'cancelled');
    options.checkDeadline?.();
  };
  try {
  for (const task of tasks) {
    if (controller.signal.aborted) { cancelled = !timedOut; break; }
    const request = prepare(scope, task);
    if (!request) break; // Other protocols remain explicitly untested, never guessed.
    options.onProgress?.({ completed, total: tasks.length, current: task, checks: cloneChecks(checks) });
    let result: SuiteCheck;
    try {
      const response = await probeRequest(scope, request.suffix, 'POST', request.body, { ...options, signal: controller.signal, checkDeadline, eventStream: task === 'stream' });
      result = validResponse(scope, task, response) ? { status: 'passed', code: 'ok' } : { status: 'inconclusive', code: 'protocol' };
    } catch (error) {
      const code: ProbeCode = error instanceof ProbeError ? error.code : 'network';
      if (controller.signal.aborted) { cancelled = !timedOut; break; }
      if (code === 'cancelled') { cancelled = true; break; }
      result = { status: 'inconclusive', code };
    }
    if (task === 'text' || task === 'stream' || task === 'tools' || task === 'image') checks[task] = result;
    else checks.thinking[task] = result;
    completed++;
    // Stop on auth/limit/transport errors rather than consuming budget repeatedly.
    if (result.code === 'auth' || result.code === 'limited' || result.code === 'network' || result.code === 'timeout' || result.code === 'server') break;
  }
  options.onProgress?.({ completed, total: tasks.length, current: '', checks: cloneChecks(checks) });
  return { scope: { ...scope }, startedAt, finishedAt: Date.now(), cancelled, timedOut, checks };
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', forwardAbort); }
}
