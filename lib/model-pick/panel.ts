import { Input } from '@earendil-works/pi-tui';
import { randomUUID } from 'node:crypto';
import { PickerStore, StoreError, type Guard, type ModelInput, type ProviderInput, type ModelLimitValues, type ModelLimitPatch } from './store.js';
import { copyThinkingLevelMap, findModelTemplate, resolveModelFields, THINKING_LEVELS, type Scope, type ThinkingLevelMap } from './reference.js';
import { discoverModels, validateEndpoint, withProbeDeadline, ProbeError, type ProbeCode } from './probe.js';
import { copySuiteChecks, probeSuite, SUITE_STANDARD_REQUESTS, SUITE_MAX_REQUESTS, SUITE_MAX_DURATION_MS, SUITE_LEVELS, type SuiteReport, type SuiteProgress } from './probe-suite.js';
import { PickerRecords, RecordError } from './records.js';
import type { Paint } from './controls.js';
import type { SheetContent } from './presentation.js';
import { SecretInput } from './secret-input.js';
import { validApiKey } from './auth-file.js';
import type { FastController } from '../fast.js';
import type { ProviderCommitBackend, ProviderChange, CommitResult } from './provider-commit.js';
import type { PickerTaskSnapshot, PickerCommand, PickerAction, PickerActionId, PrivateFormPort, PrivateFormField, ModelParameters, ModelField, FieldEvidence, ModelDiff, ModelRef, ConnectionTarget, ProbePlan, SessionFast, PickerTarget, FieldValue } from './workspace.js';

export interface ActionTarget { provider?: string; modelId?: string; kind?: 'model' | 'provider' }
export interface ModelLimitsState {
  revision: string;
  effective: { contextWindow: number; maxTokens: number };
  overrides: ModelLimitValues;
  catalog: ModelLimitValues | null;
  catalogNote?: string;
}
export interface ModelLimitsHost {
  /** Pure capability check; the read/commit ports own live profile/catalog guards. */
  canEdit(provider: string, modelId: string): boolean;
  read(provider: string, modelId: string): ModelLimitsState;
  commit(provider: string, modelId: string, patch: ModelLimitPatch, expectedRevision: string): void;
}
export interface ActionHost {
  modelLimits?: ModelLimitsHost;
  store: PickerStore;
  records: PickerRecords;
  catalog(): Array<{ provider: string; id: string; [key: string]: any }>;
  guard(): Guard;
  changed(target?: { provider: string; modelId?: string }): Promise<void>;
  requestRender(): void;
  flushRender?(): void;
  viewport?(): { width: number; height: number } | undefined;
  auth(provider: string, modelId?: string): Promise<{ scope: Scope; headers: Record<string, string> }>;
  authDraft?(provider: ProviderInput, modelId: string, key?: string): Promise<{ scope: Scope; headers: Record<string, string> }>;
  /** Deprecated compatibility property. Never used by this controller. */
  saveKey?(provider: string, key: string): void;
  providerCommit?: ProviderCommitBackend;
  storageWritable?: boolean;
  /** Refresh host-owned cached storage presentation after an effect, never render. */
  storageStateChanged?(): void;
  authStatus?(provider: string): string;
  paint: Paint;
  isProtected?(provider: string): boolean;
  feedback?(message: string, error?: boolean): void;
  replace?(modelRef: ModelRef, targets: { current: boolean; default: boolean }, expected?: Guard): Promise<void>;
  available?(): Array<{ provider: string; id: string; name?: string }>;
  providerLabel?(provider: string): string;
  fast?: {
    snapshot(): ReturnType<FastController['snapshot']>;
    setTier(tier: Parameters<FastController['setTier']>[0]): boolean;
    describe(): string;
  };
}
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const FIELDS: ModelField[] = ['name', 'contextWindow', 'maxTokens', 'reasoning', 'input', 'thinkingLevelMap'];
const NAMES: Record<ModelField, string> = { name: '显示名', contextWindow: '上下文窗口', maxTokens: '输出上限', reasoning: '思考能力', input: '输入类型', thinkingLevelMap: '推理强度映射' };
const MAX_SELECTED = 100;
/** Explicit bounded authorization policy; selection/commit may still contain 100 models. */
const BATCH_MODELS = 3, BATCH_REQUESTS = 27, BATCH_DURATION = 270_000, AUTH_DURATION = 10_000, REPORT_TTL = 3_600_000;
const validId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+\-]{0,255}$/.test(id) && !id.split('/').some(p => p === '.' || p === '..') && !['__proto__', 'prototype', 'constructor'].includes(id);
const clean = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const supported = (api: string) => api === 'openai-completions' || api === 'openai-responses';
function input(value = ''): Input { const field = new Input({ prompt: '' }); field.setValue(value); field.handleInput('\x1b[F'); return field; }
function pendingChecks(): SuiteReport['checks'] {
  return { text: { status: 'not-tested' }, stream: { status: 'not-tested' }, tools: { status: 'not-tested' }, image: { status: 'not-tested' },
    thinking: Object.fromEntries(SUITE_LEVELS.map(level => [level, { status: 'not-tested' }])) as SuiteReport['checks']['thinking'] };
}
function failure(error: unknown): string {
  if (error instanceof StoreError) return `配置操作已停止（${error.code}）；请重新核对，未自动重试。`;
  if (error instanceof ProbeError) return `连接检查未完成（${error.code}）；不能据此判定不支持。`;
  if (error instanceof RecordError) return '安全记录无法保存；未使用明文替代。';
  return '操作无法安全完成；请核对当前状态，未自动重试。';
}
interface Field { id: string; label: string; input?: Input; choices?: string[]; choice?: number; hint?: string; advanced?: boolean; readonly?: boolean }
interface Form { viewId: string; fields: Field[]; changed(fieldId?: string): void; save(): void | Promise<void>; back(): void; reviewed?: string[] }
interface Row {
  model: ModelInput;
  original?: Partial<ModelInput> & { id: string };
  resolved: ReturnType<typeof resolveModelFields>;
  manual: boolean;
  suite?: SuiteReport;
  reportId?: string;
  reused: boolean;
  referenceWhen?: number;
  editedAt?: Partial<Record<ModelField, number>>;
  evidenceScope?: Scope;
  previous?: SuiteReport;
  suggested?: ThinkingLevelMap;
  usesPrevious?: boolean;
}
interface Flow {
  id: string; generation: number; mode: 'add' | 'inspect'; isNew: boolean;
  provider: ProviderInput; key?: string; revision: string; credentialRevision?: string;
  rows: Map<string, Row>; candidates: string[]; query: string;
  listStatus: 'idle' | 'loading' | 'loaded' | 'failed' | 'cancelled' | 'unsupported'; listMessage: string;
  listCounts?: { total: number; added: number; available: number };
  includeImage: boolean; cancelled: boolean; plan?: ProbePlan; planBindings?: Map<string, Binding>; readonly: boolean;
  approvedReferences?: Array<{ modelId: string; endpoint: string; api: string; fields: ModelInput }>;
  existingIds: Set<string>;
  referenceData?: ReturnType<PickerRecords['referenceData']>;
  catalogData: ReturnType<ActionHost['catalog']>;
}
interface Binding extends ConnectionTarget { modelId?: string; revision: string; generation: number; flowId: string; draft: boolean; unsafe?: boolean }
interface Undo { id: string; revision: string; label: string; provider: string; modelId?: string }
/** One authorized, durably started request. Never retain headers, bodies or a form. */
type ActiveAttempt = { attemptId: string; when: number; provider: string } & (
  { kind: 'discovery' } | { kind: 'probe'; scope: Scope; checks?: SuiteReport['checks'] }
);

