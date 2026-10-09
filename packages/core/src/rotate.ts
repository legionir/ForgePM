import { createCipher } from './crypto';
import type { Db } from './db/unitOfWork';

/**
 * Re-encrypt every stored secret with a new key (plan §14, docs/RUNBOOK.md).
 * Reads each blob's key_version (first byte of the envelope), decrypts with the
 * OLD key, re-encrypts under the NEW key tagged with `newVersion`, and writes
 * it back. Rows already at `newVersion` are skipped, so the script is safe to
 * re-run after a partial rotation. Handles both `secrets.ciphertext` and
 * `ai_providers.encrypted_key`. Returns per-table re-encrypted counts.
 */
export interface RotationResult {
  secrets: number;
  ai_providers: number;
  skipped: number;
}

export async function rotateDbSecrets(
  db: Db,
  oldKey: Buffer,
  newKey: Buffer,
  newVersion: number,
): Promise<RotationResult> {
  const newCipher = createCipher(newKey, newVersion);
  const out: RotationResult = { secrets: 0, ai_providers: 0, skipped: 0 };

  // helper: decrypt one blob with whatever OLD key version it carries
  function decryptOld(blob: Buffer): string {
    const ver = blob[0];
    if (ver === newVersion) throw new Error('already-current'); // sentinel, caller skips
    return createCipher(oldKey, ver).decrypt(blob);
  }

  const secretRows = await db.selectFrom('secrets').select(['id', 'ciphertext']).execute();
  for (const row of secretRows) {
    const blob = row.ciphertext as Buffer;
    try {
      const plain = decryptOld(blob);
      const re = newCipher.encrypt(plain, newVersion);
      await db.updateTable('secrets').set({ ciphertext: re as never, key_version: newVersion, updated_at: new Date() }).where('id', '=', row.id).execute();
      out.secrets++;
    } catch (err) {
      if ((err as Error).message === 'already-current') { out.skipped++; continue; }
      throw err;
    }
  }

  const provRows = await db
    .selectFrom('ai_providers')
    .select(['id', 'encrypted_key'])
    .where('encrypted_key', 'is not', null)
    .execute();
  for (const row of provRows) {
    const blob = row.encrypted_key as Buffer | null;
    if (!blob) continue;
    try {
      const plain = decryptOld(blob);
      const re = newCipher.encrypt(plain, newVersion);
      await db.updateTable('ai_providers').set({ encrypted_key: re as never }).where('id', '=', row.id).execute();
      out.ai_providers++;
    } catch (err) {
      if ((err as Error).message === 'already-current') { out.skipped++; continue; }
      throw err;
    }
  }

  return out;
}
