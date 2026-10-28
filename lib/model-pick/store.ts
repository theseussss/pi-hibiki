import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { sealJson, openJson } from './vault.js';
import type { RecordProtection } from './protection.js';

export type Guard = {
  current?: { provider: string; id: string };
  default?: { provider: string; id: string };
  defaultUnknown?: boolean;
  busy?: boolean;
  /** Trusted live runtime context only; never stored in models, archives or journals. */
  recheck?: () => Guard;
};

type Dict = Record<string, unknown>;
export type ModelInput = {
  id: string; name?: string; contextWindow: number; maxTokens: number;
  reasoning: boolean; input: ('text' | 'image')[];
};
export type ProviderInput = { id: string; name: string; endpoint: string; api: string; envVar?: string };
type ProviderEdit = { name?: string; endpoint?: string; api?: string; envVar?: string };
type Archive = {
  id: string; kind: 'provider' | 'model'; provider: string; modelId?: string; createdAt: number;
  payload: Dict; binding?: { baseUrl: string | null; api: string | null };
  restoredAt?: number; restoredProvider?: string;
};
type Operation = { kind: string; provider: string; modelId?: string; archiveId?: string };
type Journal = {
  id: string; createdAt: number; before: string | null; after: string;
  beforeRevision: string; afterRevision: string; operation: Operation; archivesAfter: Archive[];
};
type VaultState = { version: 1; archives: Archive[]; history: Journal[]; pending: Journal | null };
type VaultRead = { raw: string | null; state: VaultState };
type Retention = { providers: string[]; models: string[] };
type Config = Dict & { providers?: Record<string, Dict> };
type Image = { raw: string | null; revision: string; config: Config };
type Lock = { token: string; raw: string };

const MESSAGES: Record<string, string> = {
  INVALID_INPUT: 'Invalid model management input.',
  INVALID_CONFIG: 'The model configuration is invalid; changes were refused.',
  INVALID_VAULT: 'The encrypted store cannot be opened or is invalid.',
  INVALID_INDEX: 'The retention index is invalid or unavailable.',
  UNSAFE_PATH: 'An unsafe model management path was refused.',
  LOCKED: 'Unlock the encrypted store before making changes.',
  BUSY: 'Model management is unavailable while a request is running.',
  PROTECTED: 'Built-in and extension-managed providers cannot be changed here.',
  CURRENT_MODEL: 'Switch away from this model or provider before archiving it.',
  DEFAULT_MODEL: 'Change the default model before archiving this model or provider.',
  DEFAULT_UNKNOWN: 'Default model state could not be verified; check settings before archiving.',
  CONFLICT: 'The configuration or transaction changed; refresh and review before continuing.',
  EXISTS: 'The requested provider or model already exists.',
  NOT_FOUND: 'The requested provider, model, or archive was not found.',
  PENDING: 'An unfinished transaction requires explicit recovery.',
  NO_PENDING: 'There is no unfinished transaction to recover.',
  LEGACY_PENDING: 'An unfinished legacy transaction is preserved; separately authorized legacy recovery is required.',
  IO_ERROR: 'The model management operation could not be completed safely.',
};

export class StoreError extends Error {
  code: string;
  constructor(code: string) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'IO_ERROR';
    super(MESSAGES[safeCode]);
    this.name = 'StoreError';
    this.code = safeCode;
  }
}

const APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const TX_PREFIX = '.model-pick-store-';
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_VAULT_BYTES = 128 * 1024 * 1024;
// Bound each interactive batch's validation/allocation work; the existing config
// and authenticated-vault byte/depth limits still preflight the complete transaction.
const MAX_BATCH_MODELS = 100;
const HISTORY_LIMIT = 20; // Retain exactly the most recent 20 successful full before/after backups; archives are never pruned.
const OPS = new Set(['add-provider', 'edit-provider', 'put-model', 'archive-provider', 'archive-model', 'restore-provider', 'restore-model']);
const own = (v: object, key: string) => Object.hasOwn(v, key);
const object = (v: unknown): v is Dict => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function fail(code: string): never { throw new StoreError(code); }
function safe<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    if (error instanceof StoreError) throw error;
    // Never propagate native errors, causes, paths, crypto messages, or input values.
    throw new StoreError('IO_ERROR');
  }
}
function text(v: unknown, max = 256): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v &&
    !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
}
function providerId(v: unknown): v is string {
  return text(v, 128) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v) && !DANGEROUS.has(v);
}
function modelId(v: unknown): v is string { return text(v, 512) && !DANGEROUS.has(v); }
function cleanTree(v: unknown, code: string, depth = 0): void {
  if (depth > 100 || (typeof v === 'number' && !Number.isFinite(v)) ||
      typeof v === 'bigint' || typeof v === 'symbol' || typeof v === 'function') fail(code);
  if (v === null || typeof v !== 'object') return;
  // Inputs must be JSON data, not getters/toJSON hooks, proxies or inherited data.
  // Inspect descriptors rather than evaluating potentially executable properties.
  if (types.isProxy(v)) fail(code);
  const array = Array.isArray(v);
  const prototype = Object.getPrototypeOf(v);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail(code);
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== 'string' || DANGEROUS.has(key)) fail(code);
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
    if (!descriptor.enumerable || !own(descriptor, 'value')) fail(code);
    cleanTree(descriptor.value, code, depth + 1);
  }
}
function exactKeys(v: Dict, allowed: string[], required: string[] = allowed): boolean {
  return Object.keys(v).every(k => allowed.includes(k)) && required.every(k => own(v, k));
}
function json(raw: string, code: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail(code); }
  cleanTree(value, code);
  return value;
}
function configValue(v: unknown, code = 'INVALID_CONFIG'): Config {
  cleanTree(v, code);
  if (!object(v)) fail(code);
  if (own(v, 'providers')) {
    if (!object(v.providers)) fail(code);
    for (const [id, p] of Object.entries(v.providers)) {
      if (!providerId(id) || !object(p)) fail(code);
      if (own(p, 'name') && !text(p.name)) fail(code);
      if (own(p, 'baseUrl') && (typeof p.baseUrl !== 'string' || p.baseUrl.length > 8192)) fail(code);
      if (own(p, 'api') && !text(p.api, 128)) fail(code);
      if (own(p, 'models')) {
        if (!Array.isArray(p.models)) fail(code);
        const ids = new Set<string>();
        for (const m of p.models) {
          if (!object(m) || !modelId(m.id) || ids.has(m.id)) fail(code);
          if (own(m, 'name') && !text(m.name)) fail(code);
          ids.add(m.id);
        }
      }
    }
  }
  return v as Config;
}
function revision(raw: string | null): string {
  return createHash('sha256').update(raw === null ? 'absent\0' : `file\0${raw}`).digest('hex');
}
function encode(v: unknown): string { return `${JSON.stringify(v, null, 2)}\n`; }
function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function endpoint(value: unknown): string {
  if (!text(value, 4096)) fail('INVALID_INPUT');
  let u: URL;
  try { u = new URL(value); } catch { return fail('INVALID_INPUT'); }
  // Inspect raw delimiters too: URL.search/hash collapse a trailing '?' or '#'.
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || value.includes('?') || value.includes('#') ||
      /[\s\\]/u.test(value) || !/^https:\/\//i.test(value) || value.slice(value.indexOf('//') + 2).split('/')[0].includes('@')) fail('INVALID_INPUT');
  return value;
}
function summaryEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) return '';
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    // Build from safe URL components, never the original authority/search/hash.
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch { return ''; }
}
function binding(p: Dict): { baseUrl: string | null; api: string | null } {
  return { baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : null, api: typeof p.api === 'string' ? p.api : null };
}
function models(p: Dict): Dict[] { return (p.models ?? []) as Dict[]; }
/** Call only after cleanTree has rejected executable/prototype-bearing input. */
function modelValue(input: ModelInput): Dict {
  if (!object(input) || !modelId(input.id) || (input.name !== undefined && !text(input.name)) ||
      !positive(input.contextWindow) || !positive(input.maxTokens) || input.maxTokens > input.contextWindow ||
      typeof input.reasoning !== 'boolean' || !Array.isArray(input.input) || input.input.length === 0 || input.input.length > 2 ||
      !input.input.every(x => x === 'text' || x === 'image') || new Set(input.input).size !== input.input.length) fail('INVALID_INPUT');
  return { id: input.id, ...(input.name === undefined ? {} : { name: input.name }),
    contextWindow: input.contextWindow, maxTokens: input.maxTokens, reasoning: input.reasoning, input: [...input.input] };
}
function batchModels(inputs: ModelInput[], existing: Dict[] = []): Dict[] {
  // Reject proxies before length/index access, and oversized arrays before walking
  // their contents. cleanTree then inspects descriptors, never invoking hooks.
  if (types.isProxy(inputs) || !Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_BATCH_MODELS) fail('INVALID_INPUT');
  cleanTree(inputs, 'INVALID_INPUT');
  const ids = new Set(existing.map(m => m.id));
  const result: Dict[] = [];
  for (let i = 0; i < inputs.length; i++) {
    if (!own(inputs, String(i))) fail('INVALID_INPUT'); // No sparse batch lists.
    const next = modelValue(inputs[i]);
    if (ids.has(next.id)) fail('EXISTS');
    ids.add(next.id); result.push(next);
  }
  return result;
}
function envName(v: unknown): v is string { return typeof v === 'string' && v.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v); }
function credential(p: Dict): 'reference' | 'configured' | 'missing' {
  if (typeof p.apiKey === 'string' && p.apiKey.length > 0) {
    const key = p.apiKey;
    const reference = /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(key) ||
      (key.startsWith('!') && key.slice(1).trim().length > 0);
    return reference ? 'reference' : 'configured';
  }
  if (own(p, 'apiKey') && p.apiKey !== undefined && p.apiKey !== null && p.apiKey !== '') return 'configured';
  return object(p.headers) && Object.keys(p.headers).length > 0 ? 'configured' : 'missing';
}
function checkArchive(v: unknown): asserts v is Archive {
  if (!object(v) || !text(v.id, 128) || (v.kind !== 'provider' && v.kind !== 'model') ||
      !providerId(v.provider) || !positive(v.createdAt) || !object(v.payload) ||
      !exactKeys(v, ['id', 'kind', 'provider', 'modelId', 'createdAt', 'payload', 'binding', 'restoredAt', 'restoredProvider'],
        ['id', 'kind', 'provider', 'createdAt', 'payload'])) fail('INVALID_VAULT');
  if (v.kind === 'provider') {
    if (v.modelId !== undefined || v.binding !== undefined) fail('INVALID_VAULT');
    configValue({ providers: { [v.provider]: v.payload } }, 'INVALID_VAULT');
  } else {
    if (!modelId(v.modelId) || v.payload.id !== v.modelId || !object(v.binding) ||
        !(v.binding.baseUrl === null || typeof v.binding.baseUrl === 'string') ||
        !(v.binding.api === null || typeof v.binding.api === 'string') || !exactKeys(v.binding, ['baseUrl', 'api'])) fail('INVALID_VAULT');
    configValue({ providers: { [v.provider]: { models: [v.payload] } } }, 'INVALID_VAULT');
  }
  if (v.restoredAt !== undefined && (!positive(v.restoredAt) || !providerId(v.restoredProvider))) fail('INVALID_VAULT');
  if (v.restoredProvider !== undefined && v.restoredAt === undefined) fail('INVALID_VAULT');
}
function checkArchives(v: unknown): asserts v is Archive[] {
  if (!Array.isArray(v)) fail('INVALID_VAULT');
  const ids = new Set<string>();
  for (const a of v) { checkArchive(a); if (ids.has(a.id)) fail('INVALID_VAULT'); ids.add(a.id); }
}
function checkJournal(v: unknown): asserts v is Journal {
  if (!object(v) || !text(v.id, 128) || !positive(v.createdAt) ||
      !(v.before === null || typeof v.before === 'string') || typeof v.after !== 'string' ||
      v.beforeRevision !== revision(v.before as string | null) || v.afterRevision !== revision(v.after) ||
      !object(v.operation) || typeof v.operation.kind !== 'string' || !OPS.has(v.operation.kind) || !providerId(v.operation.provider) ||
      !exactKeys(v, ['id', 'createdAt', 'before', 'after', 'beforeRevision', 'afterRevision', 'operation', 'archivesAfter']) ||
      !exactKeys(v.operation, ['kind', 'provider', 'modelId', 'archiveId'], ['kind', 'provider'])) fail('INVALID_VAULT');
  const needsModel = ['put-model', 'archive-model', 'restore-model'].includes(v.operation.kind);
  const needsArchive = v.operation.kind.startsWith('archive-') || v.operation.kind.startsWith('restore-');
  if ((needsModel && !modelId(v.operation.modelId)) || (!needsModel && v.operation.modelId !== undefined)) fail('INVALID_VAULT');
  if ((needsArchive && !text(v.operation.archiveId, 128)) || (!needsArchive && v.operation.archiveId !== undefined)) fail('INVALID_VAULT');
  if (v.before !== null) configValue(json(v.before as string, 'INVALID_VAULT'), 'INVALID_VAULT');
  configValue(json(v.after, 'INVALID_VAULT'), 'INVALID_VAULT');
  checkArchives(v.archivesAfter);
}
function vaultState(v: unknown): VaultState {
  cleanTree(v, 'INVALID_VAULT');
  if (!object(v) || v.version !== 1 || !Array.isArray(v.history) || v.history.length > HISTORY_LIMIT ||
      !exactKeys(v, ['version', 'archives', 'history', 'pending'])) fail('INVALID_VAULT');
  checkArchives(v.archives);
  for (const h of v.history) checkJournal(h);
  if (v.pending !== null) checkJournal(v.pending);
  return v as unknown as VaultState;
}
/** Keep automatic payload capacity independent of the injected protection backend. */
function autoPayload(value: unknown): void {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 64 || v === undefined) fail('INVALID_VAULT');
    if (v === null || typeof v !== 'object') return;
    if (ancestors.has(v)) fail('INVALID_VAULT');
    ancestors.add(v);
    if (Array.isArray(v) && (Object.keys(v).length !== v.length || v.some((_x, i) => !own(v, String(i))))) fail('INVALID_VAULT');
    for (const child of Object.values(v)) visit(child, depth + 1);
    ancestors.delete(v);
  }
  cleanTree(value, 'INVALID_VAULT');
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) fail('INVALID_VAULT');
}
function retentionValue(raw: string): Retention {
  const v = json(raw, 'INVALID_INDEX');
  if (!object(v) || !exactKeys(v, ['providers', 'models']) || !Array.isArray(v.providers) || !Array.isArray(v.models) ||
      !v.providers.every(providerId) || !v.models.every(x => {
        if (typeof x !== 'string') return false;
        const at = x.indexOf('/');
        return at > 0 && providerId(x.slice(0, at)) && modelId(x.slice(at + 1));
      })) fail('INVALID_INDEX');
  return { providers: [...new Set(v.providers as string[])], models: [...new Set(v.models as string[])] };
}
function retainedFrom(archives: Archive[]): Retention {
  const ps = new Set<string>(); const ms = new Set<string>();
  // Include restored archives: this is a conservative identity-retention set, not an active registry.
  for (const a of archives) {
    ps.add(a.provider);
    if (a.kind === 'model') ms.add(`${a.provider}/${a.modelId}`);
    else for (const m of models(a.payload)) ms.add(`${a.provider}/${m.id}`);
  }
  return { providers: [...ps].sort(), models: [...ms].sort() };
}

