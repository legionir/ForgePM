import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Review engine contracts (plan §10). Shared verbatim by Code Review (kind
 * `code`, scope `pr:<repo>:<n>`) and Refactor Review (kind `refactor`, scope
 * `repo:<repo>`): the run, the finding structure, the fingerprint and the
 * effective-config shape. Persisted + validated here so both modules — and
 * the worker — apply identical semantics.
 */

export const REVIEW_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
export const SEVERITY_ORDER: Record<ReviewSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export const REVIEW_RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'truncated', 'canceled'] as const;
export type ReviewRunStatus = (typeof REVIEW_RUN_STATUSES)[number];

export const REVIEW_FINDING_STATUSES = ['open', 'dismissed', 'accepted', 'issue_created', 'not_seen', 'fixed'] as const;
export type ReviewFindingStatus = (typeof REVIEW_FINDING_STATUSES)[number];

/** One diff hunk; `lines` are the changed ('+'-prefixed) source lines. */
export const hunkSchema = z.object({
  file: z.string().min(1).max(500),
  start: z.number().int(),
  lines: z.array(z.string().max(4000)).max(2000),
});
export type Hunk = z.infer<typeof hunkSchema>;

/** A file as it exists at the run's commit snapshot (evidence validation). */
export const snapshotFileSchema = z.object({
  path: z.string().min(1).max(500),
  lines: z.array(z.string().max(4000)).max(20000),
});
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;

export const reviewInputSchema = z.object({
  hunks: z.array(hunkSchema).default([]),
  snapshot: z.array(snapshotFileSchema).default([]),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

/** Raw provider finding (pre-validation); evidence ≤ 20 lines is enforced. */
export const rawFindingSchema = z.object({
  category: z.string().min(1).max(60),
  severity: z.enum(REVIEW_SEVERITIES),
  confidence: z.number().min(0).max(1),
  file: z.string().min(1).max(500),
  line_start: z.number().int().nullable().optional(),
  line_end: z.number().int().nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(4000),
  why_it_matters: z.string().max(4000).nullable().optional(),
  suggestion: z.string().max(4000).nullable().optional(),
  evidence: z.string().max(8000).nullable().optional(),
  impact: z.string().max(4000).nullable().optional(),
  effort: z.string().max(4000).nullable().optional(),
  risk: z.string().max(4000).nullable().optional(),
});
export type RawFinding = z.infer<typeof rawFindingSchema>;

export const reviewStageOutputSchema = z.object({ findings: z.array(rawFindingSchema).max(200) });
export type ReviewStageOutput = z.infer<typeof reviewStageOutputSchema>;

/** Effective `review.*` config for one run (project ← organization ← system). */
export interface ReviewConfig {
  issue_policy: 'record_only' | 'human_approval' | 'auto_high_severity';
  min_confidence: number;
  auto_run: boolean;
  max_attempts: number;
  max_cost_tokens: number | null;
  github_output: 'off' | 'summary' | 'inline';
  ignore_globs: string[];
  // module-specific (only the owning prefix supplies them)
  max_diff_bytes?: number;
  skip_drafts?: boolean;
  custom_rules?: string | null;
  min_severity?: ReviewSeverity;
  categories?: string[];
  max_files_per_run?: number;
}

/** Normalise whitespace runs to single spaces (evidence/line comparison). */
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Normalised title for the fingerprint: case/space/punct-insensitive. */
export function normalizeTitle(t: string): string {
  return normalizeWs(t.toLowerCase()).replace(/[^\w ]+/g, '');
}

/** Fingerprint is line-number independent (plan §10): file + category + normalized title + evidence hash. */
export function computeFingerprint(parts: {
  projectId: string;
  category: string;
  file: string;
  title: string;
  evidence: string | null;
}): string {
  const ev = parts.evidence ? createHash('sha256').update(normalizeWs(parts.evidence)).digest('hex') : '';
  return createHash('sha256')
    .update(`${parts.projectId}|${parts.category}|${parts.file}|${normalizeTitle(parts.title)}|${ev}`)
    .digest('hex');
}

export function codeScopeKey(repositoryId: string, prNumber: number): string {
  return `pr:${repositoryId}:${prNumber}`;
}

export function repoScopeKey(repositoryId: string): string {
  return `repo:${repositoryId}`;
}

/** Simple fnmatch-lite glob for `review.ignore_globs` (`**`, `*`, literal). */
export function matchGlob(pattern: string, path: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('**')
        .map((seg) =>
          seg
            .split('*')
            .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.'))
            .join('[^/]*'),
        )
        .join('.*') +
      '$',
  );
  return re.test(path);
}

export function isIgnored(globs: string[], path: string): boolean {
  return globs.some((g) => matchGlob(g, path));
}
