import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { types } from 'node:util';
import { assertEnvelope, openJson, sealJson, type SealedEnvelope } from './vault.js';

export type ProtectionPurpose = 'models' | 'records' | 'settings';
export interface RecordProtection {
  seal(value: unknown, purpose: ProtectionPurpose): unknown;
  open<T = unknown>(envelope: unknown, purpose: ProtectionPurpose): T;
  clear(): void;
}

/** Never retains or reports native output, input, original errors, paths or causes. */
export class ProtectionError extends Error {
  constructor() {
    super('Record protection failed.');
    this.name = 'ProtectionError';
  }
}

/** Injection seam for synthetic tests, not a configurable command/endpoint API. */
export interface ProtectionRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly input: Buffer;
  readonly env: Readonly<Record<string, string>>;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly windowsHide: true;
  readonly shell: false;
}
export interface ProtectionTransportResult {
  status: number | null;
  stdout: Buffer;
  stderr?: Buffer;
  signal?: string | null;
  error?: unknown;
}
export interface ProtectionOptions {
  platform?: NodeJS.Platform;
  wsl?: boolean;
  exists?: (path: string) => boolean;
  transport?: (request: ProtectionRequest) => ProtectionTransportResult;
}

interface ProtectedEnvelope {
  version: 1;
  protection: 'windows-dpapi-current-user';
  purpose: ProtectionPurpose;
  protectedKey: string;
  payload: SealedEnvelope;
}
interface KeyEntry { purpose: ProtectionPurpose; protectedKey: string; key: Buffer }
const OUTER_KEYS = ['version', 'protection', 'purpose', 'protectedKey', 'payload'];
const PAYLOAD_KEYS = ['version', 'kdf', 'cipher', 'salt', 'iv', 'tag', 'data'];
const WINDOWS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WSL_EXE = '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
const MAX_KEYS = 12; // Includes the (at most three) currently reused sealing keys.
const MAX_WRAPPED_KEY = 4096;
const MAX_OUTPUT = 8192;
const TIMEOUT = 15_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function fail(): never { throw new ProtectionError(); }
function purposeOf(value: unknown): ProtectionPurpose {
  if (value !== 'models' && value !== 'records' && value !== 'settings') fail();
  return value;
}

/** Reject proxies/accessors without invoking their traps/getters. */
function fields(value: unknown, allowed: readonly string[], exact: boolean): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.ownKeys(value);
  if (exact && keys.length !== allowed.length) fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    result[key] = descriptor.value;
  }
  return result;
}

/** Canonical base64 and allocation bounds are checked before any native decoder. */
function base64(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < 4 || value.length % 4 !== 0
    || value.length > Math.ceil(max / 3) * 4) fail();
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const size = value.length / 4 * 3 - padding;
  const end = value.length - padding;
  if (size < min || size > max || /[^A-Za-z0-9+/]/.test(value.slice(0, end))) fail();
  const last = ALPHABET.indexOf(value[end - 1]);
  if (last < 0 || (padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) fail();
  return value;
}

function envelopeOf(value: unknown, purpose: ProtectionPurpose): ProtectedEnvelope {
  const checked = fields(value, OUTER_KEYS, true);
  if (checked.version !== 1 || checked.protection !== 'windows-dpapi-current-user'
    || checked.purpose !== purpose) fail();
  base64(checked.protectedKey, 64, MAX_WRAPPED_KEY);
  assertEnvelope(checked.payload);
  // Snapshot only validated data properties; a transport cannot change the caller's
  // payload between validation and the subsequent authenticated decryption.
  checked.payload = fields(checked.payload, PAYLOAD_KEYS, true);
  return checked as unknown as ProtectedEnvelope;
}