/**
 * Synchronous, local custom-model store. models.json remains the active truth.
 * All full backups and archive payloads are authenticated ciphertext. Existing
 * plaintext keys in models.json are neither migrated nor claimed to be encrypted.
 * The exclusive same-UID advisory lock and pre-rename rechecks are NOT absolute
 * filesystem CAS or protection against a malicious same-UID writer.
 */
export class PickerStore {
  private readonly agentDir: string;
  private readonly dataDir: string;
  private readonly modelFile: string;
  private readonly vaultFile: string;
  private readonly indexFile: string;
  private readonly lockFile: string;
  private readonly foreignVaultFile: string;
  private readonly foreignIndexFile: string;
  private readonly protection: RecordProtection | undefined;
  private readonly protectedProviders: Set<string>;
  private passphrase: string | undefined;

  constructor(agentDir: string, protectedProviders: Iterable<string> = [], protection?: RecordProtection) {
    if (typeof agentDir !== 'string' || !path.isAbsolute(agentDir) || agentDir.includes('\0')) fail('INVALID_INPUT');
    this.agentDir = path.resolve(agentDir);
    this.dataDir = path.join(this.agentDir, 'model-pick-data');
    this.modelFile = path.join(this.agentDir, 'models.json');
    this.protection = protection;
    this.vaultFile = path.join(this.dataDir, protection ? 'vault.auto.json' : 'vault.json');
    this.indexFile = path.join(this.dataDir, protection ? 'retention-index.auto.json' : 'retention-index.json');
    this.foreignVaultFile = path.join(this.dataDir, protection ? 'vault.json' : 'vault.auto.json');
    this.foreignIndexFile = path.join(this.dataDir, protection ? 'retention-index.json' : 'retention-index.auto.json');
    this.lockFile = path.join(this.dataDir, 'store.lock');
    this.protectedProviders = safe(() => {
      const result = new Set<string>();
      for (const id of protectedProviders) { if (!providerId(id)) fail('INVALID_INPUT'); result.add(id); }
      return result;
    });
  }

