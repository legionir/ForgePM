import type { Kysely } from 'kysely';
import type { DB } from './types';

export interface RequestCtx {
  organizationId: string;
  requestId: string;
}

/**
 * scopedDb forces the organization filter at the repository layer
 * (plan §3b-2). Repositories must obtain their executor through this
 * wrapper; raw pool access outside infrastructure/ is blocked by ESLint.
 *
 * Phase 0 provides the mechanism and a compile-time surface; Phase 1
 * repositories build every query on top of `where org = scoped.organizationId`.
 */
export interface ScopedDb {
  db: Kysely<DB>;
  organizationId: string;
  requestId: string;
}

export function scopedDb(db: Kysely<DB>, ctx: RequestCtx): ScopedDb {
  if (!ctx.organizationId) throw new Error('scopedDb requires an organization context');
  return { db, organizationId: ctx.organizationId, requestId: ctx.requestId };
}

/** Convenience: adds the mandatory organization filter to any query on a table with organization_id. */
export function withOrg<Q extends { where: (col: string, op: string, val: unknown) => Q }>(scoped: ScopedDb, query: Q): Q {
  return query.where('organization_id', '=', scoped.organizationId);
}
