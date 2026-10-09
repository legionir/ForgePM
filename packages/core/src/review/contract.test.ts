import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  computeFingerprint,
  normalizeTitle,
  normalizeWs,
  matchGlob,
  isIgnored,
  codeScopeKey,
  repoScopeKey,
  partitionFindingWrites,
  validateEvidence,
  shouldCreateWorkItem,
  reviewInputSchema,
  type ReviewConfig,
} from '../index';

// snapshot: 11 filler lines, then alpha..eta at lines 12..18, then fillers.
const input = reviewInputSchema.parse({
  hunks: [{ file: 'src/a.ts', start: 12, lines: ['alpha();', 'beta();', 'gamma();', 'delta();', 'epsilon();', 'zeta();', 'eta();'] }],
  snapshot: [{ path: 'src/a.ts', lines: [...Array.from({ length: 11 }, (_, i) => `f${i}`), 'alpha();', 'beta();', 'gamma();', 'delta();', 'epsilon();', 'zeta();', 'eta();', 'tail'] }],
});

const base = {
  category: 'security',
  severity: 'high' as const,
  confidence: 0.9,
  file: 'src/a.ts',
  title: 'Missing check',
  description: 'desc',
};

const cfg: ReviewConfig = {
  issue_policy: 'record_only',
  min_confidence: 0.6,
  auto_run: false,
  max_attempts: 2,
  max_cost_tokens: null,
  github_output: 'off',
  ignore_globs: ['**/pnpm-lock.yaml', 'dist/**', '**/*.min.js'],
};

describe('review contract helpers', () => {
  it('fingerprint is line-number independent but content sensitive', () => {
    const f1 = computeFingerprint({ projectId: 'p', category: 'c', file: 'a.ts', title: 'Fix This!', evidence: 'foo bar' });
    const f2 = computeFingerprint({ projectId: 'p', category: 'c', file: 'a.ts', title: 'fix this', evidence: 'foo    bar' });
    const f3 = computeFingerprint({ projectId: 'p', category: 'c', file: 'a.ts', title: 'fix this', evidence: 'totally different' });
    expect(f1).toBe(f2); // normalized title + whitespace
    expect(f1).not.toBe(f3);
    expect(normalizeTitle('  Fix This!! ')).toBe(normalizeTitle('fix this'));
    expect(normalizeWs('a   b')).toBe('a b');
  });

  it('scope keys follow plan §10 formats', () => {
    expect(codeScopeKey('r1', 42)).toBe('pr:r1:42');
    expect(repoScopeKey('r1')).toBe('repo:r1');
  });

  it('ignore globs match lockfiles/dist/minified only', () => {
    expect(isIgnored(cfg.ignore_globs, 'web/pnpm-lock.yaml')).toBe(true);
    expect(isIgnored(cfg.ignore_globs, 'dist/bundle.js')).toBe(true);
    expect(matchGlob('vendor/**', 'vendor/x/y.js')).toBe(true);
    expect(isIgnored(cfg.ignore_globs, 'src/app.ts')).toBe(false);
  });
});

describe('evidence validation (plan §10)', () => {
  it('accepts a code finding inside a hunk with matching evidence', () => {
    const v = validateEvidence('code', { ...base, line_start: 12, line_end: 13, evidence: 'alpha();\nbeta();' }, input);
    expect(v.ok).toBe(true);
  });

  it('rejects a file outside the snapshot', () => {
    const v = validateEvidence('code', { ...base, file: 'src/zombie.ts', line_start: 12, evidence: 'alpha();' }, input);
    expect(v.ok).toBe(false);
  });

  it('rejects a line range outside the file', () => {
    const v = validateEvidence('code', { ...base, line_start: 99, line_end: 120, evidence: 'alpha();' }, input);
    expect(v.ok).toBe(false);
  });

  it('rejects evidence that does not match the actual lines', () => {
    const v = validateEvidence('code', { ...base, line_start: 12, line_end: 13, evidence: 'nothing(); similar();' }, input);
    expect(v.ok).toBe(false);
  });

  it('rejects a code range outside the diff hunks', () => {
    const v = validateEvidence('code', { ...base, line_start: 2, line_end: 3, evidence: `f1\nf2` }, input);
    expect(v.ok).toBe(false);
  });

  it('refactor findings validate against the snapshot, no hunk needed', () => {
    const v = validateEvidence('refactor', { ...base, line_start: 12, line_end: 13, evidence: 'alpha();\nbeta();' }, input);
    expect(v.ok).toBe(true);
  });

  it('rejects evidence longer than 20 lines', () => {
    const long = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n');
    const v = validateEvidence('refactor', { ...base, line_start: 1, line_end: 10, evidence: long }, input);
    expect(v.ok).toBe(false);
  });

  it('partitionFindingWrites drops invalid + low-confidence, counts them', () => {
    const kept = { ...base, line_start: 12, line_end: 13, evidence: 'alpha();\nbeta();' };
    const badEvidence = { ...base, title: 'Bad', line_start: 12, evidence: 'wrong();' };
    const lowConf = { ...base, title: 'Meh', confidence: 0.2, line_start: 12, evidence: 'alpha();' };
    const out = partitionFindingWrites('code', [kept, badEvidence, lowConf], input, cfg);
    expect(out.kept).toHaveLength(1);
    expect(out.discarded).toBe(1);
    expect(out.lowConfidence).toBe(1);
  });

  it('refactor min_severity filter applies', () => {
    const low = { ...base, severity: 'low' as const, line_start: 3, line_end: 4, evidence: 'alpha();\nbeta();' };
    const out = partitionFindingWrites('refactor', [low], input, { ...cfg, min_severity: 'medium' });
    expect(out.kept).toHaveLength(0);
  });
});

describe('issue policy eligibility (plan §10)', () => {
  const eligible = { ...base, severity: 'critical' as const, confidence: 0.95 };
  it('only auto_high_severity creates', () => {
    expect(shouldCreateWorkItem(eligible, 'code', { ...cfg, issue_policy: 'record_only' })).toBe(false);
    expect(shouldCreateWorkItem(eligible, 'code', { ...cfg, issue_policy: 'human_approval' })).toBe(false);
    expect(shouldCreateWorkItem(eligible, 'code', { ...cfg, issue_policy: 'auto_high_severity' })).toBe(true);
  });
  it('severity ≥ high with kind-specific confidence floor', () => {
    const auto = { ...cfg, issue_policy: 'auto_high_severity' } as ReviewConfig;
    expect(shouldCreateWorkItem({ ...base, severity: 'medium', confidence: 0.99 }, 'code', auto)).toBe(false);
    expect(shouldCreateWorkItem({ ...base, severity: 'high', confidence: 0.75 }, 'code', auto)).toBe(false); // < 0.8
    expect(shouldCreateWorkItem({ ...base, severity: 'high', confidence: 0.84 }, 'refactor', auto)).toBe(false); // < 0.85
    expect(shouldCreateWorkItem({ ...base, severity: 'high', confidence: 0.85 }, 'refactor', auto)).toBe(true);
  });
});

describe('review stage output schema', () => {
  it('requires the mandatory finding fields', () => {
    const schema = z.object({ findings: z.array(z.object({ category: z.string(), severity: z.string(), confidence: z.number(), file: z.string(), title: z.string(), description: z.string() })) });
    expect(() => schema.parse({ findings: [{ category: 'x' }] })).toThrow();
    expect(schema.parse({ findings: [{ category: 'x', severity: 'high', confidence: 0.5, file: 'a', title: 't', description: 'd' }] }).findings).toHaveLength(1);
  });
});
