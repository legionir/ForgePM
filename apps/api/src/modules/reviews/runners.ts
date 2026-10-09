import { createHash } from 'node:crypto';
import { AppError } from '@forgepm/shared';
import {
  newId,
  toJsonb,
  recordAudit,
  unitOfWork,
  resolveReviewProvider,
  resolveReviewConfig,
  createRun,
  executeReviewRun,
  getRunReport,
  partitionFiles,
  analyzeRepoFiles,
  structureIndexJson,
  selectFiles,
  isCodeFile,
  incrementalScope,
  type Db,
  type RunInput,
  type ReviewConfig,
} from '@forgepm/core';
import type { Actor } from '../../app/auth-context';
import { assertProjectAccess } from '../projects/access';
import {
  filterCodeInput,
  buildRefactorReviewInput,
  scopeKeyForCode,
  scopeKeyForRepo,
  assertRepoInProject,
  type CodeReviewInput,
  type RefactorReviewInput,
} from './service';

/**
 * Review runners (plan §10): assemble a validated RunInput from the request,
 * then hand it to the shared core engine. Execution is inline (same pattern as
 * planner /generate); webhook-driven runs use the identical engine through the
 * worker handler. The provider comes from the org's configured ai_providers —
 * `fake` in every offline test — so nothing here touches the network.
 * Module gating (503 MODULE_DISABLED) happens in routes before this file runs.
 */

export interface StartResult {
  run_id: string;
  status: string;
  stats: Record<string, unknown>;
}

async function providerOrThrow(orgId: string, runId: string) {
  const p = await resolveReviewProvider(orgId, runId);
  if (!p) throw new AppError('VALIDATION_ERROR', 'no AI provider configured (add one in Settings → AI Providers)');
  return p;
}

export async function startCodeReview(db: Db, actor: Actor, input: CodeReviewInput): Promise<StartResult> {
  await assertProjectAccess(db, actor, input.project_id, 'review:run');
  await assertRepoInProject(db, actor.organizationId, input.project_id, input.repository_id);

  const config = await resolveReviewConfig(db, 'code', actor.organizationId, input.project_id);
  if (input.draft && config.skip_drafts) {
    return { run_id: '', status: 'skipped_draft', stats: {} };
  }
  const filtered = filterCodeInput(input, config.ignore_globs ?? [], config.max_diff_bytes ?? 204_800);
  const runInput: RunInput = {
    projectId: input.project_id,
    organizationId: actor.organizationId,
    repositoryId: input.repository_id,
    scopeKey: scopeKeyForCode(input.repository_id, input.pr_number),
    kind: 'code',
    target: { pr: input.pr_number, commit_sha: input.commit_sha },
    review: filtered.review,
    draft: input.draft,
    customRules: config.custom_rules ?? null,
    truncated: filtered.truncated,
  };
  return runEngine(db, actor, 'code', runInput, config, input.project_id, input.repository_id);
}

export async function startRefactorReview(db: Db, actor: Actor, input: RefactorReviewInput): Promise<StartResult> {
  await assertProjectAccess(db, actor, input.project_id, 'review:run');
  await assertRepoInProject(db, actor.organizationId, input.project_id, input.repository_id);

  const config = await resolveReviewConfig(db, 'refactor', actor.organizationId, input.project_id);
  const maxFiles = config.max_files_per_run ?? 5_000;
  const codeFiles = input.files.filter((f) => isCodeFile(f.path));

  // Deterministic AI-free analysis over the WHOLE submitted repo, stored once
  // per commit_sha (plan §10.6.2) for incremental runs.
  const idx = analyzeRepoFiles(codeFiles);
  await storeStructureIndex(db, actor, input.repository_id, input.commit_sha, idx, codeFiles);

  // Incremental (plan §10.6.5): changed files + direct neighbours only.
  let scopePaths = codeFiles.map((f) => f.path);
  if (input.changed_since_sha) {
    const changed = await changedPathsSince(db, input.repository_id, input.changed_since_sha, codeFiles);
    if (changed) scopePaths = incrementalScope(changed, idx.imports.edges);
  }

  // Partitioned staged analysis (plan §10.6.4): cursor advances per run and
  // wraps when the whole scope is covered.
  const scoped = codeFiles.filter((f) => scopePaths.includes(f.path));
  const { groups } = partitionFiles(scoped, maxFiles);
  const cursor = await nextPartitionCursor(db, actor.organizationId, input.project_id, input.repository_id, groups.length);
  const batch = groups[cursor] ?? [];
  const batchFiles = selectFiles(scoped, batch);

  const runInput: RunInput = {
    projectId: input.project_id,
    organizationId: actor.organizationId,
    repositoryId: input.repository_id,
    scopeKey: scopeKeyForRepo(input.repository_id),
    kind: 'refactor',
    target: { commit_sha: input.commit_sha, partition_cursor: cursor, incremental: !!input.changed_since_sha },
    review: buildRefactorReviewInput(batchFiles),
    structure: structureIndexJson(idx),
    partitionCursor: (cursor + 1) % Math.max(1, groups.length),
  };
  return runEngine(db, actor, 'refactor', runInput, config, input.project_id, input.repository_id);
}

