import { createHash } from 'node:crypto';
import { parseTestLog } from '@forgepm/shared';

/**
 * Evidence verification (docs/EXECUTION_CONTROL_PLAN.md §9.1, acceptance B.10).
 * A claim without a real, readable pointer is rejected here — in code, not in a
 * prompt. `fs` is injected so the logic is unit-testable and never touches the
 * network/host outside the allowed roots.
 */

export type EvidenceKind = 'test_output' | 'diff' | 'file' | 'command_output' | 'manual_check';

export interface EvidenceFsLike {
  exists(path: string): boolean;
  read(path: string): string | null;
}

export interface EvidenceCheckInput {
  kind: EvidenceKind;
  ref: string;
  summary: string;
  payload?: string;
  actorType: 'agent' | 'human' | 'system';
  parser?: { pass: string[]; fail: string[]; skip: string[] };
  roots: string[];
  fs: EvidenceFsLike;
  maxBytes?: number;
}

export interface EvidenceCheckResult {
  ok: boolean;
  code?: 'EVIDENCE_INVALID' | 'EVIDENCE_UNAVAILABLE' | 'SCOPE_VIOLATION' | 'VALIDATION_ERROR';
  message?: string;
  needed_action?: string;
  sha256?: string;
  size_bytes?: number;
  meta?: Record<string, unknown>;
}

const RESULT_HINT =
  /(\b\d+\s+(passed|passing|failed|failing|skipped)\b|\bTests\s+\d|\bTest Files\s+\d|✓|✗|×|FAIL|OK\b)/i;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** `path:…` and `commit:<sha>:path` are the two file-addressable ref shapes. */
export function parseRef(ref: string): {
  kind: 'file' | 'commit' | 'ci' | 'cmd' | 'test' | 'unknown';
  path?: string;
  sha?: string;
  run?: string;
  job?: string;
  test?: string;
  line?: number;
} {
  let m = /^ci:([^:\s]+)(?::([^\s]+))?$/.exec(ref);
  if (m) return { kind: 'ci', run: m[1], job: m[2] };
  m = /^cmd:(.+)$/.exec(ref);
  if (m) return { kind: 'cmd', test: m[1].trim() };
  m = /^test:(.+)$/.exec(ref);
  if (m) return { kind: 'test', test: m[1].trim() };
  m = /^commit:([0-9a-f]{7,40}):(.+)$/.exec(ref);
  if (m) return { kind: 'commit', sha: m[1], path: m[2] };
  m = /^(?:path:|file:)(.+?)(?::(\d+))?$/.exec(ref);
  if (m) return { kind: 'file', path: m[1], line: m[2] ? Number(m[2]) : undefined };
  // bare path with an extension counts too (agents forget the prefix)
  if (/^[\w./-]+\.[A-Za-z]{1,6}(:\d+)?$/.test(ref)) {
    const [p, line] = ref.split(':');
    return { kind: 'file', path: p, line: line ? Number(line) : undefined };
  }
  return { kind: 'unknown' };
}

/** Prefix-safe containment: `/repos/for` must not match `/repos/foreign`. */
export function underRoot(path: string, roots: readonly string[]): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  const clean = path.replace(/^\.\//, '');
  if (clean.startsWith('..') || clean.includes('/../') || clean.startsWith('/') || clean.includes('\\')) return false;
  return roots.some((r) => (r && clean === norm(r)) || clean.startsWith(`${norm(r)}/`));
}

