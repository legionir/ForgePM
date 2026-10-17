import { sql } from 'kysely';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import type { DbLike } from '../db/unitOfWork';

/**
 * Append-only ledger event stream (invariant I-2/I-8). Written inside the same
 * transaction as the mutation it describes, so a failed audit insert rolls the
 * whole unit of work back — the ledger can never claim something the DB rejected.
 */

export interface LedgerEvent {
  organization_id: string;
  task_id: string | null;
  entity: string;
  entity_id?: string | null;
  entity_code?: string | null;
  action: string;
  actor_type: 'agent' | 'human' | 'system';
  actor_id: string;
  tool?: string | null;
  payload?: unknown;
}

export async function appendEvent(tx: DbLike, ev: LedgerEvent): Promise<string> {
  const id = newId();
  await sql`
    INSERT INTO exec_events (id, organization_id, task_id, entity, entity_id, entity_code, action, actor_type, actor_id, tool, payload)
    VALUES (${id}, ${ev.organization_id}, ${ev.task_id ?? null}, ${ev.entity}, ${ev.entity_id ?? null}, ${ev.entity_code ?? null},
            ${ev.action}, ${ev.actor_type}, ${ev.actor_id}, ${ev.tool ?? null}, ${toJsonb(ev.payload ?? {}) as never})
  `.execute(tx as never);
  return id;
}

export async function countEvents(tx: DbLike, taskId: string): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM exec_events WHERE task_id = ${taskId}`.execute(tx as never);
  return Number(r.rows[0]?.n ?? 0);
}
