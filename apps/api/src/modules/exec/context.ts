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

export const projectRefSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('Project key such as ZNITH (any letter case), the project id, or an exact unique project name. Optional when the API key is bound to one project. ledger_projects lists the choices.');

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

export interface VisibleProject {
  id: string;
  key: string;
  name: string;
  status: string;
}

/** The projects this caller may use: a key bound to some projects sees only those. */
export async function visibleProjects(db: DbLike, actor: Actor, opts: { includeArchived?: boolean; limit?: number } = {}): Promise<VisibleProject[]> {
  const rows = await sql<VisibleProject>`
    SELECT id::text AS id, key, name, status FROM projects
    WHERE organization_id = ${actor.organizationId} AND deleted_at IS NULL
    ORDER BY (status = 'active') DESC, key
  `.execute(db as never);
  return rows.rows
    .filter((p) => !actor.projectIds || actor.projectIds.includes(p.id))
    .filter((p) => opts.includeArchived || p.status === 'active')
    .slice(0, opts.limit ?? 50);
}

const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** The visible project whose key or name is within two edits of what was typed, if any. */
export function closestProject(ref: string, candidates: VisibleProject[]): VisibleProject | null {
  const want = squash(ref);
  if (want.length < 3) return null;
  let best: { p: VisibleProject; d: number } | null = null;
  for (const p of candidates) {
    const d = Math.min(distance(want, squash(p.key)), distance(want, squash(p.name)));
    if (d <= 2 && (!best || d < best.d)) best = { p, d };
  }
  return best?.p ?? null;
}

const describeProjects = (list: VisibleProject[]): string => list.map((p) => `${p.key} (${p.name})`).join(', ');

/**
 * `{project_ref}` is optional everywhere; the rule for filling it in lives here.
 * It accepts the project id, the key in any letter case, or an exact project name when
 * exactly one visible project has that name. A miss lists the projects the caller can
 * use (and a close match), so an agent can correct itself instead of guessing again.
 */
export async function resolveProject(
  db: DbLike,
  actor: Actor,
  ref: string | undefined,
  action: 'project:read' | 'project:write',
): Promise<string> {
  if (ref) {
    const typed = ref.trim();
    // `id::text` because a caller may pass the PRJ-key; comparing a text key to a uuid
    // column is a postgres type error, which would surface as INTERNAL rather than
    // "no such project".
    const found = await sql<{ id: string }>`
      SELECT id::text AS id FROM projects
      WHERE organization_id = ${actor.organizationId} AND deleted_at IS NULL AND (id::text = ${typed} OR lower(key) = lower(${typed}))
    `.execute(db as never);
    let id = found.rows[0]?.id;
    if (!id) {
      const all = await visibleProjects(db, actor, { includeArchived: true, limit: 500 });
      const byName = all.filter((p) => p.name.toLowerCase() === typed.toLowerCase());
      if (byName.length === 1) id = byName[0].id;
      else if (byName.length > 1) {
        throw new AppError('VALIDATION_ERROR', `project name '${typed}' matches ${byName.length} projects: ${describeProjects(byName)}`, {
          ref: typed,
          matches: byName,
          needed_action: 'pass the project key or id of the one you mean',
        });
      } else {
        const shown = all.filter((p) => p.status === 'active').slice(0, 20);
        const near = closestProject(typed, all);
        throw new AppError(
          'NOT_FOUND',
          `no project '${typed}' in this organisation${near ? ` (did you mean ${near.key} — ${near.name}?)` : ''}. Projects you can use: ${shown.length ? describeProjects(shown) : 'none'}`,
          {
            ref: typed,
            did_you_mean: near ? { key: near.key, name: near.name, id: near.id } : null,
            available: shown,
            needed_action: 'pass project_ref as one of the keys or ids in available; ledger_projects lists them',
          },
        );
      }
    }
    await assertProjectAccess(db as Db, actor, id, action);
    return id;
  }
  if (actor.projectIds && actor.projectIds.length === 1) {
    await assertProjectAccess(db as Db, actor, actor.projectIds[0], action);
    return actor.projectIds[0];
  }
  const choices = await visibleProjects(db, actor, { limit: 20 });
  throw new AppError('VALIDATION_ERROR', `the ledger needs one project to write into. Projects you can use: ${choices.length ? describeProjects(choices) : 'none'}`, {
    available: choices,
    needed_action: 'pass project_ref (key, id or exact unique name), or bind the API key to a single project',
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

/**
 * A machine caller is never the human (R-02): every API key is an agent for the
 * ledger, including a user-owned one, because humans decide only through a panel
 * session. Without this a user-owned key was recorded as `human` and slipped
 * past the agent-only rules (an agent may not soft-close a blocking item).
 */
function isHuman(actor: Actor): boolean {
  return actor.type !== 'agent' && !actor.apiKeyId;
}

export function ledgerActor(actor: Actor, projectId: string, tool: string): LedgerActor {
  return {
    organizationId: actor.organizationId,
    projectId,
    actorType: isHuman(actor) ? 'human' : 'agent',
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
