import type { Input } from '@earendil-works/pi-tui';
import type { RequestTier } from '../fast.js';
import type { SheetContent } from './presentation.js';
import type { SuiteProgress, SuiteReport } from './probe-suite.js';
import type { FieldProvenance, ThinkingLevelMap } from './reference.js';
import type { ModelInput } from './store.js';

/**
 * Formal UI boundary, not a simulator or an effect implementation.
 * Parent: registry/fuzzy ordering, matrix persistence, palettes, current/default/Fast.
 * Controller: real drafts, field lifetimes/codecs, validation, authorization and effects.
 * Component: focus/cursors, viewport/return frames, help/advanced expansion and review.
 * Snapshots are detached, JSON-safe projections: no callbacks, Inputs, keys, headers,
 * credential generations/signatures, unknown config fields or raw provider responses.
 * Producers must whitelist-copy data (no spreading config/auth objects); sanitize strings.
 * View IDs survive ordinary updates; review tokens change whenever reviewed facts do.
 */
export type ReadonlyData<T> = T extends readonly (infer U)[] ? readonly ReadonlyData<U>[]
  : T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T;
export interface ModelRef { readonly provider: string; readonly id: string }
export type PickerSelection = { readonly kind: 'model'; readonly ref: ModelRef }
  | { readonly kind: 'provider'; readonly provider: string } | { readonly kind: 'none' };
export type PickerTarget = Exclude<PickerSelection, { readonly kind: 'none' }>;
export type ModelParameters = ReadonlyData<Pick<ModelInput,
  'name' | 'contextWindow' | 'maxTokens' | 'reasoning' | 'input' | 'thinkingLevelMap'>>;
export type ModelField = keyof ModelParameters;
export type ModelFieldValue = string | number | boolean | readonly ('text' | 'image')[]
  | Readonly<ThinkingLevelMap>;
export type FieldValue = { readonly present: false }
  | { readonly present: true; readonly value: ModelFieldValue };
export interface ModelDiff {
  readonly ref: ModelRef;
  readonly fields: readonly { readonly field: ModelField; readonly before: FieldValue; readonly after: FieldValue }[];
}
export interface FieldEvidence {
  readonly field: ModelField;
  readonly provenance: ReadonlyData<FieldProvenance>;
  readonly when?: number;
  readonly conditions?: readonly string[];
  readonly testId?: string;
  readonly previous?: FieldValue;
}
export interface Capability { readonly available: boolean; readonly reason?: string }
export type PickerDigit = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '0';
export type PickerActionId =
  | 'switch' | 'favorite' | 'edit-model' | 'inspect' | 'default' | 'move-left' | 'move-right'
  | 'add-model' | 'remove-model' | 'new-provider' | 'archives' | 'undo' | 'locate' | 'fast'
  | 'edit-provider' | 'provider-up' | 'provider-down' | 'remove-provider' | 'cycle-palette' | 'help' | 'close-help' | 'close-info'
  | 'connect' | 'manual-connection' | 'save-form' | 'reset-limits' | 'commit-limits' | 'back' | 'cancel-task' | 'next-models'
  | 'read-list' | 'manual-id' | 'add-ids' | 'stop-read' | 'run' | 'skip' | 'image' | 'reuse' | 'cancel-checks'
  | 'commit' | 'finish-inspect' | 'adjust' | 'recheck' | 'details' | 'apply-inspect' | 'sync-reference'
  | 'replacement' | 'confirm-remove' | 'cancel-confirm' | 'restore' | 'confirm-restore'
  | 'recover' | 'confirm-recover' | 'fast-off' | 'fast-priority' | 'fast-ultrafast' | 'fast-observations';
