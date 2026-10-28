import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { TextDecoder, types } from 'node:util';

/** In-memory only: callers own storage, unlocking, credential resolution and authorization. */
export interface SealedEnvelope {
  version: 1;
  kdf: 'scrypt';
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/** All public failures intentionally share one message, with no input or original cause. */
export class VaultError extends Error {
  constructor() {
    super('Vault operation failed.');
    this.name = 'VaultError';
  }
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_DEPTH = 64; // Root depth is zero.
const MIN_PASSWORD_CHARACTERS = 12;
const MAX_PASSWORD_CHARACTERS = 1024; // Unicode code points, without normalization.
const MAX_PASSWORD_BYTES = 4096;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const AAD = Buffer.from('model-pick.vault/json;version=1;kdf=scrypt;cipher=aes-256-gcm', 'utf8');
const ENVELOPE_KEYS = new Set(['version', 'kdf', 'cipher', 'salt', 'iv', 'tag', 'data']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SECRET_KEYS = new Set([
  'apikey', 'apikeys', 'xapikey', 'apikeyref', 'apikeysource', 'headers', 'header',
  'requestheaders', 'defaultheaders', 'extraheaders', 'authorization', 'proxyauthorization',
  'auth', 'authentication', 'credential', 'credentials', 'credentialref', 'credentialsref',
  'oauth', 'oauth2', 'oauthconfig', 'oauth2config', 'clientsecret', 'clientsecrets',
  'token', 'tokens', 'tokenref', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken',
  'bearertoken', 'sessiontoken', 'securitytoken', 'password', 'passwd', 'passphrase',
  'secret', 'secrets', 'secretkey', 'privatekey', 'signingkey', 'encryptionkey',
  'cookie', 'cookies', 'setcookie',
]);

function fail(): never {
  throw new VaultError();
}

function assertPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== 'string' || passphrase.length > MAX_PASSWORD_CHARACTERS * 2) fail();
  let characters = 0;
  for (const character of passphrase) {
    const code = character.codePointAt(0)!;
    // Reject ill-formed UTF-16 rather than silently mapping different passwords to U+FFFD.
    if ((code >= 0xd800 && code <= 0xdfff) || ++characters > MAX_PASSWORD_CHARACTERS) fail();
  }
  if (characters < MIN_PASSWORD_CHARACTERS || Buffer.byteLength(passphrase, 'utf8') > MAX_PASSWORD_BYTES) fail();
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return SECRET_KEYS.has(normalized)
    || /(?:apikeys?|clientsecrets?|password|passwd|passphrase|secret|privatekey|authorization|credentials?|headers?|oauth2?(?:config)?|(?:access|refresh|bearer|auth|id|session)token)(?:ref|source)?$/.test(normalized);
}

function isSecretReference(value: string): boolean {
  // References are deliberately not resolved, executed, or assumed harmless.
  return /^\s*(?:env\s*:|!|process\.env\.|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*\s*$|(?:Bearer|Basic)\s+)/i.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*@/.test(value)
    || /[?&](?:api[_-]?key|(?:access[_-]?|refresh[_-]?|auth[_-]?)?token|client[_-]?secret|password)=/i.test(value);
}

/**
 * Validate before encoding; never call a getter, toJSON, or a proxy trap.
 * Only ordinary/null-prototype records and dense ordinary arrays are accepted.
 * All own properties must be enumerable data, apart from an array's length.
 * Dangerous property names are rejected at every depth (also after decryption).
 * Alias references may be duplicated as JSON, but ancestor cycles are rejected.
 */
function inspectJson(value: unknown, encode = false, scanSecrets = false): { json?: string; secret: boolean } {
  let bytes = 0;
  let nodes = 0;
  let secret = false;
  const ancestors = new WeakSet<object>();
  const pieces: string[] | undefined = encode ? [] : undefined;

  function budget(amount: number): void {
    bytes += amount;
    if (bytes > MAX_JSON_BYTES) fail();
  }

  function emit(text: string): void {
    budget(text.length); // Syntax, numeric and literal fragments are ASCII.
    pieces?.push(text);
  }

  function string(text: string): void {
    // Measure escaped JSON UTF-8 *before* allocating its encoded representation.
    budget(2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
        budget(2);
      } else if (code < 32) {
        budget(6);
      } else if (code < 128) {
        budget(1);
      } else if (code < 0x800) {
        budget(2);
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length
        && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
        budget(4);
        i++;
      } else if (code >= 0xd800 && code <= 0xdfff) {
        budget(6); // JSON.stringify escapes lone surrogates.
      } else {
        budget(3);
      }
    }
    if (pieces) pieces.push(JSON.stringify(text)); // Primitive only: no user hooks.
  }

