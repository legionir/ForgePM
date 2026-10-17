import { describe, expect, it } from 'vitest';
import { execPolicySchema, assessCheckable, EXIT_REPORT_REQUIRED_ARRAYS, checkNoneConfirmed, detectWeakening, parseTestLog } from '@forgepm/shared';
import {
  EXEC_POLICY_DEFAULT,
  HARD_DENY_CATEGORIES,
  HARD_DENY_COMMANDS,
  SENSITIVE_FOR_IRREVERSIBLE,
  classify,
  mergeAgentClaim,
  validatePolicyShape,
} from './policy';

const policy = EXEC_POLICY_DEFAULT;

describe('risk policy (plan §F, acceptance F.1–F.8)', () => {
  it('F.1 carries every category of the plan table and the appendix rows', () => {
    const cats = policy.rules.map((r) => r.category);
    for (const must of ['internal_edit', 'add_module', 'local_bugfix', 'default_change', 'public_api', 'db_schema', 'auth', 'deps_add', 'deps_upgrade', 'delete_file', 'delete_data', 'config_deploy', 'ci', 'migration', 'destructive_command', 'secret', 'none']) {
      expect(cats, `missing ${must}`).toContain(must);
    }
    for (const must of ['scope_expansion', 'drop_requirement', 'waive_requirement', 'baseline_change', 'fact_promote_from_guess', 'cancel_subtask']) {
      expect(cats, `missing appendix row ${must}`).toContain(must);
    }
    expect(validatePolicyShape(policy)).toEqual([]);
    expect(execPolicySchema.safeParse(policy).success).toBe(true);
  });

  it('F.2 public_api and db_schema are always approval', () => {
    for (const t of ['public_api', 'db_schema', 'auth', 'delete_data', 'delete_file', 'config_deploy', 'ci']) {
      expect(classify(policy, { touches: [t], reversible: true }).level, t).toBe('approval');
    }
  });

  it('F.3 a low-risk claim from the agent never lowers the level', () => {
    const { classified, claim_ignored } = mergeAgentClaim(policy, { touches: ['public_api'], reversible: true }, 'auto');
    expect(classified.level).toBe('approval');
    expect(claim_ignored).toBe(true);
  });

  it('F.3b an agent may raise the level, never lower it', () => {
    const raised = mergeAgentClaim(policy, { touches: ['internal_edit'] }, 'approval');
    expect(raised.classified.level).toBe('approval');
    expect(raised.claim_ignored).toBe(false);
  });

  it('F.5 an unknown category is review, never auto', () => {
    const r = classify(policy, { touches: ['totally_new_thing'], reversible: true });
    expect(r.level).toBe('review');
    expect(r.unknown_categories).toEqual(['totally_new_thing']);
  });

  it('F.6 several categories ⇒ the highest level wins', () => {
    expect(classify(policy, { touches: ['internal_edit', 'deps_add'] }).level).toBe('review');
    expect(classify(policy, { touches: ['add_test', 'public_api'] }).level).toBe('approval');
  });

  it('F.6b irreversible raises the floor to review, and to approval for sensitive categories', () => {
    expect(classify(policy, { touches: ['add_test'], reversible: false }).level).toBe('review');
    expect(classify(policy, { touches: ['local_bugfix'], reversible: false }).level).toBe('review');
    expect(classify(policy, { touches: ['deps_add'], reversible: false }).level).toBe('approval');
    expect(classify(policy, { touches: ['none'], reversible: false }).level).toBe('auto');
    expect(SENSITIVE_FOR_IRREVERSIBLE).toContain('deps_add');
  });

  it('F.7 secret handling and root deletion are hard-denied', () => {
    expect(classify(policy, { touches: ['secret'] }).level).toBe('deny');
    expect(classify(policy, { touches: ['write_secret'] }).level).toBe('deny');
    expect(HARD_DENY_CATEGORIES).toContain('secret');
    expect(HARD_DENY_COMMANDS.some((re) => re.test('sudo rm -rf /'))).toBe(true);
    expect(HARD_DENY_COMMANDS.some((re) => re.test('rm -rf /'))).toBe(true);
    expect(HARD_DENY_COMMANDS.some((re) => re.test('rm -rf ./dist'))).toBe(false);
    expect(HARD_DENY_COMMANDS.some((re) => re.test('rm -rf /var/lib/postgres'))).toBe(false);
    expect(HARD_DENY_COMMANDS.some((re) => re.test('git push --force origin +main:main'))).toBe(true);
    expect(HARD_DENY_COMMANDS.some((re) => re.test('git push origin feature/x'))).toBe(false);
  });

  it('F.7b destructive shell commands reach at least approval', () => {
    expect(classify(policy, { touches: ['internal_edit'], command: 'git push --force origin +main:main' }).level).toBe('deny');
    expect(classify(policy, { touches: ['internal_edit'], command: 'git push --force origin feature/x' }).level).toBe('approval');
    expect(classify(policy, { touches: ['internal_edit'], command: 'psql -c "DROP TABLE users"' }).level).toBe('approval');
  });

  it('F.1b the policy is data: a project may raise a level without code change', () => {
    const custom = { ...policy, rules: policy.rules.map((r) => (r.category === 'deps_add' ? { ...r, level: 'approval' as const } : r)) };
    expect(classify(custom, { touches: ['deps_add'], reversible: true }).level).toBe('approval');
    expect(classify(policy, { touches: ['deps_add'], reversible: true }).level).toBe('review');
  });

  it('validatePolicyShape rejects a policy that lowers a hard-deny or drops a required category', () => {
    const bad = { ...policy, rules: policy.rules.filter((r) => r.category !== 'db_schema').map((r) => (r.category === 'secret' ? { ...r, level: 'auto' as const } : r)) };
    const problems = validatePolicyShape(bad);
    expect(problems.some((p) => p.includes('db_schema'))).toBe(true);
    expect(problems.some((p) => p.includes('secret'))).toBe(true);
  });
});

