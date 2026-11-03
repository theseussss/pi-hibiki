import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { NativeAuthBackend } from './native-auth.js';

export class AuthFileError extends Error {
  constructor(readonly code: 'busy' | 'invalid' | 'unsafe' | 'io' | 'oauth' | 'coordinated') {
    super(code === 'busy' ? 'Pi 正在写入凭据，请稍后再试。'
      : code === 'oauth' ? '该供应商已有非 API Key 凭据；未覆盖已有登录。'
      : code === 'unsafe' ? 'auth.json 路径不安全，已停止写入。'
      : code === 'invalid' ? 'auth.json 或密钥格式异常，未继续修改。'
      : code === 'coordinated' ? '凭据必须与供应商配置一起安全保存；独立写入已停用。'
      : '凭据操作未能安全完成，请核对修改状态。');
    this.name = 'AuthFileError';
  }
}
const PROVIDER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const DANGER = new Set(['__proto__', 'prototype', 'constructor']);
const MAX = 4 * 1024 * 1024;
export function validApiKey(value: unknown): value is string { return typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value); }
/** Encode a pasted literal ONCE; never run a resolver or a shell to validate it. */
export function encodeLiteralKey(value: string): string {
  if (!validApiKey(value)) throw new AuthFileError('invalid');
  const encoded = value.replace(/\$/g, () => '$$');
  return encoded.startsWith('!') ? `$${encoded}` : encoded;
}
export type AuthEntry = Record<string, unknown>;
export interface AuthLease {
  entry(provider: string): AuthEntry | null;
  replace(provider: string, expected: AuthEntry | null, next: AuthEntry | null, barrier: () => void): void;
}
const object = (value: unknown): value is AuthEntry => value !== null && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value);
export function sameAuthEntry(a: AuthEntry | null, b: AuthEntry | null): boolean {
  const canonical = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as AuthEntry)[k])}`).join(',')}}`;
  return canonical(a) === canonical(b);
}
function providerId(provider: string): void { if (typeof provider !== 'string' || !PROVIDER.test(provider) || DANGER.has(provider)) throw new AuthFileError('invalid'); }

/** auth.json is Pi's shared 0600 PLAINTEXT file, not an extra key vault. */
export class AuthFile {
  readonly file: string;
  constructor(agentDir: string, private readonly native?: NativeAuthBackend, authPath?: string) {
    if (!path.isAbsolute(agentDir) || agentDir.includes('\0')) throw new AuthFileError('unsafe');
    this.file = authPath ?? path.join(path.resolve(agentDir), 'auth.json');
    if (!path.isAbsolute(this.file) || this.file.includes('\0')) throw new AuthFileError('unsafe');
  }
  private directories(): void {
    const parent = path.dirname(this.file); const root = path.parse(parent).root; let current = root;
    for (const part of path.relative(root, parent).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const st = fs.lstatSync(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new AuthFileError('unsafe');
    }
  }
  private raw(): string | null {
    this.directories();
    let st: fs.Stats;
    try { st = fs.lstatSync(this.file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > MAX || (st.mode & 0o777) !== 0o600) throw new AuthFileError('unsafe');
    const fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.ino !== st.ino || opened.dev !== st.dev) throw new AuthFileError('busy');
      const bytes = fs.readFileSync(fd); if (bytes.length > MAX) throw new AuthFileError('unsafe');
      const decoded = bytes.toString('utf8'); if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new AuthFileError('invalid');
      const after = fs.fstatSync(fd); const named = fs.lstatSync(this.file);
      if (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.size !== opened.size || named.ino !== opened.ino || named.dev !== opened.dev || named.isSymbolicLink()) throw new AuthFileError('busy');
      return decoded;
    } finally { fs.closeSync(fd); }
  }
  private parse(raw: string | null): Record<string, AuthEntry> {
    if (raw === null) return {};
    let data: unknown;
    try { data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { throw new AuthFileError('invalid'); }
    if (!object(data)) throw new AuthFileError('invalid');
    for (const [id, entry] of Object.entries(data)) {
      if (!id || id.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(id) || DANGER.has(id) || !object(entry) || typeof entry.type !== 'string') throw new AuthFileError('invalid');
    }
    return data as Record<string, AuthEntry>;
  }
  /** Read-only, including when auth.json is absent. No native ensureFileExists. */
  entry(provider: string): AuthEntry | null {
    providerId(provider);
    try { return this.parse(this.raw())[provider] ?? null; }
    catch (error) { if (error instanceof AuthFileError) throw error; throw new AuthFileError('io'); }
  }
  has(provider: string): boolean { try { const e = this.entry(provider); return e?.type === 'api_key' && typeof e.key === 'string' && e.key.length > 0; } catch { return false; } }
  literalEntry(before: AuthEntry | null, literal: string): AuthEntry {
    if (before && before.type !== 'api_key') throw new AuthFileError('oauth');
    return { ...before, type: 'api_key', key: encodeLiteralKey(literal) };
  }
  /** Deliberately no legacy independent-write fallback. Use provider commit. */
  setApiKey(_provider: string, _key: string): never { throw new AuthFileError('coordinated'); }
  async withLease<T>(work: (lease: AuthLease) => T, signal?: AbortSignal): Promise<T> {
    if (!this.native) throw new AuthFileError('coordinated');
    this.parse(this.raw()); // Refuse malformed/unsafe files before native creation.
    return this.native.withLockAsync(async () => {
      const lockPath = `${this.file}.lock`; const held = fs.lstatSync(lockPath);
      if (!held.isDirectory() || held.isSymbolicLink()) throw new AuthFileError('unsafe');
      let active = true;
      const assertHeld = () => {
        if (!active) throw new AuthFileError('coordinated');
        const now = fs.lstatSync(lockPath);
        if (!now.isDirectory() || now.isSymbolicLink() || now.ino !== held.ino || now.dev !== held.dev || now.mtimeMs !== held.mtimeMs) throw new AuthFileError('busy');
      };
      try {
        const result = work({ entry: provider => { assertHeld(); return this.entry(provider); }, replace: (provider, expected, next, barrier) => {
          providerId(provider); assertHeld();
          const raw = this.raw(); const data = this.parse(raw);
          if (!sameAuthEntry(data[provider] ?? null, expected)) throw new AuthFileError('busy');
          if (sameAuthEntry(expected, next)) return;
          if (next === null) delete data[provider]; else data[provider] = next;
          const encoded = JSON.stringify(data, null, 2);
          if (Buffer.byteLength(encoded) > MAX) throw new AuthFileError('invalid');
          const temp = path.join(path.dirname(this.file), `.auth.json.${randomUUID()}.tmp`);
          let made = false;
          try {
            const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); made = true;
            try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, encoded, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            if (this.raw() !== raw) throw new AuthFileError('busy');
            assertHeld(); barrier(); assertHeld();
            fs.renameSync(temp, this.file); made = false;
            const dir = fs.openSync(path.dirname(this.file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
            try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
            if (!sameAuthEntry(this.entry(provider), next)) throw new AuthFileError('io');
          } finally { if (made) { try { fs.unlinkSync(temp); } catch {} } }
        } });
        if (types.isPromise(result)) throw new AuthFileError('invalid');
        return { result };
      } finally { active = false; }
    }, { signal });
  }
}
