import { AppError, execHarnessSchema, execPolicySchema } from '@forgepm/shared';
import { getEffective, type Db, type ModuleDefinition } from '@forgepm/core';

/**
 * Execution-control module (docs/EXECUTION_CONTROL_PLAN.md §5 PE-0 item 3).
 *
 * Always REGISTERED (registration means "exists", plan §3b-1.1) and OFF by
 * default: while `modules.exec.enabled` is false the agent's `tools/list`
 * contains no exec tool, and the REST routes answer MODULE_DISABLED. That is how
 * this feature ships without changing anyone's current behaviour.
 *
 * `validateConfig` runs on ENABLE (plan §3b-1.4): the module refuses to switch on
 * while the policy/harness settings do not parse, so the Finalization Gate can
 * never evaluate against a half-written JSON document.
 */
const CHECKED_ON_ENABLE = [
  ['exec.policy', execPolicySchema],
  ['exec.test_result_parser', execHarnessSchema.shape.result_parser],
  ['exec.protected_test_globs', execHarnessSchema.shape.protected_test_globs],
] as const;

export const execControlModule: ModuleDefinition = {
  name: 'exec',
  validateConfig: async (db: Db) => {
    const problems: string[] = [];
    for (const [key, schema] of CHECKED_ON_ENABLE) {
      const eff = await getEffective(db, key, null, null);
      // Absent = the settings-registry default applies, which is valid by construction.
      if (!eff) continue;
      const parsed = schema.safeParse(eff.value);
      if (!parsed.success) {
        problems.push(`${key}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
      }
    }
    if (problems.length) {
      throw new AppError('VALIDATION_ERROR', `exec module config is invalid: ${problems.join(' | ')}`, { problems });
    }
  },
};
