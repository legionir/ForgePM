import { describe, expect, it } from 'vitest';
import { MIGRATION_0010_EXEC } from '../db/migrations/0010_exec.migration';
import {
  DEFAULT_PROTECTED_TEST_GLOBS,
  DEFAULT_TEST_PARSER,
  execHarnessSchema,
  execPolicySchema,
} from '@forgepm/shared';
import { SETTING_DEFINITIONS, findSettingDefinition } from '../settings-registry';
import { compareBaseline, baselineFromLog, isProtectedTest, type BaselineRow } from './baseline';
import { ALLOCATE_SQL, ENSURE_SEQ_ROW_SQL, formatCode, isCode, LEDGER_PREFIXES, parseCode } from './codes';
import { blockingOpen, dedupKey, isHumanOnlyClosure, validateNewOpenItem, validateResolution } from './open-items';

describe('baseline comparison (appendix §J, acceptance J.6)', () => {
  const parser = { pass: ['\\d+ passed'], fail: ['\\d+ failed'], skip: ['\\d+ skipped'] };
  it('J.6a results are computed by the code from a real log, not typed by the agent', () => {
    const log = '✓ auth > logs in (1ms)\n✓ gate > blocks (2ms)\nTest Files  1 passed (1)\nTests  2 passed (2)';
    const b = baselineFromLog(log, parser, 'ci');
    expect(b.complete).toBe(true);
    expect(b.rows.map((r) => r.name)).toEqual(['auth > logs in', 'gate > blocks']);
    expect(b.rows.every((r) => r.source === 'ci' && r.result === 'pass')).toBe(true);
  });

  it('J.6b a passing baseline test that fails, skips or vanishes is a red flag', () => {
    const before: BaselineRow[] = [
      { name: 'a', result: 'pass' },
      { name: 'b', result: 'pass' },
      { name: 'c', result: 'pass' },
      { name: 'd', result: 'fail' },
    ];
    const v = compareBaseline(before, ['a', 'b', 'd'], { a: 'pass', b: 'fail', d: 'fail' }, []);
    expect(v.newly_failing).toEqual(['b']);
    expect(v.vanished).toEqual(['c']);
    expect(v.ok).toBe(false);
    expect(v.needs_human).toBe(true); // deleting a test is never self-service
  });

  it('a test that was already failing is not blamed on this task', () => {
    const v = compareBaseline([{ name: 'd', result: 'fail' }], ['d'], { d: 'fail' }, []);
    expect(v.ok).toBe(true);
    expect(v.needs_human).toBe(false);
  });

  it('J.3a weakened assertions/modifiers make the verdict red', () => {
    const v = compareBaseline([{ name: 'a', result: 'pass' }], ['a'], { a: 'pass' }, [
      { path: 'x.test.ts', delta: -2, modifiers: ['.skip'] },
    ]);
    expect(v.weakened).toHaveLength(1);
    expect(v.ok).toBe(false);
    expect(v.needs_human).toBe(true);
    // a strengthening delta is not a finding
    expect(compareBaseline([], [], {}, [{ path: 'x.test.ts', delta: 3, modifiers: [] }]).ok).toBe(true);
  });

  it('J.2 protected globs decide which files the baseline watches', () => {
    expect(isProtectedTest('packages/core/src/exec/gate.test.ts', ['**/*.test.ts'])).toBe(true);
    expect(isProtectedTest('docs/gate.test.ts', ['packages/**/*.test.ts'])).toBe(false);
    expect(isProtectedTest('tests/e2e/flow.spec.ts', ['**/e2e/**/*.spec.ts'])).toBe(true);
    expect(isProtectedTest('gate.test.ts', ['**/*.test.ts'])).toBe(true);
    expect(isProtectedTest('src/gate.ts', ['**/*.test.ts'])).toBe(false);
  });
});

