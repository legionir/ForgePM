import { z } from 'zod';
import {
  EXEC_TOUCH_CATEGORIES,
  EXEC_OPEN_ITEM_TYPES,
  EXEC_EVIDENCE_KINDS,
  EXEC_REQ_KINDS,
  EXEC_REQ_SOURCES,
  POLICY_CATEGORIES,
  EXEC_FACT_KINDS,
  EXEC_FACT_SOURCES,
  EXEC_BLOCKED_ON_KINDS,
} from './enums';

/**
 * Execution-control contracts (docs/EXECUTION_CONTROL_PLAN.md §7–§13, PE-0…PE-4).
 * Every MCP tool input is validated here; `.strict()` everywhere so an
 * agent cannot smuggle a `risk_level`/`status` override past the deterministic
 * policy and gate code (invariant I-4 / I-5).
 */

const CODE = /^[A-Z]{1,3}-\d{1,4}$/;
export const ledgerCodeSchema = z.string().regex(CODE, 'expected a ledger code such as T-001, OI-014, D-007');
export const idOrCodeSchema = z.string().min(3).max(64);

/** Vague wording that must never pass as a checkable criterion/requirement. */
export const AMBIGUOUS_WORDS = [
  'works well',
  'works fine',
  'properly',
  'robust',
  'secure enough',
  'clean code',
  'as needed',
  'etc',
  'and so on',
  'somehow',
  'best effort',
  'behave well',
  'به‌درستی',
  'خوب کار',
  'امن باشد',
  'سریع باشد',
  'تمیز',
  'بهینه باشد',
  'و غیره',
  'هر طور شده',
];

/** Tokens that make a statement measurable: a verb or a condition. */
export const CHECKABLE_MARKERS = [
  'must',
  'shall',
  'should',
  'returns',
  'responds',
  'fails',
  'passes',
  'rejects',
  'accepts',
  'displays',
  'creates',
  'deletes',
  'blocks',
  'throws',
  'contains',
  'equals',
  'is at most',
  'is at least',
  'does not',
  'never',
  'only when',
  'if ',
  'when ',
  '≤',
  '≥',
  '==',
  '>=',
  '<=',
  'باید',
  'نباید',
  'می‌کند',
  'می‌دهد',
  'برمی‌گرداند',
  'رد می‌کند',
  'قبول می‌کند',
  'نمایش داده',
  'ایجاد می‌شود',
  'حذف می‌شود',
  'مسدود',
  'اگر',
  'وقتی',
  'شرط',
];

/** A readable, verifiable reference the agent can point an auditor at. */
export const READABLE_REF_RE =
  /(test:[A-Za-z0-9_.\-/]+|file:[A-Za-z0-9_./-]+(:\d+)?|commit:[0-9a-f]{7,40}|cmd:[A-Za-z0-9_.\- :/]+|ui:[A-Za-z0-9_.\-/]+|\b[a-zA-Z0-9_./-]+\.(ts|tsx|js|jsx|py|go|java|sql|md|json|scss|html)\b)/;

export interface CheckableResult {
  ok: boolean;
  errors: string[];
  /** Actionable guidance the tool returns with the error (appendix §4). */
  needed_action: string | null;
  examples: string[];
}

const GOOD_EXAMPLES = [
  'POST /auth/token with a revoked refresh token returns 401 and writes an audit_event (file:apps/api/src/modules/auth/routes.ts)',
  'npm run test:integration must print "Tests  12 passed" with 0 failed (test:exec-gate.test.ts)',
];
const BAD_EXAMPLES = ['the feature works well', 'should be secure', 'کد تمیز باشد'];

/**
 * The one place that decides whether a criterion/requirement is checkable.
 * Deterministic by design (no LLM): length + a measurable verb/condition + a
 * readable reference + no vague wording.
 */
