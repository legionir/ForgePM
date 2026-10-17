import { createHash } from 'node:crypto';
/**
 * Adversarial-reviewer input assembly + output validation
 * (docs/EXECUTION_CONTROL_PLAN.md §12, plan §E). Isolation is enforced here:
 * the builder accepts ONLY the five documented inputs and refuses anything that
 * looks like conversation history (acceptance E.1).
 */

export interface ReviewInputParts {
  user_request: { code: string; text: string; quote: string }[];
  criteria: { code: string; text: string; status: string; evidence: { ref: string; kind: string; ok: boolean }[] }[];
  diff: { path: string; change: 'A' | 'M' | 'D' | 'R'; patch?: string }[];
  ledger_status: unknown;
  exit_report: unknown;
  requirements?: { code: string; text: string; covered_by: string[] }[];
  scope_verdict?: unknown;
  baseline_verdict?: unknown;
  stale_facts?: { code: string; key: string }[];
}

const FORBIDDEN_KEYS = /(^|_)(messages|conversation|chat|transcript|agent_history|reasoning|scratchpad|dialog)(_|$)/i;

export interface BuiltReviewInput {
  prompt: string;
  meta: { sections: string[]; bytes: number; sha256: string; excluded: string[] };
}

export function buildReviewInput(parts: ReviewInputParts, maxBytes = 400_000): BuiltReviewInput {
  for (const k of Object.keys(parts)) if (FORBIDDEN_KEYS.test(k)) {
    throw new Error(`review input key '${k}' is not allowed (the reviewer must not see conversation history)`);
  }
  const sections: string[] = [
    section('ORIGINAL USER REQUEST(S) — the contract you check against', parts.user_request, 'user_request'),
    section('ACCEPTANCE CRITERIA + EVIDENCE', parts.criteria, 'criteria'),
    section('REQUIREMENTS COVERAGE (independent of the agent plan)', parts.requirements ?? [], 'requirements'),
    section('DIFF (the only source of what actually changed)', renderDiff(parts.diff), 'diff'),
    section('LEDGER STATUS', parts.ledger_status, 'ledger_status'),
    section('EXIT REPORT', parts.exit_report, 'exit_report'),
    section('SCOPE CHECK (code-computed)', parts.scope_verdict ?? { available: false }, 'scope'),
    section('BASELINE CHECK (code-computed)', parts.baseline_verdict ?? { available: false }, 'baseline'),
    section('STALE FACTS', parts.stale_facts ?? [], 'stale_facts'),
  ];
  const body = sections.join('\n\n');
  const excluded: string[] = [];
  let prompt = REVIEWER_PREAMBLE + body;
  // The cap is absolute: a reviewer prompt bigger than the budget is cut (and
  // the caller is told), never silently sent whole.
  if (Buffer.byteLength(prompt, 'utf8') > maxBytes) {
    const marker = '\n…[truncated at ' + maxBytes + ' bytes — set a smaller diff scope]';
    const keep = Buffer.from(prompt, 'utf8').subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))).toString('utf8').replace(/\uFFFD+$/, '');
    prompt = keep + marker;
    excluded.push('overflow beyond maxBytes');
  }
  return {
    prompt,
    meta: {
      sections: ['user_request', 'criteria', 'requirements', 'diff', 'ledger_status', 'exit_report', 'scope', 'baseline', 'stale_facts'],
      bytes: Buffer.byteLength(prompt, 'utf8'),
      sha256: createHash('sha256').update(prompt).digest('hex'),
      excluded,
    },
  };
}

function section(title: string, value: unknown, key?: string): string {
  return `## ${key ? `[${key}] ` : ''}${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}`;
}

function renderDiff(files: ReviewInputParts['diff']): string {
  if (!files.length) return '(no changed files measured — this itself is a finding)';
  return files.map((f) => `--- ${f.change} ${f.path}\n${f.patch ?? '(patch unavailable)'}`).join('\n');
}