describe('open-item closure rules (plan §B/§C, acceptance B.6)', () => {
  const blocking = { code: 'OI-1', type: 'defect', blocks_completion: true, status: 'open' as const };
  it('B.6a an agent cannot close a blocking item as accepted/deferred/wont_fix', () => {
    for (const requested of ['accepted', 'deferred', 'wont_fix'] as const) {
      const r = validateResolution(blocking, {
        requested,
        note: 'we decided this is fine for now, moving on',
        actorType: 'agent',
      });
      expect(r.ok, requested).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('LEDGER_TRANSITION_NOT_ALLOWED');
        expect(r.needed_action).toContain('ledger_ask_human');
      }
    }
  });

  it("B.6b a human may accept/defer it — that is their decision, not the agent's", () => {
    expect(
      validateResolution(blocking, {
        requested: 'deferred',
        note: 'deferred by the owner in the 2026-01-05 meeting; covered by REQ-4 in the next release',
        actorType: 'human',
      }).ok,
    ).toBe(true);
    expect(
      validateResolution(blocking, {
        requested: 'deferred',
        note: 'deferred by the owner in the 2026-01-05 meeting; covered by REQ-4 in the next release',
        actorType: 'system',
      }).ok,
    ).toBe(true);
  });

  it('an agent may only close a blocking item as resolved/not_applicable; active states stay available', () => {
    expect(validateResolution(blocking, { requested: 'accepted', note: 'x'.repeat(80), actorType: 'agent' }).ok).toBe(
      false,
    );
    // 'blocked'/'awaiting_human' keep the gate shut, so the agent may set them freely
    expect(
      validateResolution(blocking, {
        requested: 'blocked',
        note: 'waiting on the registry access from REQ-9 to continue',
        actorType: 'agent',
      }).ok,
    ).toBe(true);
    expect(
      validateResolution(blocking, {
        requested: 'resolved',
        note: 'fixed in commit abc123 and covered by C-3',
        actorType: 'agent',
      }).ok,
    ).toBe(true);
    // a human owns the definition of done and may park a blocking item elsewhere
    expect(
      validateResolution(blocking, {
        requested: 'wont_fix',
        note: 'we are not going to do this at all; product decision 2026-01',
        actorType: 'human',
      }).ok,
    ).toBe(true);
  });

  it('B.6c closing always needs a real note (>= 20 chars)', () => {
    const r = validateResolution(
      { ...blocking, blocks_completion: false },
      { requested: 'resolved', note: 'done', actorType: 'agent' },
    );
    expect(!r.ok && r.code).toBe('VALIDATION_ERROR');
  });

  it('B.6d an agent may not reopen a closed item', () => {
    const r = validateResolution(
      { ...blocking, status: 'resolved' },
      { requested: 'open', note: 'it is broken again', actorType: 'agent' },
    );
    expect(!r.ok && r.needed_action).toContain('ledger_ask_human');
    expect(
      validateResolution(
        { ...blocking, status: 'resolved' },
        { requested: 'open', note: 'it is broken again', actorType: 'human' },
      ).ok,
    ).toBe(true);
  });

  it("'not_applicable' on a required item needs a longer justification", () => {
    const r = validateResolution(
      { ...blocking, type: 'defect' },
      { requested: 'not_applicable', note: 'not relevant to us at all, we ship without it', actorType: 'human' },
    );
    if (!r.ok) expect(r.message).toContain('60 chars');
    expect(r.ok).toBe(false);
    const long =
      'REQ-7 says the CSV export is out of scope for this release, so this item cannot apply to the delivered slice';
    expect(
      validateResolution(
        { ...blocking, type: 'defect' },
        { requested: 'not_applicable', note: long, actorType: 'human' },
      ).ok,
    ).toBe(true);
  });

  it('only open/awaiting_human/blocked statuses block completion', () => {
    const items = [
      { blocks_completion: true, status: 'open' as const },
      { blocks_completion: true, status: 'awaiting_human' as const },
      { blocks_completion: true, status: 'blocked' as const },
      { blocks_completion: true, status: 'accepted' as const },
      { blocks_completion: false, status: 'open' as const },
      { blocks_completion: true, status: 'resolved' as const },
    ];
    expect(blockingOpen(items)).toHaveLength(3);
    expect(isHumanOnlyClosure('accepted')).toBe(true);
    expect(isHumanOnlyClosure('resolved')).toBe(false);
  });

  it('an agent cannot file an unmet requirement as a non-blocking footnote', () => {
    const r = validateNewOpenItem({
      type: 'incomplete_requirement',
      title: 'REQ-3 export is not implemented at all',
      blocks_completion: false,
      why_not_blocking: 'short',
      actorType: 'agent',
    });
    expect(!r.ok && r.code).toBe('VALIDATION_ERROR');
    if (!r.ok) expect(r.needed_action).toContain('blocks_completion=true');
    const long = 'REQ-3 is scheduled for the next release; product agreed the slice ships without it on 2026-01-05';
    expect(
      validateNewOpenItem({
        type: 'incomplete_requirement',
        title: 'REQ-3 export is not implemented at all',
        blocks_completion: false,
        why_not_blocking: long,
        actorType: 'agent',
      }).ok,
    ).toBe(true);
    expect(
      validateNewOpenItem({
        type: 'incomplete_requirement',
        title: 'REQ-3 export is not implemented at all',
        blocks_completion: true,
        actorType: 'agent',
      }).ok,
    ).toBe(true);
    expect(!validateNewOpenItem({ type: 'defect', title: 'oops', blocks_completion: true, actorType: 'agent' }).ok);
  });

  it('the same problem cannot be filed twice under different punctuation', () => {
    expect(dedupKey('defect', '  Gate blocks on Missing Test ')).toBe(
      dedupKey('defect', 'gate blocks on missing test'),
    );
    expect(dedupKey('defect', 'gate blocks')).not.toBe(dedupKey('risk', 'gate blocks'));
  });
});