describe('checkable criteria (acceptance B.2)', () => {
  const good = [
    'POST /auth/token with a revoked refresh token must return 401 and write an audit_event (file:apps/api/src/modules/auth/routes.ts)',
    'npm run test:integration must print "Tests 12 passed" with 0 failed (test:exec-gate.test.ts)',
    'دکمهٔ خروج باید user را به /login بازگرداند و session پاک شود (ui:logout-button)',
  ];
  const bad = ['the feature works well', 'should be secure', 'کد تمیز باشد', 'باید امن باشد', 'make it robust', 'TODO'];
  it('accepts measurable statements with a reference', () => {
    for (const g of good) expect(assessCheckable(g).ok, g).toBe(true);
  });
  it('rejects vague statements and says what to fix', () => {
    for (const b of bad) {
      const r = assessCheckable(b);
      expect(r.ok, b).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.needed_action).toBeTruthy();
      expect(r.examples.length).toBeGreaterThan(0);
    }
  });
});

describe('exit report "explicit none" rule (acceptance C.3)', () => {
  it('every none field must be present', () => {
    expect(EXIT_REPORT_REQUIRED_ARRAYS).toHaveLength(8);
    const r = checkNoneConfirmed({ incomplete: [] });
    expect(r.ok).toBe(false);
    expect(r.missing_fields).toEqual(EXIT_REPORT_REQUIRED_ARRAYS.filter((k) => k !== 'incomplete'));
    expect(r.missing_confirmation).toEqual(['incomplete']);
  });

  it('an empty array needs none_confirmed, a non-empty one must not claim none', () => {
    const ok = checkNoneConfirmed(Object.fromEntries([...EXIT_REPORT_REQUIRED_ARRAYS.map((k) => [k, []]), ['none_confirmed', Object.fromEntries(EXIT_REPORT_REQUIRED_ARRAYS.map((k) => [k, true]))]]));
    expect(ok.ok).toBe(true);
    const clash = checkNoneConfirmed({ incomplete: ['x'], none_confirmed: { incomplete: true } } as never);
    expect(clash.contradictory).toEqual(['incomplete']);
    expect(clash.missing_confirmation).toEqual([]); // absent fields are reported as missing_fields, not as unconfirmed
  });
});

describe('test log + weakening heuristics (acceptance J.2–J.4)', () => {
  const log = [
    '✓ auth > logs in (12ms)',
    '✓ auth > rejects revoked token (3ms)',
    '× cart > totals (5ms)',
    'Test Files  2 passed (2)',
    'Tests  2 passed | 1 failed (3)',
  ].join('\n');
  it('parses totals and names', () => {
    const p = parseTestLog(log);
    expect(p.totals.pass).toBeGreaterThanOrEqual(2);
    expect(p.totals.fail).toBeGreaterThanOrEqual(1);
    expect(p.names).toEqual(expect.arrayContaining(['auth > logs in', 'auth > rejects revoked token']));
    expect(p.complete).toBe(true);
  });
  it('detects a removed assertion and a new skip modifier', () => {
    const before = 'it("a", () => { expect(1).toBe(1); expect(2).toBe(2); });';
    expect(detectWeakening(before, 'it("a", () => { expect(1).toBe(1); });', 'x.test.ts')?.countDelta).toBe(-1);
    const w = detectWeakening(before, 'it.skip("a", () => { expect(1).toBe(1); });', 'x.test.ts');
    expect(w?.addedModifiers).toContain('.skip');
    expect(detectWeakening(before, before, 'x.test.ts')).toBeNull();
  });
});
