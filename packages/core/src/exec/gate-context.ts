import type { ExecPolicy } from '@forgepm/shared';
import { AppError } from '@forgepm/shared';
import type { DbLike } from '../db/unitOfWork';
import { getEffective } from '../settings';
import { resolveExecReviewSource } from './review-source';
import { diffScopeManifest, makeScopeManifest, type ChangedFile, type ScopeFileManifest } from './scope';
import { EXEC_POLICY_DEFAULT, GATE_VERSION } from './policy';
import {
  asStringArray,
  toBaseline,
  toCriteria,
  toDecisions,
  toFacts,
  toOpenItems,
  toQuestions,
  toReport,
  toRequirements,
  toReview,
  toScope,
  toTask,
} from './gate-mappers';
import type { GateContext, GateStamp } from './gate-types';

/**
 * The gate's snapshot loader (docs/EXECUTION_CONTROL_PLAN.md §8.2).
 *
 * Everything the thirteen rules read comes from here, and everything here is
 * read out of the ledger — the gate never trusts the agent's prose about its
 * own state. The loader is deliberately *boring*: no rule logic, no
 * judgement, just "what does the database say right now".
 *
 * Scope is measured by a read-only Git diff from a server-captured start_ref,
 * or a hash-only server-captured manifest when Git is unavailable. Agent-submitted
 * `changed_files` are never a scope input. Baseline loading remains separate:
 * only the CI-log capture path may supply test data.
 */

export const TREE_HASH_UNMEASURED = 'unmeasured';

export interface GateContextOptions {
  /** The report the caller is closing on; the newest one otherwise. */
  reportId?: string | null;
}

export interface LoadedGate {
  ctx: GateContext;
  task_id: string;
  organization_id: string;
  project_id: string;
  report_id: string | null;
  report_payload: Record<string, unknown> | null;
  /** Roots used by the same read-only adapter for close-time hash snapshots. */
  review_roots: string[];
  allowed_paths: string[];
}

