import { sql } from 'kysely';
import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { toJsonb } from '../jsonb';
import { appendEvent } from './events';
import { loadGateContext } from './gate-context';
import { recordHumanDecision } from './approvals';
import { findTaskByRef, type LedgerActor } from './open-items-service';
import { matchPathGlob, scopeIssueRef, type ChangedFile } from './scope';
import { inspectFactEvidence } from './fact-evidence';
import type { ExecFactFileSource } from './review-source';

/**
 * The human's two "this is how it is now" verbs (plan §9.5): widen a task's
 * scope, and promote a guess into a fact.
 *
 * Both are edits an agent must never make for itself:
 *
 *   • the SCOPE of a task is a promise about which files it may touch. The
 *     agent may not widen its own footprint — it files a scope-expansion
 *     question (`ledger_ask_human`, kind `scope_expansion`) and a human
 *     decides. PE-8 measures the real diff (Git or a server-captured manifest)
 *     and materializes any remaining out-of-scope finding for that human.
 *
 *   • a FACT is knowledge the project may rely on. A guess (`agent_guess`) is
 *     not knowledge, and the schema says so: `CHECK (kind <> 'fact' OR source
 *     <> 'agent_guess')` — a guess can never BE a fact. Promotion is the
 *     human saying "this is true now, and here is where it came from", and
 *     the source has to be one the ledger can check later.
 */

const MIN_REASON = 10;
const FACT_SOURCES = ['human', 'code', 'docs', 'tool_output'] as const;
export type PromotionSource = (typeof FACT_SOURCES)[number];

export interface ScopeExpansionResult {
  kind: 'scope';
  task_code: string;
  allowed_paths: string[];
  added_paths: string[];
  reason: string;
}

export interface ScopeWaiverResult {
  kind: 'scope_waiver';
  task_id: string;
  task_code: string;
  approval_id: string;
  reason: string;
}

export interface FactPromotionResult {
  kind: 'fact';
  code: string;
  key: string;
  source: PromotionSource;
  source_ref: string | null;
  verified_at: string;
  reason: string;
}

function assertHuman(actor: LedgerActor): void {
  if (actor.actorType !== 'human') {
    throw new AppError('FORBIDDEN', 'only a human may widen a scope or promote a fact', {
      needed_action: 'ask the human (ledger_ask_human) — the ledger records who decided, and that is not the agent',
    });
  }
}

function checkReason(reason: string): string {
  const text = (reason ?? '').trim();
  if (text.length < MIN_REASON) {
    throw new AppError('VALIDATION_ERROR', `the reason is too short (${text.length} characters)`, {
      needed_action: 'write what changed and why — a scope the agent widened by itself is not a scope',
    });
  }
  return text;
}

/**
 * Widen the set of paths a task may touch.
 *
 * The paths are a UNION, not a replacement: a human who adds one directory to
 * a task's scope does not silently take the others away.
 */
export async function expandTaskScope(
  db: DbLike,
  actor: LedgerActor,
  taskRef: string,
  paths: string[],
  reason: string,
): Promise<ScopeExpansionResult> {
  assertHuman(actor);
  const text = checkReason(reason);
  const wanted = (paths ?? []).map((p) => (p ?? '').trim()).filter((p) => p.length > 0);
  if (!wanted.length) {
    throw new AppError('VALIDATION_ERROR', 'no path was given', {
      needed_action: 'name the paths the task may now touch (globs, one per entry)',
    });
  }
  for (const path of wanted) {
    if (path.length > 200) {
      throw new AppError('VALIDATION_ERROR', `a path is too long: ${path.slice(0, 40)}…`, {
        needed_action: 'a scope entry is at most 200 characters',
      });
    }
  }

  const task = await findTaskByRef(db, actor, taskRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`, { ref: taskRef });
  if (task.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`, {
      needed_action: 'a closed task keeps the scope it was closed with; open a new task for new work',
    });
  }

  const row = await sql<{ allowed_paths: unknown }>`
    SELECT allowed_paths FROM exec_tasks WHERE id = ${task.id}::uuid
  `.execute(db as never);
  const current = Array.isArray(row.rows[0]?.allowed_paths) ? (row.rows[0].allowed_paths as string[]) : [];
  const merged = [...current];
  const added: string[] = [];
  for (const path of wanted) {
    if (merged.includes(path)) continue;
    merged.push(path);
    added.push(path);
  }

  await sql`
    UPDATE exec_tasks
    SET allowed_paths = ${toJsonb(merged) as never}::jsonb, updated_at = now()
    WHERE id = ${task.id}::uuid
  `.execute(db as never);

  // The human's decision is a row in the queue too: an auditor must be able
  // to walk from "the task may touch this path" back to the person who said so.
  await recordHumanDecision(db, {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    actorId: actor.actorId,
    action: 'exec.scope_expansion',
    payload: { task_id: task.id, task_code: task.code, added_paths: added, allowed_paths: merged },
    reason: text,
  });

  // A human expansion resolves only code-created out-of-scope findings that
  // are now covered by the approved globs. Deletions remain separate explicit
  // approvals and are never cleared by merely widening the path list.
  await resolveCoveredScopeFindings(db, actor, task.id, merged, text);

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'task',
    entity_id: task.id,
    entity_code: task.code,
    action: 'scope.expanded',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { allowed_paths: current },
      after: { allowed_paths: merged, added_paths: added, reason: text },
    },
  });

  return {
    kind: 'scope',
    task_code: task.code,
    allowed_paths: merged,
    added_paths: added,
    reason: text,
  };
}

