import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import {
  newId,
  createCipher,
  putSecret,
  getSecret,
  rotateDbSecrets,
} from '@forgepm/core';
import { createHarness, type Harness } from './harness';

/**
 * Plan §14 key rotation: secrets and provider keys encrypted under an old key
 * are re-encrypted under a new key, remaining decryptable, and the pass is
 * idempotent (already-current rows are skipped).
 */
const K1 = Buffer.alloc(32, 1);
const K2 = Buffer.alloc(32, 2);
let h: Harness;
let orgId: string;

beforeAll(async () => {
  h = await createHarness();
  orgId = newId();
});
afterAll(async () => h.cleanup());
beforeEach(async () => {
  await h.reset();
  await sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, 'Rot Org', ${'rot-' + orgId.slice(0, 8)})`.execute(h.db);
});

describe('rotateDbSecrets (plan §14)', () => {
  it('re-encrypts secrets so the new key decrypts them', async () => {
    const c1 = createCipher(K1, 1);
    await putSecret(h.db, c1, orgId, 'github.app_private_key', 'PRIVATE-ABC');

    const res = await rotateDbSecrets(h.db, K1, K2, 2);
    expect(res.secrets).toBe(1);

    const c2 = createCipher(K2, 2);
    expect(await getSecret(h.db, c2, orgId, 'github.app_private_key')).toBe('PRIVATE-ABC');

    // stored envelope now tagged with version 2
    const row = await sql`SELECT key_version FROM secrets WHERE name = 'github.app_private_key'`.execute(h.db);
    expect(row.rows[0].key_version).toBe(2);
  });

  it('re-encrypts provider keys and is idempotent on a second pass', async () => {
    const c1 = createCipher(K1, 1);
    const prov = newId();
    await h.db
      .insertInto('ai_providers')
      .values({ id: prov, organization_id: orgId, name: 'p', kind: 'openai', encrypted_key: c1.encrypt('sk-123') as never })
      .execute();

    const first = await rotateDbSecrets(h.db, K1, K2, 2);
    expect(first.ai_providers).toBe(1);

    // second pass: blob is version 2 now, so nothing to do (skip, not error)
    const second = await rotateDbSecrets(h.db, K1, K2, 2);
    expect(second.ai_providers).toBe(0);
    expect(second.skipped).toBeGreaterThanOrEqual(1);

    // decryptable by the new key
    const after = await h.db.selectFrom('ai_providers').select('encrypted_key').where('id', '=', prov).executeTakeFirst();
    expect(createCipher(K2, 2).decrypt(after!.encrypted_key as Buffer)).toBe('sk-123');
  });
});