export async function loadGateContext(
  db: DbLike,
  taskId: string,
  options: GateContextOptions = {},
): Promise<LoadedGate> {
  const task = await db.selectFrom('exec_tasks').selectAll().where('id', '=', taskId).executeTakeFirst();
  if (!task) throw new Error(`task ${taskId} not found`);

  const org = task.organization_id;
  const project = task.project_id;

  const [
    criteria,
    evidence,
    items,
    decisions,
    questions,
    facts,
    journal,
    reviews,
    reports,
    baselineRows,
    children,
    deps,
    waiverEvents,
  ] = await Promise.all([
    db.selectFrom('exec_criteria').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_evidence').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_open_items').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_decisions').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_questions').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_facts').selectAll().where('project_id', '=', project).execute(),
    db.selectFrom('exec_action_journal').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_reviews').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_reports').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_baseline_tests').selectAll().where('task_id', '=', taskId).execute(),
    db.selectFrom('exec_tasks').selectAll().where('parent_id', '=', taskId).execute(),
    db.selectFrom('exec_task_deps').selectAll().where('task_id', '=', taskId).execute(),
    db
      .selectFrom('exec_events')
      .selectAll()
      .where('task_id', '=', taskId)
      .where('action', 'in', ['task.waived', 'scope.waived', 'scope.manifest_captured', 'baseline.waived', 'baseline.start_captured', 'baseline.captured'])
      .execute(),
  ]);

  const factIds = facts.map((f) => f.id);
  // A requirement is linked to a task through the criteria that name it, not
  // through a table of its own: D-049 #2 — `req_ids` declares, and coverage
  // is a property of a LINKED criterion. So the link is `exec_criteria.req_id`.
  const reqLinks = criteria
    .filter((c) => c.req_id)
    .map((c) => ({ req_id: c.req_id as string, task_id: taskId, criterion_ids: [c.id] }));
  const reqIds = [...new Set(reqLinks.map((l) => l.req_id))];
  const depIds = deps.map((d) => d.depends_on_task_id);
  const [factDecisions, requirements, depTasks] = await Promise.all([
    factIds.length
      ? db.selectFrom('exec_fact_decisions').selectAll().where('fact_id', 'in', factIds).execute()
      : Promise.resolve([]),
    reqIds.length
      ? db.selectFrom('exec_requirements').selectAll().where('id', 'in', reqIds).execute()
      : Promise.resolve([]),
    depIds.length ? db.selectFrom('exec_tasks').selectAll().where('id', 'in', depIds).execute() : Promise.resolve([]),
  ]);

  const baselineEvents = waiverEvents.filter((event) => event.action === 'baseline.waived' && event.actor_type === 'human');
  const baselineWaiverIds = baselineEvents
    .map((event) => stringField(event.payload, 'approval_id'))
    .filter((id): id is string => id !== null);
  const approvedBaselineWaivers = baselineWaiverIds.length
    ? await db
        .selectFrom('approval_requests')
        .select(['id', 'payload', 'decided_by'])
        .where('organization_id', '=', org)
        .where('id', 'in', baselineWaiverIds)
        .where('action', '=', 'exec.baseline_waive')
        .where('status', '=', 'approved')
        .execute()
    : [];
  const verifiedBaselineEvents = baselineEvents.filter((event) =>
    approvedBaselineWaivers.some(
      (approval) =>
        approval.id === stringField(event.payload, 'approval_id') &&
        approval.decided_by === event.actor_id &&
        stringField(approval.payload, 'task_id') === taskId,
    ),
  );
  const humanBaselineWaived = verifiedBaselineEvents.length > 0;
  const scopeEvents = waiverEvents.filter((event) => event.action === 'scope.waived' && event.actor_type === 'human');
  const scopeWaiverIds = scopeEvents
    .map((event) => stringField(event.payload, 'approval_id'))
    .filter((id): id is string => id !== null);
  const approvedScopeWaivers = scopeWaiverIds.length
    ? await db
        .selectFrom('approval_requests')
        .select(['id', 'payload', 'decided_by'])
        .where('organization_id', '=', org)
        .where('id', 'in', scopeWaiverIds)
        .where('action', '=', 'exec.scope_waive')
        .where('status', '=', 'approved')
        .execute()
    : [];
  const verifiedScopeEvents = scopeEvents.filter((event) =>
    approvedScopeWaivers.some(
      (approval) =>
        approval.id === stringField(event.payload, 'approval_id') &&
        approval.decided_by === event.actor_id &&
        stringField(approval.payload, 'task_id') === taskId,
    ),
  );
  const humanScopeWaived = verifiedScopeEvents.length > 0;
  const taskWaiverEvents = waiverEvents
    .filter((event) => event.action === 'task.waived' && event.actor_type === 'human')
    .concat(verifiedScopeEvents, verifiedBaselineEvents);

  // R-04: waiver fatigue counter — baseline waivers in last 30d across project (via task's project)
  const projectTaskIds = await db.selectFrom('exec_tasks').select('id').where('project_id', '=', project).execute();
  const waiverCount30d = projectTaskIds.length
    ? await db
        .selectFrom('exec_events')
        .select((eb) => eb.fn.count<number>('id').as('count'))
        .where('organization_id', '=', org)
        .where('task_id', 'in', projectTaskIds.map((r) => r.id))
        .where('action', '=', 'baseline.waived')
        .where('created_at', '>', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
        .executeTakeFirst()
    : { count: 0 };
  const baselineWaivers30d = Number(waiverCount30d?.count ?? 0);
  const baselineWaiverThreshold = 3; // configurable via exec.baseline_waiver_threshold later

  const reportRow =
    reports.find((r) => r.id === options.reportId) ??
    [...reports].sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1))[0] ??
    null;
  if (options.reportId && !reports.some((r) => r.id === options.reportId)) {
    throw new AppError('NOT_FOUND', `no exit report '${options.reportId}' for task ${task.code}`, {
      ref: options.reportId,
      needed_action: 'the gate closes on a report of this task; list them with exec_ledger_status',
    });
  }
  const reportPayload = (reportRow?.payload ?? null) as Record<string, unknown> | null;
  const report = toReport(reportPayload);

  const policy = await loadPolicy(db, org, project);
  const requireReview = await loadBool(db, 'exec.require_review_for_done', org, project, true);
  // PE-7 is deliberately capped at two rounds even if an old/hand-written
  // setting bypassed the current schema validator.
  const maxReviewRounds = Math.min(2, Math.max(1, await loadNumber(db, 'exec.max_review_rounds', org, project, 2)));
  const reviewRootsSetting = await getEffective(db, 'exec.allowed_repo_roots', org, project);
  const reviewRoots = Array.isArray(reviewRootsSetting?.value) ? (reviewRootsSetting.value as string[]) : [];
  const source = resolveExecReviewSource();
  let currentTreeHash: string | null = null;
  if (reviews.length && task.start_ref && reviewRoots.length && source) {
    try {
      currentTreeHash = await source.treeHash({ roots: reviewRoots });
    } catch {
      // Missing/unreadable source is represented as unmeasurable, never as a
      // matching hash. Rule 7 will fail closed for an existing review.
      currentTreeHash = null;
    }
  }

  let currentSha: string | null = null;
  if (source?.headSha && source.isWorktreeClean) {
    try {
      const [sha, clean] = await Promise.all([source.headSha(), source.isWorktreeClean()]);
      if (clean && /^[0-9a-f]{40,64}$/i.test(sha)) currentSha = sha.toLowerCase();
    } catch {
      currentSha = null;
    }
  }

  let changedFiles: ChangedFile[] | null = null;
  let scopeUnavailableReason: string | null = null;
  let currentScopeHash: string | null = null;
  let scopeBasis: 'git' | 'manifest' = 'git';
  if (task.start_ref) {
    if (!source?.changedFiles) {
      scopeUnavailableReason = 'no read-only Git diff source is configured';
    } else {
      try {
        changedFiles = await source.changedFiles({ start_ref: task.start_ref });
      } catch (error) {
        scopeUnavailableReason = error instanceof Error ? error.message : 'Git diff source could not measure scope';
      }
    }
  } else {
    const startManifest = capturedScopeManifest(waiverEvents);
    if (!startManifest) {
      scopeUnavailableReason = 'task has no valid server-captured start commit or file manifest';
    } else if (!source?.fileManifest) {
      scopeUnavailableReason = 'no read-only file manifest source is configured';
    } else {
      try {
        const currentManifest = await source.fileManifest();
        changedFiles = diffScopeManifest(startManifest, currentManifest);
        currentScopeHash = currentManifest.hash;
        scopeBasis = 'manifest';
      } catch (error) {
        scopeUnavailableReason = error instanceof Error ? error.message : 'file manifest source could not measure scope';
      }
    }
  }

  const measuredScope = toScope(
    changedFiles,
    task.allowed_paths as unknown,
    scopeUnavailableReason,
    currentScopeHash,
    humanScopeWaived,
    scopeBasis,
  );
  const ctx: GateContext = {
    gate_version: GATE_VERSION,
    policy,
    require_review: requireReview,
    max_review_rounds: maxReviewRounds,
    baselineWaivers30d,
    baselineWaiverThreshold,
    task: toTask(task, children, deps, depTasks, taskWaiverEvents),
    criteria: toCriteria(criteria, evidence),
    open_items: toOpenItems(items),
    decisions: toDecisions(decisions),
    questions: toQuestions(questions),
    facts: toFacts(facts, factDecisions, decisions),
    requirements: toRequirements(requirements, reqLinks, criteria),
    journal: journal.map((j) => ({
      code: j.code,
      action: j.action,
      status: j.status,
      idempotent: j.idempotent,
      target: j.target,
    })),
    review: toReview(reviews),
    current_tree_hash: currentTreeHash,
    scope: measuredScope,
    baseline: toBaseline(baselineRows, waiverEvents, task.start_ref, currentSha, humanBaselineWaived),
    report,
    report_assumptions: asStringArray(reportPayload?.assumptions),
    stamp: await loadStamp(db, taskId, reportRow?.id ?? null),
  };

  return {
    ctx,
    task_id: task.id,
    organization_id: org,
    project_id: project,
    report_id: reportRow?.id ?? null,
    report_payload: reportPayload,
    review_roots: reviewRoots,
    allowed_paths: asStringArray(task.allowed_paths),
  };
}