async function resolveCoveredScopeFindings(
  db: DbLike,
  actor: LedgerActor,
  taskId: string,
  allowed: string[],
  reason: string,
): Promise<void> {
  const rows = await db
    .selectFrom('exec_open_items')
    .select(['id', 'code', 'title', 'detail', 'status', 'resolution_note', 'resolved_by', 'related_ref'])
    .where('task_id', '=', taskId)
    .where('source', '=', 'hook')
    .where('type', '=', 'out_of_scope')
    .where('status', 'in', ['open', 'blocked', 'awaiting_human'])
    .execute();

  for (const row of rows) {
    const issue = scopeIssueDetails(row.detail);
    if (!issue || issue.change === 'D' || !allowed.some((glob) => matchPathGlob(glob, issue.path))) continue;
    if (row.related_ref !== scopeIssueRef(issue.path, issue.change)) continue;
    const note = `human-approved scope expansion covers ${issue.path}: ${reason}`.slice(0, 2000);
    await db
      .updateTable('exec_open_items')
      .set({ status: 'resolved', resolution_note: note, resolved_by: 'human', updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    await appendEvent(db, {
      organization_id: actor.organizationId,
      task_id: taskId,
      entity: 'open_item',
      entity_id: row.id,
      entity_code: row.code,
      action: 'open_item.closed',
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      tool: actor.tool ?? null,
      payload: {
        before: { status: row.status, resolution_note: row.resolution_note, resolved_by: row.resolved_by },
        after: { status: 'resolved', resolution_note: note, resolved_by: 'human' },
      },
    });
  }
}

function scopeIssueDetails(detail: string | null): { path: string; change: ChangedFile['status'] } | null {
  if (!detail) return null;
  try {
    const value = JSON.parse(detail) as Record<string, unknown>;
    const path = value.path;
    const change = value.change;
    if (
      typeof path === 'string' &&
      (change === 'A' || change === 'M' || change === 'D' || change === 'R' || change === 'T')
    ) {
      return { path, change };
    }
    return null;
  } catch {
    return null;
  }
}

/** An auditable human exception for a scope source that cannot be measured. */
export async function waiveScopeMeasurement(
  db: DbLike,
  actor: LedgerActor,
  taskRef: string,
  reason: string,
): Promise<ScopeWaiverResult> {
  assertHuman(actor);
  const text = checkReason(reason);
  const task = await findTaskByRef(db, actor, taskRef);
  if (!task) throw new AppError('NOT_FOUND', `no task '${taskRef}' in this project`, { ref: taskRef });
  if (task.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`, {
      needed_action: 'a closed task keeps the scope decision it was closed with; open a new task for new work',
    });
  }
  const { ctx } = await loadGateContext(db, task.id);
  if (ctx.scope.available) {
    throw new AppError('LEDGER_STATE_INVALID', 'scope is measurable and cannot be waived', {
      needed_action: 'resolve any measured out-of-scope findings through a human scope expansion, or fix the changes; a scope-measurement waiver is only for unavailable measurement',
    });
  }

  const approvalId = await recordHumanDecision(db, {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    actorId: actor.actorId,
    action: 'exec.scope_waive',
    payload: { task_id: task.id, task_code: task.code, reason: text },
    reason: text,
    risk: 'sensitive',
  });
  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: task.id,
    entity: 'task',
    entity_id: task.id,
    entity_code: task.code,
    action: 'scope.waived',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: { waiver: `scope:${task.code}`, task_id: task.id, approval_id: approvalId, reason: text },
  });
  return { kind: 'scope_waiver', task_id: task.id, task_code: task.code, approval_id: approvalId, reason: text };
}

/**
 * Promote a guess into a fact.
 *
 * The human has to say where the knowledge came from, and the ledger keeps
 * that answer: a fact whose source is `code` or `tool_output` must name the
 * ref (`CHECK` on the table), and a `human` source must still carry the
 * reason, because "a human said so" is the weakest possible source and has
 * to be written down.
 */
export async function promoteFact(
  db: DbLike,
  actor: LedgerActor,
  code: string,
  input: { source?: string; source_ref?: string; reason: string },
  fileSource: ExecFactFileSource | null = null,
): Promise<FactPromotionResult> {
  assertHuman(actor);
  const text = checkReason(input.reason);
  const source = (input.source ?? 'human') as PromotionSource;
  if (!FACT_SOURCES.includes(source)) {
    throw new AppError('VALIDATION_ERROR', `unknown source '${source}'`, {
      needed_action: `the source is one of ${FACT_SOURCES.join(', ')}`,
    });
  }
  const sourceRef = (input.source_ref ?? '').trim() || null;

  const rows = await sql<{
    id: string;
    code: string;
    key: string;
    kind: string;
    status: string;
    project_id: string;
    source: string;
    files: unknown;
  }>`
    SELECT id::text AS id, code, key, kind, status, project_id::text AS project_id, source, files
    FROM exec_facts
    WHERE organization_id = ${actor.organizationId}::uuid AND project_id = ${actor.projectId}::uuid
      AND (code = ${code} OR id::text = ${code})
    LIMIT 1
  `.execute(db as never);
  const fact = rows.rows[0];
  if (!fact) throw new AppError('NOT_FOUND', `no fact '${code}' in this organisation`, { ref: code });
  if (fact.status !== 'active') {
    throw new AppError('LEDGER_STATE_INVALID', `fact ${fact.code} is ${fact.status}`, {
      needed_action: 'a fact that is stale, rejected or superseded keeps its state; record a new one',
    });
  }
  if (fact.kind === 'fact') {
    throw new AppError('LEDGER_STATE_INVALID', `fact ${fact.code} is already a fact`, {
      needed_action: 'there is nothing to promote — supersede it with a new fact if it changed',
    });
  }

  const clash = await sql<{ code: string }>`
    SELECT code FROM exec_facts
    WHERE project_id = ${fact.project_id}::uuid AND key = ${fact.key} AND status = 'active'
      AND id <> ${fact.id}::uuid
    LIMIT 1
  `.execute(db as never);
  if (clash.rows[0]) {
    throw new AppError('CONFLICT', `another active fact already holds the key '${fact.key}'`, {
      ref: clash.rows[0].code,
      needed_action: 'supersede the older fact first — two active facts with one key is a coin flip',
    });
  }

  const storedFiles = Array.isArray(fact.files) ? (fact.files as unknown[]).filter((path): path is string => typeof path === 'string') : [];
  const evidence = await inspectFactEvidence(
    db,
    actor,
    {
      source,
      sourceRef,
      files: storedFiles,
      requireSourceRef: source === 'code' || source === 'tool_output',
      requireCodeFiles: source === 'code',
    },
    fileSource,
  );
  const verifiedAt = new Date();
  await sql`
    UPDATE exec_facts
    SET kind = 'fact', source = ${source}, source_ref = ${sourceRef},
        files = ${toJsonb(evidence.files) as never}::jsonb,
        file_hashes = ${toJsonb(evidence.fileHashes) as never}::jsonb,
        verified_at = ${verifiedAt}, status = 'active'
    WHERE id = ${fact.id}::uuid
  `.execute(db as never);

  await recordHumanDecision(db, {
    organizationId: actor.organizationId,
    projectId: actor.projectId,
    actorId: actor.actorId,
    action: 'exec.fact_promotion',
    payload: { fact_id: fact.id, code: fact.code, key: fact.key, source, source_ref: sourceRef },
    reason: text,
  });

  await appendEvent(db, {
    organization_id: actor.organizationId,
    task_id: null,
    entity: 'fact',
    entity_id: fact.id,
    entity_code: fact.code,
    action: 'fact.promoted',
    actor_type: actor.actorType,
    actor_id: actor.actorId,
    tool: actor.tool ?? null,
    payload: {
      before: { kind: fact.kind, source: fact.source, status: fact.status },
      after: { kind: 'fact', source, source_ref: sourceRef, verified_at: verifiedAt.toISOString(), reason: text },
    },
  });

  return {
    kind: 'fact',
    code: fact.code,
    key: fact.key,
    source,
    source_ref: sourceRef,
    verified_at: verifiedAt.toISOString(),
    reason: text,
  };
}
