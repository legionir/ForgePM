import type { ExecPolicy, ExecRiskLevel, PolicyRule, PolicyCategory } from '@forgepm/shared';

/**
 * Risk policy engine (docs/EXECUTION_CONTROL_PLAN.md §10 / plan §F).
 * Pure and deterministic: the agent never chooses its own level, and the level
 * is never a prompt concern — the table below is the single source of truth and
 * is overridable through the `exec.policy` setting (no code change needed).
 */

export const GATE_VERSION = 1;

export const LEVEL_ORDER: Record<ExecRiskLevel, number> = { auto: 0, review: 1, approval: 2, deny: 3 };

/**
 * Hard floor, NOT part of the editable table: exposing secrets and destroying
 * the workspace root are never allowed, whatever the project configures.
 * (Appendix §1.5/§F: "deny" must not be downgradeable by configuration.)
 */
export const HARD_DENY_CATEGORIES = ['secret', 'write_secret', 'delete_root_folder'] as const;

/** Commands denied even when `destructive_command` is only configured to approval. */
const ROOT_RM = String.raw`(?:^|\s|;)\s*(?:sudo\s+)?rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$|[;)])`;
const FORCE_PUSH = String.raw`\bgit\s+push\b(?:[^\n]*\s--force(-with-lease)?\s+\+\S+|[^\n]*\s--force(-with-lease)?(?:\s|$)[^\n]*\s\+\S*|[^\n]*\s-f\b[^\n]*\s\+)`;
/**
 * Two hard denials, independent of the editable table (plan §F "deny"):
 * recursive deletion of the filesystem root, and a forced refspec push
 * (`+ref:...`), which rewrites published history.
 */
export const HARD_DENY_COMMANDS: readonly RegExp[] = [new RegExp(ROOT_RM, 'i'), new RegExp(FORCE_PUSH, 'i')];

/** Categories where `reversible: false` jumps straight to approval (rule: "sensitive"). */
export const SENSITIVE_FOR_IRREVERSIBLE = [
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
  'rename_bulk',
  'scope_expansion',
  'drop_requirement',
  'waive_requirement',
  'baseline_change',
  'deps_add',
  'rename_bulk',
] as const;

const r = (category: PolicyCategory, level: ExecRiskLevel, note: string): PolicyRule => ({ category, level, note });

/** The default table = plan §F rows + appendix §1.5 rows. */
export const EXEC_POLICY_DEFAULT: ExecPolicy = {
  version: 1,
  default_level: 'review',
  irreversible_floor: 'review',
  sensitive_for_irreversible: [...SENSITIVE_FOR_IRREVERSIBLE] as PolicyCategory[],
  rules: [
    r('internal_edit', 'auto', 'edit inside one function/file; rename an internal symbol'),
    r('add_test', 'auto', 'adding or extending tests'),
    r('add_module', 'review', 'new function/module in the existing contract'),
    r('local_bugfix', 'review', 'local bug fix'),
    r('default_change', 'review', 'changing an internal default value'),
    r('deps_upgrade', 'review', 'dependency upgrade'),
    r('deps_add', 'review', 'dependency add (irreversible ⇒ approval)'),
    r('cancel_subtask', 'review', 'cancelling a subtask'),
    r('public_api', 'approval', 'public API contract / exported signature change'),
    r('db_schema', 'approval', 'database schema / migration'),
    r('auth', 'approval', 'authentication, authorization, secret handling'),
    r('delete_data', 'approval', 'deleting data'),
    r('delete_file', 'approval', 'deleting a file or a capability'),
    r('config_deploy', 'approval', 'deployment configuration'),
    r('ci', 'approval', 'CI configuration'),
    r('migration', 'approval', 'data/schema migration'),
    r('destructive_command', 'approval', 'shell command with destructive potential'),
    r('rename_bulk', 'approval', 'bulk rename across modules'),
    r('scope_expansion', 'approval', 'widening a task allowed_paths'),
    r('drop_requirement', 'approval', 'dropping a requirement'),
    r('waive_requirement', 'approval', 'waiving a criterion or requirement'),
    r('baseline_change', 'approval', 'removing/weakening/altering a baseline test'),
    r('fact_promote_from_guess', 'deny', 'promoting a guess to a project fact'),
    r('none', 'auto', 'no external effect'),
    r('secret', 'deny', 'reading/writing/logging a secret or token'),
    r('write_secret', 'deny', 'writing a secret into a file or a log'),
    r('delete_root_folder', 'deny', 'deleting the workspace root'),
  ],
};

export interface ClassifyInput {
  touches: readonly string[];
  reversible?: boolean;
  /** Shell command text, when the action is a command run. */
  command?: string;
}

export interface Classified {
  level: ExecRiskLevel;
  needs_human: boolean;
  /** True when the change may not be applied before human approval. */
  blocked_until_approval: boolean;
  matched: { category: string; level: ExecRiskLevel; source: 'rule' | 'irreversible' | 'default' | 'hard' }[];
  explanation: string;
  unknown_categories: string[];
}

