import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Encrypts secrets the server has to keep and use again, such as an identity
 * provider's client secret, so they are not readable from the database alone.
 * The key is derived from SESSION_SECRET; changing that makes every stored
 * secret unreadable, and they have to be entered again.
 *
 * Stored as `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */

function key(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', config.sessionSecret, 'paradocs.secretBox', purpose, 32));
}

export function seal(plaintext: string, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(purpose), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** The secret, or null when it cannot be read: most likely SESSION_SECRET has changed. */
export function open(sealed: string, purpose: string): string | null {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || body === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
