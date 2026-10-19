import { sql } from 'kysely';
import { z } from 'zod';
import {
  appendEvent,
  getEffective,
  MCP_MAX_OUTPUT_BYTES,
  packSession,
  requirementCoverage,
  resolveExecReviewSource,
  SYSTEM_ACTOR_ID,
  applyFactVerification,
  prepareFactVerification,
  unitOfWork,
  type Db,
  type LedgerActor,
  type SessionSection,
} from '@forgepm/core';
import { sessionStartInputSchema } from '@forgepm/shared';
import type { Actor } from '../../app/auth-context';
import { auditIn, ledgerActor, parseTool, projectRefSchema, resolveProject } from './context';

export const sessionStartToolSchema = sessionStartInputSchema.extend({
  project_ref: projectRefSchema.optional(),
  since: z.string().datetime().optional(),
});

const RECENT_UNBLOCK_LIMIT = 10;
const MAX_SESSION_ROWS = 2_000;

type SessionItem = Record<string, unknown>;

export async function sessionStartTool(db: Db, actor: Actor, raw: unknown): Promise<unknown> {
  const tool = parseTool<Record<string, unknown>>(sessionStartToolSchema, raw, 'send {} or { project_ref, since }');
  const projectId = await resolveProject(db, actor, tool.project_ref as string | undefined, 'project:read');
  const configuredLimit = await getEffective(db, 'exec.session_output_max_bytes', actor.organizationId, projectId);
  const configuredMaxBytes =
    typeof configuredLimit?.value === 'number' && Number.isInteger(configuredLimit.value)
      ? configuredLimit.value
      : 8192;
  // MCP's outer JSON envelope has a lower hard cap. Stay below it so the
  // dispatcher never replaces a valid SessionSnapshot with a text preview.
  const maxBytes = Math.min(configuredMaxBytes, MCP_MAX_OUTPUT_BYTES - 512);
  const since = typeof tool.since === 'string' ? tool.since : null;
  const staleSetting = await getEffective(db, 'exec.stale_check_on_start', actor.organizationId, projectId);
  const staleCheckEnabled = staleSetting?.value !== false;
  const factActor: LedgerActor = {
    organizationId: actor.organizationId,
    projectId,
    actorType: 'system',
    actorId: SYSTEM_ACTOR_ID,
    tool: 'session_start',
  };
  const factPreparation = staleCheckEnabled
    ? await prepareFactVerification(db, factActor, resolveExecReviewSource())
    : null;
  let output: unknown;

  await unitOfWork(db, async ({ tx }) => {
    const ledger = ledgerActor(actor, projectId, 'session_start');
    if (factPreparation) {
      const verified = await applyFactVerification(tx, factActor, factPreparation);
      for (const change of verified.changes) {
        if (change.to !== 'stale' || change.from !== 'active') continue;
        await auditIn(tx, actor, 'exec.fact.stale', 'exec_fact', change.id, {
          code: change.code,
          changed_files: change.changed_files,
          warning: change.warning,
          trigger: 'session_start',
        });
      }
    }
    const interrupted = await sql<{
      id: string;
      code: string;
      task_id: string;
      task_code: string;
      action: string;
    }>`
      SELECT j.id::text AS id, j.code, j.task_id::text AS task_id, t.code AS task_code, j.action
      FROM exec_action_journal j JOIN exec_tasks t ON t.id = j.task_id
      WHERE t.organization_id = ${actor.organizationId}::uuid
        AND t.project_id = ${projectId}::uuid AND j.status = 'started'
      ORDER BY j.started_at, j.code
    `.execute(tx as never);
    for (const row of interrupted.rows) {
      await sql`
        UPDATE exec_action_journal SET status = 'unknown', finished_at = now()
        WHERE id = ${row.id}::uuid AND status = 'started'
      `.execute(tx as never);
      await appendEvent(tx, {
        organization_id: actor.organizationId,
        task_id: row.task_id,
        entity: 'journal',
        entity_id: row.id,
        entity_code: row.code,
        action: 'journal.unknown_after_session_start',
        actor_type: ledger.actorType,
        actor_id: ledger.actorId,
        tool: 'session_start',
        payload: { task: row.task_code, action: row.action, previous_status: 'started', status: 'unknown' },
      });
      await auditIn(tx, actor, 'exec.journal.mark_unknown', 'exec_action_journal', row.id, {
        task: row.task_code,
        code: row.code,
        action: row.action,
        reason: 'session_start recovery',
      });
    }

    const [coverage, questions, approvals, journals, openItems, facts, revisits, tasks, events] = await Promise.all([
      requirementCoverage(tx, { organizationId: actor.organizationId, projectId }),
      sql<SessionItem>`
        SELECT q.code, t.code AS task_code, 'question' AS kind, q.question AS title,
          q.why_it_matters AS detail, q.created_at::text AS created_at
        FROM exec_questions q JOIN exec_tasks t ON t.id = q.task_id
        WHERE q.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${projectId}::uuid
          AND q.status = 'open' AND q.blocking = true
        ORDER BY q.created_at, q.code LIMIT ${MAX_SESSION_ROWS}
      `.execute(tx as never),
      sql<SessionItem>`
        SELECT d.code, t.code AS task_code, 'approval' AS kind, d.title,
          d.rationale AS detail, d.approval_state AS status, d.created_at::text AS created_at
        FROM exec_decisions d JOIN exec_tasks t ON t.id = d.task_id
        WHERE d.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${projectId}::uuid
          AND d.approval_state = 'pending'
        ORDER BY d.created_at, d.code LIMIT ${MAX_SESSION_ROWS}
      `.execute(tx as never),
      sql<SessionItem>`
        SELECT j.id::text AS id, j.code, t.code AS task_code, j.action, j.target, j.idempotent,
          j.status, j.expected_effect, j.started_at::text AS started_at
        FROM exec_action_journal j JOIN exec_tasks t ON t.id = j.task_id
        WHERE t.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${projectId}::uuid
          AND j.status IN ('started','unknown')
        ORDER BY CASE WHEN j.status = 'unknown' THEN 0 ELSE 1 END, j.started_at, j.code
        LIMIT ${MAX_SESSION_ROWS}
      `.execute(tx as never),
      sql<SessionItem>`
        SELECT i.code, t.code AS task_code, i.title, i.detail, i.type, i.status, i.updated_at::text AS updated_at
        FROM exec_open_items i JOIN exec_tasks t ON t.id = i.task_id
        WHERE i.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${projectId}::uuid
          AND i.blocks_completion = true AND i.status IN ('open','blocked','awaiting_human')
        ORDER BY CASE WHEN i.status = 'awaiting_human' THEN 0 WHEN i.status = 'blocked' THEN 1 ELSE 2 END,
          i.created_at, i.code
        LIMIT ${MAX_SESSION_ROWS}
      `.execute(tx as never),
      sql<SessionItem>`
        SELECT code, key, value, source, files, status, created_at::text AS created_at
        FROM exec_facts
        WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${projectId}::uuid
          AND status = 'stale'
        ORDER BY code LIMIT ${MAX_SESSION_ROWS}
      `.execute(tx as never),
      sql<SessionItem>`
        SELECT d.code, t.code AS task_code, d.title, d.rationale, d.review_trigger,
          d.updated_at::text AS updated_at
        FROM exec_decisions d JOIN exec_tasks t ON t.id = d.task_id
        WHERE d.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${projectId}::uuid
          AND d.status = 'needs_revisit'
        ORDER BY d.updated_at, d.code LIMIT ${MAX_SESSION_ROWS}
      `.execute(tx as never),
      sql<SessionItem>`
        SELECT id::text AS task_id, code, title, status, blocked_on_kind, blocked_on_ref,
          blocked_reason, unblock_condition, updated_at::text AS updated_at
        FROM exec_tasks
        WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${projectId}::uuid
          AND status <> 'done'
        ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'awaiting_review' THEN 1
          WHEN 'blocked' THEN 2 ELSE 3 END, code
        LIMIT ${MAX_SESSION_ROWS}
      `.execute(tx as never),
      sql<{
        task_id: string;
        task_code: string;
        created_at: string;
        reason: string | null;
        blocker_kind: string | null;
        blocker_ref: string | null;
      }>`
        SELECT e.task_id::text AS task_id, t.code AS task_code, e.created_at::text AS created_at,
          e.payload->>'reason' AS reason, e.payload->>'blocker_kind' AS blocker_kind,
          e.payload->>'blocker_ref' AS blocker_ref
        FROM exec_events e JOIN exec_tasks t ON t.id = e.task_id
        WHERE e.organization_id = ${actor.organizationId}::uuid AND t.project_id = ${projectId}::uuid
          AND e.action = 'task.unblocked'
          ${since ? sql`AND e.created_at >= ${since}::timestamptz` : sql``}
        ORDER BY e.created_at DESC, e.id DESC LIMIT 50
      `.execute(tx as never),
    ]);

    const requirementItems: SessionItem[] = coverage.requirements
      .filter((requirement) => requirement.status === 'active' && requirement.coverage !== 'covered')
      .map((requirement) => ({ ...requirement }));
    const humanPending = [...questions.rows, ...approvals.rows].sort((a, b) =>
      String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
    );
    const staleAndRevisited = [...facts.rows, ...revisits.rows].slice(0, MAX_SESSION_ROWS);
    const sections: SessionSection<SessionItem>[] = [
      {
        key: 'human_pending',
        label: 'Human decisions',
        items: humanPending,
        hint: 'read decisions and questions with exec_ledger_status',
      },
      {
        key: 'journal_unknown',
        label: 'Unsettled actions',
        items: journals.rows,
        hint: 'inspect, then use journal_done or journal_fail; reconcile with exec_ledger_reconcile',
      },
      {
        key: 'blocking_open_items',
        label: 'Blocking items',
        items: openItems.rows,
        hint: 'read the rest with ledger_list_open',
      },
      {
        key: 'stale_facts_and_revisits',
        label: 'Stale facts / revisits',
        items: staleAndRevisited,
        hint: 'read fact and decision details with exec_ledger_status',
      },
      {
        key: 'uncovered_requirements',
        label: 'Uncovered requirements',
        items: requirementItems,
        hint: 'read the rest with req_coverage',
      },
      {
        key: 'tasks',
        label: 'Active tasks',
        items: tasks.rows,
        hint: 'read the task tree with exec_plan_view',
      },
    ];
    const unassigned = coverage.unassigned.slice(0, 10);
    const recent = events.rows.slice(0, RECENT_UNBLOCK_LIMIT);
    const context: Record<string, unknown> = {
      project_id: projectId,
      uncovered_requirements: unassigned,
      uncovered_requirement_count: coverage.unassigned.length,
      recently_unblocked: recent,
      recently_unblocked_limit: RECENT_UNBLOCK_LIMIT,
      since,
      ...(coverage.unassigned.length
        ? { needed_action: 'assign every unassigned active requirement, then link a checkable criterion with req_link_task' }
        : {}),
    };
    output = packSession(sections, { maxBytes, context });
  });

  return output;
}