export function assessCheckable(text: string): CheckableResult {
  const t = (text ?? '').trim();
  const lower = t.toLowerCase();
  const errors: string[] = [];
  if (t.length < 25) errors.push(`too short (${t.length} chars; need >= 25)`);
  if (!CHECKABLE_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
    errors.push('no measurable verb or condition (must/shall/returns/fails/rejects/≤/≥/باید/نباید/…)');
  }
  if (AMBIGUOUS_WORDS.some((w) => lower.includes(w))) {
    errors.push('contains vague wording that cannot be verified');
  }
  if (!READABLE_REF_RE.test(t)) {
    errors.push('no readable reference (test:NAME | file:path[:line] | commit:sha | cmd:… | ui:… | a real file path)');
  }
  return {
    ok: errors.length === 0,
    errors,
    needed_action: errors.length
      ? 'rewrite the statement as an observable outcome with a reference, or ask the human (ledger_ask_human) when the expected behaviour is unknown'
      : null,
    examples: errors.length ? GOOD_EXAMPLES : BAD_EXAMPLES,
  };
}

/** 13-digit guard: an omitted "none" field is a hard error. */
export const noneConfirmedSchema = z.strictObject({
  incomplete: z.literal(true).optional(),
  assumptions: z.literal(true).optional(),
  decisions_made: z.literal(true).optional(),
  risks_found: z.literal(true).optional(),
  tests_not_run: z.literal(true).optional(),
  out_of_scope_findings: z.literal(true).optional(),
  req_ids_covered: z.literal(true).optional(),
  scope_deviations: z.literal(true).optional(),
});
export type NoneConfirmed = z.infer<typeof noneConfirmedSchema>;

/**
 * The "explicit none" rule (plan §C): a report must never silently omit an
 * array field, and an empty array must be confirmed as intentional. Kept as a
 * pure function (not a zod cross-field refinement) so it is trivially testable
 * and the error message can carry the actionable hint.
 */
export const NONE_CONFIRMED_FIELDS = [
  'incomplete',
  'assumptions',
  'decisions_made',
  'risks_found',
  'tests_not_run',
  'out_of_scope_findings',
  'req_ids_covered',
  'scope_deviations',
] as const;
export type NoneConfirmedField = (typeof NONE_CONFIRMED_FIELDS)[number];

export interface NoneRuleResult {
  ok: boolean;
  /** Present-but-empty arrays that lack their none_confirmed flag. */
  missing_confirmation: NoneConfirmedField[];
  /** Keys that are not arrays at all in the raw payload (field omitted). */
  missing_fields: string[];
  /** none_confirmed=true while the array is not empty. */
  contradictory: NoneConfirmedField[];
  needed_action: string | null;
}

export function checkNoneConfirmed(raw: Record<string, unknown>): NoneRuleResult {
  const none = (raw?.none_confirmed ?? {}) as Record<string, unknown>;
  const missing_confirmation: NoneConfirmedField[] = [];
  const missing_fields: string[] = [];
  const contradictory: NoneConfirmedField[] = [];
  for (const key of NONE_CONFIRMED_FIELDS) {
    if (!(key in raw)) {
      missing_fields.push(key);
      continue;
    }
    const val = raw[key];
    const arr = Array.isArray(val) ? val : null;
    if (arr === null) {
      missing_fields.push(key);
      continue;
    }
    if (arr.length === 0 && none[key] !== true && !missing_fields.includes(key)) missing_confirmation.push(key);
    if (arr.length > 0 && none[key] === true) contradictory.push(key);
  }
  const ok = missing_fields.length === 0 && missing_confirmation.length === 0 && contradictory.length === 0;
  return {
    ok,
    missing_confirmation,
    missing_fields,
    contradictory,
    needed_action: ok
      ? null
      : 'send every "none" field explicitly: [] with none_confirmed.<field>=true when nothing applies, or list the items (never drop the field)',
  };
}

const str3 = z.string().min(3).max(2000);
const str40 = z.string().min(40).max(8000);
/** Array fields are ALWAYS present; emptiness is confirmed by `none_confirmed`. */
const noneArray = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(200);

export const exitTestExecutedSchema = z
  .strictObject({
    name: z.string().min(3).max(300),
    result: z.enum(['pass', 'fail']),
    evidence_ref: idOrCodeSchema,
  });

export const exitTestNotRunSchema = z.strictObject({
  name: z.string().min(3).max(300),
  reason: z.string().min(20).max(2000),
  open_item_ref: idOrCodeSchema.optional(),
});

