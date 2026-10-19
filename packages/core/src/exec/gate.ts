import { newId } from '../id';
import type { DbLike } from '../db/unitOfWork';
import { toJsonb } from '../jsonb';
import { detectGateStampDrift } from './drift';
import { GATE_RULES } from './gate-rules';
import { TREE_HASH_UNMEASURED, loadGateContext } from './gate-context';
import { GATE_VERSION, classify } from './policy';
import { resolveExecReviewSource } from './review-source';
import { restrictScopeManifest } from './scope';
import { blockingOpen } from './open-items';
import type { BlockedRef, FinalReport, GateContext } from './gate-types';

export { GATE_RULES, GATE_RULE_NUMBERS } from './gate-rules';
export type {
  BlockedRef,
  FinalReport,
  GateBaseline,
  GateContext,
  GateCriterion,
  GateDecision,
  GateFact,
  GateOpenItem,
  GateQuestion,
  GateReport,
  GateRequirement,
  GateReview,
  GateScope,
  GateStamp,
  GateTask,
  Rule,
} from './gate-types';

/**
 * The finalization gate (docs/EXECUTION_CONTROL_PLAN.md §8).
 *
 * The gate answers one question — "may this task be closed?" — and it answers
 * it from the ledger, never from the agent's prose. The thirteen rules live in
 * `gate-rules/`, one file each, so a rule can be read, argued about and
 * changed without touching the other twelve; this file is the orchestrator:
 * it loads the snapshot, runs the rules, writes the stamp and says what the
 * status should become.
 */

export interface GateResult {
  ok: boolean;
  gate_version: number;
  tree_hash: string | null;
  blocked_by: BlockedRef[];
  counts?: {
    criteria: number;
    evidence: number;
    decisions: number;
    reviews: number;
  };
  human_waivers?: string[];
  /**
   * On success: the completion report, composed from the very snapshot the
   * gate judged (plan §8.2's `GateResult = {ok:true, finalReport}`). The DB
   * loader `buildFinalReport(tx, taskId)` renders the same thing from the
   * rows; both come from the ledger, never from the agent's message.
   */
  final_report?: FinalReport;
}

/** Run all thirteen rules over one snapshot. Pure: same ctx in, same answer out. */
export function evaluateGate(ctx: GateContext): GateResult {
  const blocked: BlockedRef[] = [];
  // gate_version is a public contract: a stale caller must not silently pass.
  if (ctx.gate_version !== GATE_VERSION) {
    return {
      ok: false,
      gate_version: GATE_VERSION,
      tree_hash: ctx.current_tree_hash,
      blocked_by: [
        {
          rule: 0,
          ref: 'gate_version',
          title: 'the caller and the gate disagree about the gate version',
          needed: `caller gate_version ${ctx.gate_version} != engine ${GATE_VERSION}`,
          tool_to_call: 'exec_task_complete',
        },
      ],
    };
  }
  // C.9b — a task that claims to be done but has no passing stamp is drift.
  // It is checked before the rules so the drift is never hidden behind a
  // rule that happens to be unhappy about something else.
  const drift = stampDrift(ctx);
  if (drift) blocked.push(drift);
  for (const rule of GATE_RULES) blocked.push(...rule.run(ctx));
  if (blocked.length) {
    return { ok: false, gate_version: GATE_VERSION, tree_hash: ctx.current_tree_hash, blocked_by: blocked };
  }
  return {
    ok: true,
    gate_version: GATE_VERSION,
    tree_hash: ctx.current_tree_hash,
    blocked_by: [],
    final_report: composeFinalReport(ctx),
    counts: {
      criteria: ctx.criteria.length,
      evidence: ctx.criteria.reduce((a, c) => a + c.valid_evidence_count, 0),
      decisions: ctx.decisions.length,
      reviews: ctx.review ? ctx.review.round : 0,
    },
    human_waivers: ctx.task.human_waivers,
  };
}

/**
 * C.9b — the drift between "the task says done" and "the gate says so".
 *
 * `exec_task_complete` is the only path to `status='done'`, so a task in that
 * state without a passing stamp was closed by hand (or by a bug). Both the
 * gate and `exec_ledger_status` report it with the same words.
 */
export function stampDrift(ctx: GateContext): BlockedRef | null {
  const drift = detectGateStampDrift({
    status: ctx.task.status,
    stamp: ctx.stamp?.stamp_id ? { ok: ctx.stamp.ok, stamp_id: ctx.stamp.stamp_id } : null,
  });
  if (!drift) return null;
  return {
    rule: 0,
    ref: drift,
    title: 'the ledger and the board disagree about this task',
    needed:
      'the task claims to be done but the gate never passed for it — run exec_task_complete so the ledger can stamp it',
    tool_to_call: 'exec_task_complete',
  };
}

