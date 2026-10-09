import { createCipher, type Cipher, type Db, type DbLike, newId, recordAudit, unitOfWork } from '@forgepm/core';
import { AppError } from '@forgepm/shared';

export interface ProviderRow {
  id: string;
  organization_id: string;
  name: string;
  kind: 'anthropic' | 'openai' | 'openai_compatible' | 'fake';
  base_url: string | null;
  key_last4: string | null;
  default_model: string | null;
  enabled: boolean;
}

const COLS = ['id', 'organization_id', 'name', 'kind', 'base_url', 'key_last4', 'default_model', 'enabled'] as const;

export function getCipher(env: { FORGEPM_SECRET_KEY: string }): Cipher {
  return createCipher(Buffer.from(env.FORGEPM_SECRET_KEY, 'base64'));
}

export function last4(s: string): string {
  return s.slice(-4);
}

export async function listProviders(db: DbLike, orgId: string): Promise<ProviderRow[]> {
  const rows = await db.selectFrom('ai_providers').select(COLS).where('organization_id', '=', orgId).orderBy('created_at').execute();
  return rows as unknown as ProviderRow[];
}

export async function getProvider(db: DbLike, id: string, orgId: string): Promise<ProviderRow | undefined> {
  const r = await db.selectFrom('ai_providers').select(COLS).where('id', '=', id).where('organization_id', '=', orgId).executeTakeFirst();
  return r as unknown as ProviderRow | undefined;
}

export async function createProvider(
  db: Db,
  orgId: string,
  actorId: string,
  requestId: string,
  input: { name: string; kind: ProviderRow['kind']; base_url?: string | null; default_model?: string | null; api_key?: string | null; enabled?: boolean },
): Promise<string> {
  const id = newId();
  const cipher = input.api_key ? cipherFor(db) : null;
  await unitOfWork(db, async ({ tx }) => {
    await tx
      .insertInto('ai_providers')
      .values({
        id,
        organization_id: orgId,
        name: input.name,
        kind: input.kind,
        base_url: input.base_url ?? null,
        default_model: input.default_model ?? null,
        enabled: input.enabled ?? true,
        encrypted_key: input.api_key && cipher ? cipher.encrypt(input.api_key) : null,
        key_last4: input.api_key ? last4(input.api_key) : null,
      })
      .execute();
    await recordAudit(tx, {
      organization_id: orgId,
      actor_type: 'user',
      actor_id: actorId,
      action: 'ai_provider.create',
      resource_type: 'ai_provider',
      resource_id: id,
      summary: { name: input.name, kind: input.kind, last4: input.api_key ? last4(input.api_key) : null },
      request_id: requestId,
    });
  });
  return id;
}

// The cipher is injected via setCipher during app/worker bootstrap.
let CIPHER: Cipher | null = null;
export function setCipher(c: Cipher): void {
  CIPHER = c;
}
function cipherFor(_db: DbLike): Cipher {
  if (!CIPHER) throw new AppError('INTERNAL', 'cipher not initialised');
  return CIPHER;
}

export async function decryptKey(db: DbLike, id: string, orgId: string): Promise<string | null> {
  const row = await db.selectFrom('ai_providers').select('encrypted_key').where('id', '=', id).where('organization_id', '=', orgId).executeTakeFirst();
  if (!row || !row.encrypted_key) return null;
  return cipherFor(db).decrypt(row.encrypted_key as Buffer);
}



export async function recordCall(
  db: DbLike,
  orgId: string,
  v: { provider_id: string; model: string; purpose: string; tokens_in: number; tokens_out: number; latency_ms: number; status: 'ok' | 'error' },
): Promise<void> {
  await db
    .insertInto('ai_calls')
    .values({ id: newId(), organization_id: orgId, ...v })
    .execute();
}
