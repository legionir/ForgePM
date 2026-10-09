import { sql } from 'kysely';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit';
import type { Db } from '../db/unitOfWork';
import type { AiProvider } from '../ai/provider';
import { isModuleEnabled } from '../modules/registry';
import { resolveReviewProvider } from './provider-slot';
import { diffProvider } from './diff-slot';
import { resolveReviewConfig } from './config';
import {
  codeScopeKey,
  computeFingerprint,
  reviewInputSchema,
  reviewStageOutputSchema,
  type RawFinding,
  type ReviewConfig,
  type ReviewInput,
} from './contract';
import { partitionFindingWrites } from './validate';
import { upsertFindings, sweepNotSeen, shouldCreateWorkItem, requestFindingApproval, createWorkItemFromFinding, effectiveIssuePolicy } from './findings';

/**
 * Shared review run engine (plan §10). Both Code Review (`kind: 'code'`) and
 * Refactor Review (`kind: 'refactor'`) call `executeReviewRun`, which:
 *   1. creates/reuses the `review_runs` row (status running),
 *   2. runs the configured stages back-to-back through one AiProvider,
 *   3. validates evidence (invalid → stats.discarded; low confidence dropped),
 *   4. upserts findings by fingerprint (rerun = touch last_seen, not dupes),
 *   5. sweeps not_seen/fixed only for COMPLETE (non-truncated) runs,
 *   6. applies the shared issue policy (record_only / human_approval /
 *      auto_high_severity, capped at 10 items per run).
 *
 * The provider + diff/snapshot sources are injected so tests use fakes and the
 * GitHub module can plug its real client without the engine importing it.
 */

export const DEFAULT_CODE_STAGES = ['correctness', 'security', 'performance', 'test_coverage', 'reliability'] as const;
export const DEFAULT_REFACTOR_STAGES = ['architecture', 'duplication', 'complexity', 'dependency', 'maintainability'] as const;

/** One prompt stage: template version + output schema + provider/model choice. */
export interface ReviewStage {
  name: string;
  promptTemplate: string; // {scope} {rules} {payload}
}

export function defaultStages(kind: 'code' | 'refactor'): ReviewStage[] {
  const names = kind === 'code' ? DEFAULT_CODE_STAGES : DEFAULT_REFACTOR_STAGES;
  return names.map((n) => ({ name: n, promptTemplate: `review:${n}:v1` }));
}

/** Provider payload built from validated, in-scope inputs only. */
export interface RunInput {
  projectId: string;
  organizationId: string;
  repositoryId: string;
  scopeKey: string;
  kind: 'code' | 'refactor';
  /** {"pr":N,"commit_sha":"..."} for code; {"commit_sha":...,"partition_cursor":..} for refactor */
  target: Record<string, unknown>;
  review: ReviewInput;
  /** compact structure index JSON (refactor only) */
  structure?: Record<string, unknown>;
  draft?: boolean;
  customRules?: string | null;
  /** already truncated (diff over budget) */
  truncated?: boolean;
  partitionCursor?: number | null;
  /** github repo full name — set for code runs so review.github_output can post */
  repositoryFullName?: string | null;
}

export interface RunOutcome {
  run_id: string;
  status: 'completed' | 'truncated' | 'failed';
  stats: Record<string, unknown>;
  finding_ids: string[];
}

async function getRun(db: Db, id: string): Promise<{ id: string; project_id: string; organization_id: string; attempt: number; stats: Record<string, unknown> } | undefined> {
  const r = await sql<{ id: string; project_id: string; organization_id: string; attempt: number; stats: unknown }>`
    SELECT id, project_id, organization_id, attempt, stats FROM review_runs WHERE id = ${id}
  `.execute(db);
  const row = r.rows[0];
  return row ? { ...row, stats: (row.stats ?? {}) as Record<string, unknown> } : undefined;
}

async function setStatus(db: Db, id: string, status: string, stats: Record<string, unknown>): Promise<void> {
  await db.updateTable('review_runs').set({ status: status as never, stats: toJsonb(stats) as never, updated_at: new Date() } as never).where('id', '=', id).execute();
}