function levelFor(policy: ExecPolicy, category: string): { level: ExecRiskLevel; known: boolean } {
  const hit = (policy.rules ?? []).find((x: PolicyRule) => x.category === category);
  if (hit) return { level: hit.level, known: true };
  // Conservative: an unknown category is never `auto`.
  return { level: policy.default_level, known: false };
}

/**
 * Highest level wins; `reversible:false` raises the floor; unknown ⇒ review;
 * hard-deny categories/commands beat everything; an agent can never lower a level.
 */
export function classify(policy: ExecPolicy, input: ClassifyInput): Classified {
  const matched: Classified['matched'] = [];
  const unknown: string[] = [];
  let level: ExecRiskLevel = 'auto';
  let anyTouched = false;

  const cats = input.touches.length ? input.touches : ['none'];
  for (const c of cats) {
    if (c !== 'none') anyTouched = true;
    if ((HARD_DENY_CATEGORIES as readonly string[]).includes(c)) {
      matched.push({ category: c, level: 'deny', source: 'hard' });
      level = 'deny';
      continue;
    }
    const { level: lv, known } = levelFor(policy, c);
    if (!known) unknown.push(c);
    matched.push({ category: c, level: lv, source: known ? 'rule' : 'default' });
    if (LEVEL_ORDER[lv] > LEVEL_ORDER[level]) level = lv;
  }

  // Irreversibility raises the floor (never lowers it).
  if (input.reversible === false && anyTouched) {
    const sensitive: string[] = [...SENSITIVE_FOR_IRREVERSIBLE, ...(policy.sensitive_for_irreversible ?? [])];
    const floor: ExecRiskLevel = cats.some((c) => sensitive.includes(c)) ? 'approval' : policy.irreversible_floor;
    if (LEVEL_ORDER[floor] > LEVEL_ORDER[level]) {
      level = floor;
      matched.push({ category: '*', level: floor, source: 'irreversible' });
    }
  }

  // Hard-deny command patterns (independent of the editable table).
  if (input.command) {
    if (HARD_DENY_COMMANDS.some((re) => re.test(input.command as string))) {
      level = 'deny';
      matched.push({ category: 'destructive_command', level: 'deny', source: 'hard' });
    } else if (/\b(rm|rmdir|del)\b|DROP\s+TABLE|TRUNCATE|git\s+push/i.test(input.command)) {
      const floor: ExecRiskLevel = 'approval';
      if (LEVEL_ORDER[floor] > LEVEL_ORDER[level]) {
        level = floor;
        matched.push({ category: 'destructive_command', level: floor, source: 'rule' });
      }
    }
  }

  const explanation =
    level === 'deny'
      ? 'denied by policy (hard rule): do not perform this action; record an open item and ask the human'
      : level === 'approval'
        ? 'human approval required before applying — record the decision and wait'
        : level === 'review'
          ? 'apply freely, but the decision must be recorded and human-reviewed before the task closes'
          : 'agent may proceed without registration';

  return {
    level,
    needs_human: level === 'approval' || level === 'deny',
    blocked_until_approval: level === 'approval' || level === 'deny',
    matched,
    explanation,
    unknown_categories: unknown,
  };
}

/**
 * The agent's own claim about risk is only used to *raise* the level; it can
 * never lower the code-computed one (invariant I-4 / acceptance F.4).
 */
export function mergeAgentClaim(
  policy: ExecPolicy,
  input: ClassifyInput,
  claimed?: unknown,
): { classified: Classified; claim_ignored: boolean } {
  const classified = classify(policy, input);
  if (claimed === undefined) return { classified, claim_ignored: false };
  const want = LEVEL_ORDER[String(claimed) as ExecRiskLevel] ?? -1;
  if (want > LEVEL_ORDER[classified.level]) {
    return {
      classified: {
        ...classified,
        level: String(claimed) as ExecRiskLevel,
        needs_human: true,
        blocked_until_approval: String(claimed) !== 'review',
        explanation: `${classified.explanation} (raised by an explicit risk claim)`,
      },
      claim_ignored: false,
    };
  }
  return { classified, claim_ignored: true };
}

/** Validation for the editable setting value (also used by module.validateConfig). */
export function validatePolicyShape(policy: ExecPolicy): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const rules: PolicyRule[] = policy.rules ?? [];
  for (const rule of rules) {
    if (seen.has(rule.category)) problems.push(`duplicate category '${rule.category}'`);
    seen.add(rule.category);
    if ((HARD_DENY_CATEGORIES as readonly string[]).includes(rule.category) && rule.level !== 'deny') {
      problems.push(`category '${rule.category}' may not be lower than deny (hard rule)`);
    }
  }
  for (const must of ['public_api', 'db_schema', 'auth']) {
    const hit = rules.find((x: PolicyRule) => x.category === must);
    if (!hit) problems.push(`required category '${must}' is missing`);
    else if (LEVEL_ORDER[hit.level] < LEVEL_ORDER.approval)
      problems.push(`category '${must}' must be approval or deny`);
  }
  return problems;
}
