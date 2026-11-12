/** Read-only profile identity. No IO, credential-lock imports or HOME guessing. */
import { types } from 'node:util';
import * as path from 'node:path';
import type { StorageBinding } from './native-auth.js';
export type { StorageBinding } from './native-auth.js';
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function absolute(value: unknown): value is string { return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'); }
/** A trusted embedding may supply the complete binding. Otherwise only native
 * file-backed models/auth siblings identify an agent directory. Split SDK roots
 * need an explicit host assertion; memory/unknown runtimes never read CLI HOME.
 * Reading preferences is independent of the separately verified write backend:
 * an unfamiliar Pi version must not make existing favorites/order disappear. */
export async function resolvePickerStorage(registry: unknown, trusted?: StorageBinding): Promise<StorageBinding | null> {
  try {
    const runtime = own(registry, 'runtime');
    if (runtime && typeof runtime === 'object' && types.isProxy(runtime)) return null;
    const modelsPath = own(runtime, 'modelsPath');
    const authPath = own(own(own(runtime, 'credentials'), 'store'), 'authPath');
    if (modelsPath !== undefined && !absolute(modelsPath) || authPath !== undefined && !absolute(authPath)) return null;
    // Explicit memory-only storage is a contradiction, not an unknown CLI path.
    if (runtime && typeof runtime === 'object' && Object.hasOwn(runtime, 'modelsPath') && modelsPath === undefined) return null;
    let binding: StorageBinding;
    if (trusted !== undefined) {
      const dir = own(trusted, 'agentDir'), models = own(trusted, 'modelsPath'), auth = own(trusted, 'authPath');
      if (!absolute(dir) || !absolute(models) || !absolute(auth)) return null;
      binding = { agentDir: path.resolve(dir), modelsPath: path.resolve(models), authPath: path.resolve(auth) };
    } else {
      if (!absolute(modelsPath) || !absolute(authPath)) return null;
      const models = path.resolve(modelsPath), auth = path.resolve(authPath);
      if (path.dirname(models) !== path.dirname(auth)) return null;
      binding = { agentDir: path.dirname(models), modelsPath: models, authPath: auth };
    }
    if (absolute(modelsPath) && path.resolve(modelsPath) !== binding.modelsPath
      || absolute(authPath) && path.resolve(authPath) !== binding.authPath) return null;
    return binding;
  } catch { return null; }
}
