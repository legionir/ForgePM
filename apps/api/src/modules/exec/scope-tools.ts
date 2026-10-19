import { sql } from 'kysely';
import { z } from 'zod';
import { AppError, idOrCodeSchema } from '@forgepm/shared';
import { loadGateContext, type Db } from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { projectForTask, projectRefSchema } from './context';

export const scopeCheckInputSchema = z.strictObject({
  task_ref: idOrCodeSchema,
  project_ref: projectRefSchema.optional(),
});

const MAX_RETURNED_PATHS = 200;

/**
 * Read-only scope measurement. The gate and tool share loadGateContext, which
 * obtains changed paths from the configured Git adapter; exit-report claims
 * are intentionally not exposed as measurement input.
 */
export async function scopeCheck(db: Db, actor: Actor, raw: unknown): Promise<Record<string, unknown>> {
  const args = scopeCheckInputSchema.parse(raw ?? {});
  const projectId = await projectForTask(db, actor, args.task_ref, args.project_ref);
  const found = await sql<{ id: string; code: string; start_ref: string | null; allowed_paths: unknown }>`
    SELECT id::text AS id, code, start_ref, allowed_paths
    FROM exec_tasks
    WHERE organization_id = ${actor.organizationId} AND project_id = ${projectId}
      AND (code = ${args.task_ref} OR id::text = ${args.task_ref})
    LIMIT 1
  `.execute(db as never);
  const task = found.rows[0];
  if (!task) throw new AppError('NOT_FOUND', `task '${args.task_ref}' not found in this project`, { ref: args.task_ref });

  const { ctx } = await loadGateContext(db, task.id);
  const files = ctx.scope.files;
  const outside = files.filter((file) => !file.in_allowed_paths && !file.transient);
  const deleted = files.filter((file) => file.deleted);
  return {
    task_id: task.id,
    task_code: task.code,
    measurable: ctx.scope.available,
    basis: ctx.scope.basis,
    start_ref: task.start_ref,
    allowed_paths: Array.isArray(task.allowed_paths) ? task.allowed_paths : [],
    touched: files.length,
    outside_count: outside.length,
    deleted_count: deleted.length,
    needs_human: (!ctx.scope.available && !ctx.scope.human_waived) || outside.length > 0 || deleted.length > 0,
    human_waived: ctx.scope.human_waived,
    manifest_hash: ctx.scope.basis === 'manifest' ? ctx.scope.tree_hash : null,
    unavailable_reason: ctx.scope.unavailable_reason,
    outside: outside.slice(0, MAX_RETURNED_PATHS).map((file) => ({ path: file.path, change: file.change })),
    deleted: deleted.slice(0, MAX_RETURNED_PATHS).map((file) => ({ path: file.path, change: file.change })),
    files: files.slice(0, MAX_RETURNED_PATHS).map((file) => ({
      path: file.path,
      change: file.change,
      in_allowed_paths: file.in_allowed_paths,
      deleted: file.deleted,
    })),
    truncated: files.length > MAX_RETURNED_PATHS,
    report_changed_files_used: false,
  };
}
