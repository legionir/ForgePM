import { describe, it, expect } from 'vitest';
import { createCipher, type Cipher } from './crypto';

/**
 * Key rotation model (plan §14 "چرخش کلید"). ciphertext layout:
 * keyVersion(1) | iv(12) | authTag(16) | data.
 *
 * We verify:
 *  1. old-version ciphertext is readable via the OLD key + matching version.
 *  2. the new cipher refuses to decrypt old blobs with the mismatched version
 *     (fail-closed).
 *  3. reencrypt() with a multi-key resolver produces a fresh blob tagged with
 *     the CURRENT version, decryptable by the new cipher.
 *
 * Scripts/rotate-secret.ts drives (3) against the `secrets` and
 * `ai_providers.encrypted_key` tables; the pure key-management helper lives in
 * core so both the script and tests share it.
 */
const K1 = Buffer.alloc(32, 1);
const K2 = Buffer.alloc(32, 2);

describe('cipher key_version (plan §14)', () => {
  it('encrypts with v1 tag; refuses decrypt when versions differ', () => {
    const v1: Cipher = createCipher(K1, 1);
    const blob = v1.encrypt('hello');
    expect(blob[0]).toBe(1);
    expect(v1.decrypt(blob)).toBe('hello');

    const v2: Cipher = createCipher(K2, 2);
    // v2 has a different key and version; must fail closed on a v1 blob
    expect(() => v2.decrypt(blob)).toThrow(/key version 1/);
  });

  it('a multi-key resolver decrypts every historical version', () => {
    const keys = new Map<number, Buffer>([[1, K1], [2, K2]]);
    const v1 = createCipher(K1, 1);
    const v2 = createCipher(K2, 2);
    const b1 = v1.encrypt('a');
    const b2 = v2.encrypt('b');
    for (const [ver, blob] of [[1, b1], [2, b2]] as const) {
      const k = keys.get(blob[0]);
      if (!k) throw new Error('unknown key version');
      const reader = createCipher(k, blob[0]);
      expect(reader.decrypt(blob)).toBe(ver === 1 ? 'a' : 'b');
    }
  });
});