/** Insert the run row (queued). */
export async function createRun(db: Db, args: { organizationId: string; projectId: string; repositoryId: string | null; kind: 'code' | 'refactor'; target: Record<string, unknown>; configSnapshot: ReviewConfig; attempt?: number }): Promise<string> {
  const id = newId();
  await db
    .insertInto('review_runs')
    .values({
      id,
      organization_id: args.organizationId,
      project_id: args.projectId,
      repository_id: args.repositoryId,
      kind: args.kind,
      target: toJsonb(args.target) as never,
      status: 'queued',
      attempt: args.attempt ?? 1,
      config_snapshot: toJsonb(args.configSnapshot) as never,
      stats: toJsonb({}) as never,
    })
    .execute();
  return id;
}

/**
 * GitHub PR-output slot (plan §10.6.A.4). The engine never imports GitHub; a
 * writer is injected by whoever wires the module. `off` => the engine does NOT
 * call it at all (acceptance: no write calls to GitHub). Implementations must
 * UPDATE a single marked comment in place across runs, not create duplicates.
 */
export interface ReviewOutputWriter {
  publish(args: {
    mode: 'summary' | 'inline';
    runId: string;
    repositoryId: string;
    prNumber: number;
    findings: RawFinding[];
  }): Promise<{ created: number; updated: number }>;
}

let WRITER: ReviewOutputWriter | null = null;
export function setReviewOutputWriter(w: ReviewOutputWriter | null): void {
  WRITER = w;
}

export interface ExecuteArgs {
  runId: string;
  input: RunInput;
  config: ReviewConfig;
  provider: AiProvider;
  stages?: ReviewStage[];
  actorId: string;
  actorType: 'user' | 'agent' | 'system';
  requestId: string | null;
  /** auto_high_severity items are created immediately; cap 10 per run. */
  maxIssuesPerRun?: number;
}

/** One stage call: serialise input into the model, validate against schema. */
async function runStage(provider: AiProvider, stage: ReviewStage, input: RunInput, config: ReviewConfig): Promise<RawFinding[]> {
  const payload = {
    scope: input.scopeKey,
    kind: input.kind,
    files: input.review.snapshot.map((f) => f.path),
    hunks: input.review.hunks,
    structure: input.structure ?? null,
    rules: config.custom_rules ?? null,
  };
  const system = `${stage.promptTemplate}\nReturn JSON: {"findings":[...]}. Each finding: category, severity(info|low|medium|high|critical), confidence 0..1, file, line_start, line_end, title, description, why_it_matters, suggestion, evidence (<=20 lines).`;
  const res = await provider.generateStructured<unknown>({
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    schema: reviewStageOutputSchema,
    maxTokens: config.max_cost_tokens ?? undefined,
  });
  const parsed = reviewStageOutputSchema.parse(res.value);
  // tag every finding with the stage category if the model omitted it.
  return parsed.findings.map((f) => ({ ...f, category: f.category || stage.name }));
}

