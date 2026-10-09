import {
  SEVERITY_ORDER,
  normalizeWs,
  type Hunk,
  type RawFinding,
  type ReviewConfig,
  type ReviewInput,
  type SnapshotFile,
} from './contract';

/**
 * Finding evidence validation (plan §10): a finding survives only when its
 * file/line range/evidence matches the ACTUAL content of the run's commit
 * snapshot; for Code Review the range must also fall inside the PR diff hunks.
 * Invalid findings are discarded and counted in `run.stats.discarded`.
 */

function fileAt(snapshot: SnapshotFile[], path: string): SnapshotFile | undefined {
  return snapshot.find((f) => f.path === path);
}

function evidenceMatches(lines: string[], expected: string): boolean {
  const want = normalizeWs(expected);
  if (!want) return true;
  // evidence may span several consecutive lines; compare a whitespace-
  // normalised join of every window of the declared size, plus single lines.
  const wantLines = expected.split('\n').filter((l) => l.trim().length > 0).map(normalizeWs);
  const joined = lines.map(normalizeWs);
  if (wantLines.length <= 1) return joined.some((l) => l === want || (want.length > 8 && l.includes(want)));
  for (let i = 0; i + wantLines.length <= joined.length; i++) {
    if (joined.slice(i, i + wantLines.length).join(' ') === wantLines.join(' ')) return true;
  }
  return false;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Pure evidence + range check for one finding; kind drives the hunk rule. */
export function validateEvidence(
  kind: 'code' | 'refactor',
  f: RawFinding,
  input: ReviewInput,
  opts: { requireInHunks?: boolean } = {},
): ValidationResult {
  if (f.confidence < 0 || f.confidence > 1) return { ok: false, reason: 'confidence out of range' };
  const evLines = (f.evidence ?? '').split('\n').filter((l) => l.trim().length > 0);
  if (evLines.length > 20) return { ok: false, reason: 'evidence longer than 20 lines' };

  const file = fileAt(input.snapshot, f.file);
  if (!file) return { ok: false, reason: 'file not in commit snapshot' };

  const start = f.line_start ?? null;
  const end = f.line_end ?? start;
  if (start !== null) {
    if (start < 1 || end === null || end > file.lines.length || start > end) {
      return { ok: false, reason: 'line range outside snapshot file' };
    }
    if (f.evidence && !evidenceMatches(file.lines.slice(start - 1, end), f.evidence)) {
      return { ok: false, reason: 'evidence does not match snapshot lines' };
    }
  } else if (f.evidence) {
    // no range: evidence must still exist somewhere in the file.
    if (!evidenceMatches(file.lines, f.evidence)) return { ok: false, reason: 'evidence not found in snapshot file' };
  }

  if (kind === 'code' && (opts.requireInHunks ?? true)) {
    const hunks: Hunk[] = input.hunks.filter((h) => h.file === f.file);
    if (hunks.length === 0) return { ok: false, reason: 'file not part of the PR diff' };
    if (start === null) return { ok: false, reason: 'code finding needs a line range inside a hunk' };
    const inside = hunks.some((h) => h.start <= start && start <= h.start + h.lines.length);
    if (!inside) return { ok: false, reason: 'line range outside diff hunks' };
  }
  return { ok: true };
}

/** Split provider output into kept (valid + confidence) and discarded. */
export function partitionFindingWrites(
  kind: 'code' | 'refactor',
  findings: RawFinding[],
  input: ReviewInput,
  config: ReviewConfig,
): { kept: RawFinding[]; discarded: number; lowConfidence: number } {
  let discarded = 0;
  let lowConfidence = 0;
  const minSev = config.min_severity ?? 'info';
  const kept = findings.filter((f) => {
    if (f.confidence < config.min_confidence) {
      lowConfidence += 1;
      return false;
    }
    if (kind === 'refactor' && SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[minSev]) return false;
    const v = validateEvidence(kind, f, input);
    if (!v.ok) {
      discarded += 1;
      return false;
    }
    return true;
  });
  return { kept, discarded, lowConfidence };
}
