import { newId } from './id';
import { toJsonb } from './jsonb';
import type { DbLike } from './db/unitOfWork';

export interface AuditRecord {
  organization_id: string;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  summary?: unknown;
  request_id?: string | null;
}

/**
 * Write one audit_event inside the CURRENT transaction (plan §1.3, §5.8).
 * Services call this from within unitOfWork; if the audit insert fails the
 * whole unit of work rolls back — which is the required behaviour
 * (acceptance §5: injected audit failure rolls back the mutation).
 */
export async function recordAudit(tx: DbLike, rec: AuditRecord): Promise<string> {
  const id = newId();
  await tx
    .insertInto('audit_events')
    .values({
      id,
      organization_id: rec.organization_id,
      actor_type: rec.actor_type,
      actor_id: rec.actor_id,
      action: rec.action,
      resource_type: rec.resource_type,
      resource_id: rec.resource_id,
      summary: rec.summary === undefined ? null : (toJsonb(rec.summary) as never),
      request_id: rec.request_id ?? null,
    })
    .execute();
  return id;
}

export const SYSTEM_ACTOR_ID = '00000000-0000-7000-8000-000000000000';