/**
 * Status after a failed gate: anything the human must touch => awaiting_review,
 * otherwise the task stays in progress. Pure + tested (acceptance §C).
 */
export function deriveStatusAfterFailure(
  ctx: GateContext,
  blocked: BlockedRef[],
): 'in_progress' | 'awaiting_review' | 'blocked' {
  const humanRules = new Set([4, 5, 7, 9, 11, 12]);
  if (blocked.some((b) => humanRules.has(b.rule))) return 'awaiting_review';
  if (ctx.task.status === 'blocked') return 'blocked';
  return 'in_progress';
}

/**
 * The status a task gets after a gate run. Pure (acceptance §C): the only
 * way to `done` is a gate that said `ok`.
 */
export function deriveStatus(
  ctx: GateContext,
  outcome: { ok: boolean; blocked_by: BlockedRef[] },
): 'done' | 'in_progress' | 'awaiting_review' | 'blocked' {
  if (outcome.ok) return 'done';
  return deriveStatusAfterFailure(ctx, outcome.blocked_by);
}

// ------------------------------------------------------------- the DB-backed gate

export interface RunGateOptions {
  /** The report the caller closes on; the newest one otherwise. */
  reportId?: string | null;
  /** Who asked for the gate run — recorded in the stamp's `run_source`. */
  actorType?: 'agent' | 'human' | 'system';
  runSource?: string;
}

export interface RunGateResult {
  ok: boolean;
  blocked_by: BlockedRef[];
  gate_version: number;
  tree_hash: string;
  /**
   * The stamp's id — or null when the gate had no report to stamp. The
   * ledger's schema makes `exec_gate_checks.report_id` a NOT NULL foreign key
   * (a stamp always belongs to a report), so an evaluation of a task that has
   * no report yet leaves an event instead of a row. See `runGate`.
   */
  stamp_id: string | null;
  report_id: string | null;
  status: 'done' | 'in_progress' | 'awaiting_review' | 'blocked';
}

/**
 * Run the gate against the ledger and WRITE THE STAMP before answering.
 *
 * The stamp (`exec_gate_checks`) is the proof that the gate ran: which report
 * it looked at, what it blocked on, which gate version decided, and the tree
 * it measured. It is written even when the gate fails — a refused close is
 * evidence too, and without it a failed attempt would be invisible.
 *
 * The one exception is a task with no exit report at all. The schema says a
 * stamp references a report (`report_id` is NOT NULL and a foreign key), so
 * there is nothing to point the row at: rule 1 refuses the close and the
 * refusal is recorded as an event. The answer is the same, and the ledger
 * does not grow a row that pretends a report exists.
 */
export async function runGate(tx: DbLike, taskId: string, options: RunGateOptions = {}): Promise<RunGateResult> {
  const loaded = await loadGateContext(tx, taskId, { reportId: options.reportId ?? null });
  const result = evaluateGate(loaded.ctx);
  const treeHash = loaded.ctx.current_tree_hash ?? TREE_HASH_UNMEASURED;
  const stampId = loaded.report_id ? newId() : null;
  let closeFileManifest: Record<string, unknown> | null = null;
  if (result.ok && loaded.review_roots.length && loaded.allowed_paths.length) {
    const source = resolveExecReviewSource();
    if (source?.fileSnapshot) {
      try {
        const snapshot = await source.fileSnapshot({ roots: loaded.review_roots });
        const scopedSnapshot = restrictScopeManifest(snapshot, loaded.allowed_paths);
        closeFileManifest = { ...scopedSnapshot, roots: loaded.review_roots, allowed_paths: loaded.allowed_paths };
      } catch {
        // Gate remains governed by its existing rules; reconciliation reports
        // that the close-time file snapshot was unavailable rather than
        // claiming a clean tree.
        closeFileManifest = null;
      }
    }
  }
  if (stampId && loaded.report_id) {
    await tx
      .insertInto('exec_gate_checks')
      .values({
        id: stampId,
        organization_id: loaded.organization_id,
        task_id: taskId,
        report_id: loaded.report_id,
        ok: result.ok,
        blocked_by: toJsonb(result.blocked_by) as never,
        gate_version: result.gate_version,
        tree_hash: treeHash,
        run_source: options.runSource ?? options.actorType ?? 'none',
        file_manifest: closeFileManifest ? (toJsonb(closeFileManifest) as never) : null,
      })
      .execute();
    // The report learns the verdict: a report nobody judged is still 'submitted'.
    await tx
      .updateTable('exec_reports')
      .set({ status: result.ok ? 'gate_passed' : 'gate_failed', updated_at: new Date() })
      .where('id', '=', loaded.report_id)
      .execute();
  }
  return {
    ok: result.ok,
    blocked_by: result.blocked_by,
    gate_version: result.gate_version,
    tree_hash: treeHash,
    stamp_id: stampId,
    report_id: loaded.report_id,
    status: deriveStatus(loaded.ctx, { ok: result.ok, blocked_by: result.blocked_by }),
  };
}

