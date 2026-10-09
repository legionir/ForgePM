import { getEffective } from '../settings';
import { settingDefault } from '../settings-registry';
import type { DbLike, Db } from '../db/unitOfWork';
import type { ReviewConfig, ReviewSeverity } from './contract';

/**
 * Resolve the effective review config for one run (plan §10): shared keys come
 * from the single `review.*` registry; module-specific keys only from the
 * owning module prefix. Priority project ← organization ← system ← registry
 * default (getEffective returns undefined when no row exists at any level).
 */
async function eff(db: DbLike, key: string, orgId: string, projectId: string | null): Promise<unknown> {
  const hit = await getEffective(db as Db, key, orgId, projectId);
  return hit ? hit.value : settingDefault(key);
}

export async function resolveReviewConfig(
  db: DbLike,
  kind: 'code' | 'refactor',
  orgId: string,
  projectId: string | null,
): Promise<ReviewConfig> {
  const cfg: ReviewConfig = {
    issue_policy: (await eff(db, 'review.issue_policy', orgId, projectId)) as ReviewConfig['issue_policy'],
    min_confidence: (await eff(db, 'review.min_confidence', orgId, projectId)) as number,
    auto_run: (await eff(db, 'review.auto_run', orgId, projectId)) as boolean,
    max_attempts: (await eff(db, 'review.max_attempts', orgId, projectId)) as number,
    max_cost_tokens: ((await eff(db, 'review.max_cost_tokens', orgId, projectId)) as number) || null,
    github_output: (await eff(db, 'review.github_output', orgId, projectId)) as ReviewConfig['github_output'],
    ignore_globs: (await eff(db, 'review.ignore_globs', orgId, projectId)) as string[],
  };
  if (kind === 'code') {
    cfg.max_diff_bytes = (await eff(db, 'code_review.max_diff_bytes', orgId, projectId)) as number;
    cfg.skip_drafts = (await eff(db, 'code_review.skip_drafts', orgId, projectId)) as boolean;
    cfg.custom_rules = ((await eff(db, 'code_review.custom_rules', orgId, projectId)) as string) || null;
  } else {
    cfg.min_severity = (await eff(db, 'refactor_review.min_severity', orgId, projectId)) as ReviewSeverity;
    cfg.max_files_per_run = (await eff(db, 'refactor_review.max_files_per_run', orgId, projectId)) as number;
    cfg.categories = (await eff(db, 'refactor_review.categories', orgId, projectId)) as string[];
  }
  return cfg;
}