export const exitCriterionStatusSchema = z.strictObject({
  criterion_ref: idOrCodeSchema,
  evidence_refs: z.array(idOrCodeSchema).min(1),
});

export const exitReportSchema = z
  .strictObject({
    task_ref: idOrCodeSchema,
    summary: z.string().min(40).max(8000),
    changed_files: z.array(z.string().min(1).max(400)).max(500),
    completed_items: z.array(str3).max(200),
    incomplete: noneArray(str3),
    assumptions: noneArray(str3),
    decisions_made: noneArray(ledgerCodeSchema),
    risks_found: noneArray(str3),
    tests_executed: z.array(exitTestExecutedSchema).max(200),
    tests_not_run: noneArray(exitTestNotRunSchema),
    out_of_scope_findings: noneArray(str3),
    criteria_status: z.array(exitCriterionStatusSchema).max(100),
    req_ids_covered: noneArray(ledgerCodeSchema),
    scope_deviations: noneArray(z.string().min(3).max(500)),
    facts_recorded: z.array(ledgerCodeSchema).max(100).default([]),
    none_confirmed: noneConfirmedSchema.optional(),
  })
  .superRefine((r, ctx) => {
    // A criterion must be listed exactly once.
    const seen = new Set<string>();
    for (const c of r.criteria_status) {
      if (seen.has(c.criterion_ref)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `criterion ${c.criterion_ref} listed twice`, path: ['criteria_status'] });
      }
      seen.add(c.criterion_ref);
    }
  });
export type ExitReportInput = z.infer<typeof exitReportSchema>;

/** The six "must not be omitted" fields plus the two from the appendix. */
export const EXIT_REPORT_REQUIRED_ARRAYS = [
  'incomplete',
  'assumptions',
  'decisions_made',
  'risks_found',
  'tests_not_run',
  'out_of_scope_findings',
  'req_ids_covered',
  'scope_deviations',
] as const;

export const openItemInputSchema = z.strictObject({
  task_ref: idOrCodeSchema.optional(),
  title: z.string().min(5).max(500),
  detail: z.string().max(8000).optional(),
  type: z.enum(EXEC_OPEN_ITEM_TYPES),
  blocks_completion: z.boolean().optional(),
  why_not_blocking: z.string().min(40).max(2000).optional(),
  related_ref: z.string().max(200).optional(),
});
export type OpenItemInput = z.infer<typeof openItemInputSchema>;

/** Types whose default is blocking; un-blocking them needs a written reason. */
export const BLOCKING_BY_DEFAULT: ReadonlyArray<z.infer<typeof openItemInputSchema>['type']> = [
  'incomplete_requirement',
  'commitment',
];

export const resolveItemInputSchema = z.strictObject({
  item_ref: idOrCodeSchema,
  status: z.enum(['resolved', 'not_applicable', 'accepted', 'deferred', 'wont_fix', 'blocked', 'awaiting_human', 'open']),
  note: z.string().min(20).max(4000),
});

export const evidenceInputSchema = z
  .strictObject({
    criterion_ref: idOrCodeSchema.optional(),
    task_ref: idOrCodeSchema.optional(),
    kind: z.enum(EXEC_EVIDENCE_KINDS),
    ref: z.string().min(3).max(500),
    summary: z.string().min(20).max(4000),
    payload: z.string().max(131_072).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'manual_check') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'manual_check may only be recorded by a human (REST/CLI/panel)', path: ['kind'] });
    }
    if (v.kind === 'test_output' && !(v.payload && v.payload.length >= 200) && !/^ci:/.test(v.ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'test_output needs real output: payload >= 200 chars or ref "ci:<run_id>:<job>"',
        path: ['payload'],
      });
    }
  });
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

export const decisionInputSchema = z
  .strictObject({
    task_ref: idOrCodeSchema,
    title: z.string().min(5).max(500),
    context: z.string().min(20).max(8000),
    options: z.array(z.string().min(3).max(500)).min(2).max(20),
    selected: z.string().min(3).max(500),
    rationale: str40,
    reversible: z.boolean(),
    touches: z.array(z.enum(EXEC_TOUCH_CATEGORIES)).min(1).max(10),
    review_trigger: z.strictObject({ fact_codes: z.array(ledgerCodeSchema).optional(), req_codes: z.array(ledgerCodeSchema).optional() }).optional(),
    idempotency_key: z.string().min(8).max(64).optional(),
  })
  .superRefine((d, ctx) => {
    if (!d.options.some((o) => o === d.selected)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'selected must be one of options', path: ['selected'] });
    }
    if (d.touches.includes('none') && d.touches.length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "touches 'none' cannot be combined with other categories", path: ['touches'] });
    }
  });
