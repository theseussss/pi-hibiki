import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// An ephemeral synthetic account key, never written to disk or sent to a helper.
// Fresh factories can reopen each other's test records, including after clear().
// This seam does NOT exercise or emulate the Windows DPAPI implementation.
const accountKey = randomBytes(32);
export function createSyntheticProtection(state = {}) {
  state.seals ??= []; state.opens ??= []; state.clears ??= 0;
  return {
    state,
    seal(value, purpose) {
      state.seals.push(purpose); state.sealHook?.(value, purpose);
      if (state.failSeal === true || state.failSeal === purpose) throw new Error('Synthetic protection failed.');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', accountKey, iv);
      cipher.setAAD(Buffer.from(purpose));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { version: 1, kind: 'synthetic-only', purpose, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(envelope, purpose) {
      state.opens.push(purpose); state.openHook?.(envelope, purpose);
      if (state.failOpen || envelope?.version !== 1 || envelope?.kind !== 'synthetic-only' || envelope?.purpose !== purpose) throw new Error('Synthetic protection failed.');
      const decipher = createDecipheriv('aes-256-gcm', accountKey, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
    },
    clear() { state.clears++; },
  };
}
