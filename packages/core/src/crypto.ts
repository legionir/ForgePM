import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for DB-stored secrets (plan §3b-1, §14).
 * Ciphertext layout: keyVersion(1 byte) | iv(12) | authTag(16) | data.
 * Key rotation is supported by mapping keyVersion -> key outside this module.
 */
export interface Cipher {
  encrypt(plaintext: string, keyVersion?: number): Buffer;
  decrypt(blob: Buffer): string;
}

export function createCipher(key: Buffer, currentKeyVersion = 1): Cipher {
  if (key.length !== 32) throw new Error('AES-256-GCM key must be 32 bytes');
  return {
    encrypt(plaintext: string, keyVersion = currentKeyVersion): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([Buffer.from([keyVersion]), iv, tag, enc]);
    },
    decrypt(blob: Buffer): string {
      const keyVersion = blob[0];
      if (keyVersion !== currentKeyVersion) {
        // Rotation handled by caller selecting the right key per version.
        throw new Error(`secret encrypted with key version ${keyVersion}; active is ${currentKeyVersion}`);
      }
      const iv = blob.subarray(1, 13);
      const tag = blob.subarray(13, 29);
      const data = blob.subarray(29);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    },
  };
}

/**
 * Process-wide cipher holder. api/worker bootstrap installs one; every
 * service accesses it through this helper so no module owns its own copy
 * (single source of truth for encryption).
 */
let ACTIVE: Cipher | null = null;
export function setActiveCipher(c: Cipher): void {
  ACTIVE = c;
}
export function activeCipher(): Cipher {
  if (!ACTIVE) throw new Error('cipher not initialised — call setActiveCipher during bootstrap');
  return ACTIVE;
}