export type DecisionInput = z.infer<typeof decisionInputSchema>;

export const questionInputSchema = z
  .strictObject({
    task_ref: idOrCodeSchema,
    question: z.string().min(10).max(2000),
    options: z.array(z.string().min(2).max(500)).min(2).max(10),
    recommendation: z.string().min(2).max(500),
    impact_per_option: z.array(z.string().min(20).max(1000)).optional(),
    why_it_matters: z.string().min(40).max(4000),
    blocking: z.boolean().default(true),
    kind: z.enum(['generic', 'scope_expansion', 'drop_requirement', 'waive_requirement', 'baseline_change']).default('generic'),
  })
  .superRefine((q, ctx) => {
    if (!q.options.includes(q.recommendation)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'recommendation must be one of options', path: ['recommendation'] });
    }
    if (!q.impact_per_option) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'impact_per_option is required (one consequence per option)', path: ['impact_per_option'] });
    } else if (q.impact_per_option.length !== q.options.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `impact_per_option needs exactly ${q.options.length} entries`, path: ['impact_per_option'] });
    }
  });
export type QuestionInput = z.infer<typeof questionInputSchema>;

export const requirementInputSchema = z
  .strictObject({
    text: z.string().min(10).max(4000),
    quote: z.string().min(3).max(4000),
    source: z.enum(EXEC_REQ_SOURCES),
    source_ref: z.string().max(500).optional(),
    kind: z.enum(EXEC_REQ_KINDS).default('functional'),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).default('medium'),
  })
  .superRefine((r, ctx) => {
    if (r.source === 'user_message' && !r.text.includes(r.quote)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'quote must be a verbatim excerpt of text (which must come from the user message)', path: ['quote'] });
    }
    if (r.source === 'agent_derived' && !r.source_ref) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'agent_derived requirements need source_ref explaining why they exist', path: ['source_ref'] });
    }
  });
export type RequirementInput = z.infer<typeof requirementInputSchema>;

export const factInputSchema = z
  .strictObject({
    key: z.string().min(3).max(120),
    value: z.string().min(5).max(4000),
    kind: z.enum(EXEC_FACT_KINDS),
    source: z.enum(EXEC_FACT_SOURCES),
    source_ref: z.string().max(500).optional(),
    files: z.array(z.string().min(1).max(400)).max(50).default([]),
  })
  .superRefine((f, ctx) => {
    if (f.kind === 'fact' && f.source === 'agent_guess') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a guess is not a fact: use kind='assumption', or cite source='code'/'tool_output'/'docs'/'human' with source_ref",
        path: ['source'],
      });
    }
    if (f.kind === 'fact' && (f.source === 'code' || f.source === 'tool_output') && !f.source_ref) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fact needs source_ref (file:line or the command that printed it)", path: ['source_ref'] });
    }
    if (f.kind === 'fact' && f.source === 'code' && f.files.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'code-sourced facts must list the files they were read from (so they can go stale)', path: ['files'] });
    }
  });
export type FactInput = z.infer<typeof factInputSchema>;

export const journalStartInputSchema = z.strictObject({
  task_ref: idOrCodeSchema,
  action: z.string().min(3).max(120),
  target: z.string().max(400).optional(),
  idempotent: z.boolean(),
  expected_effect: z.string().min(10).max(2000),
});

export const taskBlockInputSchema = z.strictObject({
  task_ref: idOrCodeSchema,
  reason: z.string().min(20).max(2000),
  blocked_on_kind: z.enum(EXEC_BLOCKED_ON_KINDS),
  blocked_on_ref: idOrCodeSchema.optional(),
  unblock_condition: z.string().min(10).max(1000),
}).superRefine((b, ctx) => {
  if ((b.blocked_on_kind === 'question' || b.blocked_on_kind === 'decision') && !b.blocked_on_ref) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `blocked_on_ref (${b.blocked_on_kind} code) is required`, path: ['blocked_on_ref'] });
  }
});