describe('ledger codes (acceptance PE-0.5)', () => {
  it('codes are zero-padded and prefix-specific, criteria are per-task', () => {
    expect(formatCode('T', 1)).toBe('T-001');
    expect(formatCode('OI', 42)).toBe('OI-042');
    expect(formatCode('C', 1)).toBe('C-1');
    expect(formatCode('C', 12)).toBe('C-12');
    expect(formatCode('REQ', 1000)).toBe('REQ-1000');
    expect(() => formatCode('T' as never, 0)).toThrowError(/positive integer/);
    expect(() => formatCode('XX' as never, 3)).toThrowError(/unknown ledger prefix/);
  });

  it('parseCode round-trips and rejects foreign formats', () => {
    for (const p of LEDGER_PREFIXES) {
      const code = formatCode(p, 7);
      expect(parseCode(code)).toEqual({ prefix: p, seq: 7 });
      expect(isCode(code, p)).toBe(true);
    }
    expect(parseCode('c-7')).toBeNull();
    expect(parseCode('T-0007')).toBeNull();
    expect(isCode('T-001', 'C')).toBe(false);
    expect(isCode('TODO', 'T')).toBe(false);
  });

  it('allocation uses a row lock so concurrent inserts cannot collide', () => {
    expect(ALLOCATE_SQL).toContain('FOR UPDATE');
    expect(ALLOCATE_SQL).toContain('seq = s.seq + 1');
    expect(ALLOCATE_SQL).toContain('RETURNING s.seq');
    expect(ENSURE_SEQ_ROW_SQL).toContain('ON CONFLICT (project_id, prefix) DO NOTHING');
  });
});