async function runEngine(
  db: Db,
  actor: Actor,
  kind: 'code' | 'refactor',
  runInput: RunInput,
  config: ReviewConfig,
  projectId: string,
  repositoryId: string,
): Promise<StartResult> {
  const runId = await createRun(db, {
    organizationId: actor.organizationId,
    projectId,
    repositoryId,
    kind,
    target: runInput.target,
    configSnapshot: config,
  });
  // persist the validated input on the run (helper column; re-runs and the
  // worker path reuse it without re-fetching code).
  await db
    .updateTable('review_runs')
    .set({ input: toJsonb({ hunks: runInput.review.hunks, snapshot: runInput.review.snapshot, structure: runInput.structure ?? null }) as never } as never)
    .where('id', '=', runId)
    .execute();

  const provider = await providerOrThrow(actor.organizationId, runId);
  const outcome = await executeReviewRun(db, {
    runId,
    input: runInput,
    config,
    provider,
    actorId: actor.id,
    actorType: actor.type === 'agent' ? 'agent' : 'user',
    requestId: actor.requestId,
  });
  return { run_id: outcome.run_id, status: outcome.status, stats: outcome.stats };
}

/** Store the structure index (unique per repository+commit); overwrite on rerun. */
async function storeStructureIndex(
  db: Db,
  actor: Actor,
  repositoryId: string,
  commitSha: string,
  idx: ReturnType<typeof analyzeRepoFiles>,
  files: { path: string; content: string }[],
): Promise<void> {
  const json = structureIndexJson(idx);
  const hashes = Object.fromEntries(files.map((f) => [f.path, sha1(f.content)]));
  const stats = toJsonb({ file_hashes: hashes, files: idx.files, loc: idx.loc });
  await unitOfWork(db, async ({ tx }) => {
    await tx
      .insertInto('code_structure_index')
      .values({ id: newId(), repository_id: repositoryId, commit_sha: commitSha, index: toJsonb(json) as never, stats: stats as never })
      .onConflict((oc) => oc.columns(['repository_id', 'commit_sha']).doUpdateSet({ index: toJsonb(json) as never, stats: stats as never } as never))
      .execute();
    await recordAudit(tx, {
      organization_id: actor.organizationId,
      actor_type: actor.type === 'agent' ? 'agent' : 'user',
      actor_id: actor.id,
      action: 'review.structure_index',
      resource_type: 'code_structure_index',
      resource_id: repositoryId,
      summary: { commit_sha: commitSha, files: idx.files, loc: idx.loc },
      request_id: actor.requestId,
    });
  });
}

async function changedPathsSince(db: Db, repositoryId: string, fromSha: string, files: { path: string; content: string }[]): Promise<string[] | null> {
  const prev = await db
    .selectFrom('code_structure_index')
    .select('stats')
    .where('repository_id', '=', repositoryId)
    .where('commit_sha', '=', fromSha)
    .executeTakeFirst();
  if (!prev) return null;
  const stats = (prev.stats ?? {}) as { file_hashes?: Record<string, string> };
  const old = stats.file_hashes ?? {};
  const now = new Map(files.map((f) => [f.path, sha1(f.content)]));
  const changed: string[] = [];
  for (const [p, h] of now) if (old[p] !== h) changed.push(p);
  for (const p of Object.keys(old)) if (!now.has(p)) changed.push(p);
  return changed;
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

/** The newest refactor run's stats carry the next partition cursor (plan §10.6.4). */
async function nextPartitionCursor(db: Db, orgId: string, projectId: string, repositoryId: string, groupCount: number): Promise<number> {
  const r = await db
    .selectFrom('review_runs')
    .select('stats')
    .where('organization_id', '=', orgId)
    .where('project_id', '=', projectId)
    .where('repository_id', '=', repositoryId)
    .where('kind', '=', 'refactor')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc') // uuid v7: time-ordered tie-breaker
    .limit(1)
    .executeTakeFirst();
  const stats = (r?.stats ?? {}) as { partition_cursor?: number };
  const raw = Number(stats.partition_cursor ?? 0);
  return groupCount > 0 ? raw % groupCount : 0;
}

export async function runReport(db: Db, organizationId: string, runId: string): Promise<Record<string, unknown>> {
  const r = await getRunReport(db, organizationId, runId);
  if (!r) throw new AppError('NOT_FOUND', 'review run not found');
  return r;
}
