import { AppError } from '@forgepm/shared';
import { activeCipher, defaultRegistry, type Db, type DbLike, newId, recordAudit, unitOfWork } from '@forgepm/core';

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
  const cipher = input.api_key ? activeCipher() : null;
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

/** Default endpoints per provider kind (same convention as core buildProvider: base includes /v1). */
export const DEFAULT_BASE_URLS: Record<ProviderRow['kind'], string> = {
  fake: '',
  openai: 'https://api.openai.com/v1',
  openai_compatible: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

/**
 * Live model list from the provider's {base_url}/models endpoint
 * (OpenAI-compatible `data[].id` / Anthropic `data[].id`). `fake` returns the
 * deterministic offline models. Throws PROVIDER_ERROR on any failure.
 */
export async function listProviderModels(kind: ProviderRow['kind'], baseUrl: string | null, apiKey: string | null): Promise<string[]> {
  if (kind === 'fake') return ['fake-1', 'fake-mini'];
  const base = (baseUrl || DEFAULT_BASE_URLS[kind]).replace(/\/+$/, '');
  const headers: Record<string, string> =
    kind === 'anthropic'
      ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey ?? ''}` };
  let res: Response;
  try {
    res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new AppError('PROVIDER_ERROR', `models endpoint unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) throw new AppError('PROVIDER_ERROR', `models list HTTP ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
  return (json.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
}

/** Partial update (name / endpoint / key / model / enabled) with audit. */
export async function updateProvider(
  db: Db,
  orgId: string,
  actorId: string,
  requestId: string,
  id: string,
  input: { name?: string; base_url?: string | null; api_key?: string; default_model?: string | null; enabled?: boolean },
): Promise<void> {
  const cipher = input.api_key ? activeCipher() : null;
  await unitOfWork(db, async ({ tx }) => {
    const values: Record<string, unknown> = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.base_url !== undefined) values.base_url = input.base_url;
    if (input.default_model !== undefined) values.default_model = input.default_model;
    if (input.enabled !== undefined) values.enabled = input.enabled;
    if (input.api_key) {
      values.encrypted_key = cipher!.encrypt(input.api_key);
      values.key_last4 = last4(input.api_key);
    }
    if (Object.keys(values).length) {
      await tx.updateTable('ai_providers').set(values as never).where('id', '=', id).where('organization_id', '=', orgId).execute();
    }
    await recordAudit(tx, {
      organization_id: orgId,
      actor_type: 'user',
      actor_id: actorId,
      action: 'ai_provider.update',
      resource_type: 'ai_provider',
      resource_id: id,
      summary: { fields: Object.keys(values) },
      request_id: requestId,
    });
  });
}

export async function decryptKey(db: DbLike, id: string, orgId: string): Promise<string | null> {
  const row = await db.selectFrom('ai_providers').select('encrypted_key').where('id', '=', id).where('organization_id', '=', orgId).executeTakeFirst();
  if (!row || !row.encrypted_key) return null;
  return activeCipher().decrypt(row.encrypted_key as Buffer);
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
  // Plan §14: AI call counter + token histogram (labelled by provider+purpose).
  defaultRegistry.inc('forgepm_ai_calls_total', { purpose: v.purpose, status: v.status });
  defaultRegistry.observe('forgepm_ai_latency_seconds', Math.max(0, v.latency_ms) / 1000);
}