  function dataProperty(object: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    return descriptor.value;
  }

  function visit(current: unknown, depth: number): void {
    if (depth > MAX_JSON_DEPTH || ++nodes > MAX_JSON_NODES) fail();
    if (current === null) { emit('null'); return; }
    switch (typeof current) {
      case 'string':
        string(current);
        if (scanSecrets && isSecretReference(current)) secret = true;
        return;
      case 'boolean': emit(current ? 'true' : 'false'); return;
      case 'number':
        if (!Number.isFinite(current)) fail();
        emit(JSON.stringify(current));
        return;
      case 'object': break;
      default: fail();
    }
    const object = current as object;
    if (types.isProxy(object) || ancestors.has(object)) fail();
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    const keys = Reflect.ownKeys(object);
    if (keys.length > MAX_JSON_NODES) fail();
    ancestors.add(object);
    try {
      if (array) {
        const length = (object as unknown[]).length;
        if (length >= MAX_JSON_NODES || keys.length !== length + 1) fail();
        emit('[');
        for (let i = 0; i < length; i++) {
          if (i) emit(',');
          visit(dataProperty(object, String(i)), depth + 1);
        }
        emit(']');
      } else {
        emit('{');
        let index = 0;
        for (const key of keys) {
          if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) fail();
          const child = dataProperty(object, key);
          if (index++) emit(',');
          string(key);
          emit(':');
          if (scanSecrets && isSecretKey(key)) secret = true;
          visit(child, depth + 1);
        }
        emit('}');
      }
    } finally {
      ancestors.delete(object);
    }
  }

  visit(value, 0);
  return { json: pieces?.join(''), secret };
}

/** Bound parse-time allocation too; the full JSON grammar is still checked by JSON.parse. */
function preflightJson(text: string): void {
  let containers = 0;
  let tokens = 0;
  let inString = false;
  let escaped = false;
  let inAtom = false;
  function token(): void {
    // Keys add at most one extra token per value in valid JSON.
    if (containers > MAX_JSON_DEPTH || ++tokens > MAX_JSON_NODES * 2) fail();
  }
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 92) escaped = true;
      else if (code === 34) inString = false;
    } else if (code === 34) {
      token();
      inString = true;
      inAtom = false;
    } else if (code === 91 || code === 123) {
      token();
      containers++;
      inAtom = false;
    } else if (code === 93 || code === 125) {
      if (--containers < 0) fail();
      inAtom = false;
    } else if (code === 44 || code === 58 || code === 32 || code === 9 || code === 10 || code === 13) {
      inAtom = false;
    } else if (!inAtom) {
      token();
      inAtom = true;
    }
  }
  if (inString || containers !== 0) fail();
}

function assertBase64(value: unknown, minBytes: number, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 4 || value.length % 4 !== 0
    || value.length > Math.ceil(maxBytes / 3) * 4) fail();
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentLength = value.length - padding;
  // No repeated regexp groups: validation remains linear for the largest field.
  if (/[^A-Za-z0-9+/]/.test(value.slice(0, contentLength))) fail();
  const bytes = value.length / 4 * 3 - padding;
  if (bytes < minBytes || bytes > maxBytes) fail();
  const last = BASE64_ALPHABET.indexOf(value[contentLength - 1]);
  // Zero unused pad bits are required for canonical RFC 4648 Base64.
  if (last < 0 || (padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) fail();
}

function inspectEnvelope(envelope: unknown): SealedEnvelope {
  if (typeof envelope !== 'object' || envelope === null || types.isProxy(envelope)) fail();
  const prototype = Object.getPrototypeOf(envelope);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const keys = Reflect.ownKeys(envelope);
  if (keys.length !== ENVELOPE_KEYS.size) fail();
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !ENVELOPE_KEYS.has(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    fields[key] = descriptor.value;
  }
  if (fields.version !== 1 || fields.kdf !== 'scrypt' || fields.cipher !== 'aes-256-gcm') fail();
  assertBase64(fields.salt, 16, 16);
  assertBase64(fields.iv, 12, 12);
  assertBase64(fields.tag, 16, 16);
  assertBase64(fields.data, 1, MAX_JSON_BYTES);
  return fields as unknown as SealedEnvelope;
}

