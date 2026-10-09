import { z } from 'zod';

/**
 * Settings registry (plan §5.7): every settable key has a schema, default and
 * category. Values resolve project <- organization <- system (core/settings).
 * Later phases append their keys here; `modules.<name>.enabled` keys are
 * pattern-registered and always boolean.
 */
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
  { key: 'mcp.rate_limit_per_minute', schema: z.number().int().min(1).max(10_000), default: 120, category: 'mcp' },
  { key: 'mcp.client.enabled', schema: z.boolean(), default: false, category: 'mcp' },
  { key: 'github.auto_transition_on_merge', schema: z.boolean(), default: false, category: 'github' },
  {
    key: 'github.issue_sync_mode',
    schema: z.enum(['off', 'import']),
    default: 'off',
    category: 'github',
  },
  { key: 'network.allow_private_targets', schema: z.boolean(), default: false, category: 'security' },
  { key: 'ai.store_prompts', schema: z.boolean(), default: false, category: 'ai' },
  { key: 'retention.audit_days', schema: z.number().int().min(1), default: 365, category: 'retention' },
  { key: 'retention.job_days', schema: z.number().int().min(1), default: 30, category: 'retention' },
  { key: 'retention.ai_call_days', schema: z.number().int().min(1), default: 90, category: 'retention' },
  { key: 'retention.webhook_days', schema: z.number().int().min(1), default: 30, category: 'retention' },
  { key: 'retention.mcp_call_days', schema: z.number().int().min(1), default: 30, category: 'retention' },
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((d) => [d.key, d]));

/** Module lifecycle flags are pattern-registered: modules.<name>.enabled. */
const MODULE_ENABLED_RE = /^modules\.[a-z0-9_]+\.enabled$/;

export function isKnownSettingKey(key: string): boolean {
  return BY_KEY.has(key) || MODULE_ENABLED_RE.test(key);
}

export function findSettingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

export function validateSettingValue(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (MODULE_ENABLED_RE.test(key)) {
    const r = z.boolean().safeParse(value);
    return r.success ? { ok: true, value: r.data } : { ok: false, message: 'value must be boolean' };
  }
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, message: `unknown setting key '${key}'` };
  const r = def.schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

export function settingDefault(key: string): unknown {
  if (MODULE_ENABLED_RE.test(key)) return false; // optional modules default disabled
  return BY_KEY.get(key)?.default;
}
