import { randomBytes } from 'node:crypto';

// Note: Node 22's crypto.randomUUID() does not accept a version option; it
// always emits v4. We generate RFC 9562 UUIDv7 ourselves so PKs are
// time-ordered (plan §12: "کلید اصلی: UUID نسخه‌ی ۷ تولیدشده در برنامه").

/**
 * UUIDv7: 48-bit unix-ms timestamp | 4-bit version(7) | 12-bit rand_a |
 * 2-bit variant(10) | 62-bit rand_b, formatted as 8-4-4-4-12 hex.
 */
export function newId(): string {
  const ts = Date.now();
  const b = randomBytes(16);
  // msb 48 bits = timestamp (big-endian)
  b[0] = (ts / 2 ** 40) & 0xff;
  b[1] = (ts / 2 ** 32) & 0xff;
  b[2] = (ts / 2 ** 24) & 0xff;
  b[3] = (ts / 2 ** 16) & 0xff;
  b[4] = (ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  // version 7 in the high nibble of byte 6
  b[6] = (b[6] & 0x0f) | 0x70;
  // variant 10 in the top two bits of byte 8
  b[8] = (b[8] & 0x3f) | 0x80;

  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