/** Structural validation only; authenticity is checked by openJson, not this assertion. */
export function assertEnvelope(envelope: unknown): asserts envelope is SealedEnvelope {
  try {
    inspectEnvelope(envelope);
  } catch {
    throw new VaultError();
  }
}

function wipe(...buffers: (Buffer | undefined)[]): void {
  for (const buffer of buffers) buffer?.fill(0);
}

/**
 * Encrypt ordinary JSON using fresh 16-byte salt / 12-byte IV and a 16-byte GCM tag.
 * Scrypt is synchronous and fixed (N=32768, r=8, p=1, maxmem=64 MiB).
 * Runtime strings/objects, V8/crypto internals and their copies cannot be fully erased.
 * Buffer clearing below is best effort, not keychain or same-UID/process isolation.
 * A sealed envelope is storage data, never an apiKey or a credential reference.
 */
export function sealJson(value: unknown, passphrase: string): SealedEnvelope {
  let password: Buffer | undefined;
  let key: Buffer | undefined;
  let plaintext: Buffer | undefined;
  let first: Buffer | undefined;
  let last: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let salt: Buffer | undefined;
  let iv: Buffer | undefined;
  let tag: Buffer | undefined;
  try {
    assertPassphrase(passphrase);
    const { json } = inspectJson(value, true);
    plaintext = Buffer.from(json!, 'utf8');
    if (plaintext.length < 1 || plaintext.length > MAX_JSON_BYTES) fail();
    password = Buffer.from(passphrase, 'utf8');
    salt = randomBytes(16);
    iv = randomBytes(12);
    key = scryptSync(password, salt, 32, SCRYPT_OPTIONS);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(AAD);
    first = cipher.update(plaintext);
    last = cipher.final();
    ciphertext = Buffer.concat([first, last]);
    tag = cipher.getAuthTag();
    return {
      version: 1, kdf: 'scrypt', cipher: 'aes-256-gcm',
      salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: tag.toString('base64'), data: ciphertext.toString('base64'),
    };
  } catch {
    throw new VaultError();
  } finally {
    wipe(password, key, plaintext, first, last, ciphertext, salt, iv, tag);
  }
}

/** T is a caller type assertion, not an application-specific runtime schema validator. */
export function openJson<T = unknown>(envelope: unknown, passphrase: string): T {
  let password: Buffer | undefined;
  let key: Buffer | undefined;
  let first: Buffer | undefined;
  let last: Buffer | undefined;
  let plaintext: Buffer | undefined;
  let ciphertext: Buffer | undefined;
  let salt: Buffer | undefined;
  let iv: Buffer | undefined;
  let tag: Buffer | undefined;
  try {
    assertPassphrase(passphrase);
    const checked = inspectEnvelope(envelope);
    salt = Buffer.from(checked.salt, 'base64');
    iv = Buffer.from(checked.iv, 'base64');
    tag = Buffer.from(checked.tag, 'base64');
    ciphertext = Buffer.from(checked.data, 'base64');
    password = Buffer.from(passphrase, 'utf8');
    key = scryptSync(password, salt, 32, SCRYPT_OPTIONS);
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    first = decipher.update(ciphertext);
    last = decipher.final(); // Do not decode or parse unauthenticated plaintext.
    plaintext = Buffer.concat([first, last]);
    if (plaintext.length < 1 || plaintext.length > MAX_JSON_BYTES) fail();
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
    preflightJson(text);
    const value: unknown = JSON.parse(text);
    inspectJson(value);
    return value as T;
  } catch {
    throw new VaultError();
  } finally {
    wipe(password, key, first, last, plaintext, ciphertext, salt, iv, tag);
  }
}

/**
 * Conservative heuristic, not proof that an arbitrary configuration is secret-free.
 * Headers/auth containers and env/!command references count as possible secrets even
 * when empty or unresolved. Invalid/non-JSON/over-budget inputs fail closed to true.
 * This never prints, resolves credentials, executes commands, or reads the environment.
 */
export function containsSecretMaterial(value: unknown): boolean {
  try {
    return inspectJson(value, false, true).secret;
  } catch {
    return true;
  }
}