export interface PickerAction {
  readonly id: PickerActionId;
  /** Stable semantic identity, e.g. restore:<archive ID>; never label or array index. */
  readonly identity: string;
  readonly label: string;
  /** Home: Enter switch, 1 favorite, 2 edit, 3 inspect, 4 default, 5/6 order,
   * 7 add-model, 8 remove, 9 new-provider, 0 archives. Missing digits never shift. */
  readonly digit?: PickerDigit;
  readonly shortcut?: string;
  readonly disabled: boolean;
  readonly disabledReason?: string;
  readonly primary?: boolean;
  readonly danger?: boolean;
  readonly requiresReview?: boolean;
}
export interface ViewIdentity {
  readonly viewId: string;
  /** Opaque public revision token, not a digest/serialization of secret draft state. */
  readonly reviewToken: string | null;
  readonly actions: readonly PickerAction[];
  readonly message?: string;
  readonly error?: string;
}
export interface MatrixModel {
  readonly ref: ModelRef;
  readonly name: string;
  readonly parameters: ModelParameters;
  readonly favorite: boolean;
  /** Metadata-only limit editing; never grants provider or full-model writes. */
  readonly limitsEditable?: boolean;
  readonly readonly: boolean;
  readonly availability: 'ready' | 'unavailable';
  readonly unavailableReason?: string;
}
export interface MatrixProvider {
  readonly id: string;
  readonly name: string;
  readonly endpoint?: string;
  readonly api?: string;
  readonly readonly: boolean;
  readonly models: readonly MatrixModel[];
}
export interface VisibleProvider {
  readonly provider: string;
  /** Fuzzy-ranked IDs, all belonging to this provider; no foreign templates. */
  readonly modelIds: readonly string[];
}
export interface PickerPalette {
  readonly id: string;
  readonly name: string;
  /** Semantic CSS hex colors, rendered through the injected Pi theme/style API. */
  readonly colors: Readonly<Record<'current' | 'default' | 'favorite' | 'selection' | 'text'
    | 'dim' | 'accent' | 'blue' | 'success' | 'warning' | 'error', string>>;
  readonly gradient: readonly string[];
  readonly stepped: boolean;
}
export interface SessionFast {
  readonly current: ModelRef | null;
  readonly modelLabel: string;
  readonly tier: RequestTier;
  readonly supported: boolean;
  readonly active: boolean;
  readonly ultrafastEnabled: boolean;
}
export interface MatrixSnapshot extends ViewIdentity {
  readonly kind: 'matrix';
  /** Full ordered data budgets shared columns, independently of fuzzy visibility. */
  readonly providers: readonly MatrixProvider[];
  readonly visible: readonly VisibleProvider[];
  readonly query: string;
  readonly selected: PickerSelection;
  readonly current: ModelRef | null;
  readonly default: ModelRef | null;
  readonly defaultKnown: boolean;
  readonly busy: boolean;
  readonly configReadable: boolean;
  readonly palette: PickerPalette;
  readonly fast: SessionFast;
  readonly undo: { readonly identity: string; readonly label: string } | null;
  readonly locate: PickerTarget | null;
}
/** No auth material. A model-level override may differ from the supplier endpoint. */
export interface ConnectionTarget { readonly provider: string; readonly endpoint: string; readonly api: string }
export interface TaskBase extends ViewIdentity {
  readonly title: string;
  readonly content?: ReadonlyData<SheetContent>;
  /** Links a flow's subpages for UI-owned return frames; not a serialized draft. */
  readonly flowId: string;
}
export interface ConnectionSnapshot extends TaskBase {
  readonly kind: 'connection';
  readonly target: ConnectionTarget;
  readonly isNew: boolean;
}
export interface EditSnapshot extends TaskBase {
  readonly kind: 'edit';
  /** A private single-field draft form, not model-parameter editing. */
  readonly purpose?: 'manual-ids' | 'model-limits';
  readonly target: PickerTarget;
  readonly readonly: boolean;
  readonly parameters?: ModelParameters;
  readonly evidence?: readonly FieldEvidence[];
}
export interface BasketModel {
  readonly id: string;
  readonly name: string;
  readonly parameters?: ModelParameters;
  readonly needsReview: readonly ModelField[];
  readonly evidence?: readonly FieldEvidence[];
  readonly manual: boolean;
}
export interface BasketSnapshot extends TaskBase {
  readonly kind: 'basket';
  readonly target: ConnectionTarget;
  readonly query: string;
  /** Full available set, never query-prefiltered. */
  readonly candidates: readonly BasketModel[];
  readonly selected: readonly BasketModel[];
  /** idle means NOT READ, never a confirmed empty upstream response. */
  readonly listStatus: 'idle' | 'loading' | 'loaded' | 'failed' | 'cancelled' | 'unsupported';
  /** Last successful same-connection read; failures retain these and the draft. */
  readonly listCounts?: { readonly total: number; readonly added: number; readonly available: number };
  /** One-page return hint after a successful private manual join. */
  readonly focusAction?: 'manual-id';
  readonly listMessage: string;
  readonly maxSelected: number;
}
export interface ProbePlan {
  readonly id: string;
  readonly targets: readonly { readonly connection: ConnectionTarget; readonly model: ModelRef }[];
  readonly items: readonly { readonly id: string; readonly model: ModelRef; readonly label: string }[];
  readonly maxRequests: number;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number;
  readonly authTimeoutMs: number;
  readonly maxDurationMs: number;
  readonly retries: number;
  readonly priceNote: string;
  readonly includeImage: boolean;
  readonly capability: Capability;
  readonly reuse: Capability;
}
export interface PreflightSnapshot extends TaskBase {
  readonly kind: 'preflight'; readonly plan: ProbePlan;
  /** The controller supplied the complete targets, limits and consent text in
   * content. Render it once rather than duplicating every request in a second list. */
  readonly contentOwnsPlan?: boolean;
}
export interface ProgressSnapshot extends TaskBase {
  readonly kind: 'progress';
  readonly operation: 'discovery' | 'checks' | 'auth' | 'save' | 'replacement';
  readonly plan?: ProbePlan;
  readonly progress?: ReadonlyData<SuiteProgress>;
  readonly progressModel?: ModelRef;
  readonly items: readonly { readonly id: string; readonly model?: ModelRef; readonly label: string;
    readonly status: 'waiting' | 'running' | 'passed' | 'inconclusive' | 'not-tested' | 'cancelled'; readonly detail?: string }[];
  readonly cancellation: 'none' | 'stop-to-report' | 'stop-to-basket';
  readonly cancelling: boolean;
}
export interface ModelReport {
  readonly ref: ModelRef;
  readonly parameters: ModelParameters;
  readonly evidence: readonly FieldEvidence[];
  readonly needsReview: readonly ModelField[];
  /** Deliberately excludes SuiteReport.scope, which contains credentialVersion. */
  readonly suite?: ReadonlyData<Omit<SuiteReport, 'scope'>>;
  readonly connection: ConnectionTarget;
  readonly applicable: boolean;
  readonly reused: boolean;
  readonly reportId?: string;
  readonly expiresAt?: number;
}
export interface ReportSnapshot extends TaskBase {
  readonly kind: 'report';
  readonly mode: 'add' | 'inspect';
  readonly models: readonly ModelReport[];
  readonly diffs: readonly ModelDiff[];
  readonly cancelled: boolean;
  readonly batchChecks: Capability;
}
export interface ConfirmSnapshot extends TaskBase {
  readonly kind: 'confirm';
  readonly purpose: 'replacement' | 'remove' | 'restore' | 'apply-inspect' | 'commit' | 'model-limits';
  readonly target?: PickerTarget;
  readonly affectedModels: readonly ModelRef[];
  readonly replacements: readonly { readonly ref: ModelRef; readonly label: string }[];
  readonly affectsCurrent: boolean;
  readonly affectsDefault: boolean;
  readonly replacementApplied: boolean;
  readonly diffs?: readonly ModelDiff[];
}
export interface ArchiveEntry {
  readonly id: string;
  readonly kind: 'model' | 'provider';
  readonly provider: string;
  readonly modelId?: string;
  readonly label: string;
  readonly createdAt: number;
  readonly restore: Capability;
}
export interface ArchivesSnapshot extends TaskBase {
  readonly kind: 'archives'; readonly entries: readonly ArchiveEntry[]; readonly hasLegacy: boolean;
}
export interface InfoSnapshot extends TaskBase {
  readonly kind: 'info'; readonly purpose: 'discovery-consent' | 'details' | 'auth' | 'error' | 'help' | 'history';
}
export interface FastSnapshot extends TaskBase {
  readonly kind: 'fast'; readonly session: SessionFast; readonly observations: readonly string[];
}
export interface RecoverySnapshot extends TaskBase {
  readonly kind: 'recovery'; readonly pendingId: string | null; readonly operation: string;
  readonly target?: PickerTarget; readonly canRecover: Capability;
}
export type PickerTaskSnapshot = ConnectionSnapshot | EditSnapshot | BasketSnapshot | PreflightSnapshot
  | ProgressSnapshot | ReportSnapshot | ConfirmSnapshot | ArchivesSnapshot | InfoSnapshot | FastSnapshot | RecoverySnapshot;
