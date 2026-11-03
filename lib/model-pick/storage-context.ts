/** Narrow Pi 1.4 compatibility adapter. No IO, path guessing or ctx.agentDir. */
import { types } from 'node:util';
import * as path from 'node:path';
import { resolveNativeAuth, type StorageBinding } from './native-auth.js';
export type { StorageBinding } from './native-auth.js';
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function absolute(value: unknown): value is string { return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'); }
/** A trusted embedding may supply the complete binding. Otherwise only native
 * file-backed models/auth siblings identify an agent directory. Split SDK roots
 * need an explicit host assertion; memory/unknown runtimes never read CLI HOME. */
export async function resolvePickerStorage(registry: unknown, trusted?: StorageBinding): Promise<StorageBinding | null> {
  try {
    let binding = trusted;
    if (!binding) {
      const runtime = own(registry, 'runtime');
      const modelsPath = own(runtime, 'modelsPath');
      const authPath = own(own(own(runtime, 'credentials'), 'store'), 'authPath');
      if (!absolute(modelsPath) || !absolute(authPath) || path.dirname(modelsPath) !== path.dirname(authPath)) return null;
      binding = { agentDir: path.dirname(modelsPath), modelsPath, authPath };
    }
    return (await resolveNativeAuth(registry, binding)).storage;
  } catch { return null; }
}