export const REVIEWER_PREAMBLE = `You are an adversarial reviewer. Assume this work is incomplete and your job is to prove it.
Do not trust prose claims; trust only the diff and the evidence. You have NO access to the
implementing agent's conversation, and you must not ask for it.
Every finding must cite a concrete witness (file:line, a criterion code, or a ledger code);
a finding without a witness is invalid. Separate real defects from optional suggestions and
never make a suggestion blocking. If you find nothing, list what you checked.
Answer with JSON only, matching:
{"verdict":"pass"|"fail","checked":[...],"findings":[{"title":...,"type":"incomplete_requirement|commitment|assumption|bug|risk|test_gap|design_gap|unrecorded_decision|out_of_scope|suggestion","blocks_completion":bool,"evidence_ref":"file:line | C-id | OI-id","why":...}]}

`;

// ---------------------------------------------------------------- validation

export const REVIEW_FINDING_TYPES = [
  'incomplete_requirement',
  'commitment',
  'assumption',
  'bug',
  'risk',
  'test_gap',
  'design_gap',
  'unrecorded_decision',
  'out_of_scope',
  'suggestion',
] as const;

export interface ReviewFinding {
  title: string;
  type: (typeof REVIEW_FINDING_TYPES)[number];
  blocks_completion: boolean;
  evidence_ref: string;
  why: string;
}

export interface ReviewVerdict {
  verdict: 'pass' | 'fail';
  checked: string[];
  findings: ReviewFinding[];
}

export type ReviewParse = { ok: true; value: ReviewVerdict; retried: false } | { ok: false; errors: string[] };

/** Accepts strict JSON only; a witness is mandatory; optional findings are never blocking. */
export function parseReviewOutput(raw: string): ReviewParse {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return { ok: false, errors: ['output is not valid JSON'] };
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  if (o.verdict !== 'pass' && o.verdict !== 'fail') errors.push('verdict must be "pass" or "fail"');
  if (!Array.isArray(o.checked) || o.checked.length === 0) errors.push('checked must be a non-empty list (a clean verdict must say what was inspected)');
  if (!Array.isArray(o.findings)) errors.push('findings must be an array (empty when nothing was found)');
  const findings: ReviewFinding[] = [];
  if (Array.isArray(o.findings)) {
    o.findings.forEach((f, i) => {
      const x = (f ?? {}) as Record<string, unknown>;
      const at = `findings[${i}]`;
      if (typeof x.title !== 'string' || x.title.trim().length < 5) errors.push(`${at}.title missing/too short`);
      if (!(REVIEW_FINDING_TYPES as readonly unknown[]).includes(x.type)) errors.push(`${at}.type must be one of ${REVIEW_FINDING_TYPES.join('|')}`);
      if (typeof x.evidence_ref !== 'string' || !/^\S+/.test(String(x.evidence_ref ?? ''))) errors.push(`${at}.evidence_ref is required (a finding without a witness is not a finding)`);
      if (typeof x.why !== 'string' || x.why.trim().length < 20) errors.push(`${at}.why needs >= 20 chars`);
      const blocking = x.blocks_completion === true;
      if (x.type === 'suggestion' && blocking) errors.push(`${at}: optional suggestions may not block completion`);
      if (errors.length === 0) {
        findings.push({
          title: String(x.title),
          type: x.type as ReviewFinding['type'],
          blocks_completion: x.type === 'suggestion' ? false : blocking,
          evidence_ref: String(x.evidence_ref),
          why: String(x.why),
        });
      }
    });
  }
  if (errors.length) return { ok: false, errors };
  const value: ReviewVerdict = {
    verdict: o.verdict as 'pass' | 'fail',
    checked: (o.checked as unknown[]).map(String),
    findings,
  };
  // Consistency: a fail verdict must have at least one finding; a blocking
  // finding forces a fail verdict (so a sloppy "pass" cannot smuggle a blocker).
  if (value.findings.some((f) => f.blocks_completion) && value.verdict !== 'fail') {
    return { ok: false, errors: ['a blocking finding requires verdict="fail"'] };
  }
  if (value.verdict === 'fail' && value.findings.length === 0) {
    return { ok: false, errors: ['verdict "fail" requires at least one finding with a witness'] };
  }
  return { ok: true, value, retried: false };
}

function stripFences(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s ?? '');
  return (m ? m[1] : s).trim();
}
