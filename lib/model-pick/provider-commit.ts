import { types } from 'node:util';
import * as path from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { AuthFile, AuthFileError, sameAuthEntry, validApiKey, type AuthEntry } from './auth-file.js';
import { resolveNativeAuth, NativeAuthError, type StorageBinding } from './native-auth.js';
import { PickerStore, StoreError, type Guard, type ModelInput, type ProviderInput, type ProviderCredentialDelta, type ProviderStoreTransaction } from './store.js';
export type { StorageBinding } from './native-auth.js';

export type ProviderPatch = Partial<Pick<ProviderInput, 'name' | 'endpoint' | 'api' | 'envVar'>>;
export type ProviderChange =
  | { kind: 'add'; provider: ProviderInput; models: ModelInput[]; credential: { kind: 'none' } | { kind: 'literal'; value: string } }
  | { kind: 'edit'; providerId: string; patch: ProviderPatch; credential: { kind: 'keep' } | { kind: 'literal'; value: string } };
export interface CredentialSnapshot { revision: string; kind: 'absent' | 'api_key' | 'oauth' | 'unsupported' }
export interface CommitRequest { change: ProviderChange; expectedModelsRevision: string; expectedCredentialRevision: string; signal?: AbortSignal }
export type SafetyCode = 'UNSUPPORTED_PI' | 'UNSUPPORTED_NATIVE_API' | 'STORAGE_UNKNOWN' | 'STORAGE_MISMATCH' |
  'UNSAFE_PATH' | 'INVALID_INPUT' | 'INVALID_CONFIG' | 'INVALID_VAULT' | 'INVALID_INDEX' | 'LOCKED' | 'PROTECTED' |
  'CONFLICT' | 'EXISTS' | 'NOT_FOUND' | 'BUSY' | 'OAUTH' | 'CURRENT_CONNECTION' | 'CANCELLED' | 'IO_ERROR' |
  'RECOVERY_REQUIRED' | 'NO_PENDING' | 'LEGACY_PENDING';
export type CommitResult =
  | { status: 'committed'; transactionId: string; modelsRevision: string; refreshRequired: true }
  | { status: 'unchanged'; code: SafetyCode; transactionId?: string }
  | { status: 'pending'; transactionId: string; code: SafetyCode; state: 'prepared' | 'auth-only' | 'applied' | 'conflict' | 'unknown' };
export interface PendingProviderChange { transactionId: string; operation: 'add' | 'edit'; providerId: string; state: 'prepared' | 'auth-only' | 'applied' | 'conflict' | 'unknown' }
export interface ProviderCommitBackend {
  snapshotCredential(providerId: string): Promise<CredentialSnapshot>;
  commit(request: CommitRequest): Promise<CommitResult>;
  pending(): Promise<PendingProviderChange | null>;
  recover(request: { transactionId: string; action: 'complete' | 'rollback'; expectedModelsRevision: string; expectedCredentialRevision: string; signal?: AbortSignal }): Promise<CommitResult>;
}
export interface ProviderCommitOptions { modelRegistry: unknown; storageOverride?: StorageBinding; store: PickerStore; getGuard(): Guard }
export type ProviderCommitBinding = { writable: true; storage: StorageBinding; backend: ProviderCommitBackend } | { writable: false; code: SafetyCode };

// Implementation below. No provider requests or registry/current-model mutation belongs here.