/** Execute one run end-to-end. Throws on infrastructure errors (run=failed). */
export async function executeReviewRun(db: Db, args: ExecuteArgs): Promise<RunOutcome> {
  const run = await getRun(db, args.runId);
  if (!run) throw new Error('review run not found');
  await setStatus(db, args.runId, 'running', { started_at: new Date().toISOString() });

  const stats: Record<string, unknown> = { stages: [], discarded: 0, low_confidence: 0, created: 0, touched: 0, issues_created: 0, approvals_queued: 0, truncated: !!args.input.truncated };
  if (args.input.partitionCursor !== null && args.input.partitionCursor !== undefined) stats.partition_cursor = args.input.partitionCursor;
  if (args.input.truncated) stats.truncated = true;

  const stages = args.stages ?? defaultStages(args.input.kind);
  const all: RawFinding[] = [];
  let tokensUsed = 0;
  let providerFailed = false;
  for (const st of stages) {
    if (args.config.max_cost_tokens && tokensUsed >= args.config.max_cost_tokens) {
      stats.budget_exhausted_at = st.name;
      stats.truncated = true;
      break;
    }
    try {
      const out = await runStageWithRetry(args.provider, st, args.input, args.config, args.config.max_attempts, (t) => { tokensUsed += t; });
      all.push(...out);
      stats.stages = [...(stats.stages as string[]), `${st.name}:ok(${out.length})`];
    } catch (e) {
      providerFailed = true;
      stats.stages = [...(stats.stages as string[]), `${st.name}:error(${(e as Error).message.slice(0, 120)})`];
    }
  }

  const { kept, discarded, lowConfidence } = partitionFindingWrites(args.input.kind, dedupe(all), args.input.review, args.config);
  stats.discarded = discarded;
  stats.low_confidence = lowConfidence;

  // complete run only when the input itself was not truncated; truncated runs
  // do NOT participate in the not_seen → fixed counting (plan §10).
  const complete = !args.input.truncated && !providerFailed;
  let findingIds: string[] = [];
  if (complete || kept.length > 0) {
    const res = await upsertFindings(db, {
      organizationId: args.input.organizationId,
      projectId: args.input.projectId,
      runId: args.runId,
      scopeKey: args.input.scopeKey,
      findings: kept,
    });
    stats.created = res.created;
    stats.touched = res.updated;
    findingIds = res.ids;
  }

  // Re-derive the policy at completion time (one registry, shared by modules).
  const policy = await effectiveIssuePolicy(db, args.input.organizationId, args.input.projectId);
  const cap = args.maxIssuesPerRun ?? 10;
  let created = 0;
  if (policy === 'auto_high_severity') {
    for (const f of kept) {
      if (created >= cap) break;
      if (!shouldCreateWorkItem({ ...f }, args.input.kind, { ...args.config, issue_policy: policy })) continue;
      const existing = await db.selectFrom('review_findings').select(['id', 'status', 'work_item_id']).where('project_id', '=', args.input.projectId).where('scope_key', '=', args.input.scopeKey).where('fingerprint', '=', fpFor(args.input.projectId, f)).executeTakeFirst();
      if (!existing || existing.status === 'issue_created' || existing.work_item_id) continue;
      await createWorkItemFromFinding(db, { organizationId: args.input.organizationId, findingId: existing.id, actorType: args.actorType, actorId: args.actorId, requestId: args.requestId });
      created++;
    }
    stats.issues_created = created;
  } else if (policy === 'human_approval') {
    let queued = 0;
    for (const f of kept) {
      const existing = await db.selectFrom('review_findings').select(['id', 'status', 'work_item_id']).where('project_id', '=', args.input.projectId).where('scope_key', '=', args.input.scopeKey).where('fingerprint', '=', fpFor(args.input.projectId, f)).executeTakeFirstOrThrow();
      if (existing.status === 'open' && !existing.work_item_id) {
        await requestFindingApproval(db, args.input.organizationId, args.input.projectId, existing.id, args.actorId);
        queued++;
      }
    }
    stats.approvals_queued = queued;
  }

  if (complete && !(args.input.truncated === true || stats.truncated === true)) {
    const sweep = await sweepNotSeen(db, { projectId: args.input.projectId, scopeKey: args.input.scopeKey, runId: args.runId });
    stats.swept_not_seen = sweep.not_seen;
    stats.swept_fixed = sweep.fixed;
  }

  // GitHub output (plan §10.6.A.4): code runs only, only when the policy says
  // so — with `off` the engine performs ZERO write calls to GitHub
  // (acceptance-tested). Failures never fail the run; they land in stats.
  if (args.input.kind === 'code' && args.config.github_output !== 'off' && WRITER) {
    const pr = Number(args.input.target.pr ?? 0);
    if (pr > 0) {
      try {
        const pub = await WRITER.publish({
          mode: args.config.github_output,
          runId: args.runId,
          repositoryId: args.input.repositoryId,
          prNumber: pr,
          findings: kept,
        });
        stats.github_output = pub;
      } catch (e) {
        stats.github_output = { error: (e as Error).message.slice(0, 120) };
      }
    }
  }

  const wasTruncated = args.input.truncated === true || stats.truncated === true;
  const finalStatus = wasTruncated ? 'truncated' : providerFailed ? 'failed' : 'completed';
  await setStatus(db, args.runId, finalStatus, { ...stats, finished_at: new Date().toISOString() });

  await db.transaction().execute(async (tx) => {
    await recordAudit(tx, {
      organization_id: args.input.organizationId,
      actor_type: args.actorType,
      actor_id: args.actorId,
      action: `review.${args.input.kind}_run.${finalStatus}`,
      resource_type: 'review_run',
      resource_id: args.runId,
      summary: { scope_key: args.input.scopeKey, created: stats.created, touched: stats.touched, discarded: stats.discarded, issues_created: stats.issues_created, approvals_queued: stats.approvals_queued },
      request_id: args.requestId,
    });
  });

  return { run_id: args.runId, status: finalStatus as RunOutcome['status'], stats, finding_ids: findingIds };
}

