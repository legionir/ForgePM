import { z } from 'zod';
import { DEFAULT_PROTECTED_TEST_GLOBS, DEFAULT_TEST_PARSER, execPolicySchema, type ExecPolicy } from '@forgepm/shared';

/**
 * Settings registry (plan §5.7): every settable key has a schema, default and
 * category. Values resolve project <- organization <- system (core/settings).
 * Later phases append their keys here; `modules.<name>.enabled` keys are
 * pattern-registered and always boolean.
 */
import { EXEC_POLICY_DEFAULT, validatePolicyShape } from './exec/policy';

export interface SettingDefinition {
  key: string;
  schema: z.ZodTypeAny;
  default: unknown;
  category: string;
  secret?: boolean;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'approval_policy',
    schema: z.enum(['manual', 'auto_low_risk']),
    default: 'manual',
    category: 'planner',
  },
  {
    key: 'planner.max_context_tokens',
    schema: z.number().int().min(1_000).max(1_000_000),
    default: 32_000,
    category: 'planner',
  },
  {
    key: 'planner.max_items_per_plan',
    schema: z.number().int().min(1).max(200),
    default: 200,
    category: 'planner',
  },
  { key: 'timezone.default', schema: z.string().min(1), default: 'Asia/Tehran', category: 'localization' },
  { key: 'locale.default', schema: z.enum(['en', 'fa']), default: 'en', category: 'localization' },
  {
    key: 'review.issue_policy',
    schema: z.enum(['record_only', 'human_approval', 'auto_high_severity']),
    default: 'record_only',
    category: 'review',
  },
  { key: 'review.min_confidence', schema: z.number().min(0).max(1), default: 0.6, category: 'review' },
  { key: 'review.auto_run', schema: z.boolean(), default: false, category: 'review' },
  { key: 'review.max_attempts', schema: z.number().int().min(1).max(10), default: 2, category: 'review' },
  { key: 'review.max_cost_tokens', schema: z.number().int().min(0), default: 0, category: 'review' },
  { key: 'review.github_output', schema: z.enum(['off', 'summary', 'inline']), default: 'off', category: 'review' },
  {
    key: 'review.ignore_globs',
    schema: z.array(z.string().min(1).max(200)),
    default: [
      '**/package-lock.json',
      '**/pnpm-lock.yaml',
      '**/yarn.lock',
      'dist/**',
      '**/*.min.js',
      '**/*.generated.*',
    ],
    category: 'review',
  },
  // code_review.* module-specific keys (the shared `review.*` registry above is
  // the single source for both modules; redeclaring those under a module prefix
  // is rejected at the route layer — plan §10).
  {
    key: 'code_review.max_diff_bytes',
    schema: z.number().int().min(1024).max(8_388_608),
    default: 204_800,
    category: 'review',
  },
  { key: 'code_review.skip_drafts', schema: z.boolean(), default: true, category: 'review' },
  { key: 'code_review.custom_rules', schema: z.string().max(8000), default: '', category: 'review' },
  // refactor_review.* module-specific keys
  {
    key: 'refactor_review.min_severity',
    schema: z.enum(['info', 'low', 'medium', 'high', 'critical']),
    default: 'medium',
    category: 'review',
  },
  {
    key: 'refactor_review.max_files_per_run',
    schema: z.number().int().min(1).max(50_000),
    default: 5_000,
    category: 'review',
  },
  {
    key: 'refactor_review.categories',
    schema: z.array(z.string().min(1).max(60)),
    default: ['architecture', 'duplication', 'complexity', 'dependency', 'maintainability'],
    category: 'review',
  },
  { key: 'mcp.rate_limit_per_minute', schema: z.number().int().min(1).max(10_000), default: 120, category: 'mcp' },
  { key: 'mcp.client.enabled', schema: z.boolean(), default: false, category: 'mcp' },
  { key: 'github.auto_transition_on_merge', schema: z.boolean(), default: false, category: 'github' },
  {
    key: 'github.issue_sync_mode',
    schema: z.enum(['off', 'import', 'export', 'two_way']),
    default: 'off',
    category: 'github',
  },
  { key: 'network.allow_private_targets', schema: z.boolean(), default: false, category: 'security' },
  { key: 'ai.store_prompts', schema: z.boolean(), default: false, category: 'ai' },
  { key: 'ai.daily_token_budget', schema: z.number().int().min(0), default: 0, category: 'ai' },
  {
    key: 'approval.auto_operations',
    schema: z.array(z.string()),
    default: ['work_item.create', 'work_item.update_content', 'work_item.comment', 'work_item.link'],
    category: 'approval',
  },
  { key: 'approval.auto_rate_limit_per_hour', schema: z.number().int().min(1), default: 100, category: 'approval' },
  { key: 'retention.audit_days', schema: z.number().int().min(1), default: 365, category: 'retention' },
  { key: 'retention.job_days', schema: z.number().int().min(1), default: 30, category: 'retention' },
  { key: 'retention.ai_call_days', schema: z.number().int().min(1), default: 90, category: 'retention' },
  { key: 'retention.webhook_days', schema: z.number().int().min(1), default: 30, category: 'retention' },
  // ---- execution control (docs/EXECUTION_CONTROL_PLAN.md §4.1) ----
  { key: 'exec.policy', schema: execPolicySchema, default: EXEC_POLICY_DEFAULT, category: 'execution' },
  { key: 'exec.test_command', schema: z.string().max(2000), default: '', category: 'execution' },
  {
    key: 'exec.test_result_parser',
    schema: z
      .object({
        pass: z.array(z.string()).default([]),
        fail: z.array(z.string()).default([]),
        skip: z.array(z.string()).default([]),
        test_line: z.string().default(''),
      })
      .passthrough(),
    default: { ...DEFAULT_TEST_PARSER },
    category: 'execution',
  },
  {
    key: 'exec.protected_test_globs',
    schema: z.array(z.string().min(1).max(200)).max(50),
    default: [...DEFAULT_PROTECTED_TEST_GLOBS],
    category: 'execution',
  },
  {
    key: 'exec.allowed_repo_roots',
    schema: z.array(z.string().min(1).max(400)).max(20),
    default: [],
    category: 'execution',
  },
  { key: 'exec.baseline_source', schema: z.enum(['auto', 'ci', 'off']), default: 'auto', category: 'execution' },
  { key: 'exec.ci_log_endpoint', schema: z.string().max(500), default: '', category: 'execution' },
  { key: 'exec.ci_log_secret_name', schema: z.string().max(120), default: '', category: 'execution' },
  {
    key: 'exec.evidence_max_bytes',
    schema: z.number().int().min(1024).max(1_048_576),
    default: 131_072,
    category: 'execution',
  },
  {
    key: 'exec.session_output_max_bytes',
    schema: z.number().int().min(1024).max(262_144),
    default: 8192,
    category: 'execution',
  },
  {
    key: 'exec.tool_output_max_bytes',
    schema: z.number().int().min(1024).max(1_048_576),
    default: 16_384,
    category: 'execution',
  },
  { key: 'exec.max_review_rounds', schema: z.number().int().min(1).max(2), default: 2, category: 'execution' },
  { key: 'exec.require_review_for_done', schema: z.boolean(), default: true, category: 'execution' },
  { key: 'exec.block_transition_when_gate_fails', schema: z.boolean(), default: true, category: 'execution' },
  { key: 'exec.stale_check_on_start', schema: z.boolean(), default: true, category: 'execution' },
  { key: 'exec.max_cost_tokens', schema: z.number().int().min(0), default: 0, category: 'execution' },
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((d) => [d.key, d]));

