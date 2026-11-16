// Zufallswerte, Hashes, zeitkonstante Vergleiche und die Verschlüsselung des Streamer-Tokens.
import crypto from 'node:crypto';

/** 32 zufällige Bytes als base64url (für Session-IDs und den OAuth-state). */
export const randomId = () => crypto.randomBytes(32).toString('base64url');

export const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * Vergleicht zwei Texte zeitkonstant. Beide werden vorher gehasht,
 * damit auch unterschiedlich lange Werte nichts über die Länge verraten.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** AES-256-GCM. Format: v1:<iv>:<authTag>:<ciphertext>, jeweils base64url. */
export function createTokenCipher(keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(':');
    },
    /** Wirft einen Fehler, wenn der Wert nicht entschlüsselt werden kann (z. B. Schlüssel geändert). */
    decrypt(stored) {
      const parts = String(stored).split(':');
      if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unbekanntes Format');
      const iv = Buffer.from(parts[1], 'base64url');
      const tag = Buffer.from(parts[2], 'base64url');
      const data = Buffer.from(parts[3], 'base64url');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('unbekanntes Format');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}