export interface PickerSnapshot { readonly matrix: MatrixSnapshot; readonly task: PickerTaskSnapshot | null }

/** Nonserializable, interaction-private controls. Controller retains ownership/lifetime.
 * Keep existing thinking-field codecs (undefined/empty/null/literal values); never copy
 * secret Input values into snapshots/debug/commands. UI notifies changed() after editing. */
export type PrivateFormField = { readonly id: string; readonly label: string; readonly readonly: boolean;
  readonly hint?: string; readonly advanced?: boolean } & (
  | { readonly kind: 'input'; readonly input: Input; readonly secret: boolean }
  | { readonly kind: 'choice'; readonly choices: readonly string[]; choice(): number; setChoice(index: number): void });
export interface PrivateFormPort {
  readonly viewId: string;
  fields(): readonly PrivateFormField[];
  changed(fieldId: string): void;
}
/** UI reading evidence, NOT backend authorization. All activation routes share it;
 * controller must still recheck plan, configuration, binding, expiry and live guards. */
export interface ReviewProof {
  readonly reviewToken: string; readonly layoutId: string; readonly renderEpoch: number;
  readonly width: number; readonly height: number; readonly complete: true;
}
export interface PickerActionPayloads {
  switch: ModelRef; favorite: ModelRef; 'edit-model': ModelRef; inspect: ModelRef; default: ModelRef;
  'move-left': ModelRef; 'move-right': ModelRef; 'remove-model': ModelRef;
  'add-model': { readonly provider: string }; 'edit-provider': { readonly provider: string };
  'provider-up': { readonly provider: string }; 'provider-down': { readonly provider: string };
  'remove-provider': { readonly provider: string }; adjust: { readonly modelId: string };
  replacement: ModelRef; restore: { readonly archiveId: string };
  image: { readonly include: boolean }; run: { readonly planId: string }; reuse: { readonly planId: string };
}
export type PickerActivation = { [K in PickerActionId]: {
  readonly type: 'activate'; readonly viewId: string; readonly id: K; readonly identity: string; readonly review?: ReviewProof;
} & (K extends keyof PickerActionPayloads ? { readonly payload: PickerActionPayloads[K] } : { readonly payload?: never }) }[PickerActionId];
export type PickerCommand = PickerActivation | { readonly viewId: string } & (
  | { readonly type: 'matrix-query'; readonly query: string }
  | { readonly type: 'matrix-select'; readonly selection: PickerSelection }
  | { readonly type: 'basket-query'; readonly query: string }
  | { readonly type: 'basket-toggle'; readonly modelId: string });
export interface PickerWorkspace {
  snapshot(): PickerSnapshot;
  subscribe(listener: () => void): () => void;
  formFields(viewId: string): PrivateFormPort | undefined;
  /** Resolve save-form/connect from owned field controls; never accept cloned keys.
   * Reject stale view/action identities; promise completion must not revive cancelled views. */
  dispatch(command: PickerCommand): void | Promise<void>;
  dispose(): void;
}
