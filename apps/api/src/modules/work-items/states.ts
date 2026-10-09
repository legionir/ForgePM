import { sql } from 'kysely';
import { newId, type DbLike } from '@forgepm/core';
import { DEFAULT_WORKFLOW } from '@forgepm/shared';

export interface StateRow {
  id: string;
  name: string;
  category: 'backlog' | 'unstarted' | 'started' | 'in_review' | 'completed' | 'canceled';
  position: number;
}

/** Ensure a project has the default workflow; returns its states. Idempotent. */
export async function ensureWorkflow(db: DbLike, projectId: string, orgId: string): Promise<StateRow[]> {
  const existing = await listStates(db, projectId);
  if (existing.length > 0) return existing;
  let pos = 0;
  for (const s of DEFAULT_WORKFLOW) {
    await db
      .insertInto('workflow_states')
      .values({ id: newId(), organization_id: orgId, project_id: projectId, name: s.name, category: s.category, position: pos++ })
      .onConflict((oc) => oc.columns(['project_id', 'name']).doNothing())
      .execute();
  }
  return listStates(db, projectId);
}

export async function listStates(db: DbLike, projectId: string): Promise<StateRow[]> {
  const rows = await db
    .selectFrom('workflow_states')
    .select(['id', 'name', 'category', 'position'])
    .where('project_id', '=', projectId)
    .orderBy('position', 'asc')
    .execute();
  return rows;
}

export async function getState(db: DbLike, stateId: string): Promise<StateRow | undefined> {
  const r = await db
    .selectFrom('workflow_states')
    .select(['id', 'name', 'category', 'position'])
    .where('id', '=', stateId)
    .executeTakeFirst();
  return r as StateRow | undefined;
}

export async function createState(db: DbLike, projectId: string, orgId: string, input: { name: string; category: StateRow['category']; position?: number }): Promise<StateRow> {
  const id = newId();
  await db
    .insertInto('workflow_states')
    .values({ id, organization_id: orgId, project_id: projectId, name: input.name, category: input.category, position: input.position ?? 999 })
    .execute();
  return { id, name: input.name, category: input.category, position: input.position ?? 999 };
}

/**
 * Atomically allocate the next work-item number for a project. Uses
 * UPDATE ... RETURNING so 20 concurrent inserts get contiguous, unique numbers
 * (plan §6 acceptance: FPM-1..FPM-50 under concurrency).
 */
export async function allocateNumber(db: DbLike, projectId: string): Promise<number> {
  const res = await sql<{ number: number }>`
    UPDATE projects
    SET next_item_number = next_item_number + 1, updated_at = now()
    WHERE id = ${projectId}
    RETURNING (next_item_number - 1) AS number
  `.execute(db);
  const row = res.rows[0];
  if (!row) throw new Error('allocateNumber: project vanished');
  return Number(row.number);
}