/**
 * The gate, asked without closing anything (plan §9.5 — the human's dry run).
 *
 * A human asks "may this task close?" before anybody tries. The answer has to
 * be the SAME answer the gate would give — so it runs the same rules over the
 * same snapshot — but it must leave nothing behind: a dry run writes no
 * stamp, no report status and no event. A gate check that leaves a trace is
 * not a dry run, it is a second attempt.
 */
export async function dryRunGate(tx: DbLike, taskId: string): Promise<RunGateResult> {
  const loaded = await loadGateContext(tx, taskId, {});
  const result = evaluateGate(loaded.ctx);
  return {
    ok: result.ok,
    blocked_by: result.blocked_by,
    gate_version: result.gate_version,
    tree_hash: loaded.ctx.current_tree_hash ?? TREE_HASH_UNMEASURED,
    stamp_id: null,
    report_id: loaded.report_id,
    status: deriveStatus(loaded.ctx, { ok: result.ok, blocked_by: result.blocked_by }),
  };
}

// ------------------------------------------------------------- the completion report

/**
 * The completion report is generated FROM THE LEDGER, never from memory.
 * Pure: it renders the snapshot the gate just judged.
 */
export function composeFinalReport(ctx: GateContext, summary?: string, reviewRounds?: number): FinalReport {
  const humanReview: string[] = [];
  for (const d of ctx.decisions) {
    const level = classify(ctx.policy, { touches: d.touches, reversible: d.reversible }).level;
    if (level === 'review' || d.approval_state !== 'not_required') {
      humanReview.push(
        `${d.code} ${level}/${d.approval_state}${d.status === 'needs_revisit' ? ' (needs revisit)' : ''}`,
      );
    }
  }
  for (const w of ctx.task.human_waivers) humanReview.push(`waived: ${w}`);
  for (const q of ctx.questions.filter((x) => x.status === 'answered'))
    humanReview.push(`answered ${q.code}: confirm the implementation follows it`);
  // R-04: waiver fatigue warning when threshold exceeded
  let waiverWarning: string | null = null;
  if (ctx.baselineWaivers30d !== undefined && ctx.baselineWaiverThreshold !== undefined && ctx.baselineWaivers30d > ctx.baselineWaiverThreshold) {
    waiverWarning = `baseline waiver fatigue: ${ctx.baselineWaivers30d} waivers in last 30d exceeds threshold ${ctx.baselineWaiverThreshold} — Gate is decorative, fix CI`;
    humanReview.push(waiverWarning);
  }
  return {
    task: ctx.task.code,
    summary: summary ?? ctx.report?.summary ?? '',
    baseline_waivers_30d: ctx.baselineWaivers30d,
    baseline_waiver_warning: waiverWarning,
    completed: ctx.criteria
      .filter((c) => c.status === 'verified')
      .map((c) => ({ criterion: c.text, evidence: c.valid_evidence_count })),
    accepted_or_deferred: ctx.open_items.filter(
      (i) =>
        i.status === 'accepted' || i.status === 'deferred' || i.status === 'wont_fix' || i.status === 'not_applicable',
    ),
    decisions: ctx.decisions.map((d) => ({
      code: d.code,
      title: d.title,
      level: classify(ctx.policy, { touches: d.touches, reversible: d.reversible }).level,
      approval_state: d.approval_state,
    })),
    needs_human_review: humanReview,
    assumptions: ctx.report_assumptions ?? [],
    out_of_scope: outOfScope(ctx),
    counts: {
      criteria_verified: ctx.criteria.filter((c) => c.status === 'verified').length,
      criteria_pending: ctx.criteria.filter((c) => c.status === 'pending').length,
      open_blocking: blockingOpen(ctx.open_items).length,
      review_rounds: reviewRounds ?? (ctx.review ? ctx.review.round : 0),
    },
  };
}

function outOfScope(ctx: GateContext): string[] {
  const measured = ctx.scope.files
    .filter((file) => !file.transient && (!file.in_allowed_paths || file.deleted))
    .map((file) => `${file.deleted ? 'deleted' : 'outside allowed_paths'}: ${file.path}`);
  const codeItems = ctx.open_items
    .filter((item) => item.type === 'out_of_scope' && item.source === 'hook')
    .map((item) => `${item.code} ${item.title}`);
  return [...new Set([...measured, ...codeItems])];
}