function fpFor(projectId: string, f: RawFinding): string {
  return computeFingerprint({ projectId, category: f.category, file: f.file, title: f.title, evidence: f.evidence ?? null });
}

/** Deterministic per-scope dedupe before persistence (double protection). */
function dedupe(findings: RawFinding[]): RawFinding[] {
  const seen = new Set<string>();
  const out: RawFinding[] = [];
  for (const f of findings) {
    const k = `${f.category}|${f.file}|${f.title.toLowerCase()}|${(f.evidence ?? '').replace(/\s+/g, ' ')}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

async function runStageWithRetry(provider: AiProvider, stage: ReviewStage, input: RunInput, config: ReviewConfig, maxAttempts: number, onTokens: (t: number) => void): Promise<RawFinding[]> {
  let err: unknown;
  for (let a = 1; a <= Math.max(1, maxAttempts); a++) {
    try {
      const out = await runStage(provider, stage, input, config);
      onTokens(estimateTokensFor(out));
      return out;
    } catch (e) {
      err = e;
    }
  }
  throw err instanceof Error ? err : new Error(String(err));
}

function estimateTokensFor(findings: RawFinding[]): number {
  return Math.ceil(JSON.stringify(findings).length / 4);
}

/** Load a run row for the panel / MCP get_report. */
export async function getRunReport(db: Db, organizationId: string, runId: string): Promise<Record<string, unknown> | undefined> {
  const r = await sql`SELECT id, organization_id, project_id, repository_id, kind, target, status, attempt, config_snapshot, stats, created_at, updated_at FROM review_runs WHERE id = ${runId} AND organization_id = ${organizationId}`.execute(db);
  return r.rows[0] as Record<string, unknown> | undefined;
}

/**
 * Webhook-triggered Code Review (plan §10.6.A.1): the worker handler calls
 * this with the PR coordinates from the delivery. Gates re-checked at runtime:
 * module enabled, review.auto_run, draft skip. The diff/snapshot come from the
 * injected DiffProvider slot (fake in tests; the GitHub client in prod).
 */
export async function runCodeReviewForPr(
  db: Db,
  args: {
    organizationId: string;
    projectId: string;
    repositoryId: string;
    repositoryFullName: string;
    prNumber: number;
    headSha: string | null;
    draft: boolean;
  },
): Promise<RunOutcome | { skipped: string }> {
  if (!(await isModuleEnabled(db, 'code_review', args.organizationId, args.projectId))) return { skipped: 'module_disabled' };
  const config = await resolveReviewConfig(db, 'code', args.organizationId, args.projectId);
  if (!config.auto_run) return { skipped: 'auto_run_off' };
  if (args.draft && config.skip_drafts) return { skipped: 'draft' };

  const provider = await resolveReviewProvider(args.organizationId);
  if (!provider) return { skipped: 'no_provider' };

  const dp = diffProvider();
  if (!dp) return { skipped: 'no_diff_source' };
  const fetched = await dp({
    organizationId: args.organizationId,
    repositoryId: args.repositoryId,
    repositoryFullName: args.repositoryFullName,
    prNumber: args.prNumber,
    headSha: args.headSha,
  });
  const review = reviewInputSchema.parse({ hunks: fetched.hunks, snapshot: fetched.snapshot });

  const input: RunInput = {
    projectId: args.projectId,
    organizationId: args.organizationId,
    repositoryId: args.repositoryId,
    scopeKey: codeScopeKey(args.repositoryId, args.prNumber),
    kind: 'code',
    target: { pr: args.prNumber, commit_sha: args.headSha },
    review,
    draft: args.draft,
    customRules: config.custom_rules ?? null,
    truncated: false,
  };
  const runId = await createRun(db, {
    organizationId: args.organizationId,
    projectId: args.projectId,
    repositoryId: args.repositoryId,
    kind: 'code',
    target: input.target,
    configSnapshot: config,
  });
  return executeReviewRun(db, {
    runId,
    input,
    config,
    provider,
    actorId: SYSTEM_ACTOR_ID,
    actorType: 'system',
    requestId: null,
  });
}