  snapshot(): { revision: string; providers: Array<{
    id: string; name: string; endpoint: string; api: string;
    credentialState: 'reference' | 'configured' | 'missing';
    models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: ('text' | 'image')[] }>;
  }> } {
    return safe(() => {
      const image = this.readModels();
      return {
        revision: image.revision,
        providers: Object.entries(image.config.providers ?? {}).map(([id, p]) => ({
          id, name: typeof p.name === 'string' ? p.name : id,
          endpoint: summaryEndpoint(p.baseUrl), api: typeof p.api === 'string' && APIS.has(p.api) ? p.api : '',
          credentialState: credential(p),
          models: models(p).map(m => ({
            id: m.id as string,
            ...(typeof m.name === 'string' ? { name: m.name } : {}),
            ...(positive(m.contextWindow) ? { contextWindow: m.contextWindow } : {}),
            ...(positive(m.maxTokens) ? { maxTokens: m.maxTokens } : {}),
            ...(typeof m.reasoning === 'boolean' ? { reasoning: m.reasoning } : {}),
            ...(Array.isArray(m.input) && m.input.length > 0 && m.input.every(x => x === 'text' || x === 'image')
              ? { input: [...m.input] as ('text' | 'image')[] } : {}),
          })),
        })),
      };
    });
  }

  unlock(passphrase: string): void {
    // Automatic mode has no human gate and never interprets a supplied password.
    if (this.protection) return;
    // Drop previous references even when a subsequent unlock fails. JS strings
    // and crypto internals cannot be reliably zeroed; lock is not a zeroization guarantee.
    this.lock();
    safe(() => {
      if (typeof passphrase !== 'string' || passphrase.length === 0 || passphrase.length > 4096) fail('INVALID_INPUT');
      const opened = this.readVault(passphrase);
      if (opened.raw === null) {
        // Let the crypto module validate a new passphrase without creating a file.
        try { sealJson(null, passphrase); } catch { fail('INVALID_INPUT'); }
      }
      this.passphrase = passphrase;
    });
  }
  lock(): void { this.passphrase = undefined; safe(() => this.protection?.clear()); }
  dispose(): void { this.lock(); }
  isUnlocked(): boolean { return this.protection !== undefined || this.passphrase !== undefined; }
  hasVault(): boolean { return safe(() => this.vaultContainer() !== null); }
  hasLegacyData(): boolean {
    return safe(() => this.privateExists(path.join(this.dataDir, 'vault.json')) ||
      this.privateExists(path.join(this.dataDir, 'retention-index.json')));
  }
  hasPending(): boolean {
    return safe(() => {
      const ownPending = this.vaultContainer()?.pending === true;
      const foreignPending = this.vaultContainer(this.foreignVaultFile, this.protection ? 1 : 2)?.pending === true;
      return ownPending || foreignPending;
    });
  }

  retained(): Retention {
    return safe(() => {
      let ownRetained: Retention;
      if (this.isUnlocked()) {
        const { state } = this.readVault(this.requireUnlocked());
        ownRetained = retainedFrom([...state.archives, ...(state.pending?.archivesAfter ?? [])]);
      } else {
        ownRetained = this.advisoryRetention(this.vaultFile, this.indexFile, 1);
      }
      // A foreign mode's completed archives never gate ordinary tasks on its password.
      // Its strictly parsed advisory identities must nevertheless survive cleanup.
      const foreign = this.advisoryRetention(this.foreignVaultFile, this.foreignIndexFile, this.protection ? 1 : 2);
      return { providers: [...new Set([...ownRetained.providers, ...foreign.providers])].sort(),
        models: [...new Set([...ownRetained.models, ...foreign.models])].sort() };
    });
  }

  listArchives(): Array<{ id: string; kind: 'provider' | 'model'; provider: string; modelId?: string; createdAt: number }> {
    return safe(() => {
      const { state } = this.readVault(this.requireUnlocked());
      return state.archives.filter(a => a.restoredAt === undefined).map(a => ({
        id: a.id, kind: a.kind, provider: a.provider, ...(a.modelId === undefined ? {} : { modelId: a.modelId }), createdAt: a.createdAt,
      }));
    });
  }

  addProvider(input: ProviderInput, expectedRevision: string, guard?: Guard): void {
    this.mutate(expectedRevision, guard, (cfg, archives) => {
      const p = this.newProvider(cfg, input);
      cfg.providers ??= {};
      cfg.providers[input.id] = p;
      return { archives, operation: { kind: 'add-provider', provider: input.id } };
    });
  }

  /** Create one provider and 1–100 models in a single authenticated transaction. */
  addProviderWithModels(input: ProviderInput, inputs: ModelInput[], expectedRevision: string, guard?: Guard): void {
    this.mutate(expectedRevision, guard, (cfg, archives) => {
      const p = this.newProvider(cfg, input);
      p.models = batchModels(inputs);
      cfg.providers ??= {};
      cfg.providers[input.id] = p;
      // Existing v1 add-provider journals already hold full before/after images.
      return { archives, operation: { kind: 'add-provider', provider: input.id } };
    });
  }

  /** Add 1–100 models without overwrites; never commit only part of a batch. */
  putModels(provider: string, inputs: ModelInput[], expectedRevision: string, guard?: Guard): void {
    this.mutate(expectedRevision, guard, (cfg, archives) => {
      const p = this.provider(cfg, provider);
      const list = models(p);
      const added = batchModels(inputs, list);
      p.models = [...list, ...added];
      // Provider-scoped edit, not a new journal kind/version: existing readers
      // and recovery use the authenticated full before/after configuration mirrors.
      return { archives, operation: { kind: 'edit-provider', provider } };
    });
  }

  editProvider(provider: string, input: ProviderEdit, expectedRevision: string, guard?: Guard): void {
    this.mutate(expectedRevision, guard, (cfg, archives) => {
      const p = this.provider(cfg, provider);
      cleanTree(input, 'INVALID_INPUT');
      if (!object(input)) fail('INVALID_INPUT');
      if (input.name !== undefined) { if (!text(input.name)) fail('INVALID_INPUT'); p.name = input.name; }
      if (input.endpoint !== undefined) p.baseUrl = endpoint(input.endpoint);
      if (input.api !== undefined) { if (!APIS.has(input.api)) fail('INVALID_INPUT'); p.api = input.api; }
      this.applyEnv(p, input.envVar);
      return { archives, operation: { kind: 'edit-provider', provider } };
    });
  }

  putModel(provider: string, input: ModelInput, mode: 'add' | 'edit', expectedRevision: string, guard?: Guard): void {
    this.mutate(expectedRevision, guard, (cfg, archives) => {
      const p = this.provider(cfg, provider);
      cleanTree(input, 'INVALID_INPUT');
      const value = modelValue(input);
      if (mode !== 'add' && mode !== 'edit') fail('INVALID_INPUT');
      const list = models(p); const at = list.findIndex(m => m.id === input.id);
      if (mode === 'add' && at !== -1) fail('EXISTS');
      if (mode === 'edit' && at === -1) fail('NOT_FOUND');
      const next = { ...(at === -1 ? {} : list[at]), ...value };
      if (at === -1) list.push(next); else list[at] = next;
      p.models = list;
      return { archives, operation: { kind: 'put-model', provider, modelId: input.id } };
    });
  }

  archiveProvider(provider: string, expectedRevision: string, guard?: Guard): void {
    this.mutate(expectedRevision, guard, (cfg, archives) => {
      const p = this.provider(cfg, provider);
      this.archiveGuard(provider, undefined, guard);
      const a: Archive = { id: randomUUID(), kind: 'provider', provider, createdAt: Date.now(), payload: clone(p) };
      delete cfg.providers![provider];
      return { archives: [...archives, a], operation: { kind: 'archive-provider', provider, archiveId: a.id } };
    });
  }

  archiveModel(provider: string, modelId: string, expectedRevision: string, guard?: Guard): void {
    this.mutate(expectedRevision, guard, (cfg, archives) => {
      const p = this.provider(cfg, provider);
      if (!modelIdValid(modelId)) fail('INVALID_INPUT');
      const list = models(p); const at = list.findIndex(m => m.id === modelId);
      if (at === -1) fail('NOT_FOUND');
      this.archiveGuard(provider, modelId, guard);
      const a: Archive = { id: randomUUID(), kind: 'model', provider, modelId, createdAt: Date.now(), payload: clone(list[at]), binding: binding(p) };
      p.models = list.filter((_m, i) => i !== at);
      return { archives: [...archives, a], operation: { kind: 'archive-model', provider, modelId, archiveId: a.id } };
    });
  }

  restore(archiveId: string, expectedRevision: string, guard?: Guard, newProviderId?: string): void {
    this.mutate(expectedRevision, guard, (cfg, archives) => {
      if (!text(archiveId, 128)) fail('INVALID_INPUT');
      const a = archives.find(x => x.id === archiveId && x.restoredAt === undefined);
      if (!a) fail('NOT_FOUND');
      const target = newProviderId ?? a.provider;
      this.mutableProvider(target);
      if (a.kind === 'provider') {
        if (cfg.providers && own(cfg.providers, target)) fail('EXISTS');
        cfg.providers ??= {};
        cfg.providers[target] = clone(a.payload);
      } else {
        if (newProviderId !== undefined) fail('INVALID_INPUT');
        const p = this.provider(cfg, a.provider);
        const b = binding(p);
        if (b.baseUrl !== a.binding!.baseUrl || b.api !== a.binding!.api) fail('CONFLICT');
        if (models(p).some(m => m.id === a.modelId)) fail('EXISTS');
        p.models = [...models(p), clone(a.payload)];
      }
      a.restoredAt = Date.now(); a.restoredProvider = target;
      return { archives, operation: { kind: a.kind === 'provider' ? 'restore-provider' : 'restore-model', provider: target, archiveId, ...(a.modelId === undefined ? {} : { modelId: a.modelId }) } };
    });
  }

  recover(expectedRevision: string, guard?: Guard): void {
    safe(() => {
      const passphrase = this.requireUnlocked();
      this.writeGuard(guard);
      this.withLock(true, () => {
        this.assertForeignSettled();
        const image = this.readModels(); this.expected(image.revision, expectedRevision);
        const current = this.readVault(passphrase); const pending = current.state.pending;
        if (!pending) fail('NO_PENDING');
        this.mutableProvider(pending.operation.provider);
        if (image.revision !== pending.beforeRevision && image.revision !== pending.afterRevision) fail('CONFLICT');
        const completedRaw = this.sealedState(this.completedState(current.state), passphrase);
        const unapplied = image.revision === pending.beforeRevision;
        // Protection can block synchronously while another process changes runtime
        // guards. Only before-image recovery can still prevent an archive deletion.
        this.writeGuard(guard, unapplied ? pending.operation : undefined);
        if (unapplied) {
          this.writeIndex(retainedFrom([...current.state.archives, ...pending.archivesAfter]), guard);
          this.atomicWrite(this.modelFile, pending.after, image.raw, MAX_BYTES,
            () => this.writeGuard(guard, pending.operation));
          if (this.readModels().revision !== pending.afterRevision) fail('CONFLICT');
        }
        this.finish(current, completedRaw, guard);
      });
    });
  }

  private mutate(expectedRevision: string, guard: Guard | undefined,
    plan: (cfg: Config, archives: Archive[]) => { archives: Archive[]; operation: Operation }): void {
    safe(() => {
      const passphrase = this.requireUnlocked();
      this.writeGuard(guard);
      this.withLock(false, () => {
        this.assertForeignSettled();
        const before = this.readModels(); this.expected(before.revision, expectedRevision);
        const current = this.readVault(passphrase);
        if (current.state.pending) fail('PENDING');
        const cfg = clone(before.config);
        const planned = plan(cfg, clone(current.state.archives));
        configValue(cfg); checkArchives(planned.archives);
        const after = encode(cfg);
        const pending: Journal = { id: randomUUID(), createdAt: Date.now(), before: before.raw, after,
          beforeRevision: before.revision, afterRevision: revision(after), operation: planned.operation, archivesAfter: planned.archives };
        const journalState: VaultState = { ...current.state, pending };
        // Preflight the completed ciphertext too. Archive duplication can make the
        // final state larger than the pending state; crypto size/depth limits must
        // fail BEFORE models.json changes, never strand an unfinishable journal.
        const completedRaw = this.sealedState(this.completedState(journalState), passphrase);
        const journalRaw = this.sealedState(journalState, passphrase);
        // Recheck live guards after both crypto preflights and before journaling;
        // a refusal here leaves no pending transaction or applied models change.
        this.atomicWrite(this.vaultFile, journalRaw, current.raw, MAX_VAULT_BYTES,
          () => this.writeGuard(guard, planned.operation));
        // A conservative index is durable before any identities leave models.json.
        // It is completed again before clearing pending; it is never decrypted truth.
        this.writeIndex(retainedFrom([...current.state.archives, ...planned.archives]), guard);
        // Index/staging IO is intervening work too. Refresh at the final rename
        // barrier; refusal preserves the authenticated, unapplied pending journal.
        this.atomicWrite(this.modelFile, after, before.raw, MAX_BYTES,
          () => this.writeGuard(guard, planned.operation));
        if (this.readModels().revision !== pending.afterRevision) fail('CONFLICT');
        this.finish({ raw: journalRaw, state: journalState }, completedRaw, guard);
      });
    });
  }

  private completedState(state: VaultState): VaultState {
    const pending = state.pending!;
    return { version: 1, archives: pending.archivesAfter,
      history: [...state.history, pending].slice(-HISTORY_LIMIT), pending: null };
  }
  private finish(current: VaultRead, completedRaw: string, guard?: Guard): void {
    const pending = current.state.pending!;
    if (this.readModels().revision !== pending.afterRevision) fail('CONFLICT');
    // Models already match the after image. Busy still guards metadata writes,
    // but archive guards cannot retroactively undo an applied models change.
    this.writeIndex(retainedFrom(pending.archivesAfter), guard);
    this.atomicWrite(this.vaultFile, completedRaw, current.raw, MAX_VAULT_BYTES,
      () => this.writeGuard(guard));
  }

  private requireUnlocked(): string | undefined {
    if (this.protection) return undefined;
    return this.passphrase === undefined ? fail('LOCKED') : this.passphrase;
  }
  private assertForeignSettled(): void {
    if (this.vaultContainer(this.foreignVaultFile, this.protection ? 1 : 2)?.pending) fail(this.protection ? 'LEGACY_PENDING' : 'PENDING');
    // Validate the foreign advisory index before any models/history writes.
    this.advisoryRetention(this.foreignVaultFile, this.foreignIndexFile, this.protection ? 1 : 2);
  }
  private advisoryRetention(vaultFile: string, indexFile: string, version: number): Retention {
    const container = this.vaultContainer(vaultFile, version);
    const raw = this.readRegular(indexFile, true, true);
    if (raw === null) {
      if (container) fail('INVALID_INDEX');
      return { providers: [], models: [] };
    }
    if (!container) fail('INVALID_INDEX');
    return retentionValue(raw);
  }
  private expected(actual: string, expected: string): void { if (typeof expected !== 'string' || actual !== expected) fail('CONFLICT'); }
  private mutableProvider(id: unknown): asserts id is string {
    if (!providerId(id)) fail('INVALID_INPUT');
    if (this.protectedProviders.has(id)) fail('PROTECTED');
  }
  private provider(cfg: Config, id: string): Dict {
    this.mutableProvider(id);
    if (!cfg.providers || !own(cfg.providers, id)) fail('NOT_FOUND');
    return cfg.providers[id];
  }
  private newProvider(cfg: Config, input: ProviderInput): Dict {
    cleanTree(input, 'INVALID_INPUT');
    if (!object(input)) fail('INVALID_INPUT');
    this.mutableProvider(input.id);
    if (!text(input.name) || !APIS.has(input.api)) fail('INVALID_INPUT');
    const url = endpoint(input.endpoint);
    if (cfg.providers && own(cfg.providers, input.id)) fail('EXISTS');
    const p: Dict = { name: input.name, baseUrl: url, api: input.api, models: [] };
    this.applyEnv(p, input.envVar);
    return p;
  }
  private applyEnv(p: Dict, value: unknown): void {
    if (value === undefined || value === '') return; // Blank edit does NOT erase or replace an existing key.
    if (!envName(value)) fail('INVALID_INPUT');
    p.apiKey = `$${value}`; // Pi requires '$NAME'; a bare name is a literal key. Never resolve env or execute commands.
  }
  private writeGuard(guard?: Guard, operation?: Operation): void {
    let latest = guard;
    if (guard?.recheck !== undefined) {
      try {
        latest = guard.recheck();
        if (!object(latest)) fail('IO_ERROR');
      } catch {
        // A runtime callback failure is not evidence that an operation is safe.
        // Even callback-thrown StoreErrors must not carry caller error text out.
        fail('IO_ERROR');
      }
    }
    if (latest?.busy) fail('BUSY');
    if (operation?.kind === 'archive-provider' || operation?.kind === 'archive-model') {
      this.archiveGuard(operation.provider, operation.modelId, latest);
    }
  }
  private archiveGuard(provider: string, id: string | undefined, guard?: Guard): void {
    if (guard?.defaultUnknown) fail('DEFAULT_UNKNOWN');
    if (guard?.current?.provider === provider && (id === undefined || guard.current.id === id)) fail('CURRENT_MODEL');
    if (guard?.default?.provider === provider && (id === undefined || guard.default.id === id)) fail('DEFAULT_MODEL');
  }
  private readModels(): Image {
    const raw = this.readRegular(this.modelFile, true);
    return { raw, revision: revision(raw), config: raw === null ? {} : configValue(json(raw, 'INVALID_CONFIG')) };
  }
  private vaultContainer(file = this.vaultFile, version = this.protection ? 2 : 1): { raw: string; pending: boolean; sealed: unknown } | null {
    const raw = this.readRegular(file, true, true, MAX_VAULT_BYTES);
    if (raw === null) return null;
    const v = json(raw, 'INVALID_VAULT');
    // The sole plaintext flag is an advisory locked-state indicator, never an
    // authority: it must match the pending journal inside authenticated ciphertext.
    if (!object(v) || Object.keys(v).sort().join(',') !== 'pending,sealed,version' || v.version !== version ||
        typeof v.pending !== 'boolean' || !object(v.sealed)) fail('INVALID_VAULT');
    return { raw, pending: v.pending, sealed: v.sealed };
  }
  private readVault(passphrase: string | undefined): VaultRead {
    const container = this.vaultContainer();
    if (!container) {
      // An orphan index is evidence of missing archive material, not a new empty vault.
      if (this.readRegular(this.indexFile, true, true) !== null) fail('INVALID_VAULT');
      return { raw: null, state: { version: 1, archives: [], history: [], pending: null } };
    }
    let value: unknown;
    try {
      if (this.protection) value = this.protection.open(container.sealed, 'models');
      else {
        if (passphrase === undefined || passphrase.length === 0) fail('LOCKED');
        value = openJson<unknown>(container.sealed, passphrase);
      }
    } catch { return fail('INVALID_VAULT'); }
    if (this.protection) autoPayload(value);
    const state = vaultState(value);
    if (container.pending !== (state.pending !== null)) fail('INVALID_VAULT');
    return { raw: container.raw, state };
  }
  private sealedState(state: VaultState, passphrase: string | undefined): string {
    let sealed: unknown;
    if (this.protection) {
      // Preserve legacy capacity/depth limits even for an injectable protector.
      // Map preflight failures to the same safe write failure as legacy crypto.
      try { autoPayload(state); vaultState(state); } catch { return fail('IO_ERROR'); }
      sealed = this.protection.seal(state, 'models');
      cleanTree(sealed, 'INVALID_VAULT');
      if (!object(sealed)) fail('INVALID_VAULT');
    } else {
      if (passphrase === undefined || passphrase.length === 0) fail('LOCKED');
      sealed = sealJson(state, passphrase);
    }
    const raw = encode({ version: this.protection ? 2 : 1, pending: state.pending !== null, sealed });
    if (Buffer.byteLength(raw) > MAX_VAULT_BYTES) fail('IO_ERROR');
    return raw;
  }
  private writeIndex(value: Retention, guard?: Guard): void {
    // If present, an index must still be a safe regular file; its contents are not
    // used to decide archive state or recovery. Only provider/full-model IDs go here.
    const before = this.readRegular(this.indexFile, true, true);
    this.atomicWrite(this.indexFile, encode(value), before, MAX_BYTES,
      () => this.writeGuard(guard));
  }

  /** Presence only: never decrypts legacy data or resolves any credentials. */
  private privateExists(file: string): boolean {
    if (!this.checkDirectories(path.dirname(file), true)) return false;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail('UNSAFE_PATH');
    return true;
  }
  private checkDirectories(directory: string, allowMissing = false): boolean {
    const root = path.parse(directory).root;
    let current = root;
    for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(current); } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PATH');
      if (current === this.dataDir && (stat.mode & 0o777) !== 0o700) fail('UNSAFE_PATH');
    }
    return true;
  }
  private readRegular(file: string, allowMissing = false, privateFile = false, maxBytes = MAX_BYTES): string | null {
    if (!this.checkDirectories(path.dirname(file), allowMissing)) return null;
    let lst: fs.Stats;
    try { lst = fs.lstatSync(file); } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (lst.isSymbolicLink() || !lst.isFile() || lst.nlink !== 1 || (privateFile && (lst.mode & 0o777) !== 0o600)) fail('UNSAFE_PATH');
    if (lst.size > maxBytes) fail(file === this.vaultFile ? 'INVALID_VAULT' : 'INVALID_CONFIG');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const initial = fs.fstatSync(fd);
      if (!initial.isFile() || initial.ino !== lst.ino || initial.dev !== lst.dev) fail('CONFLICT');
      const buffer = fs.readFileSync(fd);
      if (buffer.length > maxBytes) fail('INVALID_CONFIG');
      const value = buffer.toString('utf8');
      if (!Buffer.from(value, 'utf8').equals(buffer)) fail('INVALID_CONFIG');
      const final = fs.lstatSync(file); const actual = fs.fstatSync(fd);
      if (final.isSymbolicLink() || final.ino !== initial.ino || final.dev !== initial.dev ||
          actual.size !== initial.size || actual.mtimeMs !== initial.mtimeMs || actual.ctimeMs !== initial.ctimeMs) fail('CONFLICT');
      return value;
    } finally { fs.closeSync(fd); }
  }
  private syncDirectory(directory: string): void {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  private atomicWrite(file: string, value: string, expectedRaw: string | null, maxBytes = MAX_BYTES,
    beforeRename?: () => void): void {
    if (Buffer.byteLength(value) > maxBytes) fail('IO_ERROR');
    this.checkDirectories(path.dirname(file));
    const temp = path.join(path.dirname(file), `${TX_PREFIX}${randomUUID()}.tmp`);
    let fd: number | undefined; let madeTemp = false;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      madeTemp = true;
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, value, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      const actual = this.readRegular(file, true, file !== this.modelFile, maxBytes);
      this.expected(revision(actual), revision(expectedRaw));
      beforeRename?.(); // Trusted runtime guard only; never serialized into the staged image.
      fs.renameSync(temp, file); madeTemp = false;
      this.syncDirectory(path.dirname(file));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (madeTemp) fs.unlinkSync(temp);
    }
  }
  private noExtraTransactions(): void {
    for (const directory of [this.agentDir, this.dataDir]) {
      for (const entry of fs.readdirSync(directory)) if (entry.startsWith(TX_PREFIX)) fail('CONFLICT');
    }
  }
  private acquireLock(recover: boolean): Lock {
    this.checkDirectories(this.agentDir);
    try { fs.mkdirSync(this.dataDir, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    this.checkDirectories(this.dataDir);
    this.noExtraTransactions();
    const token = randomUUID(); const raw = encode({ pid: process.pid, token });
    const create = (): Lock => {
      const fd = fs.openSync(this.lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      const identity = fs.fstatSync(fd);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, raw, 'utf8'); fs.fsyncSync(fd); }
      catch (error) {
        // A failed lock acquisition must not strand our own half-written lock.
        const actual = fs.lstatSync(this.lockFile);
        if (actual.ino === identity.ino && actual.dev === identity.dev) fs.unlinkSync(this.lockFile);
        throw error;
      } finally { fs.closeSync(fd); }
      return { token, raw };
    };
    try { return create(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const prior = this.readRegular(this.lockFile, false, true)!;
      if (!recover) fail('CONFLICT');
      const v = json(prior, 'CONFLICT');
      if (!object(v) || Object.keys(v).sort().join(',') !== 'pid,token' || !positive(v.pid) || !text(v.token, 128)) fail('CONFLICT');
      // Explicit recovery only: remove an unchanged lock of a provably dead PID.
      // No timeouts/mtime guessing; PID reuse conservatively remains a conflict.
      try { process.kill(v.pid, 0); fail('CONFLICT'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') fail('CONFLICT');
      }
      if (this.readRegular(this.lockFile, false, true) !== prior) fail('CONFLICT');
      fs.unlinkSync(this.lockFile);
      try { return create(); } catch { return fail('CONFLICT'); }
    }
  }
  private withLock(recover: boolean, fn: () => void): void {
    const lock = this.acquireLock(recover);
    try { fn(); } finally {
      if (this.readRegular(this.lockFile, false, true) !== lock.raw) fail('CONFLICT');
      fs.unlinkSync(this.lockFile); this.syncDirectory(this.dataDir);
    }
  }
}

// Avoid shadowing the validation helper in the API's archiveModel(modelId) signature.
const modelIdValid = modelId;
