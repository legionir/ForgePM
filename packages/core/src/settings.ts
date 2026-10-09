import type { Db } from './db/unitOfWork';
import { newId } from './id';
import { toJsonb } from './jsonb';

export type SettingsScope = 'system' | 'organization' | 'project';

export interface EffectiveSetting {
  key: string;
  value: unknown;
  source: SettingsScope; // which level the effective value came from
}

/**
 * Resolve the effective value for a key: project <- organization <- system
 * (plan §5.7). Returns the nearest defined level **for the specific scope_id**
 * plus its source. Matching on (scope, scope_id, key) is required so that one
 * project's override never leaks into another project (tenancy correctness).
 *
 * Phase 1 extends this with the settings registry (schema + defaults per key);
 * Phase 0 needs it for `modules.<name>.enabled` lookups.
 */
export async function getEffective(
  db: Db,
  key: string,
  orgId: string | null,
  projectId: string | null,
): Promise<EffectiveSetting | undefined> {
  const rows = await db
    .selectFrom('settings')
    .select(['scope', 'scope_id', 'value'])
    .where('key', '=', key)
    .execute();

  if (projectId !== null) {
    const hit = rows.find((r) => r.scope === 'project' && r.scope_id === projectId);
    if (hit) return { key, value: hit.value, source: 'project' };
  }
  if (orgId !== null) {
    const hit = rows.find((r) => r.scope === 'organization' && r.scope_id === orgId);
    if (hit) return { key, value: hit.value, source: 'organization' };
  }
  const sys = rows.find((r) => r.scope === 'system');
  if (sys) return { key, value: sys.value, source: 'system' };
  return undefined;
}

export async function upsertSetting(
  db: Db,
  scope: SettingsScope,
  scopeId: string | null,
  key: string,
  value: unknown,
): Promise<void> {
  const existing = await db
    .selectFrom('settings')
    .select('id')
    .where('scope', '=', scope)
    .where((eb) => (scopeId === null ? eb('scope_id', 'is', null) : eb('scope_id', '=', scopeId)))
    .where('key', '=', key)
    .executeTakeFirst();

  if (existing) {
    await db
      .updateTable('settings')
      .set({ value: toJsonb(value) as never, updated_at: new Date() })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('settings')
      .values({ id: newId(), scope, scope_id: scopeId, key, value: toJsonb(value) as never })
      .execute();
  }
}

export async function deleteSetting(
  db: Db,
  scope: SettingsScope,
  scopeId: string | null,
  key: string,
): Promise<void> {
  await db
    .deleteFrom('settings')
    .where('scope', '=', scope)
    .where((eb) => (scopeId === null ? eb('scope_id', 'is', null) : eb('scope_id', '=', scopeId)))
    .where('key', '=', key)
    .execute();
}
