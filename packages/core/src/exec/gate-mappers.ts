import { evidenceIsVerifiable } from './evidence';
import { isTransient, matchPathGlob, type ChangedFile } from './scope';
import type {
  GateBaseline,
  GateCriterion,
  GateDecision,
  GateFact,
  GateOpenItem,
  GateQuestion,
  GateReport,
  GateRequirement,
  GateReview,
  GateScope,
  GateTask,
} from './gate-types';

/**
 * Row → snapshot mappers for the gate (plan §8.2).
 *
 * Pure and separate from the loader on purpose: a mapper is the place where a
 * database column becomes a rule's input, and a rule must never have to know
 * what a column is called. Every mapper is total — a missing or surprising
 * value becomes an explicit "empty", never an exception.
 */

export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asStringArray = (v: unknown): string[] => asArray(v).filter((x): x is string => typeof x === 'string');
const asBool = (v: unknown): boolean => v === true;

export function toReport(payload: Record<string, unknown> | null): GateReport | null {
  if (!payload) return null;
  const executed = asArray(payload.tests_executed)
    .map((t) => {
      const x = (t ?? {}) as Record<string, unknown>;
      const result = x.result === 'fail' ? 'fail' : x.result === 'not_run' ? 'not_run' : 'pass';
      return {
        name: String(x.name ?? ''),
        result: result as 'pass' | 'fail' | 'not_run',
        evidence_ref: String(x.evidence_id ?? x.evidence_ref ?? ''),
      };
    })
    .filter((t) => t.name.length > 0);
  const notRun = asArray(payload.tests_not_run)
    .map((t) => {
      const x = (t ?? {}) as Record<string, unknown>;
      return { name: String(x.name ?? ''), reason: String(x.reason ?? '') };
    })
    .filter((t) => t.name.length > 0);
  return {
    summary: typeof payload.summary === 'string' ? payload.summary : undefined,
    tests_executed: executed,
    tests_not_run: notRun,
    changed_files: asStringArray(payload.changed_files),
  };
}

export function toTask(
  task: { code: string; status: GateTask['status'] },
  children: { code: string; title: string; status: GateTask['status'] }[],
  deps: { depends_on_task_id: string }[],
  depTasks: { id: string; code: string; status: GateTask['status'] }[],
  waivers: { entity_code: string | null; payload: unknown }[],
): GateTask {
  const waiverNames = waivers.map((w) => waiverName(w.payload) ?? w.entity_code ?? '').filter((w) => w.length > 0);
  const depById = new Map(depTasks.map((d) => [d.id, d]));
  return {
    code: task.code,
    status: task.status,
    children: children.map((c) => ({
      code: c.code,
      title: c.title,
      status: c.status,
      req_codes: [],
      cancelled: waiverNames.some((w) => w === `cancel:${c.code}` || w.startsWith(`cancel:${c.code}:`)),
    })),
    depends_on: deps.map((d) => {
      const dep = depById.get(d.depends_on_task_id);
      return { code: dep?.code ?? d.depends_on_task_id, status: dep?.status ?? 'not_started' };
    }),
    human_waivers: waiverNames,
  };
}

/** A waiver event carries `{ waiver: 'cancel:T-002' }` in its payload. */
function waiverName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const w = p.waiver ?? p.name;
  return typeof w === 'string' ? w : null;
}

export function toCriteria(
  criteria: {
    id: string;
    code: string;
    text: string;
    status: 'pending' | 'verified' | 'waived';
    waiver_approval_id: string | null;
    req_id: string | null;
  }[],
  evidence: { criterion_id: string | null; ref: string; payload: string | null; sha256: string | null }[],
): GateCriterion[] {
  return criteria.map((c) => {
    const rows = evidence.filter((e) => e.criterion_id === c.id);
    return {
      code: c.code,
      status: c.status,
      evidence_count: rows.length,
      valid_evidence_count: rows.filter(evidenceIsVerifiable).length,
      has_waiver_approval: c.waiver_approval_id !== null,
      req_code: c.req_id,
      text: c.text,
    };
  });
}

export function toOpenItems(
  items: {
    code: string;
    title: string;
    type: string;
    status: GateOpenItem['status'];
    blocks_completion: boolean;
    source: string;
    related_ref?: string | null;
    resolved_by?: 'agent' | 'human' | null;
  }[],
): GateOpenItem[] {
  return items.map((i) => ({
    code: i.code,
    title: i.title,
    type: i.type,
    status: i.status,
    blocks_completion: i.blocks_completion,
    source: i.source,
    related_ref: i.related_ref ?? null,
    resolved_by: i.resolved_by ?? null,
  }));
}

export function toDecisions(
  decisions: {
    code: string;
    title: string;
    touches: string[];
    reversible: boolean;
    approval_state: GateDecision['approval_state'];
    applied_at: Date | null;
    status?: GateDecision['status'];
  }[],
): GateDecision[] {
  return decisions.map((d) => ({
    code: d.code,
    title: d.title,
    touches: d.touches ?? [],
    reversible: d.reversible,
    approval_state: d.approval_state,
    applied: d.applied_at !== null,
    status: d.status ?? 'active',
  }));
}

