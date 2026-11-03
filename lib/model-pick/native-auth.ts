/** Pi 1.4.0 compatibility boundary. No public auth-store API is assumed. */
import { getAgentDir, getPackageDir, VERSION } from '@earendil-works/pi-coding-agent';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { types } from 'node:util';

export interface StorageBinding { agentDir: string; modelsPath: string; authPath: string }
/** Native async 30s leases are preserved. Pi's own sync 10s stale/async 15s
 * heartbeat mismatch and process pauses prevent an absolute cross-process CAS
 * guarantee; keep the critical section short and classify any applied writes. */
export interface NativeAuthBackend {
  withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T }>, options?: { signal?: AbortSignal }): Promise<T>;
}
export type NativeBindingCode = 'UNSUPPORTED_PI' | 'UNSUPPORTED_NATIVE_API' | 'STORAGE_UNKNOWN' | 'STORAGE_MISMATCH';
export class NativeAuthError extends Error {
  constructor(readonly code: NativeBindingCode) { super(code); this.name = 'NativeAuthError'; }
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && 'value' in d ? d.value : undefined;
}
function absolute(value: unknown): value is string { return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'); }
function normalize(binding: StorageBinding): StorageBinding {
  if (!binding || !absolute(own(binding, 'agentDir')) || !absolute(own(binding, 'authPath')) || !absolute(own(binding, 'modelsPath'))) throw new NativeAuthError('STORAGE_UNKNOWN');
  return { agentDir: path.resolve(binding.agentDir), modelsPath: path.resolve(binding.modelsPath), authPath: path.resolve(binding.authPath) };
}
export async function resolveNativeAuth(registry: unknown, override?: StorageBinding): Promise<{ storage: StorageBinding; native: NativeAuthBackend }> {
  if (VERSION !== '1.4.0') throw new NativeAuthError('UNSUPPORTED_PI');
  const runtime = own(registry, 'runtime');
  if (runtime && typeof runtime === 'object' && types.isProxy(runtime)) throw new NativeAuthError('STORAGE_UNKNOWN');
  const credentials = own(runtime, 'credentials');
  const modelsPath = own(runtime, 'modelsPath');
  const authPath = own(own(credentials, 'store'), 'authPath');
  if (modelsPath !== undefined && !absolute(modelsPath) || authPath !== undefined && !absolute(authPath)) throw new NativeAuthError('STORAGE_UNKNOWN');
  const storage = normalize(override ?? { agentDir: getAgentDir(), modelsPath: path.join(getAgentDir(), 'models.json'), authPath: path.join(getAgentDir(), 'auth.json') });
  // An explicit SDK override is the trusted host's storage assertion when native
  // paths are unavailable. Discoverable contradictory native paths always refuse.
  if (absolute(modelsPath) && path.resolve(modelsPath) !== storage.modelsPath || absolute(authPath) && path.resolve(authPath) !== storage.authPath) throw new NativeAuthError('STORAGE_MISMATCH');
  if (!override && (!absolute(modelsPath) || !absolute(authPath))) throw new NativeAuthError('STORAGE_UNKNOWN');
  // Native memory-only storage is not an unknown file binding to guess around.
  if (runtime && Object.hasOwn(runtime as object, 'modelsPath') && modelsPath === undefined) throw new NativeAuthError('STORAGE_MISMATCH');
  const packageDir = getPackageDir();
  if (!absolute(packageDir)) throw new NativeAuthError('UNSUPPORTED_NATIVE_API');
  let loaded: any;
  try { loaded = await import(pathToFileURL(path.join(packageDir, 'dist/core/auth-storage.js')).href); }
  catch { throw new NativeAuthError('UNSUPPORTED_NATIVE_API'); }
  const Backend = loaded?.FileAuthStorageBackend;
  if (typeof Backend !== 'function' || typeof Backend.prototype?.withLockAsync !== 'function' || typeof Backend.prototype?.withLock !== 'function') throw new NativeAuthError('UNSUPPORTED_NATIVE_API');
  try { return { storage, native: new Backend(storage.authPath) as NativeAuthBackend }; }
  catch { throw new NativeAuthError('UNSUPPORTED_NATIVE_API'); }
}