export class ProviderCommitError extends Error {
  constructor(readonly code: SafetyCode) { super(code); this.name = 'ProviderCommitError'; }
}
const CODES = new Set<SafetyCode>(['UNSUPPORTED_PI', 'UNSUPPORTED_NATIVE_API', 'STORAGE_UNKNOWN', 'STORAGE_MISMATCH', 'UNSAFE_PATH', 'INVALID_INPUT', 'INVALID_CONFIG', 'INVALID_VAULT', 'INVALID_INDEX', 'LOCKED', 'PROTECTED', 'CONFLICT', 'EXISTS', 'NOT_FOUND', 'BUSY', 'OAUTH', 'CURRENT_CONNECTION', 'CANCELLED', 'IO_ERROR', 'RECOVERY_REQUIRED', 'NO_PENDING', 'LEGACY_PENDING']);
function code(error: unknown): SafetyCode {
  try { return classifyError(error); } catch { return 'IO_ERROR'; }
}
function classifyError(error: unknown): SafetyCode {
  if (error instanceof ProviderCommitError || error instanceof NativeAuthError) return CODES.has(error.code) ? error.code : 'IO_ERROR';
  if (error instanceof StoreError) return error.code === 'PENDING' || error.code === 'CREDENTIAL_PENDING' ? 'RECOVERY_REQUIRED' : CODES.has(error.code as SafetyCode) ? error.code as SafetyCode : 'IO_ERROR';
  if (error instanceof AuthFileError) return ({ busy: 'CONFLICT', invalid: 'INVALID_INPUT', unsafe: 'UNSAFE_PATH', io: 'IO_ERROR', oauth: 'OAUTH', coordinated: 'UNSUPPORTED_NATIVE_API' } as const)[error.code] ?? 'IO_ERROR';
  const c = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  if (c === 'ELOCKED' || c === 'ENOTEMPTY' || c === 'ECOMPROMISED') return 'BUSY';
  if (error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'name')?.value === 'AbortError') return 'CANCELLED';
  return 'IO_ERROR';
}
function refuse(c: SafetyCode): never { throw new ProviderCommitError(c); }
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  return Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as AuthEntry)[k])}`).join(',')}}`;
}
/** Reject executable/non-JSON changes without calling getters/toJSON/proxy traps. */
function inspect(v: unknown, depth = 0): void {
  if (depth > 64) refuse('INVALID_INPUT');
  if (v === null || ['string', 'boolean', 'undefined'].includes(typeof v)) return;
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (!v || typeof v !== 'object' || types.isProxy(v)) refuse('INVALID_INPUT');
  const array = Array.isArray(v); const proto = Object.getPrototypeOf(v);
  if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array)) refuse('INVALID_INPUT');
  if (array && (v as unknown[]).length > 100) refuse('INVALID_INPUT');
  for (const k of Reflect.ownKeys(v)) {
    if (array && k === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(v, k)!;
    if (typeof k !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(k) || !d.enumerable || !('value' in d)) refuse('INVALID_INPUT');
    inspect(d.value, depth + 1);
  }
}
/** Guards only this host's current model. Other processes cannot be rebound here;
 * shared endpoint/credential identity changes need host policy or a new identity. */
