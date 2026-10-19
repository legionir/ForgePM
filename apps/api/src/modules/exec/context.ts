import { sql } from 'kysely';
import { z } from 'zod';
import { AppError } from '@forgepm/shared';
import { recordAudit, type Db, type DbLike, type LedgerActor } from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from '../projects/access';

/**
 * The shared plumbing of every exec tool (plan §7, §8).
 *
 * Which project the caller means, whether the task exists in it, who the
 * ledger actor is and how the audit row is written — none of that belongs to
 * an individual tool, and a second copy of it is a second answer. The tools
 * themselves stay thin: schema in, ledger out.
 */

export const projectRefSchema = z.string().min(1).max(64);

/** A malformed call is an answer, not a crash: same shape as the ledger parsers (A.5). */
export function parseTool<T extends object>(schema: z.ZodTypeAny, raw: unknown, neededAction: string): T {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data as T;
  const issue = parsed.error.issues[0] ?? { path: [], message: 'payload did not parse' };
  const path = (issue.path as (string | number)[]).join('.');
  throw new AppError('VALIDATION_ERROR', path ? `${path}: ${issue.message}` : issue.message, {
    needed_action: neededAction,
  });
}

/** `{project_ref}` is optional everywhere; the rule for filling it in lives here. */
export async function resolveProject(
  db: DbLike,
  actor: Actor,
  ref: string | undefined,
  action: 'project:read' | 'project:write',
): Promise<string> {
  if (ref) {
    // `id::text` because a caller may pass the PRJ-key; comparing a text key to a uuid
    // column is a postgres type error, which would surface as INTERNAL rather than
    // "no such project".
    const found = await sql<{ id: string }>`
      SELECT id::text AS id FROM projects
      WHERE organization_id = ${actor.organizationId} AND (id::text = ${ref} OR key = ${ref})
    `.execute(db as never);
    const row = found.rows[0];
    if (!row) {
      throw new AppError('NOT_FOUND', `no project '${ref}' in this organisation`, {
        ref,
        needed_action: 'the key may only touch the projects it is bound to',
      });
    }
    await assertProjectAccess(db as Db, actor, row.id, action);
    return row.id;
  }
  if (actor.projectIds && actor.projectIds.length === 1) {
    await assertProjectAccess(db as Db, actor, actor.projectIds[0], action);
    return actor.projectIds[0];
  }
  throw new AppError('VALIDATION_ERROR', 'the ledger needs one project to write into', {
    needed_action: 'pass project_ref (id or PRJ-key), or bind the API key to a single project',
  });
}

/**
 * A task code is unique per project, not per org, so `T-004` alone can name several
 * tasks. Resolving it by project is fine; guessing between two projects is not.
 */
export async function projectForTask(db: DbLike, actor: Actor, taskRef: string, explicit?: string): Promise<string> {
  if (explicit) return resolveProject(db, actor, explicit, 'project:read');
  const rows = await sql<{ project_id: string }>`
    SELECT project_id::text AS project_id FROM exec_tasks
    WHERE organization_id = ${actor.organizationId} AND (code = ${taskRef} OR id::text = ${taskRef})
  `.execute(db as never);
  const found = [...new Set(rows.rows.map((r) => r.project_id))];
  const narrowed = actor.projectIds ? found.filter((p) => actor.projectIds?.includes(p)) : found;
  if (narrowed.length === 1) return narrowed[0];
  if (!narrowed.length) {
    throw new AppError('NOT_FOUND', `no ledger task '${taskRef}' you may write to`, {
      ref: taskRef,
      needed_action: 'exec_task_start creates the task; ledger_status without task_ref lists what exists',
    });
  }
  throw new AppError('VALIDATION_ERROR', `'${taskRef}' names a task in ${narrowed.length} projects`, {
    needed_action: 'pass project_ref to pick one',
  });
}

export function ledgerActor(actor: Actor, projectId: string, tool: string): LedgerActor {
  return {
    organizationId: actor.organizationId,
    projectId,
    actorType: actor.type === 'agent' ? 'agent' : 'human',
    actorId: actor.id,
    tool,
  };
}

export function auditIn(
  tx: DbLike,
  actor: Actor,
  action: string,
  resourceType: string,
  resourceId: string,
  summary: unknown,
): Promise<string> {
  return recordAudit(tx, {
    organization_id: actor.organizationId,
    actor_type: actor.type === 'agent' ? 'agent' : 'user',
    actor_id: actor.id,
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    summary,
    request_id: actor.requestId,
  });
}