describe('exec settings (D-05 policy/harness as data)', () => {
  const execKeys = SETTING_DEFINITIONS.filter((d) => d.key.startsWith('exec.')).map((d) => d.key);
  it('every documented exec.* key exists exactly once, in category execution', () => {
    expect(new Set(execKeys).size).toBe(execKeys.length);
    // The plan counts 16 exec.* keys after D-041 removed the runner surface: a
    // new setting must be an intentional, reviewed change to that contract.
    expect(execKeys.slice().sort()).toEqual([
      'exec.allowed_repo_roots',
      'exec.baseline_source',
      'exec.block_transition_when_gate_fails',
      'exec.ci_log_endpoint',
      'exec.ci_log_secret_name',
      'exec.evidence_max_bytes',
      'exec.max_cost_tokens',
      'exec.max_review_rounds',
      'exec.policy',
      'exec.protected_test_globs',
      'exec.require_review_for_done',
      'exec.session_output_max_bytes',
      'exec.stale_check_on_start',
      'exec.test_command',
      'exec.test_result_parser',
      'exec.tool_output_max_bytes',
    ]);
    for (const must of [
      'exec.policy',
      'exec.test_command',
      'exec.test_result_parser',
      'exec.protected_test_globs',
      'exec.allowed_repo_roots',
      'exec.baseline_source',
      'exec.ci_log_endpoint',
      'exec.max_review_rounds',
      'exec.require_review_for_done',
      'exec.block_transition_when_gate_fails',
    ]) {
      expect(execKeys, must).toContain(must);
    }
    for (const d of SETTING_DEFINITIONS.filter((x) => x.key.startsWith('exec.')))
      expect(d.category, d.key).toBe('execution');
  });

  it('every default validates against its own schema (a registry typo fails here, not in production)', () => {
    for (const d of SETTING_DEFINITIONS.filter((x) => x.key.startsWith('exec.'))) {
      const parsed = d.schema.safeParse(d.default);
      expect(parsed.success, `${d.key}: ${JSON.stringify(parsed.success ? {} : parsed.error.issues)}`).toBe(true);
    }
  });

  it('the cancelled runner keys are gone (no host/container execution path exists)', () => {
    for (const gone of [
      'exec.runner.enabled',
      'exec.runner.image',
      'exec.runner.network',
      'exec.runner_timeout_sec',
      'exec.runner_max_output_bytes',
    ]) {
      expect(findSettingDefinition(gone), gone).toBeUndefined();
    }
    const parsed = execHarnessSchema.parse({ test_command: 'npm run test:unit', baseline_source: 'ci' });
    expect(parsed.baseline_source).toBe('ci');
    expect(execHarnessSchema.safeParse({ test_command: 'x', baseline_source: 'runner' }).success).toBe(false);
  });

  it('the policy and harness defaults are the shared schema defaults', () => {
    expect(execPolicySchema.parse(findSettingDefinition('exec.policy')!.default).version).toBe(1);
    expect(DEFAULT_TEST_PARSER.pass.length).toBeGreaterThan(0);
    expect(DEFAULT_PROTECTED_TEST_GLOBS).toContain('**/*.test.ts');
  });
});

describe('baseline provenance contract (D-041)', () => {
  it('the DB CHECK and the pure builder agree: a baseline row is CI or an approved human, never a self-run', () => {
    // The migration's constraint is the contract; 'runner'/'agent' are gone with
    // D-041, so nothing in the code may start claiming a run ForgePM did itself.
    expect(MIGRATION_0010_EXEC).toMatch(
      /exec_baseline_tests[\s\S]{0,2000}?source text NOT NULL CHECK \(source IN \('ci','human'\)\)/,
    );
    expect(MIGRATION_0010_EXEC).not.toMatch(/'ci','runner'/);
    const parser = { pass: ['1 passing'], fail: ['0 failing'], skip: ['0 pending'], test_line: '' };
    expect(baselineFromLog('✓ works\n1 passing', parser).rows[0]?.source).toBe('ci');
    expect(baselineFromLog('✓ works\n1 passing', parser, 'human').rows.every((r) => r.source === 'human')).toBe(true);
  });
});