export async function createProviderCommitBackend(options: ProviderCommitOptions): Promise<ProviderCommitBinding> {
  try {
    if (typeof options.getGuard !== 'function') refuse('INVALID_INPUT');
    const { storage, native } = await resolveNativeAuth(options.modelRegistry, options.storageOverride);
    const storePaths = options.store.storagePaths();
    if (path.resolve(storePaths.agentDir) !== storage.agentDir || path.resolve(storePaths.modelsPath) !== storage.modelsPath) refuse('STORAGE_MISMATCH');
    const auth = new AuthFile(storage.agentDir, native, storage.authPath);
    const salt = randomBytes(32);
    const token = (provider: string, entry: AuthEntry | null) => createHmac('sha256', salt).update(provider).update('\0').update(canonical(entry)).digest('hex');
    const assertPaths = (p: ProviderPendingLike) => {
      if (p.credential.authPath !== storage.authPath || p.credential.modelsPath !== storage.modelsPath) refuse('STORAGE_MISMATCH');
    };
    const snapshotCredential = async (provider: string): Promise<CredentialSnapshot> => {
      try {
        const entry = auth.entry(provider);
        return { revision: token(provider, entry), kind: entry === null ? 'absent' : entry.type === 'api_key' ? 'api_key' : entry.type === 'oauth' ? 'oauth' : 'unsupported' };
      } catch (error) { throw new ProviderCommitError(code(error)); }
    };
    const state = (p: ProviderPendingLike, modelsRevision: string, entry: AuthEntry | null): PendingProviderChange['state'] => {
      assertPaths(p);
      const before = modelsRevision === p.beforeRevision; const after = modelsRevision === p.afterRevision;
      const authBefore = sameAuthEntry(entry, p.credential.before); const authAfter = sameAuthEntry(entry, p.credential.after);
      if (after && authAfter) return 'applied';
      if (before && authBefore) return 'prepared';
      if (before && authAfter) return 'auth-only';
      return 'conflict';
    };
    const pendingResult = (tx: ProviderStoreTransaction | undefined, p: ProviderPendingLike, failure: SafetyCode): CommitResult => {
      let observed: PendingProviderChange['state'] = 'unknown';
      try {
        const actualPending = tx ? tx.pending() : options.store.providerPending();
        const revision = tx ? tx.models().revision : options.store.snapshot().revision;
        const entry = auth.entry(p.credential.provider);
        if (!actualPending) {
          if (revision === p.beforeRevision && sameAuthEntry(entry, p.credential.before)) return { status: 'unchanged', code: failure, transactionId: p.id };
          if (revision === p.afterRevision && sameAuthEntry(entry, p.credential.after)) return { status: 'committed', transactionId: p.id, modelsRevision: revision, refreshRequired: true };
        }
        observed = actualPending && actualPending.id !== p.id ? 'conflict' : state(p, revision, entry);
      } catch {}
      return { status: 'pending', transactionId: p.id, code: failure, state: observed };
    };
    const guardFor = (provider: () => string, risky: () => boolean, signal?: AbortSignal) => {
      let compensating = false;
      const barrier = () => {
        if (!compensating && signal?.aborted) refuse('CANCELLED');
        let guard: Guard;
        try { guard = options.getGuard(); } catch { return refuse('IO_ERROR'); }
        if (!guard || typeof guard !== 'object' || types.isProxy(guard) || Array.isArray(guard) || types.isPromise(guard)) refuse('IO_ERROR');
        for (const field of ['busy', 'current']) { const d = Object.getOwnPropertyDescriptor(guard, field); if (d && !('value' in d)) refuse('IO_ERROR'); }
        if (guard.busy !== undefined && typeof guard.busy !== 'boolean') refuse('IO_ERROR');
        if (guard.current !== undefined && (!guard.current || typeof guard.current.provider !== 'string' || typeof guard.current.id !== 'string')) refuse('IO_ERROR');
        if (guard.busy) refuse('BUSY');
        if (risky() && guard.current?.provider === provider()) refuse('CURRENT_CONNECTION');
      };
      return { barrier, compensate: () => { compensating = true; } };
    };
    const commit = async (request: CommitRequest): Promise<CommitResult> => {
      let prepared: ProviderPendingLike | undefined; let completed: CommitResult | undefined; let attemptedStage = false; let attemptedAuth = false;
      try {
        inspect(request.change);
        const change = request.change;
        if (!change || !['add', 'edit'].includes(change.kind) || !change.credential) refuse('INVALID_INPUT');
        const provider = change.kind === 'add' ? change.provider.id : change.providerId;
        const intent = change.credential;
        if (change.kind === 'add' ? !['none', 'literal'].includes(intent.kind) : !['keep', 'literal'].includes(intent.kind)) refuse('INVALID_INPUT');
        if (intent.kind === 'literal' && !validApiKey(intent.value)) refuse('INVALID_INPUT');
        if (intent.kind === 'literal' && (change.kind === 'add' ? change.provider.envVar : change.patch.envVar)) refuse('INVALID_INPUT');
        if (typeof request.expectedModelsRevision !== 'string' || typeof request.expectedCredentialRevision !== 'string') refuse('INVALID_INPUT');
        let risky = change.kind === 'edit' && (intent.kind === 'literal' || ['endpoint', 'api', 'envVar'].some(k => Object.hasOwn(change.patch, k)));
        const checks = guardFor(() => provider, () => risky, request.signal);
        return await options.store.withProviderTransaction(false, checks.barrier, async tx => {
          const before = auth.entry(provider);
          if (token(provider, before) !== request.expectedCredentialRevision) refuse('CONFLICT');
          if (change.kind === 'add' && before !== null) refuse('EXISTS');
          const after = intent.kind === 'literal' ? auth.literalEntry(before, intent.value) : before;
          const delta: ProviderCredentialDelta = { version: 1, kind: change.kind, provider, authPath: storage.authPath, modelsPath: storage.modelsPath, before, after, connectionChanged: risky };
          prepared = tx.prepare(change.kind === 'add' ? { kind: 'add', provider: change.provider, models: change.models } : { kind: 'edit', providerId: provider, patch: change.patch }, delta, request.expectedModelsRevision);
          risky = prepared.credential.connectionChanged;
          try {
            const result = await auth.withLease(lease => {
              if (!sameAuthEntry(lease.entry(provider), before)) refuse('CONFLICT');
              checks.barrier();
              try {
                attemptedStage = true; tx.stage();
                attemptedAuth = true; lease.replace(provider, before, after, checks.barrier);
                tx.apply();
                if (!sameAuthEntry(lease.entry(provider), after)) refuse('CONFLICT');
                tx.finish();
                completed = { status: 'committed', transactionId: prepared!.id, modelsRevision: tx.models().revision, refreshRequired: true };
                return completed;
              } catch (error) {
                const failure = code(error);
                // A rename/fsync can throw AFTER applying. Inspect durable images.
                try {
                  const actualPending = tx.pending();
                  if (!actualPending) return attemptedAuth ? pendingResult(tx, prepared!, failure) : { status: 'unchanged', code: failure } as CommitResult;
                  if (actualPending.id !== prepared!.id) refuse('CONFLICT');
                  const images = tx.models(); const actual = lease.entry(provider);
                  if (images.before && !images.after && (sameAuthEntry(actual, before) || sameAuthEntry(actual, after))) {
                    checks.compensate();
                    if (!sameAuthEntry(actual, before)) lease.replace(provider, after, before, checks.barrier);
                    tx.abort();
                    return { status: 'unchanged', code: failure, transactionId: prepared!.id } as CommitResult;
                  }
                  // Also abort a wholly unapplied key-only transaction.
                  if (images.before && sameAuthEntry(actual, before) && !sameAuthEntry(actual, after)) {
                    checks.compensate(); tx.abort();
                    return { status: 'unchanged', code: failure, transactionId: prepared!.id } as CommitResult;
                  }
                } catch { /* Preserve pending; never overwrite an external target. */ }
                return pendingResult(tx, prepared!, failure);
              }
            }, request.signal);
            if (result.status === 'committed') completed = result;
            return result;
          } catch (error) {
            if (completed) return completed;
            if (!attemptedStage) return { status: 'unchanged', code: request.signal?.aborted ? 'CANCELLED' : code(error) };
            return pendingResult(tx, prepared!, request.signal?.aborted ? 'CANCELLED' : code(error));
          }
        });
      } catch (error) {
        if (completed) return completed;
        try { const actual = options.store.providerPending(); if (actual) return pendingResult(undefined, actual, code(error)); if (prepared && attemptedStage) return pendingResult(undefined, prepared, code(error)); } catch {}
        return { status: 'unchanged', code: code(error) };
      }
    };
    const pending = async (): Promise<PendingProviderChange | null> => {
      try {
        const p = options.store.providerPending(); if (!p) return null; assertPaths(p);
        return { transactionId: p.id, operation: p.credential.kind, providerId: p.credential.provider,
          state: state(p, options.store.snapshot().revision, auth.entry(p.credential.provider)) };
      } catch (error) { throw new ProviderCommitError(code(error)); }
    };
    const recover: ProviderCommitBackend['recover'] = async request => {
      let p: ProviderPendingLike | undefined; let completed: CommitResult | undefined;
      try {
        p = options.store.providerPending() ?? undefined; if (!p) refuse('NO_PENDING'); assertPaths(p);
        if (p.id !== request.transactionId || !['complete', 'rollback'].includes(request.action)) refuse('CONFLICT');
        const checks = guardFor(() => p!.credential.provider, () => p!.credential.connectionChanged, request.signal);
        return await options.store.withProviderTransaction(true, checks.barrier, async tx => {
          const current = tx.pending(); if (!current || current.id !== p!.id) refuse('CONFLICT'); p = current;
          const images = tx.models(); const entry = auth.entry(p.credential.provider);
          if (images.revision !== request.expectedModelsRevision || token(p.credential.provider, entry) !== request.expectedCredentialRevision) refuse('CONFLICT');
          return auth.withLease(lease => {
            const d = p!.credential; const actual = lease.entry(d.provider); checks.barrier();
            if (!sameAuthEntry(actual, entry) || tx.models().revision !== images.revision) refuse('CONFLICT');
            try {
              const before = sameAuthEntry(actual, d.before); const after = sameAuthEntry(actual, d.after);
              if ((!images.before && !images.after) || (!before && !after)) refuse('CONFLICT');
              if (request.action === 'rollback') {
                if (!images.before) refuse('CONFLICT');
                if (!before) lease.replace(d.provider, d.after, d.before, checks.barrier);
                tx.abort(); return { status: 'unchanged', transactionId: p!.id, code: 'CANCELLED' } as CommitResult;
              }
              if (images.after && !images.before && !after) refuse('CONFLICT');
              if (!after) lease.replace(d.provider, d.before, d.after, checks.barrier);
              if (!images.after) tx.apply();
              tx.finish();
              completed = { status: 'committed', transactionId: p!.id, modelsRevision: images.after ? images.revision : p!.afterRevision, refreshRequired: true };
              return completed;
            } catch (error) { return pendingResult(tx, p!, code(error)); }
          }, request.signal);
        });
      } catch (error) {
        if (completed) return completed;
        return p ? pendingResult(undefined, p, request.signal?.aborted ? 'CANCELLED' : code(error)) : { status: 'unchanged', code: code(error) };
      }
    };
    return { writable: true, storage, backend: { snapshotCredential, commit, pending, recover } };
  } catch (error) { return { writable: false, code: code(error) }; }
}
type ProviderPendingLike = { id: string; beforeRevision: string; afterRevision: string; credential: ProviderCredentialDelta };
