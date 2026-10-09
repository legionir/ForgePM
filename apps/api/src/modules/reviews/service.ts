import { z } from 'zod';
import { AppError } from '@forgepm/shared';
import {
  type Db,
  type ReviewInput,
  reviewInputSchema,
  codeScopeKey,
  repoScopeKey,
  isIgnored,
  computeFingerprint,
} from '@forgepm/core';

/**
 * Reviews domain service (plan §10) — the ONLY writer path for review data in
 * the api. REST and MCP both call these functions. Everything is validated at
 * the boundary (zod), scoped to the actor's organization, and audited by the
 * shared engine.
 */

export const codeReviewInputSchema = z.object({
  project_id: z.string().uuid(),
  repository_id: z.string().uuid(),
  pr_number: z.number().int().min(1),
  commit_sha: z.string().max(80),
  draft: z.boolean().default(false),
  hunks: z.array(z.object({ file: z.string().max(500), start: z.number().int(), lines: z.array(z.string().max(4000)).max(2000) })).max(500).default([]),
  snapshot: z.array(z.object({ path: z.string().max(500), lines: z.array(z.string().max(4000)).max(20000) })).max(500).default([]),
  idempotency_key: z.string().min(8).max(120).optional(),
});
export type CodeReviewInput = z.infer<typeof codeReviewInputSchema>;

export const refactorReviewInputSchema = z.object({
  project_id: z.string().uuid(),
  repository_id: z.string().uuid(),
  commit_sha: z.string().max(80),
  files: z.array(z.object({ path: z.string().max(500), content: z.string().max(1_048_576) })).max(20_000),
  changed_since_sha: z.string().max(80).nullable().optional(),
  idempotency_key: z.string().min(8).max(120).optional(),
});
export type RefactorReviewInput = z.infer<typeof refactorReviewInputSchema>;

/** Filter ignored paths + enforce max_diff_bytes with logical-before-docs order. */
export function filterCodeInput(input: CodeReviewInput, ignoreGlobs: string[], maxDiffBytes: number): { review: ReviewInput; truncated: boolean; droppedFiles: string[] } {
  const dropped: string[] = [];
  const hunks = input.hunks.filter((h) => {
    if (isIgnored(ignoreGlobs, h.file)) {
      dropped.push(h.file);
      return false;
    }
    return true;
  });
  // priority order: logical code before tests before docs (plan §10.6.1.2)
  const rank = (f: string): number => (/\b(tests?|__tests__)\b/.test(f) ? 1 : /\.(md|txt|rst)$|\/docs?\//.test(f) ? 2 : 0);
  const ordered = [...hunks].sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file));
  let budget = maxDiffBytes;
  const kept = [];
  let truncated = false;
  for (const h of ordered) {
    const size = h.lines.join('\n').length;
    if (size > budget) {
      truncated = true;
      break;
    }
    budget -= size;
    kept.push(h);
  }
  const keepFiles = new Set(kept.map((h) => h.file));
  const snapshot = input.snapshot.filter((f) => keepFiles.has(f.path));
  return { review: reviewInputSchema.parse({ hunks: kept, snapshot }), truncated, droppedFiles: dropped };
}

/** Build the ReviewInput (snapshot lines) from refactor files. */
export function buildRefactorReviewInput(files: { path: string; content: string }[]): ReviewInput {
  return reviewInputSchema.parse({
    hunks: [],
    snapshot: files.map((f) => ({ path: f.path, lines: f.content.split('\n').slice(0, 20000) })),
  });
}

export function scopeKeyForCode(repositoryId: string, prNumber: number): string {
  return codeScopeKey(repositoryId, prNumber);
}

export function scopeKeyForRepo(repositoryId: string): string {
  return repoScopeKey(repositoryId);
}

export function fingerprintOf(projectId: string, f: { category: string; file: string; title: string; evidence?: string | null }): string {
  return computeFingerprint({ projectId, category: f.category, file: f.file, title: f.title, evidence: f.evidence ?? null });
}

/** Guard: repository must belong to the actor's org and be linked to project. */
export async function assertRepoInProject(db: Db, organizationId: string, projectId: string, repositoryId: string): Promise<void> {
  const repo = await db
    .selectFrom('repositories')
    .select('id')
    .where('id', '=', repositoryId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst();
  if (!repo) throw new AppError('NOT_FOUND', 'repository not found');
  const link = await db
    .selectFrom('project_repositories')
    .select('project_id')
    .where('project_id', '=', projectId)
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst();
  if (!link) throw new AppError('VALIDATION_ERROR', 'repository is not connected to this project');
}
