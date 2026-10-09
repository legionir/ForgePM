import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createCipher } from './crypto';

describe('AES-256-GCM cipher', () => {
  const key = randomBytes(32);

  it('round-trips plaintext', () => {
    const c = createCipher(key);
    const blob = c.encrypt('sk-secret-123');
    expect(blob[0]).toBe(1); // key version byte
    expect(c.decrypt(blob)).toBe('sk-secret-123');
  });

  it('produces non-deterministic ciphertext (random IV)', () => {
    const c = createCipher(key);
    const a = c.encrypt('same');
    const b = c.encrypt('same');
    expect(a.equals(b)).toBe(false);
    expect(c.decrypt(a)).toBe(c.decrypt(b));
  });

  it('fails to decrypt a tampered blob', () => {
    const c = createCipher(key);
    const blob = c.encrypt('hello');
    blob[blob.length - 1] ^= 0xff; // flip a bit of the ciphertext
    expect(() => c.decrypt(blob)).toThrowError();
  });

  it('rejects a key of the wrong length', () => {
    expect(() => createCipher(randomBytes(16))).toThrowError(/32 bytes/);
  });

  it('refuses to decrypt a blob from another key version', () => {
    const c = createCipher(key, 1);
    const blob = c.encrypt('x', 2); // tag as version 2
    expect(() => c.decrypt(blob)).toThrowError(/key version 2/);
  });
});
