import { describe, expect, it } from 'vitest';
import { EXEC_POLICY_DEFAULT, classify } from '@forgepm/core';
import { buildAnswer } from '../../src/modules/exec/policy-tools';

/**
 * `exec_policy_check` (plan §9.4, acceptance B.12).
 *
 * The tool exists so the agent can ask BEFORE it acts. The answer comes from
 * the same table that decides, so it is worth exactly as much as the decision
 * — and it must never soften a level.
 */

const answer = (actionKind: string, command?: string) =>
  buildAnswer(
    classify(EXEC_POLICY_DEFAULT, { touches: [actionKind], reversible: true, command }),
    'packages/core/src/exec/gate.ts',
    actionKind,
  );

describe('the policy answers before the agent acts (B.12)', () => {
  it('a destructive command is at least approval', () => {
    const a = answer('destructive_command', 'git push --force');
    expect(a.level).toBe('approval');
    expect(a.required.tool_to_call).toBe('ledger_record_decision');
    expect(a.warning).toContain('journal');
  });

  it('writing a secret is denied, and no approval makes it allowed', () => {
    const a = answer('write_secret');
    expect(a.level).toBe('deny');
    expect(a.required.tool_to_call).toBeNull();
    expect(a.warning).toContain('do not apply');
  });

  it('an internal edit is auto, and needs no approval', () => {
    const a = answer('internal_edit');
    expect(a.level).toBe('auto');
    expect(a.required.approval_id).toBeNull();
    expect(a.required.tool_to_call).toBeNull();
  });

  it('the answer names the rules it matched', () => {
    const a = answer('public_api');
    expect(a.level).toBe('approval');
    expect(a.matched_rules.some((r) => r.category === 'public_api')).toBe(true);
    expect(a.explanation).toContain('public_api');
  });
});
