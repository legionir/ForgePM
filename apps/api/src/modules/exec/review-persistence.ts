import { sql } from 'kysely';
import type { ExecOpenItemType } from '@forgepm/shared';
import {
  computeFingerprint,
  createOpenItem,
  dedupKey,
  listTaskItems,
  newId,
  recordAudit,
  redactSecrets,
  toJsonb,
  unitOfWork,
  type Db,
  type ReviewFinding,
  type Tx,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { ledgerActor } from './context';
import type { TaskRow } from './review-input-data';
import { REVIEW_STAGES } from './review-provider';

export async function reserveReviewRun(input: {
  db: Db;
  actor: Actor;
  task: TaskRow;
  runId: string;
  treeHash: string;
  inputMeta: Record<string, unknown>;
  maxRounds: number;
  maxCost: number;
  providerKind: string;
  model: string;
}): Promise<{ round: number } | null> {
  let round: number | null = null;
  await unitOfWork(input.db, async ({ tx }) => {
    await sql`SELECT id FROM exec_tasks WHERE id = ${input.task.id}::uuid FOR UPDATE`.execute(tx as never);
    const maxRow = await tx.selectFrom('exec_reviews')
      .select(sql<number>`COALESCE(MAX(round), 0)::int`.as('max_round'))
      .where('task_id', '=', input.task.id)
      .executeTakeFirst();
    const lastRound = Number(maxRow?.max_round ?? 0);
    if (lastRound >= input.maxRounds) return;
    const reservedRound = lastRound + 1;
    round = reservedRound;
    const runMeta = toJsonb(input.inputMeta) as never;
    await tx.insertInto('review_runs').values({
      id: input.runId,
      organization_id: input.actor.organizationId,
      project_id: input.task.project_id,
      repository_id: null,
      kind: 'code',
      target: toJsonb({
        task_code: input.task.code,
        task_id: input.task.id,
        round: reservedRound,
        start_ref: input.task.start_ref,
        tree_hash: input.treeHash,
      }) as never,
      status: 'running',
      attempt: reservedRound,
      config_snapshot: toJsonb({
        source: 'exec',
        provider_kind: input.providerKind,
        model: input.model,
        stages: REVIEW_STAGES.map((stage) => stage.name),
        max_review_rounds: input.maxRounds,
        max_cost_tokens: input.maxCost,
      }) as never,
      input: runMeta,
      stats: toJsonb({ status: 'running' }) as never,
    }).execute();
    await tx.insertInto('exec_reviews').values({
      id: newId(),
      organization_id: input.actor.organizationId,
      task_id: input.task.id,
      round: reservedRound,
      review_run_id: input.runId,
      verdict: 'fail',
      findings: toJsonb([]) as never,
      checked: toJsonb(['review in progress']) as never,
      tree_hash: input.treeHash,
      input_meta: runMeta,
    }).execute();
    await recordAudit(tx, {
      organization_id: input.actor.organizationId,
      actor_type: input.actor.type === 'agent' ? 'agent' : 'user',
      actor_id: input.actor.id,
      action: 'exec.review.started',
      resource_type: 'exec_review',
      resource_id: input.task.id,
      summary: {
        task_code: input.task.code,
        round: reservedRound,
        run_id: input.runId,
        tree_hash: input.treeHash,
        input_sections: input.inputMeta.input_sections,
      },
      request_id: input.actor.requestId,
    });
  });
  return round === null ? null : { round };
}

export async function finalizeReviewRun(input: {
  db: Db;
  actor: Actor;
  task: TaskRow;
  projectId: string;
  runId: string;
  treeHash: string;
  round: number;
  maxRounds: number;
  verdict: 'pass' | 'fail';
  findings: ReviewFinding[];
  checked: string[];
  failure: string | null;
  stale: boolean;
  malformedOutput: boolean;
  tokensUsed: number;
}): Promise<{ openItems: string[]; errors: string[] }> {
  const openItems: string[] = [];
  const finalStatus = input.failure ? 'failed' : 'completed';
  const errors = input.failure ? [redactSecrets(input.failure).text] : [];
  await unitOfWork(input.db, async ({ tx }) => {
    const ledger = ledgerActor(input.actor, input.projectId, 'review_task');
    await sql`SELECT id FROM exec_tasks WHERE id = ${input.task.id}::uuid FOR UPDATE`.execute(tx as never);
    const storedFindings: Record<string, unknown>[] = [];
    const activeItems = await listTaskItems(tx, input.task.id, { activeOnly: true });
    for (const finding of input.findings) {
      const safeFinding: ReviewFinding = {
        ...finding,
        title: redactSecrets(finding.title).text,
        why: redactSecrets(finding.why).text,
      };
      const type = mapFindingType(safeFinding.type);
      const existing = activeItems.find((item) => dedupKey(item.type, item.title) === dedupKey(type, safeFinding.title));
      const item = existing ?? await createOpenItem(
        tx,
        ledger,
        input.task.code,
        {
          title: safeFinding.title,
          detail: safeFinding.why,
          type,
          blocks_completion: safeFinding.type === 'suggestion' ? false : safeFinding.blocks_completion,
          related_ref: safeFinding.evidence_ref,
        },
        'reviewer',
      );
      if (!existing) activeItems.push(item);
      if (!openItems.includes(item.code)) openItems.push(item.code);
      const reviewFindingId = await persistReviewFinding(tx, {
        runId: input.runId,
        projectId: input.projectId,
        organizationId: input.actor.organizationId,
        scopeKey: `exec:task:${input.task.id}`,
        finding: safeFinding,
      });
      storedFindings.push({ ...safeFinding, open_item_code: item.code, review_finding_id: reviewFindingId });
    }

    if (input.round >= input.maxRounds && (input.failure || input.verdict === 'fail')) {
      const code = await ensureHumanArbitrationInTx(
        tx,
        ledger,
        input.task,
        input.round,
        input.maxRounds,
        input.treeHash,
        input.failure ?? 'The adversarial review still has blocking findings.',
      );
      if (code && !openItems.includes(code)) openItems.push(code);
    }

    const checked = [...input.checked];
    if (input.failure) {
      checked.push(input.malformedOutput ? 'review_failed: corrective retry exhausted' : `review_failed: ${input.failure}`);
    }
    await tx.updateTable('exec_reviews').set({
      verdict: input.verdict,
      findings: toJsonb(storedFindings) as never,
      checked: toJsonb(checked) as never,
    }).where('task_id', '=', input.task.id).where('round', '=', input.round).execute();
    await tx.updateTable('review_runs').set({
      status: finalStatus as never,
      stats: toJsonb({
        round: input.round,
        stages_completed: input.checked.filter((entry) => REVIEW_STAGES.some((stage) => stage.name === entry)).length,
        finding_count: input.findings.length,
        tokens_used: input.tokensUsed,
        status: input.failure ? (input.stale ? 'stale' : 'review_failed') : 'completed',
        errors,
        open_item_codes: openItems,
      }) as never,
      updated_at: new Date(),
    }).where('id', '=', input.runId).execute();
    await recordAudit(tx, {
      organization_id: input.actor.organizationId,
      actor_type: input.actor.type === 'agent' ? 'agent' : 'user',
      actor_id: input.actor.id,
      action: 'exec.review.completed',
      resource_type: 'exec_review',
      resource_id: input.task.id,
      summary: {
        task_code: input.task.code,
        round: input.round,
        verdict: input.verdict,
        status: finalStatus,
        run_id: input.runId,
        tokens_used: input.tokensUsed,
        findings: input.findings.length,
      },
      request_id: input.actor.requestId,
    });
  });
  return { openItems, errors };
}

export async function ensureHumanArbitration(
  db: Db,
  actor: Actor,
  task: TaskRow,
  round: number,
  maxRounds: number,
  treeHash: string,
): Promise<string[]> {
  let code: string | undefined;
  await unitOfWork(db, async ({ tx }) => {
    await sql`SELECT id FROM exec_tasks WHERE id = ${task.id}::uuid FOR UPDATE`.execute(tx as never);
    code = (await ensureHumanArbitrationInTx(
      tx,
      ledgerActor(actor, task.project_id, 'review_task'),
      task,
      round,
      maxRounds,
      treeHash,
      'The execution adversarial review round limit was reached.',
    )) ?? undefined;
    if (code) {
      await recordAudit(tx, {
        organization_id: actor.organizationId,
        actor_type: actor.type === 'agent' ? 'agent' : 'user',
        actor_id: actor.id,
        action: 'exec.review.human_arbitration_required',
        resource_type: 'exec_task',
        resource_id: task.id,
        summary: { task_code: task.code, round, max_rounds: maxRounds, open_item_code: code },
        request_id: actor.requestId,
      });
    }
  });
  return code ? [code] : [];
}

async function ensureHumanArbitrationInTx(
  tx: Tx,
  ledger: ReturnType<typeof ledgerActor>,
  task: TaskRow,
  round: number,
  maxRounds: number,
  treeHash: string,
  reason: string,
): Promise<string | null> {
  const title = 'human arbitration required';
  const relatedRef = `review-arbitration:${task.code}:r${round}:${treeHash}`;
  const all = await listTaskItems(tx, task.id, { activeOnly: false });
  const prior = all.find((item) =>
    item.source === 'reviewer' &&
    item.type === 'risk' &&
    item.related_ref === relatedRef &&
    item.title.trim().toLowerCase().startsWith(title),
  );
  if (prior) return prior.code;

  // A model finding or another item may use the human-readable title. Avoid
  // colliding with the active-item dedup key while keeping the provenance ref
  // unique and machine-checkable for Gate rule 7.
  const titleCollision = all.some((item) =>
    ['open', 'blocked', 'awaiting_human'].includes(item.status) &&
    dedupKey(item.type, item.title) === dedupKey('risk', title),
  );
  const arbitrationTitle = titleCollision ? `${title} for review round ${round}` : title;
  const row = await createOpenItem(
    tx,
    ledger,
    task.code,
    {
      title: arbitrationTitle,
      detail: `Review round ${round} of ${maxRounds} requires a human decision. ${redactSecrets(reason).text}`.slice(0, 7900),
      type: 'risk',
      blocks_completion: true,
      related_ref: relatedRef,
    },
    'reviewer',
  );
  return row.code;
}

function mapFindingType(type: ReviewFinding['type']): ExecOpenItemType {
  return (type === 'unrecorded_decision' ? 'design_gap' : type) as ExecOpenItemType;
}

async function persistReviewFinding(
  tx: Tx,
  input: {
    runId: string;
    organizationId: string;
    projectId: string;
    scopeKey: string;
    finding: ReviewFinding;
  },
): Promise<string> {
  const id = newId();
  const { finding } = input;
  const fileEvidence = /^(?:file:)?(.+):([1-9]\d*)$/.exec(finding.evidence_ref);
  const file = fileEvidence?.[1] ?? `(ledger)/${finding.evidence_ref}`;
  const line = fileEvidence ? Number(fileEvidence[2]) : null;
  const fingerprint = computeFingerprint({
    projectId: input.projectId,
    category: finding.type,
    file,
    title: finding.title,
    evidence: finding.evidence_ref,
  });
  const result = await tx.insertInto('review_findings').values({
    id,
    organization_id: input.organizationId,
    project_id: input.projectId,
    run_id: input.runId,
    first_run_id: input.runId,
    last_seen_run_id: input.runId,
    scope_key: input.scopeKey,
    fingerprint,
    category: finding.type,
    severity: finding.blocks_completion ? 'high' : 'info',
    confidence: 1,
    file,
    line_start: line,
    line_end: line,
    title: finding.title,
    description: finding.why,
    why_it_matters: finding.why,
    suggestion: null,
    evidence: finding.evidence_ref,
    impact: null,
    effort: null,
    risk: finding.blocks_completion ? 'blocks completion' : null,
  }).onConflict((oc) => oc.columns(['project_id', 'scope_key', 'fingerprint']).doUpdateSet({
    run_id: input.runId,
    last_seen_run_id: input.runId,
    unseen_streak: 0,
    title: finding.title,
    description: finding.why,
    why_it_matters: finding.why,
    evidence: finding.evidence_ref,
    updated_at: new Date(),
  })).returning('id').executeTakeFirst();
  return result?.id ?? id;
}
