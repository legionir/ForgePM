import { sql } from 'kysely';
import { EXEC_POLICY_DEFAULT, classify, getEffective, isJournalLockException, journalWriteLock, throwIfJournalLocked, type Db } from '@forgepm/core';
import type { ExecPolicy } from '@forgepm/shared';
import type { Actor } from '../../app/auth-context';

interface LockJournalRow {
  code: string;
  task_id: string;
  action: string;
  target: string | null;
  expected_effect: string;
  idempotent: boolean;
  status: 'started' | 'unknown';
}

/**
 * Dispatch-level enforcement for every agent write to the execution ledger.
 * The handler cannot be reached while an unresolved action exists, except for
 * the recovery/read exceptions encoded in the core journal helper.
 */
export async function enforceExecWriteLock(
  db: Db,
  actor: Actor,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (actor.type !== 'agent' || isJournalLockException(tool)) return;
  const projectIds = await targetProjects(db, actor, args);
  if (!projectIds.length) return;

  const openResult = await sql<LockJournalRow>`
    SELECT j.code, j.task_id::text AS task_id, j.action, j.target, j.expected_effect, j.idempotent, j.status
    FROM exec_action_journal j JOIN exec_tasks t ON t.id = j.task_id
    WHERE t.organization_id = ${actor.organizationId}::uuid
      AND t.project_id = ANY(${projectIds}::uuid[])
      AND j.status IN ('started','unknown')
    ORDER BY j.started_at, j.code
  `.execute(db as never);
  if (!openResult.rows.length) return;

  let retryIntent: Parameters<typeof journalWriteLock>[0]['retryIntent'];
  if (tool === 'journal_start') {
    const taskRef = stringField(args, 'task_ref');
    const action = stringField(args, 'action');
    const target = stringField(args, 'target');
    const expectedEffect = stringField(args, 'expected_effect');
    const idempotent = args.idempotent === true;
    if (taskRef && action && expectedEffect) {
      const task = await sql<{ id: string }>`
        SELECT id::text AS id FROM exec_tasks
        WHERE organization_id = ${actor.organizationId}::uuid
          AND project_id = ANY(${projectIds}::uuid[])
          AND (id::text = ${taskRef} OR code = ${taskRef})
        ORDER BY project_id, code LIMIT 2
      `.execute(db as never);
      if (task.rows.length === 1) {
        retryIntent = { task_id: task.rows[0]!.id, action, target: target ?? null, expected_effect: expectedEffect, idempotent };
      }
    }
  }

  const approvalDecision =
    tool === 'ledger_record_decision' ? await isApprovalDecision(db, actor, args, projectIds) : false;
  throwIfJournalLocked(
    journalWriteLock({
      tool,
      actorType: 'agent',
      openRows: openResult.rows,
      retryIntent,
      approvalDecision,
    }),
  );
}

async function targetProjects(db: Db, actor: Actor, args: Record<string, unknown>): Promise<string[]> {
  const explicit = stringField(args, 'project_ref');
  if (explicit) {
    const found = await sql<{ id: string }>`
      SELECT id::text AS id FROM projects
      WHERE organization_id = ${actor.organizationId}::uuid AND (id::text = ${explicit} OR key = ${explicit})
        ${actor.projectIds ? sql`AND id = ANY(${actor.projectIds}::uuid[])` : sql``}
    `.execute(db as never);
    return found.rows.map((row) => row.id);
  }

  const taskRefs = ['task_ref', 'parent_ref', 'task_id']
    .map((key) => stringField(args, key))
    .filter((value): value is string => value !== null);
  if (taskRefs.length) {
    const found = await sql<{ project_id: string }>`
      SELECT DISTINCT project_id::text AS project_id FROM exec_tasks
      WHERE organization_id = ${actor.organizationId}::uuid
        AND (code = ANY(${taskRefs}::text[]) OR id::text = ANY(${taskRefs}::text[]))
        ${actor.projectIds ? sql`AND project_id = ANY(${actor.projectIds}::uuid[])` : sql``}
    `.execute(db as never);
    return found.rows.map((row) => row.project_id);
  }

  const factRef = stringField(args, 'fact_ref');
  if (factRef) {
    const found = await sql<{ project_id: string }>`
      SELECT DISTINCT project_id::text AS project_id FROM exec_facts
      WHERE organization_id = ${actor.organizationId}::uuid
        AND (code = ${factRef} OR id::text = ${factRef})
        ${actor.projectIds ? sql`AND project_id = ANY(${actor.projectIds}::uuid[])` : sql``}
    `.execute(db as never);
    return found.rows.map((row) => row.project_id);
  }

  const journalRef = stringField(args, 'journal_ref');
  if (journalRef) {
    const found = await sql<{ project_id: string }>`
      SELECT DISTINCT t.project_id::text AS project_id
      FROM exec_action_journal j JOIN exec_tasks t ON t.id = j.task_id
      WHERE t.organization_id = ${actor.organizationId}::uuid
        AND (j.code = ${journalRef} OR j.id::text = ${journalRef})
        ${actor.projectIds ? sql`AND t.project_id = ANY(${actor.projectIds}::uuid[])` : sql``}
    `.execute(db as never);
    return found.rows.map((row) => row.project_id);
  }

  if (actor.projectIds) return actor.projectIds;
  const projects = await sql<{ id: string }>`
    SELECT id::text AS id FROM projects WHERE organization_id = ${actor.organizationId}::uuid
  `.execute(db as never);
  return projects.rows.map((row) => row.id);
}

async function isApprovalDecision(
  db: Db,
  actor: Actor,
  args: Record<string, unknown>,
  projectIds: string[],
): Promise<boolean> {
  const taskRef = stringField(args, 'task_ref');
  const touches = Array.isArray(args.touches) ? args.touches.filter((value): value is string => typeof value === 'string') : [];
  if (!taskRef || typeof args.reversible !== 'boolean') return false;
  const task = await sql<{ project_id: string }>`
    SELECT DISTINCT project_id::text AS project_id FROM exec_tasks
    WHERE organization_id = ${actor.organizationId}::uuid
      AND project_id = ANY(${projectIds}::uuid[])
      AND (id::text = ${taskRef} OR code = ${taskRef})
    ORDER BY project_id LIMIT 2
  `.execute(db as never);
  if (task.rows.length !== 1) return false;
  const effective = await getEffective(db, 'exec.policy', actor.organizationId, task.rows[0]!.project_id);
  const policy = (effective?.value as ExecPolicy | undefined) ?? EXEC_POLICY_DEFAULT;
  return classify(policy, { touches, reversible: args.reversible }).level === 'approval';
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}