/** Module lifecycle flags are pattern-registered: modules.<name>.enabled. */
const MODULE_ENABLED_RE = /^modules\.[a-z0-9_]+\.enabled$/;

/**
 * Plan §10: `review.*` is one shared registry for both review modules; a
 * module may only define keys under its own prefix and may NOT redeclare a
 * shared key there (routes must reject with 422, not silently accept).
 */
const SHARED_REVIEW_SUFFIXES = SETTING_DEFINITIONS.filter((d) => d.key.startsWith('review.')).map((d) =>
  d.key.slice('review.'.length),
);

export function isReviewKeyRedeclaration(key: string): boolean {
  const m = /^(?:code_review|refactor_review)\.([a-z_]+)$/.exec(key);
  return !!m && SHARED_REVIEW_SUFFIXES.includes(m[1]);
}

export function isKnownSettingKey(key: string): boolean {
  return BY_KEY.has(key) || MODULE_ENABLED_RE.test(key);
}

export function findSettingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

export function validateSettingValue(
  key: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (MODULE_ENABLED_RE.test(key)) {
    const r = z.boolean().safeParse(value);
    return r.success ? { ok: true, value: r.data } : { ok: false, message: 'value must be boolean' };
  }
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, message: `unknown setting key '${key}'` };
  const r = def.schema.safeParse(value);
  if (!r.success) {
    return { ok: false, message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  if (key === 'exec.policy') {
    const problems = validatePolicyShape(r.data as ExecPolicy);
    if (problems.length) return { ok: false, message: problems.join('; ') };
  }
  return { ok: true, value: r.data };
}

export function settingDefault(key: string): unknown {
  if (MODULE_ENABLED_RE.test(key)) return false; // optional modules default disabled
  return BY_KEY.get(key)?.default;
}
