import { type Cipher } from './crypto';
import { newId } from './id';
import type { DbLike } from './db/unitOfWork';

/**
 * Encrypted application secrets stored in the `secrets` table (plan §3b-1.5,
 * §14). Env vars are bootstrap-only: the first time a secret is needed and not
 * yet in the DB, the env value is copied in and the DB becomes the source of
 * truth. Values never appear in API responses; only `last4` is exposed.
 */
export interface SecretMeta {
  name: string;
  scope: 'system' | 'project' | 'module';
  organization_id: string;
  last4: string | null;
}

export async function putSecret(db: DbLike, cipher: Cipher, orgId: string, name: string, value: string, scope: SecretMeta['scope'] = 'system'): Promise<void> {
  const ciphertext = cipher.encrypt(value);
  const last4 = value.length > 4 ? value.slice(-4) : value;
  const existing = await db
    .selectFrom('secrets')
    .select('id')
    .where('organization_id', '=', orgId)
    .where('scope', '=', scope)
    .where('name', '=', name)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('secrets')
      .set({ ciphertext: ciphertext as never, last4, updated_at: new Date() } as never)
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('secrets')
      .values({ id: newId(), organization_id: orgId, scope, name, ciphertext: ciphertext as never, last4 })
      .execute();
  }
}

export async function getSecret(db: DbLike, cipher: Cipher, orgId: string, name: string, scope: SecretMeta['scope'] = 'system'): Promise<string | null> {
  const row = await db
    .selectFrom('secrets')
    .select('ciphertext')
    .where('organization_id', '=', orgId)
    .where('scope', '=', scope)
    .where('name', '=', name)
    .executeTakeFirst();
  if (!row || !row.ciphertext) return null;
  return cipher.decrypt(row.ciphertext as Buffer);
}

/** Find any org's secret by name (single-app GitHub config lives org-agnostic). */
export async function findSecretByName(db: DbLike, cipher: Cipher, name: string): Promise<{ organization_id: string; value: string } | null> {
  const row = await db
    .selectFrom('secrets')
    .select(['organization_id', 'ciphertext'])
    .where('name', '=', name)
    .limit(1)
    .executeTakeFirst();
  if (!row || !row.ciphertext) return null;
  return { organization_id: row.organization_id, value: cipher.decrypt(row.ciphertext as Buffer) };
}

export async function deleteSecret(db: DbLike, orgId: string, name: string, scope: SecretMeta['scope'] = 'system'): Promise<void> {
  await db
    .deleteFrom('secrets')
    .where('organization_id', '=', orgId)
    .where('scope', '=', scope)
    .where('name', '=', name)
    .execute();
}