/** Six fixed programs: only these closed enums contribute to static script text. */
function script(operation: 'protect' | 'unprotect', purpose: ProtectionPurpose): string {
  const protect = operation === 'protect';
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[byte[]]$inputBytes = $null
[byte[]]$outputBytes = $null
try {
  Add-Type -AssemblyName System.Security -ErrorAction Stop
  $text = [Console]::In.ReadToEnd()
  if ($text.Length -lt 4 -or $text.Length -gt 5464 -or ($text.Length % 4) -ne 0 -or $text -cnotmatch '^[A-Za-z0-9+/]+={0,2}$') { throw 'Invalid input' }
  $inputBytes = [Convert]::FromBase64String($text)
  if ([Convert]::ToBase64String($inputBytes) -cne $text) { throw 'Invalid input' }
  if (${protect ? '$inputBytes.Length -ne 32' : '$inputBytes.Length -lt 64 -or $inputBytes.Length -gt 4096'}) { throw 'Invalid input' }
  $entropy = [Text.Encoding]::UTF8.GetBytes('pi.model-pick.record-key;version=1;purpose=${purpose}')
  $outputBytes = [Security.Cryptography.ProtectedData]::${protect ? 'Protect' : 'Unprotect'}($inputBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  if (${protect ? '$outputBytes.Length -lt 64 -or $outputBytes.Length -gt 4096' : '$outputBytes.Length -ne 32'}) { throw 'Invalid output' }
  [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
} catch {
  exit 1
} finally {
  if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
  if ($null -ne $outputBytes) { [Array]::Clear($outputBytes, 0, $outputBytes.Length) }
}
`;
}
const COMMANDS = Object.fromEntries((['models', 'records', 'settings'] as const).map((purpose) => [purpose, {
  protect: Buffer.from(script('protect', purpose), 'utf16le').toString('base64'),
  unprotect: Buffer.from(script('unprotect', purpose), 'utf16le').toString('base64'),
}])) as Record<ProtectionPurpose, Record<'protect' | 'unprotect', string>>;

function nativeTransport(request: ProtectionRequest): ProtectionTransportResult {
  return spawnSync(request.executable, [...request.args], {
    input: request.input,
    env: { ...request.env },
    timeout: request.timeout,
    maxBuffer: request.maxBuffer,
    windowsHide: request.windowsHide,
    shell: request.shell,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Transparent Windows DPAPI CurrentUser protection (native Windows or WSL with
 * Windows PowerShell at the fixed system path). No local key file, password,
 * credential/environment resolution, network, migration, or plaintext fallback.
 * Construction/import do not launch a process or probe an executable.
 *
 * Only random 32-byte record keys cross the stdin/stdout bridge; records stay in
 * Node and use vault.ts's strict JSON + scrypt/AES-GCM. DPAPI entropy binds the
 * application, format version and purpose. Both envelopes must authenticate.
 *
 * clear() wipes cached Buffer keys best-effort and permits fresh subsequent use.
 * It cannot erase V8 strings/crypto/runtime copies. This is not isolation from
 * malicious code running as this Node UID or the same Windows user, nor from a
 * compromised host. Losing the Windows user DPAPI context can lose these records.
 */
export function createRecordProtection(options?: ProtectionOptions): RecordProtection {
  try {
    const opts = options === undefined ? {} : fields(options, ['platform', 'wsl', 'exists', 'transport'], false);
    const platform = opts.platform === undefined ? process.platform : opts.platform;
    const wsl = opts.wsl === undefined ? !!process.env.WSL_INTEROP : opts.wsl;
    const existsOption = opts.exists === undefined ? existsSync : opts.exists;
    const transportOption = opts.transport === undefined ? nativeTransport : opts.transport;
    if (typeof platform !== 'string' || typeof wsl !== 'boolean'
      || typeof existsOption !== 'function' || typeof transportOption !== 'function') fail();
    const exists = existsOption as (path: string) => boolean;
    const transport = transportOption as (request: ProtectionRequest) => ProtectionTransportResult;
    // Only this interop routing variable is read; API-key environment variables are
    // neither enumerated nor forwarded. It is never stored in an envelope/error.
    const interop = platform === 'linux' && wsl ? process.env.WSL_INTEROP : undefined;
    let executable: string | undefined;
    const cache = new Map<string, KeyEntry>();
    const active = new Map<ProtectionPurpose, KeyEntry>();
    function identity(entry: { purpose: ProtectionPurpose; protectedKey: string }): string {
      return `${entry.purpose}:${entry.protectedKey}`;
    }
    function remember(entry: KeyEntry): void {
      const id = identity(entry);
      cache.delete(id);
      cache.set(id, entry);
      while (cache.size > MAX_KEYS) {
        const oldest = cache.entries().next().value!;
        cache.delete(oldest[0]);
        if (active.get(oldest[1].purpose) === oldest[1]) active.delete(oldest[1].purpose);
        oldest[1].key.fill(0);
      }
    }
    function bridge(operation: 'protect' | 'unprotect', purpose: ProtectionPurpose, text: string): Buffer {
      let input: Buffer | undefined;
      let stdout: Buffer | undefined;
      let stderr: Buffer | undefined;
      try {
        base64(text, operation === 'protect' ? 32 : 64, operation === 'protect' ? 32 : MAX_WRAPPED_KEY);
        if (!executable) {
          const candidate = platform === 'win32' ? WINDOWS_EXE : platform === 'linux' && wsl ? WSL_EXE : undefined;
          if (!candidate || exists(candidate) !== true) fail();
          executable = candidate;
        }
        input = Buffer.from(text, 'ascii');
        const env: Record<string, string> = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows' };
        if (platform === 'linux' && wsl && interop) env.WSL_INTEROP = interop;
        const response = fields(transport(Object.freeze({
          executable, args: Object.freeze(['-NoProfile', '-NonInteractive', '-EncodedCommand', COMMANDS[purpose][operation]]),
          input, env: Object.freeze(env), timeout: TIMEOUT, maxBuffer: MAX_OUTPUT, windowsHide: true, shell: false,
        })), ['status', 'stdout', 'stderr', 'signal', 'error', 'pid', 'output'], false);
        if (!types.isProxy(response.stdout) && Buffer.isBuffer(response.stdout)) stdout = response.stdout;
        if (!types.isProxy(response.stderr) && Buffer.isBuffer(response.stderr)) stderr = response.stderr;
        if (response.status !== 0 || (response.signal !== undefined && response.signal !== null)
          || response.error !== undefined || !stdout || stdout.length > MAX_OUTPUT
          || (response.stderr !== undefined && (!stderr || stderr.length !== 0))) fail();
        const encoded = base64(stdout.toString('utf8'), operation === 'protect' ? 64 : 32,
          operation === 'protect' ? MAX_WRAPPED_KEY : 32);
        return Buffer.from(encoded, 'base64');
      } catch {
        throw new ProtectionError();
      } finally {
        input?.fill(0);
        stdout?.fill(0);
        stderr?.fill(0);
      }
    }
    return {
      seal(value, requestedPurpose) {
        let freshKey: Buffer | undefined;
        let wrapped: Buffer | undefined;
        try {
          const purpose = purposeOf(requestedPurpose);
          let entry = active.get(purpose);
          const key = entry ? entry.key : (freshKey = randomBytes(32));
          // Strict JSON validation happens before launching a helper on a cold cache.
          const payload = sealJson(value, key.toString('base64'));
          if (!entry) {
            wrapped = bridge('protect', purpose, key.toString('base64'));
            entry = { purpose, protectedKey: wrapped.toString('base64'), key };
            remember(entry);
            active.set(purpose, entry);
            freshKey = undefined; // Ownership moves to the bounded per-instance cache.
          } else remember(entry);
          return { version: 1, protection: 'windows-dpapi-current-user', purpose, protectedKey: entry.protectedKey, payload };
        } catch {
          throw new ProtectionError();
        } finally {
          freshKey?.fill(0);
          wrapped?.fill(0);
        }
      },
      open<T = unknown>(value: unknown, requestedPurpose: ProtectionPurpose): T {
        let freshKey: Buffer | undefined;
        try {
          const purpose = purposeOf(requestedPurpose);
          const envelope = envelopeOf(value, purpose);
          const id = identity(envelope);
          let entry = cache.get(id);
          if (!entry) {
            freshKey = bridge('unprotect', purpose, envelope.protectedKey);
            entry = { purpose, protectedKey: envelope.protectedKey, key: freshKey };
          }
          const restored = openJson<T>(envelope.payload, entry.key.toString('base64'));
          // Never cache unwrapped keys from records that fail AES-GCM/JSON validation.
          remember(entry);
          freshKey = undefined;
          return restored;
        } catch {
          throw new ProtectionError();
        } finally {
          freshKey?.fill(0);
        }
      },
      clear() {
        for (const entry of cache.values()) entry.key.fill(0);
        cache.clear();
        active.clear();
      },
    };
  } catch {
    throw new ProtectionError();
  }
}
