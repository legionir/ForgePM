import { z } from 'zod';
import { AppError } from '@forgepm/shared';
import {
  buildReviewInput,
  getEffective,
  newId,
  redactSecrets,
  remainingTokenBudget,
  resolveExecReviewSource,
  resolveReviewProvider,
  tokensUsedToday,
  type Db,
  type ReviewFinding,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from '../projects/access';
import { projectForTask } from './context';
import { findReviewTask, loadReviewParts, type TaskRow } from './review-input-data';
import { ensureHumanArbitration, finalizeReviewRun, reserveReviewRun } from './review-persistence';
import { callReviewStage, REVIEW_STAGES } from './review-provider';

export const reviewTaskInputSchema = z.strictObject({
  task_ref: z.string().min(1).max(64),
  project_ref: z.string().min(1).max(64).optional(),
});

const MAX_REVIEW_ROUNDS = 2;
const MAX_REVIEW_FINDINGS = 200;
const PROMPT_MAX_BYTES = 400_000;

interface ReviewTaskResult {
  status: 'completed' | 'review_failed' | 'stale' | 'review_in_progress' | 'human_arbitration_required' | 'round_limit_reached';
  verdict?: 'pass' | 'fail';
  task_id: string;
  task_code: string;
  round: number;
  review_run_id?: string;
  tree_hash?: string;
  findings: number;
  open_items: string[];
  tokens_used: number;
  errors?: string[];
}

/**
 * Run the execution-control adversarial review. The model receives one isolated
 * five-section snapshot and six fixed review lenses; it has no tool interface.
 * Writes are restricted to review data, AI usage, ledger findings and audit.
 */
export async function reviewTask(db: Db, actor: Actor, raw: unknown): Promise<ReviewTaskResult> {
  const args = reviewTaskInputSchema.parse(raw ?? {});
  const projectId = await projectForTask(db, actor, args.task_ref, args.project_ref);
  await assertProjectAccess(db, actor, projectId, 'review:run');

  const task = await findReviewTask(db, actor.organizationId, projectId, args.task_ref);
  if (!task) throw new AppError('NOT_FOUND', `no ledger task '${args.task_ref}' in this project`, { ref: args.task_ref });
  if (!task.start_ref) {
    throw new AppError('REVIEW_INPUT_UNAVAILABLE', 'REVIEW_INPUT_UNAVAILABLE: task has no start_ref baseline', {
      needed_action: 'capture the task start_ref with the agent-side ledger hook, or ask a human to review the task manually',
    });
  }

  const [rootsSetting, maxRoundsSetting, runCostSetting, dailyBudgetSetting] = await Promise.all([
    getEffective(db, 'exec.allowed_repo_roots', actor.organizationId, projectId),
    getEffective(db, 'exec.max_review_rounds', actor.organizationId, projectId),
    getEffective(db, 'exec.max_cost_tokens', actor.organizationId, projectId),
    getEffective(db, 'ai.daily_token_budget', actor.organizationId, null),
  ]);
  const roots = Array.isArray(rootsSetting?.value) ? (rootsSetting.value as string[]) : [];
  if (!roots.length) {
    throw new AppError('REVIEW_INPUT_UNAVAILABLE', 'REVIEW_INPUT_UNAVAILABLE: exec.allowed_repo_roots is empty', {
      needed_action: 'configure a read-only exec.allowed_repo_roots setting before running review_task',
    });
  }
  const maxRounds = Math.min(MAX_REVIEW_ROUNDS, Math.max(1, finiteNumber(maxRoundsSetting?.value, 2)));
  const latest = await latestReview(db, task.id);
  if (latest && Number(latest.round) >= maxRounds) {
    const isRunning = latest.run_status === 'running';
    const openItems = !isRunning && latest.verdict === 'fail'
      ? await ensureHumanArbitration(db, actor, task, Number(latest.round), maxRounds, latest.tree_hash)
      : [];
    return {
      status: isRunning ? 'review_in_progress' : latest.verdict === 'fail' ? 'human_arbitration_required' : 'round_limit_reached',
      verdict: latest.verdict,
      task_id: task.id,
      task_code: task.code,
      round: Number(latest.round),
      findings: Array.isArray(latest.findings) ? latest.findings.length : 0,
      open_items: openItems,
      tokens_used: 0,
    };
  }

  const source = resolveExecReviewSource();
  if (!source) {
    throw new AppError('REVIEW_INPUT_UNAVAILABLE', 'REVIEW_INPUT_UNAVAILABLE: no read-only worktree source is configured', {
      needed_action: 'configure the API Git review source or ask a human to review the task manually',
    });
  }
  const snapshot = await source.snapshot({ start_ref: task.start_ref, roots });
  if (!/^[0-9a-f]{64}$/i.test(snapshot.tree_hash)) {
    throw new AppError('REVIEW_INPUT_UNAVAILABLE', 'REVIEW_INPUT_UNAVAILABLE: worktree source returned an invalid tree hash');
  }

  const parts = await loadReviewParts(db, actor.organizationId, projectId, task, snapshot);
  let built: ReturnType<typeof buildReviewInput>;
  try {
    built = buildReviewInput(parts, PROMPT_MAX_BYTES);
  } catch {
    throw new AppError('REVIEW_INPUT_UNAVAILABLE', 'REVIEW_INPUT_UNAVAILABLE: ledger input contains forbidden history-like fields or cannot be serialized', {
      needed_action: 'remove the invalid data from the review source and ask a human to inspect the task',
    });
  }
  const inputMeta = {
    input_sections: built.meta.sections,
    prompt_bytes: built.meta.bytes,
    prompt_sha256: built.meta.sha256,
    excluded: built.meta.excluded,
    redacted_secrets: built.meta.redacted_secrets,
    tree_hash: snapshot.tree_hash,
    source_truncated: Boolean(snapshot.truncated),
  };

  const runId = newId();
  const provider = await resolveReviewProvider(actor.organizationId, runId);
  if (!provider) throw new AppError('PROVIDER_ERROR', 'no AI provider configured for execution review');
  const providerRow = await db
    .selectFrom('ai_providers')
    .select('id')
    .where('organization_id', '=', actor.organizationId)
    .where('kind', '=', provider.kind as never)
    .where('default_model', '=', provider.model)
    .where('enabled', '=', true)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!providerRow) {
    throw new AppError('PROVIDER_ERROR', 'the execution-review provider has no enabled ai_providers row for usage logging');
  }

  const runCost = Math.max(0, finiteNumber(runCostSetting?.value, 0));
  const dailyBudget = Math.max(0, finiteNumber(dailyBudgetSetting?.value, 0));
  const dailyUsed = dailyBudget > 0 ? await tokensUsedToday(db, actor.organizationId) : 0;
  const dailyRemaining = dailyBudget > 0 ? remainingTokenBudget(dailyBudget, dailyUsed) ?? 0 : null;
  const effectiveLimit = minConfiguredBudget(runCost, dailyRemaining);
  const preflightBudgetError = effectiveLimit !== null && effectiveLimit <= 0
    ? `AI_BUDGET_EXCEEDED: no review tokens remain (daily ${dailyUsed}/${dailyBudget})`
    : null;

  const reservation = await reserveReviewRun({
    db,
    actor,
    task,
    runId,
    treeHash: snapshot.tree_hash,
    inputMeta,
    maxRounds,
    maxCost: runCost,
    providerKind: provider.kind,
    model: provider.model,
  });
  if (!reservation) return noReservationResult(db, actor, task, maxRounds);

  let tokensUsed = 0;
  let failure: string | null = preflightBudgetError;
  let stale = false;
  let malformedOutput = false;
  const findings: ReviewFinding[] = [];
  const checked = new Set<string>();

  if (!failure && (snapshot.truncated || built.meta.excluded.length > 0)) {
    failure = 'REVIEW_INPUT_INVALID: the changed-file list or prompt exceeded the review input limit';
  }
  if (!failure) {
    for (const stage of REVIEW_STAGES) {
      const result = await callReviewStage({
        db,
        provider,
        providerId: providerRow.id,
        organizationId: actor.organizationId,
        prompt: built.prompt,
        witnesses: built.witness_refs,
        stage,
        budgetLimit: effectiveLimit ?? 0,
        tokensAlreadyUsed: tokensUsed,
      });
      tokensUsed += result.tokens_used;
      if (!result.ok || !result.value) {
        failure = result.error ?? 'REVIEW_OUTPUT_INVALID: reviewer stage did not return a valid result';
        malformedOutput = !failure.startsWith('AI_BUDGET_EXCEEDED') && !failure.startsWith('AI_USAGE_LOG_FAILED');
        break;
      }
      checked.add(stage.name);
      for (const item of result.value.checked) checked.add(redactSecrets(item).text);
      if (findings.length + result.value.findings.length > MAX_REVIEW_FINDINGS) {
        failure = `REVIEW_OUTPUT_INVALID: more than ${MAX_REVIEW_FINDINGS} findings in one review run`;
        malformedOutput = true;
        break;
      }
      findings.push(...result.value.findings);
    }
  }

  try {
    const currentHash = await source.treeHash({ roots });
    if (currentHash !== snapshot.tree_hash) {
      stale = true;
      failure = 'REVIEW_STALE: the worktree changed while the model was reviewing it';
    }
  } catch {
    stale = true;
    failure = 'REVIEW_STALE: the current worktree hash could not be verified after model review';
  }

  const verdict: 'pass' | 'fail' = failure || findings.some((finding) => finding.blocks_completion) ? 'fail' : 'pass';
  const finalized = await finalizeReviewRun({
    db,
    actor,
    task,
    projectId,
    runId,
    treeHash: snapshot.tree_hash,
    round: reservation.round,
    maxRounds,
    verdict,
    findings,
    checked: [...checked],
    failure,
    stale,
    malformedOutput,
    tokensUsed,
  });
  return {
    status: stale ? 'stale' : failure ? 'review_failed' : 'completed',
    verdict,
    task_id: task.id,
    task_code: task.code,
    round: reservation.round,
    review_run_id: runId,
    tree_hash: snapshot.tree_hash,
    findings: findings.length,
    open_items: finalized.openItems,
    tokens_used: tokensUsed,
    ...(failure ? { errors: finalized.errors } : {}),
  };
}