export function toQuestions(
  questions: { code: string; blocking: boolean; status: GateQuestion['status'] }[],
): GateQuestion[] {
  return questions.map((q) => ({ code: q.code, blocking: q.blocking, status: q.status }));
}

export function toFacts(
  facts: { id: string; code: string; status: GateFact['status'] }[],
  factDecisions: { fact_id: string; decision_id: string }[],
  decisions: { id: string; code: string; status: string }[],
): GateFact[] {
  const decisionCode = new Map(decisions.filter((d) => d.status === 'active').map((d) => [d.id, d.code]));
  return facts.map((f) => ({
    code: f.code,
    status: f.status,
    active_dependent_decisions: factDecisions
      .filter((fd) => fd.fact_id === f.id)
      .map((fd) => decisionCode.get(fd.decision_id))
      .filter((c): c is string => typeof c === 'string'),
  }));
}

export function toRequirements(
  all: { id: string; code: string; status: GateRequirement['status'] }[],
  links: { req_id: string; criterion_ids: unknown }[],
  criteria: { id: string; code: string; status: string; req_id: string | null }[],
): GateRequirement[] {
  const linked = new Map<string, string[]>();
  for (const l of links) linked.set(l.req_id, asStringArray(l.criterion_ids));
  return all.map((r) => {
    const ids = new Set(linked.get(r.id) ?? []);
    const verified = criteria
      .filter((c) => (ids.has(c.id) || c.req_id === r.id) && c.status === 'verified')
      .map((c) => c.code);
    return { code: r.code, status: r.status, verified_criteria: verified };
  });
}

export function toReview(
  reviews: {
    round: number;
    verdict: 'pass' | 'fail';
    tree_hash: string;
    findings: unknown;
    created_at: Date;
  }[],
): GateReview | null {
  if (!reviews.length) return null;
  const latest = [...reviews].sort((a, b) => b.round - a.round || b.created_at.getTime() - a.created_at.getTime())[0];
  const findings = asArray(latest.findings) as Record<string, unknown>[];
  const openBlocking = findings.filter((f) => asBool(f.blocks_completion)).length;
  return {
    round: latest.round,
    verdict: latest.verdict,
    tree_hash: latest.tree_hash,
    open_blocking_findings: openBlocking,
  };
}

/**
 * Map a code-measured Git diff or server-captured manifest diff into Rule 11
 * inputs. An exit report is deliberately not accepted: `changed_files` is an agent claim.
 */
export function toScope(
  changed: readonly ChangedFile[] | null,
  allowedRaw: unknown,
  unavailableReason: string | null = null,
  treeHash: string | null = null,
  humanWaived = false,
  basis: 'git' | 'manifest' = 'git',
): GateScope {
  if (!changed) {
    return {
      available: false,
      basis: 'none',
      unavailable_reason: unavailableReason ?? 'no start_ref or read-only diff source',
      human_waived: humanWaived,
      files: [],
      tree_hash: null,
    };
  }
  const allowed = asStringArray(allowedRaw);
  const isAllowed = (path: string): boolean => allowed.some((glob) => matchPathGlob(glob, path));
  const files = changed.map((file) => ({
    path: file.path,
    change: file.status,
    in_allowed_paths: isAllowed(file.path) && (!file.from || isAllowed(file.from)),
    deleted: file.status === 'D',
    transient: isTransient(file.path),
  }));
  return { available: true, basis, unavailable_reason: null, human_waived: humanWaived, files, tree_hash: treeHash };
}

/**
 * Build baseline inputs only from CI-origin rows and a system-written capture
 * event whose SHA matches the current clean worktree. Exit-report test claims
 * are intentionally absent from this function.
 */