export const policyActionKindSchema = z.enum(POLICY_CATEGORIES);
export type PolicyActionKind = z.infer<typeof policyActionKindSchema>;

export const policyCheckInputSchema = z.strictObject({
  action_kind: policyActionKindSchema,
  command: z.string().max(2000).optional(),
  target: z.string().min(1).max(400),
  reversible: z.boolean().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------- risk policy

export const policyRuleSchema = z.strictObject({
  category: policyActionKindSchema,
  level: z.enum(['auto', 'review', 'approval', 'deny']),
  note: z.string().max(300).optional(),
});
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const execPolicySchema = z.strictObject({
  version: z.number().int().min(1).max(100),
  default_level: z.enum(['review', 'approval']).default('review'),
  irreversible_floor: z.enum(['review', 'approval']).default('review'),
  /** Force-pushing a protected branch is denied outright (plan §F "deny"). */
  /** Categories whose irreversible flag jumps straight to approval. */
  sensitive_for_irreversible: z.array(policyActionKindSchema).default([
    'public_api',
    'db_schema',
    'auth',
    'secret',
    'delete_data',
    'delete_file',
    'config_deploy',
    'ci',
    'migration',
    'destructive_command',
    'drop_requirement',
    'waive_requirement',
    'baseline_change',
    'scope_expansion',
  ]),
  rules: z.array(policyRuleSchema).min(1),
});
export type ExecPolicy = z.infer<typeof execPolicySchema>;

/** Baseline/evidence harness config (PE-8). `ci_log_endpoint`/`runner_image` etc. */
/** Default runner-output vocabulary; overridable per project via `exec.test_result_parser`. */
export const DEFAULT_TEST_PARSER = {
  pass: ['\\d+\\s+passed', '\\d+ passing', 'Tests\\s+\\d+\\s+passed'],
  fail: ['\\d+\\s+failed', '\\d+ failing', 'FAILED'],
  skip: ['\\d+\\s+skipped', '\\d+ pending'],
  test_line: '',
} as const;

/** Files whose tests must never disappear or be weakened (appendix §J.2). */
export const DEFAULT_PROTECTED_TEST_GLOBS = ['**/*.test.ts', '**/test/**/*.ts', '**/e2e/**/*.spec.ts'] as const;

export const execHarnessSchema = z.strictObject({
  test_command: z.string().max(2000),
  baseline_source: z.enum(['auto', 'ci', 'runner', 'off']).default('auto'),
  ci_log_endpoint: z.string().max(500).default(''),
  ci_log_secret_name: z.string().max(120).default(''),
  runner_enabled: z.boolean().default(false),
  runner_image: z.string().min(1).max(300).default('forgepm-runner:node22'),
  runner_network: z.enum(['none', 'registry-allowlist']).default('none'),
  runner_timeout_sec: z.number().int().min(10).max(1800).default(900),
  runner_max_output_bytes: z.number().int().min(1024).max(8_388_608).default(1_048_576),
  result_parser: z
    .strictObject({
      pass: z.array(z.string().max(200)).default([...DEFAULT_TEST_PARSER.pass]),
      fail: z.array(z.string().max(200)).default([...DEFAULT_TEST_PARSER.fail]),
      skip: z.array(z.string().max(200)).default([...DEFAULT_TEST_PARSER.skip]),
      test_line: z.string().max(200).default(''),
    })
    .default({ pass: [], fail: [], skip: [], test_line: '' }),
  protected_test_globs: z.array(z.string().max(200)).default([...DEFAULT_PROTECTED_TEST_GLOBS]),
});
export type ExecHarness = z.infer<typeof execHarnessSchema>;

/** Deterministic test-result extraction from a runner/CI log (PE-8 J.6b). */
export interface ParsedTestLog {
  totals: { pass: number; fail: number; skip: number };
  failures: string[];
  skipped: string[];
  names: string[];
  complete: boolean;
}

/** Test names we accept are vitest/jest style file + test titles. */
/** A per-test result line, e.g. "✓ auth > logs in (12ms)" or "  file.test.ts > name ×". */
const TEST_MARK = /(?:^|\s)[✓✗×√•]\s*(.+?)\s*(?:\(\d+(?:\.\d+)?m?s\))?\s*$|(?:✓|✗|×)\s*(.*)$/;

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
/** Removes terminal colour codes so a log can be matched/diffed deterministically. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** The count belonging to a summary keyword, e.g. "Tests  2 passed | 1 failed (3)". */
function numIn(line: string, keyword: 'passed' | 'failed' | 'skipped'): number {
  const word = keyword === 'skipped' ? 'skipped' : keyword === 'failed' ? 'failed|failing' : 'passed|passing';
  let best = 0;
  for (const m of line.matchAll(new RegExp('(\\d+)\\s*(?:\\S+\\s+){0,2}?(?:' + word + ')\\b', 'gi'))) best = Math.max(best, Number(m[1]));
  for (const m of line.matchAll(new RegExp('(?:' + word + ')\\s*[:=]?\\s*(\\d+)', 'gi'))) best = Math.max(best, Number(m[1]));
  return best;
}

export function parseTestLog(log: string, parser?: { pass?: string[]; fail?: string[]; skip?: string[]; test_line?: string }): ParsedTestLog {
  const text = stripAnsi(log);
  const lines = text.split(/\r?\n/);
  const passRe = (parser?.pass?.length ? parser.pass : ['Tests\\s+\\d+\\s+passed', '\\d+ passing']).map((p) => new RegExp(p, 'i'));
  const failRe = (parser?.fail?.length ? parser.fail : ['\\d+ failed', 'failing', 'FAILED']).map((p) => new RegExp(p, 'i'));
  const skipRe = (parser?.skip?.length ? parser.skip : ['\\d+ skipped', 'pending']).map((p) => new RegExp(p, 'i'));
  let pass = 0;
  let fail = 0;
  let skip = 0;
  const failures: string[] = [];
  const skipped: string[] = [];
  const names: string[] = [];
  for (const line of lines) {
    if (passRe.some((re) => re.test(line))) pass = Math.max(pass, numIn(line, 'passed'));
    if (failRe.some((re) => re.test(line))) {
      fail = Math.max(fail, numIn(line, 'failed'));
      if (failures.length < 50) failures.push(line.trim().slice(0, 300));
    }
    if (skipRe.some((re) => re.test(line))) skip = Math.max(skip, numIn(line, 'skipped'));
    const marked = TEST_MARK.exec(line);
    const name = (marked?.[1] ?? marked?.[2] ?? '').replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, '').trim();
    if (name && !/\d+\s+(passed|failed|skipped)/i.test(line) && names.length < 5000 && !names.includes(name)) names.push(name.slice(0, 300));
  }
  return {
    totals: { pass, fail, skip },
    failures,
    skipped,
    names,
    complete: pass + fail > 0 && lines.some((l) => /Test Files|Tests\s+\d|passed/i.test(l)),
  };
}

/** Assertion/skip weakening heuristic (deterministic, PE-8 J.3). */
export interface TestFileWeakening {
  path: string;
  assertionsBefore: number;
  assertionsAfter: number;
  countDelta: number;
  addedModifiers: string[];
}

const ASSERTION_RE = /\b(?:expect\s*\(|assert\s*[(.]|assertEquals\s*\()/g;
const MODIFIER_RE = /\b(?:\.skip\b|\.only\b|\bxit\s*\(|\bxdescribe\s*\(|\b@Ignore\b|\bskip\s*:\s*true)/g;

export function countAssertions(src: string): number {
  return (src.match(ASSERTION_RE) ?? []).length;
}

export function findTestModifiers(src: string): string[] {
  return [...new Set([...src.matchAll(MODIFIER_RE)].map((m) => m[0].trim()))];
}

export function detectWeakening(before: string, after: string, path: string): TestFileWeakening | null {
  const a = countAssertions(before);
  const b = countAssertions(after);
  const mods = findTestModifiers(after).filter((m) => !before.includes(m));
  if (a === b && mods.length === 0) return null;
  return { path, assertionsBefore: a, assertionsAfter: b, countDelta: b - a, addedModifiers: mods };
}