async function latestReview(db: Db, taskId: string) {
  return db
    .selectFrom('exec_reviews as er')
    .innerJoin('review_runs as rr', 'rr.id', 'er.review_run_id')
    .select(['er.round as round', 'er.verdict as verdict', 'er.findings as findings', 'er.tree_hash as tree_hash', 'rr.status as run_status'])
    .where('er.task_id', '=', taskId)
    .orderBy('er.round', 'desc')
    .limit(1)
    .executeTakeFirst();
}

async function noReservationResult(db: Db, actor: Actor, task: TaskRow, maxRounds: number): Promise<ReviewTaskResult> {
  const latest = await latestReview(db, task.id);
  const isRunning = latest?.run_status === 'running';
  const isFail = !isRunning && latest?.verdict === 'fail';
  const openItems = isFail
    ? await ensureHumanArbitration(
      db,
      actor,
      task,
      Number(latest?.round ?? maxRounds),
      maxRounds,
      String(latest?.tree_hash ?? ''),
    )
    : [];
  return {
    status: isRunning ? 'review_in_progress' : isFail ? 'human_arbitration_required' : 'round_limit_reached',
    verdict: latest?.verdict,
    task_id: task.id,
    task_code: task.code,
    round: Number(latest?.round ?? maxRounds),
    findings: Array.isArray(latest?.findings) ? latest.findings.length : 0,
    open_items: openItems,
    tokens_used: 0,
  };
}

function minConfiguredBudget(runCost: number, dailyRemaining: number | null): number | null {
  if (runCost > 0 && dailyRemaining !== null) return Math.min(runCost, dailyRemaining);
  if (runCost > 0) return runCost;
  return dailyRemaining;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
