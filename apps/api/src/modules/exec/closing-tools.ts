import { z } from 'zod';
import { AppError, exitReportObjectSchema, idOrCodeSchema } from '@forgepm/shared';
import {
  applyFactVerification,
  completeTask,
  normalizeExitReportPayload,
  prepareFactVerification,
  resolveExecReviewSource,
  SYSTEM_ACTOR_ID,
  parseExitReport,
  submitExitReport,
  unitOfWork,
  type Db,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { auditIn, ledgerActor, parseTool, projectForTask, projectRefSchema } from './context';

/**
 * PE-3's two closing tools (plan §8): the exit report and the gate.
 *
 * They live together because they are two halves of one act: the report says
 * what was done, the gate says whether that is enough. The rules are in
 * `@forgepm/core/src/exec`; what is here is the API's share — which project,
 * which transaction, which audit row.
 */

/**
 * The exit report's own shape, plus the API-level `project_ref`. The strict
 * object is shared with the service so the advertised schema and the schema
 * that validates the call cannot drift apart.
 *
 * The `preprocess` is the *alias*, not a loophole: the plan (§8.1) calls the
 * task's field `task_id` and the repo calls it `task_ref`, so both spellings
 * are accepted and the canonical one is what the ledger sees. The advertised
 * shape is unchanged — a preprocess does not add a key, it renames one (see
 * `jsonSchemaFor`, which unwraps the wrapper).
 */
export const exitReportToolSchema = z.preprocess(
  (raw) => normalizeExitReportPayload(raw),
  exitReportObjectSchema.extend({
    project_ref: projectRefSchema.optional(),
  }),
);

export const completeToolSchema = z.strictObject({
  task_ref: idOrCodeSchema,
  /** The report to close on (a uuid — reports have no code of their own). */
  report_ref: z.string().uuid().optional(),
  project_ref: projectRefSchema.optional(),
});

/**
 * `exec_submit_exit_report` (plan §8.1).
 *
 * The report is written and its findings become open items in ONE
 * transaction, so a report can never exist without the items it promised.
 * `project_ref` is an API-level field and is stripped before the strict
 * ledger schema sees the payload.
 */
export async function submitExitReportTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const { project_ref, ...rest } = (raw ?? {}) as Record<string, unknown>;
  const parsed = parseExitReport(rest);
  if (!parsed.ok) {
    throw new AppError('UNPROCESSABLE', parsed.message, {
      needed_action: parsed.needed_action,
      ...(parsed.details ?? {}),
    });
  }
  const projectId = await projectForTask(db, actor, parsed.value.taskRef, project_ref as string | undefined);
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const row = await submitExitReport(tx, ledgerActor(actor, projectId, 'exec_submit_exit_report'), rest);
    await auditIn(tx, actor, 'exec.exit_report.submit', 'exec_report', row.report_id, {
      task: row.task_code,
      promoted: row.promoted,
      referenced: row.referenced,
    });
    out = row;
  });
  return out;
}

/**
 * `exec_task_complete` (plan §8.2) — the one door to `done`.
 *
 * A refusal is an ANSWER, not an error: the agent gets `{ ok:false,
 * blocked_by:[…] }` with the rule, the reference, what is needed and which
 * tool to call. The gate's stamp, the status change and the audit row are
 * one transaction.
 */
export async function completeTaskTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<z.infer<typeof completeToolSchema>>(
    completeToolSchema,
    raw,
    'send { task_ref } — the gate reads the ledger, not the message',
  );
  const projectId = await projectForTask(db, actor, tool.task_ref, tool.project_ref);
  const ledger = ledgerActor(actor, projectId, 'exec_task_complete');
  const factActor = {
    organizationId: actor.organizationId,
    projectId,
    actorType: 'system' as const,
    actorId: SYSTEM_ACTOR_ID,
    tool: 'exec_task_complete',
  };
  const factPreparation = await prepareFactVerification(db, ledger, resolveExecReviewSource());
  let out: unknown;
  await unitOfWork(db, async ({ tx }) => {
    const checked = await applyFactVerification(tx, factActor, factPreparation);
    for (const change of checked.changes) {
      if (change.to !== 'stale' || change.from !== 'active') continue;
      await auditIn(tx, actor, 'exec.fact.stale', 'exec_fact', change.id, {
        code: change.code,
        changed_files: change.changed_files,
        warning: change.warning,
        trigger: 'exec_task_complete',
      });
    }
    const row = await completeTask(tx, ledger, tool.task_ref, {
      reportId: tool.report_ref ?? null,
    });
    await auditIn(tx, actor, 'exec.task.complete', 'exec_task', row.task_id, {
      ok: row.ok,
      status: row.status,
      stamp_id: row.stamp_id,
      blocked_by: row.blocked_by.map((b) => `${b.rule}:${b.ref}`),
    });
    out = row;
  });
  return out;
}