export function checkEvidence(input: EvidenceCheckInput): EvidenceCheckResult {
  const max = input.maxBytes ?? 131_072;
  const summary = (input.summary ?? '').trim();
  if (summary.length < 20) {
    return invalid(
      'summary too short',
      `a summary of at least 20 chars that states WHAT was observed (got ${summary.length})`,
    );
  }
  if (input.kind === 'manual_check' && input.actorType === 'agent') {
    return invalid(
      'manual_check may only be recorded by a human',
      'attach real output instead (test_output / command_output), or ask the human to record the check',
    );
  }

  const ref = parseRef(input.ref ?? '');
  let meta: Record<string, unknown> = { ref_kind: ref.kind };

  if (ref.kind === 'unknown') {
    return invalid(
      `ref '${input.ref}' is not readable by an auditor`,
      'use file:<path>[:line] | commit:<sha>:<path> | ci:<run_id>:<job> | test:<name> | cmd:<command>',
    );
  }

  // File-addressable refs must exist inside an allowed root.
  if (ref.kind === 'file' && ref.path) {
    if (!underRoot(ref.path, input.roots)) {
      return {
        ...invalid(
          `ref path '${ref.path}' is outside exec.allowed_repo_roots`,
          'point at a file inside a configured repo root',
        ),
        code: 'SCOPE_VIOLATION',
      };
    }
    if (!input.fs.exists(ref.path))
      return {
        ...invalid(
          `ref path '${ref.path}' does not exist`,
          'run the thing you claim; a path to a missing file is not evidence',
        ),
        code: 'EVIDENCE_UNAVAILABLE',
      };
    meta.sha256_file = undefined;
    const body = input.fs.read(ref.path);
    if (body === null)
      return {
        ...invalid(`ref path '${ref.path}' is not readable`, 'ensure the file is inside a mounted root'),
        code: 'EVIDENCE_UNAVAILABLE',
      };
    meta.sha256_file = sha256(body);
    meta.bytes_file = Buffer.byteLength(body);
  }
  if (ref.kind === 'commit' && ref.sha) meta.commit_sha = ref.sha;

  const payload = input.payload ?? '';
  const size = Buffer.byteLength(payload);
  if (size > max) {
    return invalid(
      `payload is ${size} bytes (max ${max})`,
      'store the output where the ref points (journal/CI log) and reference it instead of pasting',
    );
  }

  if (input.kind === 'test_output') {
    if (!payload && ref.kind !== 'ci') {
      return invalid(
        'test_output has no real output',
        'paste the command output (>= 200 chars) or reference a CI run: ref="ci:<run_id>:<job>"',
      );
    }
    if (payload) {
      if (payload.length < 200)
        return invalid(
          'test_output payload is too short to be real output',
          'include the CI log excerpt summary lines, not a paraphrase',
        );
      if (!RESULT_HINT.test(payload))
        return invalid(
          'test_output payload has no result line',
          'the output must contain the summary line (e.g. "Tests 12 passed")',
        );
      const counts = extractCounts(payload, input.parser);
      meta = { ...meta, ...counts };
      if (counts.failed > 0) meta.note = 'evidence records failures; the gate will still block on them (rule 6)';
    }
  }
  if (input.kind === 'command_output') {
    if (!payload && ref.kind !== 'cmd')
      return invalid('command_output needs output or a cmd: ref', 'ref="cmd:<journal id>" if the run was journalled');
    if (payload && payload.length < 200 && summary.length < 40) {
      return invalid(
        'command_output is a bare claim',
        'add >= 200 chars of output, or a summary >= 40 chars describing what it proves',
      );
    }
  }
  if (input.kind === 'diff' && !payload) {
    if (ref.kind !== 'commit')
      return invalid('diff evidence needs a commit ref or the diff text', 'ref="commit:<sha>:path" or paste the diff');
  }

  return {
    ok: true,
    sha256: payload ? sha256(payload) : (meta.sha256_file as string),
    size_bytes: size || (meta.bytes_file as number) || 0,
    meta,
  };
}

export function extractCounts(
  payload: string,
  parser?: { pass: string[]; fail: string[]; skip: string[] },
): { passed: number; failed: number; skipped: number } {
  // One parser for every log we read: the shared implementation is the tested one.
  const p = parseTestLog(payload, parser);
  return { passed: p.totals.pass, failed: p.totals.fail, skipped: p.totals.skip };
}

function invalid(message: string, needed_action: string): EvidenceCheckResult {
  return { ok: false, code: 'EVIDENCE_INVALID', message, needed_action };
}

/** Secrets must never be stored in the ledger (acceptance B.16). */
const SECRET_PATTERNS = [
  /fpm_[a-z0-9]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // `password: "…"`, `token = '…'` — a quoted value of a secret-sounding key.
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)(\s*[:=]\s*)"[^"]{8,}"/gi,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)(\s*[:=]\s*)'[^']{8,}'/gi,
  // unquoted `token=<12+ chars>` (tokens in the wild are never human-readable words)
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)(\s*[:=]\s*)[^\s"',;]{12,}/gi,
] as const;

export function redactSecrets(text: string): { text: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      hits += 1;
      return `[redacted:${m.slice(0, 4)}…]`;
    });
  }
  return { text: out, hits };
}