export function toBaseline(
  rows: {
    test_name: string;
    result_at_start: 'pass' | 'fail' | 'skip';
    source: 'ci' | 'human';
    provenance: unknown;
  }[],
  events: { id: string; action: string; actor_type: string; actor_id: string | null; tool: string | null; payload: unknown; created_at: Date }[],
  startSha: string | null,
  currentSha: string | null,
  humanWaived: boolean,
): GateBaseline {
  const expectedStart = validSha(startSha) ? startSha.toLowerCase() : null;
  const expectedCurrent = validSha(currentSha) ? currentSha.toLowerCase() : null;
  const startProvenance = expectedStart
    ? events
        .filter((event) => event.action === 'baseline.start_captured')
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .map((event) => capturedStartEvent(event, expectedStart))
        .find((run) => run !== null) ?? null
    : null;
  const baselineRows = rows
    .filter((row) => {
      const provenance = record(row.provenance);
      return Boolean(
        row.source === 'ci' && startProvenance && provenance &&
        provenance.provider === startProvenance.provider && provenance.run_id === startProvenance.run_id &&
        provenance.job === startProvenance.job && provenance.sha256_log === startProvenance.sha256_log &&
        typeof provenance.sha === 'string' && provenance.sha.toLowerCase() === expectedStart,
      );
    })
    .map((row) => ({ name: row.test_name, result_at_start: row.result_at_start, source: 'ci' as const }));
  const latest = expectedCurrent
    ? events
        .filter(
          (event) =>
            event.action === 'baseline.captured' &&
            event.actor_type === 'system' &&
            event.actor_id === 'ci-baseline-reader' &&
            event.tool === 'baseline_capture',
        )
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
        .map((event) => capturedRun(event.payload, expectedCurrent))
        .find((run) => run !== null) ?? null
    : null;
  const ran = Boolean(expectedStart && expectedCurrent && baselineRows.length > 0 && latest);
  let unavailableReason: string | null = null;
  if (!expectedStart) unavailableReason = 'BASELINE_UNAVAILABLE: task has no code-captured start SHA';
  else if (!baselineRows.length) unavailableReason = `BASELINE_UNAVAILABLE: no CI baseline captured for ${expectedStart}`;
  else if (!expectedCurrent) unavailableReason = 'BASELINE_UNAVAILABLE: current worktree is dirty or its commit SHA is unavailable';
  else if (!latest) unavailableReason = `BASELINE_UNAVAILABLE: no CI log captured for current SHA ${expectedCurrent}`;

  return {
    ran,
    unavailable_reason: ran ? null : unavailableReason,
    human_waived: humanWaived,
    start_sha: expectedStart,
    current_sha: expectedCurrent,
    tests: baselineRows,
    after: latest
      ? {
          sha: latest.sha,
          run_id: latest.run_id,
          job: latest.job,
          present: latest.tests.map((test) => test.name),
          results: Object.fromEntries(latest.tests.map((test) => [test.name, test.result])),
        }
      : null,
    weakening: latest?.weakening ?? [],
  };
}

interface CapturedStart {
  provider: string;
  run_id: string;
  job: string;
  sha: string;
  sha256_log: string;
}

function capturedStartEvent(
  event: { action: string; actor_type: string; actor_id: string | null; tool: string | null; payload: unknown },
  expectedSha: string,
): CapturedStart | null {
  if (
    event.action !== 'baseline.start_captured' || event.actor_type !== 'system' ||
    event.actor_id !== 'ci-baseline-reader' || event.tool !== 'baseline_capture'
  ) return null;
  const start = record(record(event.payload)?.start);
  if (
    !start || typeof start.provider !== 'string' || !start.provider ||
    typeof start.run_id !== 'string' || !start.run_id || typeof start.job !== 'string' || !start.job ||
    typeof start.sha !== 'string' || start.sha.toLowerCase() !== expectedSha ||
    typeof start.sha256_log !== 'string' || !/^[0-9a-f]{64}$/i.test(start.sha256_log)
  ) return null;
  return {
    provider: start.provider,
    run_id: start.run_id,
    job: start.job,
    sha: expectedSha,
    sha256_log: start.sha256_log.toLowerCase(),
  };
}

interface CapturedRun {
  sha: string;
  run_id: string;
  job: string;
  tests: { name: string; result: 'pass' | 'fail' | 'skip' }[];
  weakening: { path: string; count_delta: number; modifiers: string[] }[];
}

function capturedRun(payload: unknown, expectedSha: string): CapturedRun | null {
  const after = record(record(payload)?.after);
  if (!after || typeof after.sha !== 'string' || after.sha.toLowerCase() !== expectedSha) return null;
  if (
    typeof after.run_id !== 'string' || !after.run_id || typeof after.job !== 'string' || !after.job ||
    after.complete !== true || typeof after.sha256_log !== 'string' || !/^[0-9a-f]{64}$/i.test(after.sha256_log)
  ) return null;
  if (!Array.isArray(after.tests) || after.tests.length === 0) return null;
  const tests = after.tests.flatMap((value) => {
    const item = record(value);
    if (!item || typeof item.name !== 'string' || !item.name || !isTestResult(item.result)) return [];
    return [{ name: item.name, result: item.result }];
  });
  if (tests.length !== after.tests.length) return null;
  if (!Array.isArray(after.weakening)) return null;
  const weakening = after.weakening.map((value) => {
    const item = record(value);
    if (
      !item || typeof item.path !== 'string' || typeof item.count_delta !== 'number' ||
      !Array.isArray(item.modifiers) || !item.modifiers.every((modifier) => typeof modifier === 'string')
    ) return null;
    return { path: item.path, count_delta: item.count_delta, modifiers: item.modifiers as string[] };
  });
  if (weakening.some((item) => item === null)) return null;
  return { sha: expectedSha, run_id: after.run_id, job: after.job, tests, weakening: weakening as CapturedRun['weakening'] };
}

function record(value: unknown): Record<string, unknown> | null {
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

function validSha(value: string | null): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
}

function isTestResult(value: unknown): value is 'pass' | 'fail' | 'skip' {
  return value === 'pass' || value === 'fail' || value === 'skip';
}