/** Real task controller. No rendering/input router, synthetic engine, or second backend. */
export class PickerActions {
  private task: PickerTaskSnapshot | null = null;
  private flow?: Flow;
  private form?: Form;
  private forms = new Set<Form>();
  private listeners = new Set<() => void>();
  private secrets = new Set<SecretInput>();
  private redactions = new Set<string>();
  private disposed = false;
  private epoch = 0;
  private abort?: AbortController;
  private attempt?: ActiveAttempt;
  private undo: Undo | null = null;
  private taskFlowId = randomUUID();
  private back?: () => void;
  private route = new Map<string, () => void | Promise<void>>();
  private viewIds = new Map<string, string>();
  private replacementApplied = false;
  constructor(private readonly host: ActionHost) {}
  get active(): boolean { return this.task !== null; }
  get undoLabel(): string | null { return this.undo?.label ?? null; }
  taskSnapshot(): PickerTaskSnapshot | null { return this.task ? clone(this.task) : null; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { if (this.disposed) return; for (const listener of this.listeners) { try { listener(); } catch {} } this.host.requestRender(); }
  private publicText(value: unknown): string {
    let result = clean(value);
    const values = [...this.redactions, ...[...this.secrets].map(s => s.getValue()), this.flow?.key ?? ''].filter(Boolean).sort((a,b) => b.length - a.length);
    for (const secret of values) result = result.split(secret).join('[已遮蔽]');
    return result;
  }
  private parameters(m: ModelInput): ModelParameters {
    const p: { name?: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: ('text'|'image')[]; thinkingLevelMap?: ThinkingLevelMap } = { contextWindow: m.contextWindow, maxTokens: m.maxTokens, reasoning: m.reasoning, input: [] };
    if (typeof m.name === 'string') p.name = this.publicText(m.name);
    if (Number.isSafeInteger(m.contextWindow)) p.contextWindow = m.contextWindow;
    if (Number.isSafeInteger(m.maxTokens)) p.maxTokens = m.maxTokens;
    if (typeof m.reasoning === 'boolean') p.reasoning = m.reasoning;
    if (Array.isArray(m.input)) p.input = m.input.filter(x => x === 'text' || x === 'image');
    const map = copyThinkingLevelMap(m.thinkingLevelMap);
    if (map) p.thinkingLevelMap = Object.fromEntries(Object.entries(map).map(([k,v]) => [k, typeof v === 'string' ? this.publicText(v) : v]));
    return p;
  }
  private publicEndpoint(endpoint: string): string {
    try { const url = new URL(endpoint); if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[?#\s\\]/u.test(endpoint)) return '地址不可安全核对（不会发送请求）'; return this.publicText(endpoint); }
    catch { return ''; }
  }
  private connection(binding: ConnectionTarget | ProviderInput): ConnectionTarget { return { provider: this.publicText('provider' in binding ? binding.provider : binding.id), endpoint: this.publicEndpoint(binding.endpoint), api: this.publicText(binding.api) }; }
  private evidence(row: Row): FieldEvidence[] {
    return FIELDS.map(field => {
      const provenance = row.resolved.provenance[field];
      const index = provenance.source === 'tested' ? provenance.history.map(h => /^test\[(\d+)\]:selected$/.exec(h.reason)).find(Boolean)?.[1] : undefined;
      const proof = index === undefined ? undefined : this.flow?.referenceData?.tests[Number(index)];
      const when = row.editedAt?.[field] ?? proof?.testedAt ?? (provenance.source === 'manual' && row.original?.[field] === undefined ? row.referenceWhen : undefined);
      return { field, provenance: { source: provenance.source, history: provenance.history.map(h => ({ source: this.publicText(h.source), reason: this.publicText(h.reason) })) },
        ...(when === undefined ? {} : { when }), ...(proof ? { testId: this.publicText(proof.id) } : {}),
        ...(row.original && !equal(row.original[field],row.model[field]) ? { previous: row.original[field] === undefined ? { present: false as const } : { present: true as const, value: this.parameters(row.original as ModelInput)[field]! } } : {}),
        ...(row.reportId ? { conditions: ['短请求不证明最大窗口/输出；参数接受不证明内部推理执行。', ...(field === 'thinkingLevelMap' && row.previous ? [`此前同连接记录：${new Date(row.previous.startedAt).toISOString()}（有效期一小时）`, ...SUITE_LEVELS.map(level => `此前 ${level} · ${row.previous!.checks.thinking[level].status}`)] : [])] } : {}) };
    });
  }
  private action(id: PickerActionId, label: string, run: () => void | Promise<void>, options: Partial<PickerAction> = {}): PickerAction {
    const identity = options.identity ?? id;
    this.route.set(identity, run);
    return { id, identity, label, disabled: false, ...options };
  }
  private base(title: string, review = false, identity = title) {
    const flowId = this.flow?.id ?? this.taskFlowId, key = `${flowId}:${identity}`;
    let viewId = this.viewIds.get(key); if (!viewId) { viewId = randomUUID(); this.viewIds.set(key,viewId); }
    return { title, viewId, flowId, reviewToken: review ? randomUUID() : null };
  }
  private show(task: PickerTaskSnapshot, back?: () => void, form?: Form): void {
    // Whole-task cancellation is always available to Ctrl+C, even when a
    // confirmation exposes only its contextual Back/Cancel button. A durable
    // save/replacement critical section deliberately has no cancel route.
    if (!(task.kind === 'progress' && task.cancellation === 'none') && !task.actions.some(a => a.id === 'cancel-task')) {
      task = { ...task, actions: [...task.actions, this.action('cancel-task', '结束任务', () => this.leave())] };
    }
    this.task = task; this.back = back ?? (() => this.leave()); this.form = form; this.emit();
  }
  private beginView(): void { this.route.clear(); this.form = undefined; }
  private leave(): void {
    this.epoch++; this.abort?.abort(); this.abort = undefined;
    // Close before clearing redactions, but detach before any protected write.
    // Epoch invalidation already prevents auth/fetch continuations from doing work.
    const auditWarning = this.closeAttempt(this.attempt, 'cancelled');
    for (const secret of this.secrets) secret.setValue('');
    this.secrets.clear(); this.redactions.clear();
    for (const f of this.forms) { f.reviewed = undefined; f.save = () => {}; f.back = () => {}; f.changed = () => {}; }
    this.forms.clear(); this.form = undefined;
    if (this.flow) { this.flow.key = undefined; this.flow.rows.clear(); }
    this.flow = undefined; this.task = null; this.route.clear(); this.viewIds.clear(); this.back = undefined;
    this.connectionBack = undefined; this.fastBack = undefined; this.removal = undefined; this.basketId = undefined;
    this.emit();
    if (auditWarning) { try { this.host.feedback?.(auditWarning, true); } catch { /* Cancellation must still finish. */ } }
  }
  /** Exactly one bounded terminal write per started attempt, including auth cancellation.
   * All text is projected while private redactions still exist; failures never fall
   * back to plaintext, retry writes, or escape into task teardown. */
  private closeAttempt(attempt: ActiveAttempt | undefined, code: ProbeCode = 'ok', result?: { count?: number; suite?: SuiteReport; reportId?: string }): string | undefined {
    if (!attempt || this.attempt !== attempt) return;
    this.attempt = undefined;
    try {
      if (this.host.storageWritable === false || this.host.store.hasPending()) throw new RecordError();
      const text = (value: string) => this.publicText(value).slice(0, 8192) || 'unavailable';
      if (attempt.kind === 'discovery') {
        this.host.records.append({ kind: 'discovery', attemptId: attempt.attemptId, when: attempt.when, provider: text(attempt.provider), code, count: code === 'ok' ? Math.max(0, Math.min(1000, result?.count ?? 0)) : 0 });
      } else {
        const suite = result?.suite, scope = suite?.scope ?? attempt.scope;
        const testedAt = suite?.startedAt ?? attempt.when;
        const checks = copySuiteChecks(suite?.checks ?? attempt.checks);
        this.host.records.append({ kind: 'probe', attemptId: attempt.attemptId, report: {
          id: result?.reportId ?? randomUUID(),
          scope: { provider: text(scope.provider), modelId: text(scope.modelId), endpoint: text(scope.endpoint), api: text(scope.api), credentialVersion: text(scope.credentialVersion) },
          testedAt, expiresAt: testedAt + REPORT_TTL, status: 'inconclusive', fields: {}, verifiedFields: [],
          ...(checks ? { checks } : {}),
          cancelled: code === 'cancelled' || suite?.cancelled === true, timedOut: code === 'timeout' || suite?.timedOut === true, code, suiteVersion: 1,
        } });
      }
    } catch { return '检查记录未能保存；任务已停止，未写入明文替代。'; }
  }
  dispose(): void { if (this.disposed) return; this.leave(); this.disposed = true; this.listeners.clear(); this.host.store.lock(); }
  formFields(viewId: string): PrivateFormPort | undefined {
    const form = this.form;
    if (!form || form.viewId !== viewId || this.task?.viewId !== viewId) return undefined;
    return { viewId, fields: () => form.fields.map((f): PrivateFormField => f.input
      ? { id: f.id, label: f.label, readonly: !!f.readonly, kind: 'input', input: f.input, secret: f.input instanceof SecretInput, hint: f.hint, advanced: f.advanced }
      : { id: f.id, label: f.label, readonly: !!f.readonly, kind: 'choice', choices: f.choices ?? [], choice: () => f.choice ?? 0, setChoice: index => {
        if (this.form !== form || f.readonly || !Number.isInteger(index) || index < 0 || index >= (f.choices?.length ?? 0)) return;
        f.choice = index; form.changed(f.id);
      }, hint: f.hint, advanced: f.advanced }),
      changed: fieldId => { if (this.form === form && this.task?.viewId === viewId && form.fields.some(f => f.id === fieldId && !f.readonly)) form.changed(fieldId); } };
  }
  async dispatch(command: PickerCommand): Promise<void> {
    const task = this.task;
    if (this.disposed || !task || command.viewId !== task.viewId) return;
    try {
      if (command.type === 'basket-query' && task.kind === 'basket' && this.flow) { this.flow.query = command.query.slice(0, 8192); this.showBasket(true); return; }
      if (command.type === 'basket-toggle' && task.kind === 'basket') { this.toggle(command.modelId); return; }
      if (command.type !== 'activate') return;
      const action = task.actions.find(a => a.id === command.id && a.identity === command.identity);
      if (!action || action.disabled) return;
      if (action.requiresReview || action.id === 'commit-limits') {
        const p = command.review, size = this.host.viewport?.();
        if (!p || p.complete !== true || p.reviewToken !== task.reviewToken || !p.layoutId || !Number.isSafeInteger(p.renderEpoch) || p.renderEpoch < 1 || p.width < 24 || p.height < 6 || (size && (p.width !== size.width || p.height !== size.height))) {
          this.message('请先完整阅读当前目标与范围。'); return;
        }
      }
      if (command.id === 'adjust' && this.flow) { const row = this.flow.rows.get(command.payload.modelId); if (row) this.modelForm(row, () => task.kind === 'basket' ? this.showBasket() : this.showReport()); return; }
      if (command.id === 'image' && task.kind === 'preflight' && this.flow) { this.flow.includeImage = command.payload.include; this.preflight(); return; }
      if ((command.id === 'run' || command.id === 'reuse') && task.kind === 'preflight' && command.payload.planId !== task.plan.id) return;
      if (command.id === 'restore' && task.kind === 'archives') { if (command.identity === `restore:${command.payload.archiveId}`) this.restoreConsent(command.payload.archiveId); return; }
      if (command.id === 'replacement' && task.kind === 'confirm' && task.purpose === 'replacement') { this.replacementConsent(command.payload); return; }
      await this.route.get(action.identity)?.();
    } catch (error) { if (!this.disposed && this.task?.viewId === task.viewId) this.message(failure(error), true); }
  }
  private message(message: string, error = false): void { if (this.task) { this.task = { ...this.task, ...(error ? { error: message } : { message }) }; this.emit(); } }
  open(target: ActionTarget, intent: 'add' | 'remove' | 'edit' | 'inspect' | 'new-provider' | 'archives' | 'recover' = 'edit'): void {
    if (this.disposed || (this.task?.kind === 'progress' && this.task.cancellation === 'none')) return;
    this.leave(); this.taskFlowId = randomUUID(); this.replacementApplied = false;
    try {
      if (intent === 'new-provider' || (intent === 'add' && !target.provider)) this.connectionForm();
      else if (intent === 'archives') this.archives();
      else if (intent === 'recover') void this.recovery();
      else if (intent === 'remove') this.removeConsent(target);
      else if (intent === 'add') { this.createFlow(target.provider!); this.showBasket(); }
      else if (intent === 'edit' && (target.kind === 'provider' || !target.modelId)) this.connectionForm(target.provider);
      else if (target.provider && target.modelId) {
        // A native/registered target gets only the metadata port. Owned mutable
        // custom models retain their existing complete parameter editor.
        const own = this.host.store.snapshot().providers.find(p => p.id === target.provider)?.models.some(m => m.id === target.modelId);
        if (intent === 'edit' && (!own || this.host.isProtected?.(target.provider)) && this.host.modelLimits?.canEdit(target.provider, target.modelId)) {
          this.modelLimitsForm(target.provider, target.modelId); return;
        }
        this.createFlow(target.provider, target.modelId);
        if (intent === 'inspect') this.preflight();
        else this.modelForm(this.flow!.rows.get(target.modelId)!, () => this.leave(), true);
      } else this.info('未选择对象', ['请返回矩阵选择模型或供应商。']);
    } catch (error) { this.info('无法准备任务', [failure(error)]); }
  }
  private liveGuard(): Guard { return { ...this.host.guard(), recheck: () => this.host.guard() }; }
  private writable(provider?: string): void {
    if (this.host.storageWritable === false) throw new StoreError('PROTECTED');
    if (this.host.guard().busy) throw new StoreError('BUSY');
    if (provider && this.host.isProtected?.(provider)) throw new StoreError('PROTECTED');
  }
  private assertFlow(flow: Flow, generation = flow.generation): void {
    if (this.disposed || this.flow !== flow || flow.generation !== generation) throw new ProbeError('cancelled');
    // Never cache this: auth-only/external pending work can appear after review,
    // during auth, or between suite items. Unreadable pending state also blocks.
    try { if (this.host.store.hasPending()) throw new StoreError('PENDING'); }
    catch { throw new StoreError('PENDING'); }
    if (this.host.store.snapshot().revision !== flow.revision) throw new StoreError('CONFLICT');
  }
  private binding(flow: Flow, modelId?: string): Binding {
    this.assertFlow(flow);
    let endpoint = flow.provider.endpoint, api = flow.provider.api, unsafe = false;
    if (!flow.isNew) {
      const p = this.host.store.snapshot().providers.find(p => p.id === flow.provider.id);
      const m = modelId ? this.host.catalog().find(m => m.provider === flow.provider.id && m.id === modelId) : undefined;
      endpoint = m?.baseUrl || p?.endpoint || ''; api = m?.api || p?.api || '';
      unsafe = !m?.baseUrl && p?.referenceUnsafe === true;
    }
    return { provider: flow.provider.id, endpoint, api, modelId, revision: flow.revision, generation: flow.generation, flowId: flow.id, draft: flow.isNew, unsafe };
  }
  private requestable(binding: ConnectionTarget & { unsafe?: boolean }): boolean {
    try { validateEndpoint(binding.endpoint); return !binding.unsafe && !/[?#\s\\]/u.test(binding.endpoint) && /^https:\/\//i.test(binding.endpoint) && APIS.includes(binding.api); }
    catch { return false; }
  }
  private checkBinding(flow: Flow, expected: Binding, scope?: Scope): void {
    this.assertFlow(flow, expected.generation);
    if (this.host.guard().busy) throw new StoreError('BUSY');
    const current = this.binding(flow, expected.modelId);
    if (current.flowId !== expected.flowId || current.endpoint !== expected.endpoint || current.api !== expected.api || current.draft !== expected.draft || current.unsafe !== expected.unsafe || (scope && (scope.provider !== expected.provider || scope.endpoint !== expected.endpoint || scope.api !== expected.api || (expected.modelId !== undefined && scope.modelId !== expected.modelId)))) throw new StoreError('CONFLICT');
  }
  private async auth(flow: Flow, binding: Binding, controller: AbortController) {
    return withProbeDeadline(async deadline => {
      this.checkBinding(flow, binding); deadline();
      if (this.host.storageWritable === false) throw new StoreError('PROTECTED');
      if (!this.requestable(binding)) throw new ProbeError('unsupported');
      const result = flow.isNew ? await this.host.authDraft?.(flow.provider, binding.modelId ?? 'catalog', flow.key) : await this.host.auth(binding.provider, binding.modelId);
      deadline(); if (!result) throw new ProbeError('unsupported');
      this.checkBinding(flow, binding, result.scope);
      for (const value of Object.values(result.headers)) {
        this.redactions.add(value); const payload = value.replace(/^\S+\s+/, ''); if (payload) this.redactions.add(payload);
      }
      const credentialVersion = this.host.records.credentialVersion(result.headers);
      deadline(); this.checkBinding(flow, binding, result.scope);
      return { headers: result.headers, scope: { provider: binding.provider, modelId: binding.modelId ?? result.scope.modelId, endpoint: binding.endpoint, api: binding.api, credentialVersion } };
    }, controller, AUTH_DURATION);
  }
  private createFlow(provider: string, modelId?: string, draft?: { value: ProviderInput; key?: string; revision: string }): Flow {
    const summary = this.host.store.snapshot();
    const p = summary.providers.find(p => p.id === provider);
    const own = p?.models.find(m => m.id === modelId);
    if (own?.invalidThinkingLevelMap) throw new StoreError('INVALID_INPUT');
    if (!draft && !p && !this.host.catalog().some(m => m.provider === provider)) throw new StoreError('NOT_FOUND');
    const readonly = !!this.host.isProtected?.(provider) || !p || this.host.storageWritable === false;
    if (!modelId && !draft) { this.writable(provider); if (!p) throw new StoreError('PROTECTED'); }
    const flow: Flow = { id: this.taskFlowId, generation: (this.flow?.generation ?? -1) + 1, mode: modelId ? 'inspect' : 'add', isNew: !!draft,
      provider: draft?.value ?? { id: provider, name: p?.name ?? provider, endpoint: p?.endpoint ?? '', api: p?.api ?? '' },
      key: draft?.key, revision: draft?.revision ?? summary.revision, rows: new Map(),
      candidates: draft ? [] : [...new Set(this.host.catalog().filter(m => m.provider === provider && !p?.models.some(x => x.id === m.id)).map(m => m.id))],
      query: '', listStatus: 'idle', listMessage: '尚未读取上游清单；当前仅显示本地同供应商候选。规格仍需核对，可读取清单或手动输入 ID。', includeImage: false, cancelled: false, readonly: draft ? false : readonly,
      existingIds: new Set(p?.models.map(m => m.id) ?? []), catalogData: this.host.catalog(), referenceData: this.host.records.hasData() ? this.host.records.referenceData() : undefined };
    this.flow = flow; this.basketId = undefined;
    if (modelId) {
      const row = this.resolveRow(modelId, false, own);
      // Editing absence is meaningful: do not silently adopt a borrowed wire map.
      if (own?.thinkingLevelMap === undefined) delete row.model.thinkingLevelMap;
      row.original = own ? clone({ id: modelId, ...Object.fromEntries(FIELDS.filter(field => Object.hasOwn(own,field)).map(field => [field,own[field]])) }) : clone(row.model); flow.rows.set(modelId, row);
      flow.readonly ||= !own;
    }
    return flow;
  }
  private resolveRow(id: string, manual: boolean, existing?: Partial<ModelInput>, scope?: Scope): Row {
    const flow = this.flow!;
    const binding = this.binding(flow, id);
    const hint: Scope = scope ?? { provider: flow.provider.id, modelId: id, endpoint: binding.endpoint, api: binding.api, credentialVersion: `unresolved:${randomUUID()}` };
    const data = flow.referenceData;
    const unsafe = this.host.store.snapshot().providers.find(p => p.id === flow.provider.id)?.referenceUnsafe;
    const remembered = !unsafe ? data?.reference(hint) : undefined;
    const resolved = resolveModelFields({ scope: hint, now: Date.now(), tests: data?.tests,
      manual: existing ?? remembered?.fields, providerModel: findModelTemplate(id, flow.catalogData, flow.provider.id), generic: findModelTemplate(id, flow.catalogData) });
    return { model: { id, ...resolved.fields } as ModelInput, resolved, manual, reused: false, referenceWhen: remembered?.when };
  }
  private values(form: Form): string[] { return form.fields.map(f => f.input?.getValue() ?? f.choices?.[f.choice ?? 0] ?? ''); }
  private valuesById(form: Form): Record<string, string> { return Object.fromEntries(form.fields.map((f,i) => [f.id, this.values(form)[i]])); }
  private newSecret(): SecretInput { const field = new SecretInput(); this.secrets.add(field); return field; }
  private connectionForm(providerId?: string, retained?: Form): void {
    const originFlow = this.flow;
    const summary = this.host.store.snapshot(), p = summary.providers.find(p => p.id === providerId);
    const isNew = !providerId;
    if (!isNew) { this.writable(providerId); if (!p) throw new StoreError('PROTECTED'); }
    let authStatus = '未知';
    if (!isNew) {
      try { authStatus = this.publicText(this.host.authStatus?.(providerId!) ?? '未知'); } catch { /* Status failure must not expose native auth errors. */ }
    }
    const fields: Field[] = retained?.fields ?? [
      { id: 'name', label: '名称', input: input(p?.name ?? originFlow?.provider.name ?? '') },
      { id: 'endpoint', label: '地址', input: input(p?.endpoint ?? originFlow?.provider.endpoint ?? '') },
      { id: 'api', label: '接口类型', choices: isNew ? APIS : ['保持现有协议', ...APIS], choice: isNew && originFlow ? Math.max(0, APIS.indexOf(originFlow.provider.api)) : 0 },
      { id: 'key', label: 'API Key', input: this.newSecret(), hint: isNew ? '遮蔽显示；草稿留空表示撤回，最终确认前不写凭据。' : '留空保留现有凭据。auth.json 为 0600 明文；不会覆盖 OAuth。' },
    ];
    const form: Form = retained ?? { viewId: randomUUID(), fields, changed: () => {}, save: () => {}, back: () => this.leave() };
    this.forms.add(form);
    let credentialRevision: string | undefined;
    const originalRevision = summary.revision;
    const originalConnection = originFlow ? { endpoint: originFlow.provider.endpoint, api: originFlow.provider.api, key: originFlow.key } : undefined;
    let connectionDirty = false;
    const providerValue = (): ProviderInput => {
      const v = this.valuesById(form); const endpoint = v.endpoint.trim();
      if (isNew || endpoint !== p?.endpoint) {
        validateEndpoint(endpoint);
        if (endpoint.length > 4096 || /[?#\s\\]/u.test(endpoint) || !/^https:\/\//i.test(endpoint) || endpoint.slice(endpoint.indexOf('//') + 2).split('/')[0].includes('@')) throw new StoreError('INVALID_INPUT');
      }
      const name = v.name.trim() || (isNew ? new URL(endpoint).hostname : providerId!);
      if (name.length > 256 || clean(name) !== name) throw new StoreError('INVALID_INPUT');
      const key = v.key.trim(); if (key && !validApiKey(key)) throw new StoreError('INVALID_INPUT');
      let id = providerId ?? originFlow?.provider.id;
      if (!id) {
        const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[-.]+$/g, '');
        const base = (slug(name) || slug(new URL(endpoint).hostname) || 'provider').slice(0,100);
        const retainedIds = this.host.store.retained().providers;
        const taken = (s: string) => ['__proto__','prototype','constructor'].includes(s) || summary.providers.some(x => x.id === s) || this.host.catalog().some(x => x.provider === s) || retainedIds.includes(s) || this.host.isProtected?.(s);
        id = base; let n = 2; while (taken(id)) id = `${base}-${n++}`;
      }
      return { id, name, endpoint, api: v.api === '保持现有协议' ? p!.api : v.api };
    };
    const publish = () => {
      this.beginView(); const v = this.valuesById(form); let value: ProviderInput | undefined;
      try { value = providerValue(); } catch {}
      form.reviewed = this.values(form);
      const target = value ? this.connection(value) : { provider: providerId ?? '', endpoint: '', api: this.publicText(v.api === '保持现有协议' ? p?.api : v.api) };
      const actions = isNew ? [
        this.action('connect', '连接并读取清单', () => form.save(), { primary: true, requiresReview: true, disabled: !value || this.host.storageWritable === false, disabledReason: this.host.storageWritable === false ? '存储绑定不可写，无法安全保存读取记录。' : value ? undefined : '请填写有效 HTTPS 地址与连接信息。' }),
        this.action('manual-connection', '手动选择模型', () => enter(false), { disabled: !value }),
      ] : [this.action('save-form', '保存修改', () => form.save(), { primary: true, requiresReview: true, disabled: !value || !this.host.providerCommit || !credentialRevision, disabledReason: !this.host.providerCommit ? '缺少安全凭据/配置提交后端；未提供旧 saveKey 回退。' : !credentialRevision ? '正在核对凭据状态。' : undefined })];
      if (!isNew) actions.push(this.action('back', '返回', () => this.leave()));
      actions.push(this.action('cancel-task', '取消任务', () => this.leave()));
      const content: SheetContent = { stage: '01 连接', title: isNew ? '新供应商连接' : '编辑供应商连接', sections: [
        { title: '完整请求目标', lines: [`供应商：${target.provider || '自动生成'} · ${target.api}`, target.endpoint || '地址未填写'] },
        { title: isNew ? '授权范围' : '保存范围', lines: isNew
          ? ['一次 HTTPS GET：地址末尾 /models，无自动重试；仅读取 ID，不发模型推理请求。', '鉴权与读取总计最多 10 秒；上游仍可能计费。使用刚填写的草稿 Key，不预先保存。']
          : ['只修改当前列出的名称/连接字段及非空新 Key；未知配置字段保留。', '当前会话供应商的地址/API/Key 变更将由安全后端拒绝；请先切换。', 'API Key 与 /login 同库同优先级；auth.json 为 0600 明文，OAuth 不覆盖。'] },
        ...(!isNew ? [{ title: '鉴权状态与设置', lines: [`当前鉴权状态：${authStatus}`, '可通过 Pi 原生 /login 设置支持的凭据；--api-key 是本次运行参数。', '也可在 API Key 栏粘贴直接 Key；留空保留现有凭据，不覆盖 OAuth。'] }] : []),
      ] };
      const base = { ...this.base(content.title, true), viewId: form.viewId };
      this.show(isNew ? { ...base, kind: 'connection', target, isNew: true, actions, content }
        : { ...base, kind: 'edit', target: { kind: 'provider', provider: providerId! }, readonly: false, actions, content }, () => this.leave(), form);
    };
    const enter = async (read: boolean) => {
      if (read && this.host.storageWritable === false) { this.message('存储绑定不可写，未读取或保存记录。',true); return; }
      if (!equal(this.values(form), form.reviewed)) { publish(); return; }
      const value = providerValue(), key = this.valuesById(form).key.trim() || undefined;
      if (this.host.store.snapshot().revision !== originalRevision) throw new StoreError('CONFLICT');
      // changed() is a UI notification, never the sole scope-invalidation guard.
      if (originalConnection && (value.endpoint !== originalConnection.endpoint || value.api !== originalConnection.api || key !== originalConnection.key)) connectionDirty = true;
      let flow: Flow;
      if (originFlow && !connectionDirty) {
        flow = originFlow; flow.provider = value; flow.key = key; this.flow = flow;
      } else {
        if (originFlow) { originFlow.generation++; originFlow.key = undefined; originFlow.rows.clear(); }
        flow = this.createFlow(value.id, undefined, { value, key, revision: originalRevision });
      }
      // Returning to connection retains private fields only, not old authoritative IDs/reports.
      this.connectionBack = () => this.connectionForm(undefined, form);
      if (this.host.providerCommit && !flow.credentialRevision) {
        const token = this.epoch, abort = new AbortController(); this.abort = abort;
        this.progress('auth', '核对新供应商身份', 'stop-to-basket');
        try { const c = await withProbeDeadline(async deadline => { const c = await this.host.providerCommit!.snapshotCredential(value.id); deadline(); return c; },abort); if (token !== this.epoch || this.flow !== flow || abort.signal.aborted) return; flow.credentialRevision = c.revision; }
        catch { if (token !== this.epoch) return; this.showBasket(); this.message('凭据核对未完成；可以准备报告，但不能提交或自动读取。', true); return; }
        finally { if (token === this.epoch) this.abort = undefined; }
      }
      if (read) await this.discover(); else this.showBasket();
    };
    form.changed = () => {
      if (this.form !== form) return;
      if (originFlow && originalConnection) {
        const v = this.valuesById(form);
        if (v.endpoint.trim() !== originalConnection.endpoint || v.api !== originalConnection.api || (v.key.trim() || undefined) !== originalConnection.key) {
          connectionDirty = true; originFlow.generation++; originFlow.key = undefined; originFlow.rows.clear(); originFlow.candidates = []; originFlow.listCounts = undefined; originFlow.listStatus = 'idle'; originFlow.plan = undefined; originFlow.approvedReferences = undefined;
        }
      }
      publish();
    };
    form.save = isNew ? () => enter(true) : async () => {
      if (!equal(this.values(form), form.reviewed)) { publish(); return; }
      if (!this.host.providerCommit || !credentialRevision) throw new StoreError('PROTECTED');
      this.writable(providerId); if (this.host.store.snapshot().revision !== originalRevision) throw new StoreError('CONFLICT');
      const value = providerValue(), key = this.valuesById(form).key.trim();
      const patch = { ...(value.name !== p!.name ? { name: value.name } : {}), ...(value.endpoint !== p!.endpoint ? { endpoint: value.endpoint } : {}), ...(value.api !== p!.api ? { api: value.api } : {}) };
      if (!Object.keys(patch).length && !key) { this.leave(); this.host.feedback?.('未修改连接配置'); return; }
      await this.providerWrite({ kind: 'edit', providerId: providerId!, patch, credential: key ? { kind: 'literal', value: key } : { kind: 'keep' } }, originalRevision, credentialRevision, () => publish());
    };
    publish();
    if (!isNew && this.host.providerCommit) {
      const token = this.epoch;
      void this.host.providerCommit.snapshotCredential(providerId!).then(c => { if (token === this.epoch && this.form === form) { credentialRevision = c.revision; publish(); } }).catch(() => { if (token === this.epoch && this.form === form) this.message('无法核对凭据状态；未启用保存。', true); });
    }
  }
  private connectionBack?: () => void;
  private basketId?: string;
  private showBasket(sameView = false, focusAction?: 'manual-id'): void {
    const f = this.flow!; this.beginView();
    const id = this.basketId ?? randomUUID(); this.basketId = id;
    const row = (id: string) => {
      const r = f.rows.get(id);
      return { id: this.publicText(id), name: this.publicText(r?.model.name ?? id), ...(r ? { parameters: this.parameters(r.model), evidence: this.evidence(r) } : {}), needsReview: r ? r.resolved.needsReview.filter((x): x is ModelField => FIELDS.includes(x as ModelField)) : [], manual: r?.manual ?? false };
    };
    const actions = [
      this.action('next-models', '下一步', () => this.preflight(), { primary: !!f.rows.size, disabled: !f.rows.size }),
      this.action('read-list', '读取模型清单', () => this.discoveryConsent(), { primary: !f.rows.size }),
      this.action('manual-id', '手动输入ID', () => this.manualForm()),
      this.action('adjust', '调整参数', () => {}, { disabled: !f.rows.size }),
      this.action('back', '返回', () => f.isNew ? this.connectionBack?.() : this.leave()),
      this.action('cancel-task', '取消任务', () => this.leave()),
    ];
    this.show({ ...this.base(`${this.publicText(f.provider.name)} · 选择模型`), viewId: id, kind: 'basket', target: this.connection(f.provider), query: this.publicText(f.query), candidates: f.candidates.map(row), selected: [...f.rows.keys()].map(row), listStatus: f.listStatus, listMessage: f.listMessage, ...(f.listCounts ? { listCounts: { ...f.listCounts } } : {}), ...(focusAction ? { focusAction } : {}), maxSelected: MAX_SELECTED, actions }, () => f.isNew ? this.connectionBack?.() : this.leave());
  }
  private blocked(id: string): boolean { return this.flow?.existingIds.has(id) ?? false; }
  private toggle(id: string): void {
    const f = this.flow!; this.assertFlow(f);
    if (f.rows.has(id)) f.rows.delete(id);
    else { if (!f.candidates.includes(id) || !validId(id) || this.blocked(id) || f.rows.size >= MAX_SELECTED) return; f.rows.set(id, this.resolveRow(id, false)); }
    f.plan = undefined; this.showBasket(true);
  }
  private manualForm(): void {
    const f = this.flow!; this.assertFlow(f); this.beginView();
    const form: Form = { viewId: randomUUID(), fields: [{ id: 'ids', label: '模型ID（可多个）', input: input(), hint: '准确 ID，以逗号分隔；最多已选100个。只加入草稿，不读取或启用模型。' }],
      changed: () => { if (this.form === form && this.task) { this.task = { ...this.task, error: undefined }; this.emit(); } },
      save: () => { if (this.form === form) this.manual(this.valuesById(form).ids); }, back: () => this.showBasket() };
    this.forms.add(form);
    this.show({ ...this.base('手动输入模型ID'), viewId: form.viewId, kind: 'edit', purpose: 'manual-ids',
      target: { kind: 'provider', provider: this.publicText(f.provider.id) }, readonly: false,
      actions: [this.action('add-ids', '加入已选', () => form.save(), { primary: true }), this.action('back', '返回', form.back)] }, form.back, form);
  }
  private manual(value: string): void {
    const f = this.flow!; this.assertFlow(f);
    const ids = value.split(/[,，]/u).map(x => x.trim());
    if (!ids.length || ids.some(id => !validId(id) || this.blocked(id) || f.rows.has(id)) || new Set(ids).size !== ids.length || ids.length + f.rows.size > MAX_SELECTED) { this.message('请输入不重复的准确模型 ID，最多选择100个；本次未加入。', true); return; }
    const rows = ids.map(id => [id, this.resolveRow(id, true)] as const);
    for (const [id,row] of rows) f.rows.set(id,row);
    f.plan = undefined; this.showBasket(true, 'manual-id');
  }
  private discoveryConsent(): void {
    const f = this.flow!; const binding = this.binding(f); this.beginView();
    this.show({ ...this.base('读取本家模型清单', true), kind: 'info', purpose: 'discovery-consent', content: { stage: '01 读取授权', title: '完整连接与请求范围', sections: [
      { title: '目标', lines: [this.publicText(binding.provider), this.publicEndpoint(binding.endpoint), this.publicText(binding.api)] },
      { title: '范围', lines: ['一次 HTTPS GET：地址末尾 /models，无自动重试；只读取 ID，不运行模型。', '鉴权＋读取总计最多10秒；服务商仍可能计费。未保存配置或凭据。'] },
    ] }, actions: [this.action('connect', '确认读取', () => this.discover(binding), { primary: true, requiresReview: true, disabled: this.host.storageWritable === false || !this.requestable(binding), disabledReason: this.host.storageWritable === false ? '存储绑定不可写；不能保存读取记录。' : !this.requestable(binding) ? '此连接无法安全执行 HTTPS 清单读取，可继续手输。' : undefined }), this.action('back', '返回选择', () => this.showBasket()), this.action('cancel-task', '取消任务', () => this.leave())] }, () => this.showBasket());
  }
  private progress(operation: 'discovery'|'checks'|'auth'|'save'|'replacement', title: string, cancellation: 'none'|'stop-to-report'|'stop-to-basket', plan?: ProbePlan): void {
    this.beginView();
    const stop = () => { this.abort?.abort(); if (this.task?.kind === 'progress') { this.task = { ...this.task, cancelling: true }; this.emit(); } };
    this.show({ ...this.base(title), kind: 'progress', operation, plan, cancellation, cancelling: false, items: plan?.items.map(item => ({ ...item, status: 'waiting' as const })) ?? [], actions: cancellation === 'none' ? [] : [this.action(cancellation === 'stop-to-report' ? 'cancel-checks' : 'stop-read', '停止', stop), this.action('cancel-task', '结束任务', () => this.leave())] }, cancellation === 'none' ? () => {} : stop);
    try { this.host.flushRender?.(); } catch { /* Rendering is not an effect authorization gate. */ }
  }
  private async discover(expected?: Binding): Promise<void> {
    if (this.host.storageWritable === false) throw new StoreError('PROTECTED');
    const f = this.flow!, binding = expected ?? this.binding(f), token = ++this.epoch, abort = new AbortController(); this.abort = abort;
    const attemptId = randomUUID(), when = Date.now();
    this.checkBinding(f, binding);
    f.listStatus = 'loading';
    this.progress('discovery', '读取模型清单', 'stop-to-basket');
    let ids: string[] = [], code: ProbeCode | 'record-failed' = 'ok';
    let attempt: ActiveAttempt | undefined;
    try {
      if (this.disposed || token !== this.epoch || abort.signal.aborted) return;
      this.checkBinding(f, binding);
      this.host.records.append({ kind: 'discovery-start', attemptId, when, provider: this.publicText(f.provider.id) });
      attempt = { kind: 'discovery', attemptId, when, provider: binding.provider }; this.attempt = attempt;
      ids = await withProbeDeadline(async deadline => {
        const auth = await this.auth(f, binding, abort);
        const guard = () => { deadline(); this.checkBinding(f, binding, auth.scope); };
        guard(); return discoverModels(auth.scope, { headers: auth.headers, signal: abort.signal, checkDeadline: guard });
      }, abort, AUTH_DURATION);
    } catch (error) { code = error instanceof ProbeError ? error.code : 'network'; }
    if (this.disposed || token !== this.epoch || this.flow !== f) return;
    this.abort = undefined;
    try { this.checkBinding(f, binding); } catch (error) {
      const warning = this.closeAttempt(attempt, 'network');
      this.info('连接已变化', [failure(error), '旧清单已丢弃；请返回重新读取。', ...(warning ? [warning] : [])], () => this.showBasket()); return;
    }
    const auditWarning = this.closeAttempt(attempt, code, { count: ids.length });
    if (auditWarning) code = 'record-failed';
    if (code === 'ok') {
      f.candidates = ids.filter(id => !this.blocked(id)); f.listStatus = 'loaded';
      f.listCounts = { total: ids.length, added: ids.length - f.candidates.length, available: f.candidates.length };
      f.listMessage = !ids.length ? '读取成功：上游返回空清单（0 个 ID），可手动输入 ID。'
        : !f.candidates.length ? `读取成功：上游返回 ${ids.length} 个 ID，均已配置；没有可添加候选。`
        : `已读取上游 ${ids.length} 个 ID · 已配置 ${f.listCounts.added} · 可添加 ${f.candidates.length}；未验证可调用或规格。`;
    }
    else { f.listStatus = code === 'cancelled' ? 'cancelled' : code === 'unsupported' ? 'unsupported' : 'failed'; f.listMessage = `读取未完成（${code}），保留同连接现场，可继续手输。`; }
    this.showBasket(); if (auditWarning) this.message(auditWarning, true);
  }
  private planRows(): Array<[string, Row]> { return [...this.flow!.rows].filter(([id]) => supported(this.binding(this.flow!, id).api) && this.requestable(this.binding(this.flow!,id))).slice(0, BATCH_MODELS); }
  private preflight(): void {
    const f = this.flow!; this.assertFlow(f); if (!f.rows.size) return;
    const chosen = this.planRows();
    const requests = f.includeImage ? SUITE_MAX_REQUESTS : SUITE_STANDARD_REQUESTS;
    const targets = chosen.map(([id]) => ({ connection: this.connection(this.binding(f,id)), model: { provider: this.publicText(f.provider.id), id: this.publicText(id) } }));
    const items = chosen.flatMap(([id]) => ['text','stream','tools', ...(f.includeImage ? ['image'] : []), ...SUITE_LEVELS].map(check => ({ id: `${id}:${check}`, model: { provider: this.publicText(f.provider.id), id: this.publicText(id) }, label: `${this.publicText(id)} · ${check}` })));
    const plan: ProbePlan = { id: randomUUID(), targets, items, maxRequests: Math.min(BATCH_REQUESTS, chosen.length * requests), maxInputTokens: null, maxOutputTokens: chosen.length * requests * 64,
      authTimeoutMs: AUTH_DURATION, maxDurationMs: Math.min(BATCH_DURATION, chosen.length * SUITE_MAX_DURATION_MS), retries: 0,
      priceNote: '可能计费；价格与输入 token 数未知，不能保证金额上限。只发送固定合成样例，不发送当前对话。', includeImage: f.includeImage,
      capability: { available: this.host.storageWritable !== false && chosen.length > 0, reason: this.host.storageWritable === false ? '存储绑定不可写，无法安全保存检查记录。' : chosen.length ? undefined : '所选协议/连接的自动能力检查尚未实现或不能安全发送。' }, reuse: { available: this.host.storageWritable !== false && this.host.records.hasData(), reason: '只核对当前连接与凭据；没有有效记录时不发送模型请求。' } };
    f.plan = plan; f.planBindings = new Map(chosen.map(([id]) => [id, this.binding(f,id)])); this.beginView();
    const remainder = f.rows.size - chosen.length;
    const allTargets = [...f.rows.keys()].map(id => { const b = this.binding(f,id); return `${this.publicText(id)} · ${this.publicEndpoint(b.endpoint)} · ${this.publicText(b.api)}`; });
    this.show({ ...this.base('确认检查范围', true), kind: 'preflight', plan, contentOwnsPlan: true, content: { stage: '02 第一次确认', title: `${f.rows.size} 个模型 · 检查授权`, sections: [
      { title: '完整目标', lines: allTargets },
      { title: '本次检查', lines: ['文本 · 流式 · 工具 · low/medium/high/xhigh/max 参数接受；图片可选。off/minimal 不测试。', `按选择顺序最多检查 ${BATCH_MODELS} 个受支持模型（仅 OpenAI Chat/Responses）。${remainder ? `其余 ${remainder} 个明确未测试，不会自动续批。` : ''}`] },
      { title: '限额与费用', lines: [`最多 ${plan.maxRequests} 次请求 · 每次最多64输出 token · 总计最多 ${plan.maxOutputTokens} 输出 token。`, '输入 token 数未知；仅固定短文本/工具及可选16×16合成图，不做窗口压力测试。', `每模型鉴权最多10秒＋套件最多90秒；套件批次总时限最多${plan.maxDurationMs / 1000}秒，含鉴权总时限最多${(plan.maxDurationMs + chosen.length * AUTH_DURATION) / 1000}秒；不重试。`, plan.priceNote, 'Esc 停止后看部分报告；Ctrl+C 结束任务，迟到结果不再继续。同步凭据命令不能强制中断。'] },
    ] }, actions: [
      this.action('run', '开始检查', () => this.runChecks(false), { primary: true, requiresReview: true, disabled: !plan.capability.available, disabledReason: plan.capability.reason }),
      this.action('image', f.includeImage ? '不含图片' : '包含合成图片', () => {}),
      this.action('reuse', '使用有效历史', () => this.runChecks(true), { requiresReview: true, disabled: !plan.reuse.available }),
      this.action('skip', '跳过检查看参考', () => { for (const row of f.rows.values()) { row.suite = undefined; row.reused = false; row.reportId = undefined; row.previous = undefined; row.suggested = undefined; row.usesPrevious = false; } this.showReport(); }),
      this.action('back', '返回', () => f.mode === 'inspect' ? this.leave() : this.showBasket()), this.action('cancel-task', '取消任务', () => this.leave()),
    ] }, () => f.mode === 'inspect' ? this.leave() : this.showBasket());
  }
  private updateProgress(model: string, p: SuiteProgress): void {
    if (this.task?.kind !== 'progress' || !this.flow) return;
    if (this.attempt?.kind === 'probe' && this.attempt.scope.modelId === model) this.attempt.checks = copySuiteChecks(p.checks);
    const check = (key: string) => ['text','stream','tools','image'].includes(key) ? p.checks[key as 'text'] : p.checks.thinking[key as typeof SUITE_LEVELS[number]];
    this.task = { ...this.task, progress: { completed: p.completed, total: p.total, current: p.current, checks: copySuiteChecks(p.checks)! }, progressModel: { provider: this.publicText(this.flow.provider.id), id: this.publicText(model) },
      items: this.task.items.map(item => {
        if (item.model?.id !== this.publicText(model)) return item;
        const key = item.id.slice(item.id.lastIndexOf(':') + 1), result = check(key);
        return { ...item, status: p.current === key ? 'running' : result?.status === 'not-tested' ? 'waiting' : result?.status ?? 'not-tested', detail: result?.code };
      }) };
    this.emit();
  }
  private async runChecks(reuse: boolean): Promise<void> {
    const f = this.flow!, plan = f.plan!; this.assertFlow(f);
    if (this.host.storageWritable === false) throw new StoreError('PROTECTED');
    const bindings = f.planBindings;
    if (!bindings || !plan) throw new StoreError('CONFLICT');
    const rows = [...bindings.keys()].map(id => [id,f.rows.get(id)!] as const);
    for (const [id] of rows) this.checkBinding(f,bindings.get(id)!);
    const token = ++this.epoch, abort = new AbortController(); this.abort = abort; f.cancelled = false;
    for (const row of f.rows.values()) { row.suite = undefined; row.reused = false; row.reportId = undefined; row.previous = undefined; row.suggested = undefined; row.usesPrevious = false; }
    this.progress('checks', reuse ? '核对历史记录' : '正在检查', 'stop-to-report', plan);
    const batchStart = performance.now(); let warning = '';
    for (const [id,row] of rows) {
      if (abort.signal.aborted || this.disposed || token !== this.epoch) break;
      let attempt: ActiveAttempt | undefined;
      try {
        const binding = bindings.get(id)!; this.checkBinding(f,binding);
        const attemptId = randomUUID(), when = Date.now();
        if (!reuse) {
          this.host.records.append({ kind: 'probe-start', attemptId, when, provider: this.publicText(f.provider.id), modelId: this.publicText(id) });
          // Until auth finishes, this opaque unresolved binding cannot qualify as
          // tested evidence for any real credential. It contains no key/hash.
          attempt = { kind: 'probe', attemptId, when, provider: binding.provider, scope: { provider: binding.provider, modelId: id, endpoint: binding.endpoint, api: binding.api, credentialVersion: `unresolved:${attemptId}` }, checks: pendingChecks() };
          this.attempt = attempt;
        }
        const auth = await this.auth(f,binding,abort);
        if (this.disposed || token !== this.epoch || abort.signal.aborted) break;
        if (attempt?.kind === 'probe') attempt.scope = { ...auth.scope };
        const resolved = this.resolveRow(id,row.manual,row.manual ? row.model : row.original,auth.scope);
        row.model = resolved.model; row.resolved = resolved.resolved; row.referenceWhen = resolved.referenceWhen; row.evidenceScope = auth.scope;
        const previous = this.host.records.recentSuite(auth.scope,Date.now());
        const previousChecks = previous ? copySuiteChecks(previous.checks) : undefined;
        row.previous = previous && previousChecks ? { scope: auth.scope, startedAt: previous.testedAt, finishedAt: previous.testedAt, cancelled: previous.cancelled === true, timedOut: previous.timedOut === true, checks: previousChecks } : undefined;
        if (reuse) {
          const stored = this.host.records.recentSuite(auth.scope, Date.now()); const checks = stored ? copySuiteChecks(stored.checks) : undefined;
          if (!stored || !checks) { warning = '部分模型没有当前连接的有效历史；明确未测试，未发送模型请求。'; continue; }
          row.suite = { scope: auth.scope, startedAt: stored.testedAt, finishedAt: stored.testedAt, cancelled: stored.cancelled === true, timedOut: stored.timedOut === true, checks };
          row.reportId = stored.id; row.reused = true;
        } else {
          // Suite time budget excludes bounded auth resolution; whole flow includes both explicitly.
          const remaining = Math.min(SUITE_MAX_DURATION_MS, plan.maxDurationMs + rows.length * AUTH_DURATION - (performance.now() - batchStart));
          if (remaining < 1) { abort.abort(); warning = this.closeAttempt(attempt, 'timeout') ?? ''; break; }
          const result = await probeSuite(auth.scope, { headers: auth.headers, signal: abort.signal, includeImage: plan.includeImage, totalTimeoutMs: Math.max(1, Math.floor(remaining)), checkDeadline: () => { if (token !== this.epoch) throw new ProbeError('cancelled'); this.checkBinding(f,binding,auth.scope); }, onProgress: p => { if (token === this.epoch && !this.disposed) this.updateProgress(id,p); } });
          if (this.disposed || token !== this.epoch || this.flow !== f) return;
          this.checkBinding(f,binding,auth.scope);
          row.suite = result; row.reportId = randomUUID();
          const auditWarning = this.closeAttempt(attempt, result.timedOut ? 'timeout' : result.cancelled ? 'cancelled' : 'ok', { suite: result, reportId: row.reportId });
          if (result.cancelled || result.timedOut) f.cancelled = true;
          if (auditWarning) { warning = auditWarning; break; }
          if (result.cancelled || result.timedOut) break;
        }
        this.suggestMapping(row);
        if (this.task?.kind === 'progress') { this.task = { ...this.task, items: this.task.items.map(item => item.model?.id === this.publicText(id) && item.status === 'waiting' ? { ...item, status: 'not-tested' as const } : item) }; this.emit(); }
      } catch (error) {
        if (this.disposed || token !== this.epoch || this.flow !== f) return;
        warning = this.closeAttempt(attempt, error instanceof ProbeError ? error.code : abort.signal.aborted ? 'cancelled' : 'network') ?? failure(error);
        // Never continue a batch after failed auth/binding/record protection.
        break;
      }
    }
    if (this.disposed || token !== this.epoch || this.flow !== f) return;
    f.cancelled ||= abort.signal.aborted; this.abort = undefined;
    const terminalWarning = this.closeAttempt(this.attempt, abort.signal.aborted ? 'cancelled' : 'network');
    warning ||= terminalWarning ?? '';
    this.showReport(); if (warning) this.message(warning, true);
  }
  private suggestMapping(row: Row): void {
    row.suggested = undefined;
    if (!row.model.reasoning || row.model.thinkingLevelMap !== undefined || !row.suite) return;
    const suggestion: ThinkingLevelMap = {};
    for (const level of ['xhigh','max'] as const) {
      const check = row.suite.checks.thinking[level];
      if (check.status === 'passed' || (check.status === 'not-tested' && row.previous && Date.now() < row.previous.startedAt + REPORT_TTL && row.previous.checks.thinking[level].status === 'passed')) suggestion[level] = level;
    }
    if (Object.keys(suggestion).length) row.suggested = suggestion;
  }
  private diffs(): ModelDiff[] {
    const f = this.flow!;
    const value = (m: Partial<ModelInput>, field: ModelField): FieldValue => m[field] === undefined ? { present: false } : { present: true, value: this.parameters(m as ModelInput)[field]! };
    return [...f.rows].filter(([,row]) => row.original).map(([id,row]) => ({ ref: { provider: this.publicText(f.provider.id), id: this.publicText(id) }, fields: FIELDS.filter(field => !equal(row.original![field],row.model[field])).map(field => ({ field, before: value(row.original!,field), after: value(row.model,field) })) })).filter(d => d.fields.length);
  }
  private expired(row: Row): boolean {
    const now = Date.now();
    if (row.suite && (now < row.suite.startedAt || now >= row.suite.startedAt + REPORT_TTL)) return true;
    if (row.usesPrevious && (!row.previous || now >= row.previous.startedAt + REPORT_TTL)) return true;
    return FIELDS.some(field => {
      const provenance = row.resolved.provenance[field]; if (provenance.source !== 'tested') return false;
      const index = provenance.history.map(h => /^test\[(\d+)\]:selected$/.exec(h.reason)).find(Boolean)?.[1];
      const proof = index === undefined ? undefined : this.flow?.referenceData?.tests[Number(index)];
      return !proof || proof.testedAt > now || proof.expiresAt <= now;
    });
  }
  private showReport(): void {
    const f = this.flow!; let scopeValid = true;
    try { this.assertFlow(f); } catch { scopeValid = false; }
    this.beginView(); const diffs = this.diffs();
    const models = [...f.rows].map(([id,row]) => {
      const b = scopeValid ? this.binding(f,id) : row.suite?.scope ?? f.planBindings?.get(id) ?? { provider: f.provider.id, endpoint: f.provider.endpoint, api: f.provider.api }; const suite = row.suite;
      return { ref: { provider: this.publicText(f.provider.id), id: this.publicText(id) }, parameters: this.parameters(row.model), evidence: this.evidence(row), needsReview: row.resolved.needsReview.filter((x): x is ModelField => FIELDS.includes(x as ModelField)), connection: this.connection(b), applicable: scopeValid && !this.expired(row), reused: row.reused,
        ...(suite ? { suite: { startedAt: suite.startedAt, finishedAt: suite.finishedAt, cancelled: suite.cancelled, timedOut: suite.timedOut, checks: copySuiteChecks(suite.checks)! }, expiresAt: suite.startedAt + REPORT_TTL } : {}), ...(row.reportId ? { reportId: row.reportId } : {}) };
    });
    const notes = [...f.rows].flatMap(([id,r]) => [
      ...(r.resolved.provenance.thinkingLevelMap.source === 'generic' ? [`${this.publicText(id)}：跨供应商强度映射仅为建议；最终添加需明确接受，可先调整参数。`] : []),
      ...(r.suggested ? [`${this.publicText(id)}：建议映射 ${Object.keys(r.suggested).join(' / ')}（含当前有效历史），仅表示接口接受，尚未采用；可调整或保持Pi默认。`] : []),
    ]);
    const actions = f.mode === 'add' ? [this.action('commit', '确认添加…', () => this.commitConsent(), { primary: true, disabled: !scopeValid, disabledReason: !scopeValid ? '配置或连接已变化；请结束任务重新核对。' : undefined })]
      : [this.action('finish-inspect', '完成，仅保留报告', () => this.leave(), { primary: true }), this.action('apply-inspect', '查看应用差异…', () => this.commitConsent(), { disabled: !scopeValid || f.readonly || !diffs.length, disabledReason: !scopeValid ? '配置或连接已变化；不能应用。' : f.readonly ? '此模型只读，不能应用。' : !diffs.length ? '尚无参数差异。' : undefined })];
    actions.push(this.action('adjust', '调整参数', () => {}, { disabled: !scopeValid || !f.rows.size }), this.action('details', '报告详情', () => this.details()), this.action('recheck', '重新检查', () => this.preflight(), { disabled: !scopeValid }),
      this.action('sync-reference', '确认同步本渠道参考…', () => this.syncReferenceConsent(), { disabled: !scopeValid }), this.action('back', '返回', () => scopeValid ? this.preflight() : this.leave()), this.action('cancel-task', '结束任务', () => this.leave()));
    this.show({ ...this.base(f.mode === 'add' ? '模型报告 · 尚未添加' : '模型检查报告', true), kind: 'report', mode: f.mode, models, diffs, cancelled: f.cancelled, batchChecks: { available: true, reason: `单批最多${BATCH_MODELS}个受支持模型/${BATCH_REQUESTS}次请求；其余未测试，不自动续批。` }, content: { stage: '04 模型报告', title: '基本规格 · 能力检查 · 推理强度 · 待确认', sections: [{ lines: notes }, { title: '结论边界', lines: ['检查仅证明固定合成样例或接口参数接受；不证明最大窗口、内部推理或普遍视觉能力。', 'off/minimal 未测试；不支持的协议和超过批次范围的模型均未测试。'] }] }, actions, ...(!scopeValid ? { error: '配置或连接已变化；报告仅供查看，不能采用。请结束任务重新打开。' } : {}) }, () => scopeValid ? this.preflight() : this.leave());
  }
  private details(): void {
    const f = this.flow!;
    const lines = [...f.rows].flatMap(([id,row]) => [this.publicText(id), ...FIELDS.flatMap(field => [`${NAMES[field]}：${JSON.stringify(this.parameters(row.model)[field] ?? 'Pi默认')} · ${row.resolved.provenance[field].source}`, ...row.resolved.provenance[field].history.map(h => `${this.publicText(h.source)} → ${this.publicText(h.reason)}`)]),
      ...(row.previous ? [`此前同连接历史：${new Date(row.previous.startedAt).toISOString()}；有效至${new Date(row.previous.startedAt + REPORT_TTL).toISOString()}`, ...SUITE_LEVELS.map(level => `此前 ${level} · ${row.previous!.checks.thinking[level].status}`)] : []),
      ...(row.suite ? [`${row.reused ? '历史复用' : '本次实测'} ${new Date(row.suite.startedAt).toISOString()}，有效至 ${new Date(row.suite.startedAt + REPORT_TTL).toISOString()}`, ...['text','stream','tools','image',...SUITE_LEVELS].map(key => { const c = ['text','stream','tools','image'].includes(key) ? row.suite!.checks[key as 'text'] : row.suite!.checks.thinking[key as typeof SUITE_LEVELS[number]]; return `${key} · ${c.status}${c.code ? ` · ${c.code}` : ''}`; })] : ['全部能力：未测试']), 'off · 未测试', 'minimal · 未测试']);
    this.info('参数来源与检查详情', lines, () => this.showReport(), 'details');
  }
  private async validateReports(flow: Flow, abort: AbortController, token: number): Promise<void> {
    this.assertFlow(flow);
    for (const [id,row] of flow.rows) {
      const proofs = FIELDS.filter(field => row.resolved.provenance[field].source === 'tested').map(field => {
        const index = row.resolved.provenance[field].history.map(h => /^test\[(\d+)\]:selected$/.exec(h.reason)).find(Boolean)?.[1];
        const proof = index === undefined ? undefined : flow.referenceData?.tests[Number(index)];
        if (!proof || proof.testedAt > Date.now() || proof.expiresAt <= Date.now()) throw new StoreError('CONFLICT');
        return proof;
      });
      if (!row.suite && !proofs.length) continue;
      if (row.suite && (Date.now() >= row.suite.startedAt + REPORT_TTL || Date.now() < row.suite.startedAt || (row.usesPrevious && (!row.previous || Date.now() >= row.previous.startedAt + REPORT_TTL)))) throw new StoreError('CONFLICT');
      const auth = await this.auth(flow,this.binding(flow,id),abort);
      if (token !== this.epoch || abort.signal.aborted) throw new ProbeError('cancelled');
      const expected = row.suite?.scope ?? row.evidenceScope;
      const sameScope = (scope?: Scope) => !!scope && ['provider','modelId','endpoint','api','credentialVersion'].every(k => auth.scope[k as keyof Scope] === scope[k as keyof Scope]);
      if (this.expired(row) || !sameScope(expected) || proofs.some(proof => !sameScope(proof.scope) || proof.expiresAt <= Date.now())) throw new StoreError('CONFLICT');
    }
    this.assertFlow(flow);
  }
  private commitConsent(): void {
    const f = this.flow!; this.assertFlow(f); if (f.mode === 'inspect' && f.readonly) return;
    const diffs = this.diffs(); if (f.mode === 'inspect' && !diffs.length) return;
    const finalBindings = [...f.rows.keys()].map(id => this.binding(f,id));
    this.beginView();
    this.show({ ...this.base(f.mode === 'add' ? '最终确认添加' : '确认应用参数差异', true), kind: 'confirm', purpose: f.mode === 'add' ? 'commit' : 'apply-inspect', affectedModels: [...f.rows.keys()].map(id => ({ provider: this.publicText(f.provider.id), id: this.publicText(id) })), replacements: [], affectsCurrent: false, affectsDefault: false, replacementApplied: false, diffs,
      content: { stage: '05 独立最终确认', title: f.mode === 'add' ? '添加供应商/模型，不切换会话或默认' : '只应用列出的参数差异，不改变连接', sections: [
        { title: '完整保存范围', lines: [...f.rows].flatMap(([id,row]) => { const b = this.binding(f,id); return [`${this.publicText(f.provider.id)} / ${this.publicText(id)} · ${this.publicEndpoint(b.endpoint)} · ${this.publicText(b.api)}`, ...FIELDS.map(field => `${NAMES[field]}：${JSON.stringify(this.parameters(row.model)[field] ?? 'Pi默认')} · ${row.resolved.provenance[field].source}`), `待核对：${row.resolved.needsReview.map(x => NAMES[x as ModelField]).join('、') || '无'}`, ...(row.resolved.provenance.thinkingLevelMap.source === 'generic' ? ['确认即明确接受跨供应商建议映射；不接受请返回调整映射（可选择Pi默认）。'] : []), ...(!row.suite ? ['未测试；本次接受参考/保守默认不代表实测。'] : [])]; }) },
        { title: '后果', lines: [f.isNew ? '供应商与所有已选模型单次最终提交；凭据和配置通过协调后端保存，不保证跨文件原子性。' : '保留未知字段与模型覆盖地址；不会切换当前/默认。', '未确认字段与未知价格由你在本次确认中接受；可返回调整，不会悄悄采用未展示映射。'] },
      ] }, actions: [this.action(f.mode === 'add' ? 'commit' : 'apply-inspect', f.mode === 'add' ? '确认添加并接受上述待核对项' : '确认应用差异', () => this.commitFlow(finalBindings), { primary: true, requiresReview: true, disabled: this.host.storageWritable === false || f.isNew && (!this.host.providerCommit || !f.credentialRevision), disabledReason: this.host.storageWritable === false ? '存储绑定不可写，不能提交。' : f.isNew && !this.host.providerCommit ? '安全提交后端不可用，拒绝供应商写入。' : f.isNew && !f.credentialRevision ? '凭据状态未确认。' : undefined }), this.action('back', '返回报告', () => this.showReport()), this.action('cancel-task', '取消任务', () => this.leave())] }, () => this.showReport());
  }
  private async commitFlow(finalBindings: Binding[]): Promise<void> {
    const f = this.flow!;
    for (const binding of finalBindings) this.checkBinding(f,binding);
    const token = ++this.epoch, abort = new AbortController(); this.abort = abort;
    this.writable(f.provider.id); if (f.mode === 'inspect' && f.readonly) throw new StoreError('PROTECTED');
    this.progress('auth', '最终核对连接与报告', 'stop-to-report');
    try {
      await this.validateReports(f,abort,token);
      for (const binding of finalBindings) this.checkBinding(f,binding);
      if (this.disposed || token !== this.epoch || abort.signal.aborted) { if (token === this.epoch) this.showReport(); return; }
      const rows = [...f.rows.values()];
      this.assertFlow(f); this.writable(f.provider.id);
      if (rows.some(row => this.expired(row))) throw new StoreError('CONFLICT');
      // Report/auth validation is over. Enter the non-cancellable saving phase
      // before the first proposed-record seal, not only before the config write.
      this.progress('save', '保存参数与提议记录', 'none');
      if (this.disposed || token !== this.epoch) return;
      this.assertFlow(f); this.writable(f.provider.id);
      if (rows.some(row => this.expired(row))) throw new StoreError('CONFLICT');
      f.approvedReferences = rows.filter(row => this.requestable(finalBindings.find(b => b.modelId === row.model.id)!)).map(row => { const b = finalBindings.find(b => b.modelId === row.model.id)!; return { modelId: row.model.id, endpoint: b.endpoint, api: b.api, fields: clone(row.model) }; });
      this.host.records.appendMany(rows.map(row => ({ kind: 'resolution', id: randomUUID(), when: Date.now(), provider: f.provider.id, modelId: row.model.id, fields: row.model, recommendation: row.resolved.fields, provenance: row.resolved.provenance, edited: FIELDS.filter(field => !equal(row.model[field],row.resolved.fields[field])), phase: 'proposed' })));
      this.assertFlow(f); this.writable(f.provider.id);
      if (rows.some(row => this.expired(row))) throw new StoreError('CONFLICT');
      if (f.isNew) {
        if (!f.credentialRevision || !this.host.providerCommit) throw new StoreError('PROTECTED');
        await this.providerWrite({ kind: 'add', provider: f.provider, models: rows.map(r => r.model), credential: f.key ? { kind: 'literal', value: f.key } : { kind: 'none' } }, f.revision, f.credentialRevision, () => this.showReport());
      } else {
        await this.storeWrite(() => {
          this.assertFlow(f); this.writable(f.provider.id);
          if (f.mode === 'inspect') {
            if (f.readonly || rows.length !== 1 || !this.diffs().length) throw new StoreError('PROTECTED');
            const row = rows[0];
            const edit = row.original?.thinkingLevelMap !== undefined && row.model.thinkingLevelMap === undefined ? { unsetThinkingLevelMap: true } : undefined;
            this.host.store.putModel(f.provider.id,row.model,'edit',f.revision,this.liveGuard(),edit);
          }
          else this.host.store.putModels(f.provider.id,rows.map(r => r.model),f.revision,this.liveGuard());
        }, { provider: f.provider.id, modelId: rows[0].model.id }, () => this.showReport());
      }
    } catch (error) { if (token === this.epoch && !this.disposed) { this.showReport(); this.message(failure(error), true); } }
    finally { if (token === this.epoch) this.abort = undefined; }
  }
  private storageStateChanged(): void {
    try { this.host.storageStateChanged?.(); } catch { /* Presentation refresh cannot change a commit outcome. */ }
  }
  private async providerWrite(change: ProviderChange, revision: string, credentialRevision: string, back: () => void): Promise<void> {
    const backend = this.host.providerCommit; if (!backend) throw new StoreError('PROTECTED');
    const token = ++this.epoch; this.progress('save', '保存连接配置', 'none');
    let result: CommitResult;
    try { result = await backend.commit({ change, expectedModelsRevision: revision, expectedCredentialRevision: credentialRevision }); }
    catch { result = { status: 'pending', transactionId: '', code: 'IO_ERROR', state: 'unknown' }; }
    if (this.disposed || token !== this.epoch) return;
    this.storageStateChanged();
    if (result.status === 'committed') {
      const target = change.kind === 'add' ? { provider: change.provider.id, modelId: change.models[0]?.id } : undefined;
      await this.saved(target); return;
    }
    if (result.status === 'pending') {
      this.clearTerminalSecrets();
      this.info('修改待恢复，不能重复提交', [`协调提交尚未完整结束（${result.code} · ${result.state}）。`, '凭据/配置可能已部分写入；请在恢复入口核对，不能当作“未保存”重试。'], () => this.leave()); return;
    }
    back(); this.message(`未提交（${result.code}）；原输入保留，请重新核对。`, true);
  }
  private clearTerminalSecrets(): void {
    for (const s of this.secrets) s.setValue(''); this.secrets.clear(); this.redactions.clear();
    for (const form of this.forms) form.reviewed = undefined;
    if (this.flow) this.flow.key = undefined;
  }
  private async storeWrite(operation: () => void, target?: { provider: string; modelId?: string }, back = () => this.leave()): Promise<void> {
    const before = this.host.store.snapshot().revision;
    const token = ++this.epoch; this.progress('save', '保存配置', 'none');
    try { this.writable(); operation(); }
    catch (error) {
      if (token === this.epoch && !this.disposed) {
        let uncertain = true;
        try { uncertain = this.host.store.snapshot().revision !== before || this.host.store.hasPending(); } catch {}
        if (uncertain) { this.storageStateChanged(); this.clearTerminalSecrets(); this.info('修改待核对，请勿重复提交', ['配置可能已保存或留有待恢复修改；请从恢复入口核对，未自动重试。']); }
        else {
          try { back(); this.message(failure(error), true); }
          catch {
            this.clearTerminalSecrets();
            this.info('修改未完成，请重新核对', [failure(error), '原返回路径已变化；请返回列表重新打开任务，未自动重试。']);
          }
        }
      }
      return;
    }
    if (token === this.epoch && !this.disposed) await this.saved(target);
  }
  private async saved(target?: { provider: string; modelId?: string }): Promise<void> {
    const token = this.epoch; this.clearTerminalSecrets(); let referenceWarning = false;
    const f = this.flow;
    if (f?.approvedReferences?.length) {
      try { this.host.records.appendMany(f.approvedReferences.map(r => ({ kind: 'reference', id: randomUUID(), when: Date.now(), provider: f.provider.id, modelId: r.modelId, endpoint: r.endpoint, api: r.api, fields: r.fields }))); }
      catch { referenceWarning = true; }
    }
    try { await this.host.changed(target); if (!this.disposed && token === this.epoch) { this.leave(); this.host.feedback?.(referenceWarning ? '配置已保存，但参考记录未保存；请下次核对。' : '配置已保存'); } }
    catch { if (!this.disposed && token === this.epoch) { this.info('已保存，列表尚未更新', ['保存已完成；请重新打开列表核对，不要重复添加或再次提交。'], () => this.leave()); } }
  }
  private syncReferenceConsent(): void {
    const f = this.flow!; this.beginView();
    this.show({ ...this.base('仅同步本渠道参考', true), kind: 'info', purpose: 'details', content: { stage: '参考同步确认', title: '参考表不是启用配置', sections: [{ lines: ['只保存当前报告中的模型参数作为本渠道人工确认参考；不改变启用配置。', '自动/AI辅助同步策略未实现；不能把短请求推断成最大窗口或内部推理证明。', ...[...f.rows.keys()].map(id => { const b = this.binding(f,id); return `${this.publicText(id)} · ${this.publicEndpoint(b.endpoint)} · ${this.publicText(b.api)}`; })] }] }, actions: [this.action('sync-reference', '确认保存参考', async () => {
      const token = ++this.epoch, abort = new AbortController(); this.abort = abort; this.progress('auth','核对参考适用性','stop-to-report');
      try { await this.validateReports(f,abort,token); if (token !== this.epoch || abort.signal.aborted) { if (token === this.epoch) this.showReport(); return; }
        this.writable();
        this.progress('save', '保存本渠道参考', 'none');
        if (token !== this.epoch || this.disposed) return;
        this.assertFlow(f); this.writable();
        this.host.records.appendMany([...f.rows].map(([id,row]) => { const b = this.binding(f,id); if (!this.requestable(b)) throw new ProbeError('unsupported'); return { kind: 'reference', id: randomUUID(), when: Date.now(), provider: f.provider.id, modelId: id, endpoint: b.endpoint, api: b.api, fields: row.model }; })); this.showReport(); this.message('本渠道参考已保存，启用配置未变。');
      } catch (error) { if (token === this.epoch) { this.showReport(); this.message(failure(error),true); } }
    }, { requiresReview: true, primary: true, disabled: this.host.storageWritable === false }), this.action('back','返回报告', () => this.showReport()), this.action('cancel-task','结束任务', () => this.leave())] }, () => this.showReport());
  }
  private modelLimitsForm(provider: string, modelId: string): void {
    const port = this.host.modelLimits!, flowId = this.taskFlowId;
    const keys = ['contextWindow', 'maxTokens'] as const;
    const read = (): ModelLimitsState => {
      this.writable();
      if (this.disposed || this.taskFlowId !== flowId || this.host.modelLimits !== port || !port.canEdit(provider, modelId)) throw new StoreError('PROTECTED');
      if (this.host.store.hasPending()) throw new StoreError('PENDING');
      if (!this.host.catalog().some(m => m.provider === provider && m.id === modelId)) throw new StoreError('NOT_FOUND');
      // Detach only the metadata pair; never retain provider/auth/config objects.
      const s = port.read(provider, modelId);
      const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
      if (typeof s.revision !== 'string' || !s.revision || !keys.every(k => valid(s.effective[k]) && (s.overrides[k] === undefined || valid(s.overrides[k])) && (s.catalog === null || s.catalog[k] === undefined || valid(s.catalog[k])))) throw new StoreError('INVALID_INPUT');
      const pair = (v: ModelLimitValues): ModelLimitValues => Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
      return { revision: s.revision, effective: { contextWindow: s.effective.contextWindow, maxTokens: s.effective.maxTokens }, overrides: pair(s.overrides), catalog: s.catalog === null ? null : pair(s.catalog), ...(s.catalogNote ? { catalogNote: this.publicText(s.catalogNote) } : {}) };
    };
    const initial = read();
    const assertState = () => { if (!equal(read(), initial)) throw new StoreError('CONFLICT'); };
    const ref = { provider: this.publicText(provider), id: this.publicText(modelId) };
    const status = (values: ModelLimitValues | null, inherited: string) => keys.map(k => `${NAMES[k]} ${values?.[k] ?? inherited}`).join(' · ');
    const warning = '本地预算不等于上游真实容量；修改不会扩展服务端限制，不自动发起付费测试。';
    const fields: Field[] = keys.map(k => ({ id: k, label: NAMES[k], input: input(initial.overrides[k] === undefined ? '' : String(initial.overrides[k])), hint: '留空＝继承目录值；仅正安全整数' }));
    const form: Form = { viewId: this.base(`limits:${modelId}`).viewId, fields, back: () => this.leave(), changed: () => {
      if (this.task && this.form === form) { this.task = { ...this.task, reviewToken: null, error: undefined, message: undefined }; this.emit(); }
    }, save: () => prepare(false) };
    this.forms.add(form);
    const publish = () => {
      this.beginView();
      this.show({ ...this.base(`${ref.id} · 本地限制`), viewId: form.viewId, kind: 'edit', purpose: 'model-limits', target: { kind: 'model', ref }, readonly: false,
        content: { stage: '仅编辑本地元数据', title: `${ref.provider} / ${ref.id}`, sections: [{ lines: [
          `当前生效：${status(initial.effective, '未知')}`, `目录参考：${status(initial.catalog, '未知（刷新后确认）')}`,
          ...(initial.catalogNote ? [initial.catalogNote] : []), `本地覆盖：${status(initial.overrides, '继承')}`,
          '仅修改上下文窗口与输出上限；名称、推理、输入、映射、认证和连接均保持不变。', warning,
        ] }] }, actions: [this.action('save-form', '查看保存差异', () => form.save(), { primary: true }),
          this.action('reset-limits', '重置为继承…', () => prepare(true)), this.action('back', '返回', () => this.leave()), this.action('cancel-task', '取消任务', () => this.leave())] }, () => this.leave(), form);
    };
    const prepare = (reset: boolean) => {
      assertState();
      const raw = this.values(form), patch: ModelLimitPatch = {}, next: ModelLimitValues = { ...initial.overrides };
      for (const [i, k] of keys.entries()) {
        const text = reset ? '' : raw[i]!.trim();
        const value = text === '' ? undefined : Number(text);
        if (text !== '' && (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value! < 1)) { this.message('限制须为正安全整数；留空表示继承目录值。', true); return; }
        if (value === initial.overrides[k]) continue;
        patch[k] = value ?? null;
        if (value === undefined) delete next[k]; else next[k] = value;
      }
      if (!Object.keys(patch).length) { this.leave(); this.host.feedback?.('模型限制未修改'); return; }
      // A currently unoverridden field already has a known inherited value in
      // the captured effective frame. It is safe for preview only, never patch.
      // Clearing an explicit override does NOT reveal its base: keep it unknown
      // unless the directory supplies it, rather than pinning the old override.
      const preview = Object.fromEntries(keys.map(k => [k, next[k] ?? initial.catalog?.[k] ?? (initial.overrides[k] === undefined ? initial.effective[k] : undefined)])) as ModelLimitValues;
      if (preview.contextWindow !== undefined && preview.maxTokens !== undefined && preview.maxTokens > preview.contextWindow) { this.message('输出上限不能大于上下文窗口；请核对覆盖与目录参考。', true); return; }
      const diffs: ModelDiff[] = [{ ref, fields: keys.filter(k => Object.hasOwn(patch, k)).map(k => ({ field: k,
        before: initial.overrides[k] === undefined ? { present: false } : { present: true, value: initial.overrides[k]! },
        after: next[k] === undefined ? { present: false } : { present: true, value: next[k]! },
      })) }];
      this.beginView();
      this.show({ ...this.base(reset ? '确认重置本地限制' : '确认修改本地限制', true), kind: 'confirm', purpose: 'model-limits', target: { kind: 'model', ref },
        affectedModels: [ref], replacements: [], affectsCurrent: this.host.guard().current?.provider === provider && this.host.guard().current?.id === modelId, affectsDefault: false, replacementApplied: false, diffs,
        content: { stage: reset ? '重置为继承' : '本地覆盖差异', title: `${ref.provider} / ${ref.id}`, sections: [{ lines: [
          '差异仅指本地覆盖；未配置表示继承，不是复制当前生效数值。',
          `刷新后预览：${status(preview, '未知（刷新后确认）')}`, warning,
          '仅保存上述两字段的变更；其他覆盖不变，不切换当前模型或全局默认。',
        ] }] }, actions: [this.action('commit-limits', reset ? '确认重置' : '确认保存', async () => {
          // Retained private Inputs can change without a changed notification.
          // Re-review rather than authorizing a different intent with an old token.
          if (!equal(this.values(form), raw)) { publish(); this.message('输入已变化，请重新查看差异。', true); return; }
          assertState();
          await this.storeWrite(() => {
            assertState();
            // Progress publication is a reentrant barrier too. Do not commit an
            // old intent if a retained private Input changed while it rendered.
            if (!equal(this.values(form), raw)) throw new StoreError('CONFLICT');
            port.commit(provider, modelId, patch, initial.revision);
          }, { provider, modelId }, publish);
        }, { primary: true, requiresReview: true }), this.action('back', '返回编辑', publish), this.action('cancel-task', '取消任务', () => this.leave())] }, publish);
    };
    publish();
  }
  private modelForm(row: Row, back: () => void, direct = false): void {
    const f = this.flow!, initial = clone(row.model); this.beginView();
    const readonly = direct && f.readonly;
    const encoded = (level: typeof THINKING_LEVELS[number]) => { const v = initial.thinkingLevelMap?.[level]; return v === undefined ? '' : v === null ? '-' : v === '' || v === '-' || v.startsWith('=') ? `=${v}` : v; };
    const fields: Field[] = [
      { id: 'name', label: '显示名', input: input(initial.name ?? initial.id) }, { id: 'context', label: '上下文窗口', input: input(String(initial.contextWindow)) }, { id: 'output', label: '最大输出', input: input(String(initial.maxTokens)) },
      { id: 'reasoning', label: '思考能力', choices: ['否','是'], choice: initial.reasoning ? 1 : 0 }, { id: 'vision', label: '图片输入', choices: ['否','是'], choice: initial.input.includes('image') ? 1 : 0 },
      { id: 'map-mode', label: '强度映射', choices: ['Pi默认（未配置）','显式映射（可为空）'], choice: initial.thinkingLevelMap === undefined ? 0 : 1, advanced: true },
      ...(row.suggested ? [{ id: 'suggestion', label: '实测建议映射', choices: ['不采用建议','采用接口接受建议'], choice: 0, hint: `${Object.keys(row.suggested).join(' / ')}；只证明参数接受，可能含有效历史。`, advanced: true }] : []),
      ...THINKING_LEVELS.map(level => ({ id: `thinking:${level}`, label: `强度 ${level}`, input: input(encoded(level)), hint: '空=Pi默认 · -=不支持 · = 后跟字面值（=表示空字符串）', advanced: true })),
    ].map(field => ({ ...field, readonly }));
    const form: Form = { viewId: this.base(`参数:${initial.id}`).viewId, fields, changed: fieldId => {
      if (this.form !== form) return;
      if (fieldId?.startsWith('thinking:')) fields.find(f => f.id === 'map-mode')!.choice = 1;
      if (this.task) { this.task = { ...this.task, reviewToken: null, error: undefined }; this.emit(); }
    }, back, save: async () => {
      if (readonly) return; this.assertFlow(f);
      const v = this.valuesById(form); const contextWindow = Number(v.context), maxTokens = Number(v.output);
      if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || contextWindow < maxTokens) { this.message('窗口/输出须为正整数，输出不能大于窗口。', true); return; }
      const map: ThinkingLevelMap = {};
      for (const level of THINKING_LEVELS) { const value = v[`thinking:${level}`]; if (value === '') continue; map[level] = value === '-' ? null : value.startsWith('=') ? value.slice(1) : value; }
      const copied = copyThinkingLevelMap(map); if (!copied) { this.message('强度映射值过长或含控制字符。',true); return; }
      // Typing any mapping explicitly selects it, but clearing all retains the map-mode distinction.
      let hasMap = v['map-mode'] === '显式映射（可为空）';
      if (v.suggestion === '采用接口接受建议' && row.suggested) {
        Object.assign(copied,row.suggested); hasMap = true;
        row.usesPrevious = Object.keys(row.suggested).some(level => row.suite?.checks.thinking[level as 'xhigh'].status !== 'passed');
      }
      const next: ModelInput = { id: initial.id, name: v.name.trim() || initial.id, contextWindow, maxTokens, reasoning: v.reasoning === '是', input: v.vision === '是' ? ['text','image'] : ['text'], ...(hasMap ? { thinkingLevelMap: copied } : {}) };
      if (clean(next.name) !== next.name || next.name!.length > 256) { this.message('显示名过长或含控制字符。',true); return; }
      for (const field of FIELDS) if (!equal(next[field], initial[field])) {
        row.editedAt ??= {}; row.editedAt[field] = Date.now();
        row.resolved.provenance[field] = { source: 'manual', history: [...row.resolved.provenance[field].history, { source: 'manual', reason: 'user-edited' }] };
        row.resolved.needsReview = row.resolved.needsReview.filter(x => x !== field);
      }
      row.model = next; row.manual = true;
      if (direct && !this.diffs().length) { this.leave(); this.host.feedback?.('模型参数未修改'); }
      else if (direct) this.commitConsent(); else back();
    } };
    this.forms.add(form);
    const actions = [this.action('save-form', direct ? '查看保存差异' : '保存参数并返回', () => form.save(), { primary: true, disabled: readonly }), this.action('back','返回',back), this.action('cancel-task','取消任务',() => this.leave())];
    this.show({ ...this.base(`${this.publicText(initial.id)} · 参数${readonly ? '（只读）' : ''}`), viewId: form.viewId, kind: 'edit', target: { kind: 'model', ref: { provider: this.publicText(f.provider.id), id: this.publicText(initial.id) } }, readonly, parameters: this.parameters(initial), evidence: this.evidence(row), content: { stage: '参数', title: '只修改明确字段，保留未知配置与模型覆盖地址', sections: [{ lines: ['高级映射保留 off/minimal/low/medium/high/xhigh/max；未配置、空映射、不支持和字面空值各自独立。'] }] }, actions }, back, form);
  }
  private info(title: string, lines: string[], back = () => this.leave(), purpose: 'details'|'error'|'help'|'history' = 'error'): void {
    this.beginView(); this.show({ ...this.base(title), kind: 'info', purpose, content: { stage: title, title, sections: [{ lines: lines.map(s => this.publicText(s)) }] }, actions: [this.action('back','返回',back), this.action('cancel-task','结束任务',() => this.leave())] }, back);
  }
  openHelp(): void {
    if (this.disposed || this.task?.kind === 'progress') return;
    const task = this.task, route = new Map(this.route), form = this.form, back = this.back;
    this.info('快捷键与能力边界', ['矩阵 Tab/Shift+Tab：对象↔可见动作；普通数字不触发操作。', 'Alt+1 收藏 · 2 编辑 · 3 检查 · 4 默认 · 5/6 排序 · 7 添加 · 8 移除 · 9 新供应商 · 0 归档', '任务页自然方向键/普通Tab；Alt+数字直达当前可见动作。Alt+T 配色。', 'Esc 返回/停止到部分报告；Ctrl+C 结束任务。添加和恢复不自动切换当前/默认模型。', '检查仅固定合成样例，支持Chat/Responses；AI分析策略、完整逐字段历史回退尚未实现。'], () => { this.route = route; this.show(task!,back,form); if (!task) this.leave(); }, 'help');
  }
  openFast(): void {
    if (this.disposed || this.task?.kind === 'progress' || !this.host.fast) return;
    const origin = this.task, route = new Map(this.route), back = this.back, form = this.form;
    this.fastBack = () => { this.route = route; if (origin) this.show(origin,back,form); else this.leave(); };
    this.fastPage();
  }
  private fastBack?: () => void;
  private fastSession(): SessionFast {
    const info = this.host.fast!.snapshot(), current = this.host.guard().current;
    return { current: current ? { provider: this.publicText(current.provider), id: this.publicText(current.id) } : null, modelLabel: this.publicText(info.modelLabel), tier: info.tier, supported: info.supported, active: info.active, ultrafastEnabled: info.ultrafastEnabled };
  }
  private fastPage(): void {
    if (!this.host.fast) return; const session = this.fastSession(); this.beginView();
    this.show({ ...this.base('当前会话 Fast'), kind: 'fast', session, observations: this.host.fast.describe().split('\n').map(s => this.publicText(s)), content: { stage: '会话策略', title: session.modelLabel, sections: [{ lines: ['仅影响当前会话后续适用请求；不切换候选或默认，不重写分支/历史策略。', '请求档位、上游回显、实际加速与计费分别看待。Ultrafast 仅显式启用时可选。'] }] }, actions: [
      this.action('fast-off','关闭',() => { if (this.host.fast?.setTier('off')) this.fastPage(); }),
      this.action('fast-priority','Fast（priority）',() => { if (this.host.fast?.setTier('priority')) this.fastPage(); }, { disabled: !session.supported }),
      this.action('fast-ultrafast','Ultrafast',() => { if (this.host.fast?.setTier('ultrafast')) this.fastPage(); }, { disabled: !session.supported || !session.ultrafastEnabled }),
      this.action('fast-observations','发送与回显',() => this.info('Fast 观察（不发请求）',this.host.fast!.describe().split('\n'),() => this.fastPage(),'history')),
      this.action('back','返回',() => this.fastBack?.()), this.action('cancel-task','结束任务',() => this.leave()),
    ] }, () => this.fastBack?.());
  }
  refreshFast(): void { if (!this.disposed && this.task?.kind === 'fast') this.fastPage(); }
  private removal?: { target: ActionTarget; revision: string; affected: ModelRef[]; guard: Guard };
  private removeConsent(target: ActionTarget): void {
    const provider = target.provider; if (!provider) throw new StoreError('NOT_FOUND'); this.writable(provider);
    const summary = this.host.store.snapshot(), p = summary.providers.find(p => p.id === provider), guard = this.host.guard();
    if (!p || (target.kind !== 'provider' && !p.models.some(m => m.id === target.modelId))) throw new StoreError('NOT_FOUND');
    if (guard.defaultUnknown) throw new StoreError('DEFAULT_UNKNOWN');
    if (this.host.store.hasPending()) { void this.recovery(); return; }
    const modelId = target.kind === 'provider' ? undefined : target.modelId;
    const affected = p.models.filter(m => !modelId || m.id === modelId).map(m => ({ provider, id: m.id }));
    this.removal = { target: { ...target, modelId }, revision: summary.revision, affected, guard };
    const affects = (ref?: ModelRef) => ref?.provider === provider && (!modelId || ref.id === modelId);
    const current = affects(guard.current), def = affects(guard.default);
    const candidates = (this.host.available?.() ?? []).filter(m => !affects(m));
    this.beginView();
    const replace = current || def;
    this.show({ ...this.base(replace ? '先选择替代模型' : '确认移除（可恢复）', true), kind: 'confirm', purpose: replace ? 'replacement' : 'remove', target: this.pickerTarget(target), affectedModels: affected.map(r => ({ provider: this.publicText(r.provider), id: this.publicText(r.id) })), replacements: candidates.map(m => ({ ref: { provider: this.publicText(m.provider), id: this.publicText(m.id) }, label: this.publicText(m.name ?? `${m.provider} / ${m.id}`) })), affectsCurrent: current, affectsDefault: def, replacementApplied: this.replacementApplied,
      content: { stage: '移除', title: replace ? '当前/默认先明确替换，再单独确认移除' : '只移除并归档，不永久删除', sections: [{ lines: [`全量影响 ${affected.length} 个模型（包含搜索隐藏项）：`, ...affected.map(m => `${this.publicText(m.provider)} / ${this.publicText(m.id)}`), ...(this.replacementApplied ? ['当前/默认已切换；取消不会自动切回。'] : []), ...(replace && (!candidates.length || !this.host.replace) ? ['无可用替代或宿主不支持替换；请先切换后再移除。'] : [])] }] }, actions: [
      ...(replace ? [this.action('replacement','选择替代',() => {}, { disabled: !candidates.length || !this.host.replace })] : [this.action('confirm-remove','确认移除并归档',() => this.remove(), { danger: true, requiresReview: true })]),
      this.action('cancel-confirm','取消',() => this.leave()),
    ] }, () => this.leave());
  }
  private pickerTarget(t: ActionTarget): PickerTarget { return t.kind === 'provider' || !t.modelId ? { kind: 'provider', provider: this.publicText(t.provider) } : { kind: 'model', ref: { provider: this.publicText(t.provider), id: this.publicText(t.modelId) } }; }
  private replacementConsent(ref: ModelRef): void {
    const r = this.removal!; const g = this.host.guard();
    if (!this.host.replace || !(this.host.available?.() ?? []).some(m => m.provider === ref.provider && m.id === ref.id) || (ref.provider === r.target.provider && (!r.target.modelId || ref.id === r.target.modelId))) return;
    if (this.host.store.snapshot().revision !== r.revision || !equal(g.current,r.guard.current) || !equal(g.default,r.guard.default) || g.busy || g.defaultUnknown) throw new StoreError('CONFLICT');
    const affected = (m?: ModelRef) => !!m && m.provider === r.target.provider && (!r.target.modelId || m.id === r.target.modelId), targets = { current: affected(g.current), default: affected(g.default) };
    this.beginView();
    this.show({ ...this.base('确认替换后继续移除确认',true), kind: 'confirm', purpose: 'replacement', target: this.pickerTarget(r.target), affectedModels: r.affected, replacements: [{ ref: { provider: this.publicText(ref.provider), id: this.publicText(ref.id) }, label: `${this.publicText(ref.provider)} / ${this.publicText(ref.id)}` }], affectsCurrent: targets.current, affectsDefault: targets.default, replacementApplied: false,
      content: { stage: '替换授权', title: '仅替换，不立即移除', sections: [{ lines: [`${targets.current ? '当前会话 ' : ''}${targets.default ? '全局默认 ' : ''}→ ${this.publicText(ref.provider)} / ${this.publicText(ref.id)}`, '替换可能部分完成；取消移除不会撤回已成功的替换。'] }] }, actions: [this.action('commit','确认替换',async () => {
        this.writable(); const latest = this.host.guard();
        if (this.host.store.snapshot().revision !== r.revision || !equal(latest.current,g.current) || !equal(latest.default,g.default) || latest.defaultUnknown || latest.busy) throw new StoreError('CONFLICT');
        const token = ++this.epoch; this.progress('replacement','替换当前/默认','none');
        try { await this.host.replace!(ref,targets,latest); if (token !== this.epoch || this.disposed) return;
          const now = this.host.guard(); if (now.busy || now.defaultUnknown || affected(now.current) || affected(now.default) || this.host.store.snapshot().revision !== r.revision) throw new StoreError('CONFLICT');
          this.replacementApplied = true; this.removeConsent(r.target);
        } catch { if (token === this.epoch && !this.disposed) this.info('替换未完整完成', ['未归档；当前/默认可能已部分改变，请重新核对。']); }
      }, { requiresReview: true, primary: true }), this.action('back','返回替代选择',() => this.removeConsent(r.target)), this.action('cancel-task','停止移除',() => this.leave())] }, () => this.removeConsent(r.target));
  }
  private async remove(): Promise<void> {
    const r = this.removal!;
    const check = () => {
      this.writable(r.target.provider);
      const guard = this.host.guard();
      if (guard.defaultUnknown) throw new StoreError('DEFAULT_UNKNOWN');
      const affected = (ref?: ModelRef) => !!ref && ref.provider === r.target.provider && (!r.target.modelId || ref.id === r.target.modelId);
      if (affected(guard.current)) throw new StoreError('CURRENT_MODEL');
      if (affected(guard.default)) throw new StoreError('DEFAULT_MODEL');
    };
    // Refuse stale destructive consent before lock directories or protected
    // envelopes can be created, then recheck after the saving transition.
    try { check(); }
    catch (error) {
      if (error instanceof StoreError && (error.code === 'CURRENT_MODEL' || error.code === 'DEFAULT_MODEL')) {
        this.removeConsent(r.target); return;
      }
      throw error;
    }
    await this.storeWrite(() => {
      check();
      const previous = new Set(this.host.store.listArchives().map(a => a.id));
      if (r.target.modelId) this.host.store.archiveModel(r.target.provider!,r.target.modelId,r.revision,this.liveGuard());
      else this.host.store.archiveProvider(r.target.provider!,r.revision,this.liveGuard());
      this.undo = null;
      try { const a = this.host.store.listArchives().find(a => !previous.has(a.id)); if (a) this.undo = { id: a.id, provider: a.provider, modelId: a.modelId, revision: this.host.store.snapshot().revision, label: `撤销移除 ${this.publicText(a.provider)}${a.modelId ? ` / ${this.publicText(a.modelId)}` : ''}` }; } catch {}
    }, undefined, () => this.removeConsent(r.target));
  }
  undoLast(): void {
    const u = this.undo; if (!u || this.active || this.disposed) return;
    void this.storeWrite(() => { this.writable(u.provider); this.host.store.restore(u.id,u.revision,this.liveGuard()); this.undo = null; }, { provider: u.provider, modelId: u.modelId },
      () => this.info('无法撤销移除', ['撤销未完成；原归档与撤销身份保留。请在已移除项目中重新核对后恢复。']))
      .catch(error => { if (!this.disposed) this.info('无法撤销移除',[failure(error)]); });
  }
  private archives(): void {
    const summary = this.host.store.snapshot(), entries = this.host.store.listArchives(); this.beginView();
    const data = entries.map(a => {
      const p = summary.providers.find(p => p.id === a.provider);
      const conflict = a.kind === 'model' && (!p || p.models.some(m => m.id === a.modelId) || this.host.isProtected?.(a.provider));
      return { id: a.id, kind: a.kind, provider: this.publicText(a.provider), ...(a.modelId ? { modelId: this.publicText(a.modelId) } : {}), label: `${a.kind === 'provider' ? '整行' : '模型'} · ${this.publicText(a.provider)}${a.modelId ? ` / ${this.publicText(a.modelId)}` : ''}`, createdAt: a.createdAt, restore: { available: !conflict && this.host.storageWritable !== false && !this.host.guard().busy, reason: conflict ? '原供应商不存在/只读或已有同名模型，不能覆盖。' : undefined } };
    });
    this.show({ ...this.base('已移除的项目'), kind: 'archives', entries: data, hasLegacy: this.host.store.hasLegacyData() || this.host.records.hasLegacyData(), content: { stage: '归档', title: '恢复不等于上游账号可用', sections: [{ lines: ['同名不覆盖；供应商冲突由系统生成副本。保留旧版记录，不做永久删除。', '恢复不自动切换当前/默认；凭据可用性仍需核对。'] }] }, actions: [
      ...data.map(a => this.action('restore', a.label, () => this.restoreConsent(a.id), { identity: `restore:${a.id}`, disabled: !a.restore.available, disabledReason: a.restore.reason })),
      this.action('recover','处理未完成修改',() => this.recovery(), { disabled: !this.host.store.hasPending() }), this.action('back','返回',() => this.leave()),
    ] }, () => this.leave());
  }
  private restoreConsent(id: string): void {
    const a = this.host.store.listArchives().find(a => a.id === id); if (!a) return;
    const summary = this.host.store.snapshot(); let destination = a.provider;
    if (a.kind === 'provider') {
      const occupied = new Set([...summary.providers.map(p => p.id), ...this.host.catalog().map(m => m.provider)]);
      if (occupied.has(destination) || this.host.isProtected?.(destination)) {
        const retained = new Set(this.host.store.retained().providers), base = `${destination.slice(0,96)}-restored`; let n = 2; destination = base;
        while (occupied.has(destination) || retained.has(destination) || this.host.isProtected?.(destination)) destination = `${base}-${n++}`;
      }
    }
    this.beginView();
    this.show({ ...this.base('确认恢复归档',true,`restore:${id}`), kind: 'confirm', purpose: 'restore', affectedModels: a.modelId ? [{ provider: this.publicText(destination), id: this.publicText(a.modelId) }] : [], replacements: [], affectsCurrent: false, affectsDefault: false, replacementApplied: false, content: { stage: '恢复', title: this.publicText(a.provider), sections: [{ lines: [a.modelId ? this.publicText(a.modelId) : '整个供应商及全部归档模型', destination !== a.provider ? `已有同名供应商；作为 ${this.publicText(destination)} 副本恢复，不迁移旧收藏/排序。` : '不覆盖同名项；保留原收藏/排序。', '不会自动切换当前/默认；不保证凭据仍有效。'] }] }, actions: [
      this.action('confirm-restore','确认恢复',() => this.storeWrite(() => { this.writable(destination); this.host.store.restore(a.id,summary.revision,this.liveGuard(),a.kind === 'provider' ? destination : undefined); }, { provider: destination, modelId: a.modelId }, () => this.archives()), { primary: true, requiresReview: true }), this.action('back','返回归档',() => this.archives()),
    ] }, () => this.archives());
  }
  private async recovery(): Promise<void> {
    const token = ++this.epoch, abort = new AbortController(); this.abort = abort; this.progress('auth','核对未完成修改','stop-to-report');
    try {
      const revision = this.host.store.snapshot().revision;
      const p = this.host.providerCommit ? await withProbeDeadline(async deadline => {
        try { const value = await this.host.providerCommit!.pending(); deadline(); return value; }
        catch (error) {
          deadline();
          // The store's ordinary recovery still rechecks and refuses credential/foreign journals.
          if (error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error,'code')?.value === 'LEGACY_PENDING') return null;
          throw error;
        }
      },abort) : null;
      if (token !== this.epoch || this.disposed) return;
      const legacy = p ? null : this.host.store.pendingDetails();
      const id = p?.transactionId ?? legacy?.id ?? null;
      const credential = p ? await withProbeDeadline(async deadline => { const c = await this.host.providerCommit!.snapshotCredential(p.providerId); deadline(); return c; },abort) : undefined;
      if (token !== this.epoch || this.disposed) return;
      this.beginView();
      this.show({ ...this.base('恢复未完成修改',true), kind: 'recovery', pendingId: id, operation: p?.operation ?? legacy?.kind ?? '无', canRecover: { available: !!id && this.host.storageWritable !== false, reason: !id ? '没有待恢复修改。' : undefined }, content: { stage: '恢复核对', title: p ? `${this.publicText(p.providerId)} · ${p.state}` : this.publicText(legacy?.provider ?? '没有待恢复修改'), sections: [{ lines: ['只恢复当前已核对的事务身份；不覆盖外部变更，旧版材料保持原样。', '凭据协调恢复只在后端判定安全时完成；不重试添加。'] }] }, actions: [this.action('confirm-recover','确认完成修改',async () => {
        this.writable();
        if (!id) return;
        if (p) {
          const current = await this.host.providerCommit!.pending(); if (current?.transactionId !== id) throw new StoreError('CONFLICT');
          const op = ++this.epoch; this.progress('save','恢复协调提交','none');
          const result = await this.host.providerCommit!.recover({ transactionId: id, action: 'complete', expectedModelsRevision: revision, expectedCredentialRevision: credential!.revision });
          if (op !== this.epoch || this.disposed) return;
          this.storageStateChanged();
          if (result.status === 'committed') await this.saved(); else this.info('恢复未完成', [`结果：${result.status} · ${result.code}；未自动重试，请核对。`]);
        } else await this.storeWrite(() => this.host.store.recover(revision,this.liveGuard(),id));
      }, { requiresReview: true, primary: true, disabled: !id || this.host.storageWritable === false }), this.action('back','返回',() => this.leave()), this.action('cancel-task','结束任务',() => this.leave())] }, () => this.leave());
    } catch (error) { if (token === this.epoch && !this.disposed) { if (abort.signal.aborted) this.leave(); else this.info('无法安全恢复', [failure(error), '旧版/外部/凭据事务不会通过旧恢复路径绕过。']); } }
    finally { if (token === this.epoch) this.abort = undefined; }
  }
}