export async function loadStamp(db: DbLike, taskId: string, reportId: string | null): Promise<GateStamp> {
  const rows = await db.selectFrom('exec_gate_checks').selectAll().where('task_id', '=', taskId).execute();
  const scoped = reportId ? rows.filter((r) => r.report_id === reportId) : rows;
  // `id` is the tie-breaker: ids carry their creation timestamp, so the order is
  // the order the stamps were written in, even inside the same millisecond.
  const newest = [...scoped].sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1),
  )[0];
  if (!newest) return { stamp_id: null, ok: false, tree_hash: null, gate_version: GATE_VERSION };
  return {
    stamp_id: newest.id,
    ok: newest.ok,
    tree_hash: newest.tree_hash,
    gate_version: newest.gate_version,
  };
}

function capturedScopeManifest(
  events: readonly {
    action: string;
    actor_type: string;
    actor_id: string | null;
    tool: string | null;
    payload: unknown;
  }[],
): ScopeFileManifest | null {
  const event = events.find(
    (row) =>
      row.action === 'scope.manifest_captured' &&
      row.actor_type === 'system' &&
      row.actor_id === 'exec-scope-manifest' &&
      row.tool === 'exec_task_start',
  );
  if (!event) return null;
  const payload = objectRecord(event.payload);
  const files = payload?.files;
  if (payload?.version !== 1 || typeof payload.hash !== 'string' || !Array.isArray(files) || files.length > 10_000) {
    return null;
  }
  const entries: { path: string; sha256: string }[] = [];
  for (const value of files) {
    const entry = objectRecord(value);
    if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string') return null;
    entries.push({ path: entry.path, sha256: entry.sha256 });
  }
  try {
    const manifest = makeScopeManifest(entries);
    return manifest.hash === payload.hash.toLowerCase() ? manifest : null;
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function loadPolicy(db: DbLike, org: string, project: string): Promise<ExecPolicy> {
  const eff = await getEffective(db, 'exec.policy', org, project);
  const value = eff?.value as ExecPolicy | undefined;
  return value ?? EXEC_POLICY_DEFAULT;
}

async function loadBool(db: DbLike, key: string, org: string, project: string, fallback: boolean): Promise<boolean> {
  const eff = await getEffective(db, key, org, project);
  return typeof eff?.value === 'boolean' ? eff.value : fallback;
}

async function loadNumber(db: DbLike, key: string, org: string, project: string, fallback: number): Promise<number> {
  const eff = await getEffective(db, key, org, project);
  return typeof eff?.value === 'number' ? eff.value : fallback;
}

function stringField(value: unknown, key: string): string | null {
  let record: Record<string, unknown> | null = null;
  if (value && typeof value === 'object' && !Array.isArray(value)) record = value as Record<string, unknown>;
  else if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const field = record?.[key];
  return typeof field === 'string' ? field : null;
}
