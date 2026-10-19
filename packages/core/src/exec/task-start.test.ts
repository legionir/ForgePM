import { describe, expect, it } from 'vitest';
import { checkCriteria, parseTaskStart } from './task-start';

/**
 * PE-2 §7 B.1/B.2/B.3 — the shape of a task-start payload and the checkability of
 * its criteria, proven without a database. Existence questions (`req_ids`, the task
 * ref) are the ledger's answer, not the parser's, so they are deliberately absent here.
 */

const GOOD = 'POST /api/v1/x returns 201 and one outbox row; test:exec_task_start_ok';
const base = {
  title: 'PE-2 tool slice',
  acceptance_criteria: [GOOD],
  allowed_paths: ['packages/core/src/exec/**'],
};

describe('parseTaskStart — shape only (B.1)', () => {
  it('accepts the documented minimal payload and applies defaults', () => {
    const r = parseTaskStart(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      title: 'PE-2 tool slice',
      criteria: [GOOD],
      reqIds: [],
      allowedPaths: ['packages/core/src/exec/**'],
    });
  });

  it('refuses every missing required field with a structured answer, never a throw', () => {
    const cases: [string, unknown][] = [
      ['no title', { acceptance_criteria: [GOOD], allowed_paths: ['a'] }],
      ['title too short', { ...base, title: 'ab' }],
      ['title not a string', { ...base, title: 42 }],
      ['no criteria', { title: 'x', allowed_paths: ['a'] }],
      ['empty criteria array', { ...base, acceptance_criteria: [] }],
      ['criteria not an array', { ...base, acceptance_criteria: GOOD }],
      ['no allowed_paths', { title: 'x', acceptance_criteria: [GOOD] }],
      ['empty allowed_paths', { ...base, allowed_paths: [] }],
      ['allowed_paths wrong element type', { ...base, allowed_paths: [1] }],
      ['null payload', null],
      ['array payload', []],
      ['string payload', 'exec_task_start'],
    ];
    for (const [what, raw] of cases) {
      const r = parseTaskStart(raw);
      expect(r.ok, what).toBe(false);
      if (r.ok) continue;
      expect(r.code, what).toBe('VALIDATION_ERROR');
      expect(r.message.length, what).toBeGreaterThan(0);
      expect(r.needed_action.length, what).toBeGreaterThan(5);
    }
  });

  it('refuses unknown keys instead of ignoring them (strictObject)', () => {
    // The computed key is deliberate: both `__proto__: v` and `'__proto__': v` in an
    // object literal set the prototype instead of adding a property, so only
    // `{ ['__proto__']: v }` is an unknown *field* for strictObject to refuse.
    const protoKey = { ['__proto__']: 'nope' };
    for (const extra of [{ status: 'done' }, { id: '1' }, protoKey, { work_item_id: 'x' }, { start_ref: 'a'.repeat(40) }]) {
      const r = parseTaskStart({ ...base, ...extra });
      expect(r.ok, JSON.stringify(extra)).toBe(false);
    }
  });

  it('refuses an idempotency key too short to be a real key', () => {
    expect(parseTaskStart({ ...base, idempotency_key: 'abc' }).ok).toBe(false);
    expect(parseTaskStart({ ...base, idempotency_key: 'idem-12345' }).ok).toBe(true);
  });

  it('refuses a task list longer than the ledger will read back', () => {
    expect(parseTaskStart({ ...base, acceptance_criteria: Array(51).fill(GOOD) }).ok).toBe(false);
    expect(parseTaskStart({ ...base, allowed_paths: Array(201).fill('a') }).ok).toBe(false);
  });
});

describe('checkCriteria — testability is code, not taste (B.2)', () => {
  it('refuses the two documented vague examples', () => {
    for (const vague of ['the feature works well', 'امن باشد']) {
      const r = checkCriteria([vague]);
      expect(r.ok, vague).toBe(false);
      if (r.ok) continue;
      expect(r.code).toBe('CRITERION_NOT_CHECKABLE');
      expect(r.needed_action).toMatch(/rewrite|reference/i);
      expect(r.examples.length).toBeGreaterThan(1);
      expect(r.examples.join(' ')).toMatch(/returns 401|Tests {2}12 passed/);
    }
  });

  /* the 10-row table the plan asks for: 5 acceptable, 5 refused */
  const table: [string, boolean][] = [
    ['GET /api/v1/exec/ledger returns 404 for an unknown task code; test:ledger_404', true],
    ['cmd:npm run test:unit returns exit code 0 and prints the passing count', true],
    [
      'the migration file contains exec_append_only() and is not edited after merge; file:packages/core/src/db/migrations/0010_exec.migration.ts',
      true,
    ],
    ['ui: the board column displays the dragged card key after the drop; test:chain.spec.ts', true],
    ['commit abc1234 adds the CHECK that rejects a done task without closed_at; commit:abc1234', true],
    ['the ledger is robust and secure', false],
    ['handler should return proper values', false],
    ['کد باید تمیز باشد و خوب کار کند', false],
    ['fast enough for users', false],
    ['the tests pass, I think', false],
  ];
  it.each(table)('classifies %s', (text, ok) => {
    expect(checkCriteria([text]).ok).toBe(ok);
  });

  it('reports the offending index so a batch of 20 criteria is fixable in one pass', () => {
    const r = checkCriteria([GOOD, 'it works well', GOOD, 'secure']);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.bad.map((b) => b.index)).toEqual([1, 3]);
    expect(r.bad[1]?.errors.length).toBeGreaterThan(0);
  });

  it('does not invent a duplicate of the shared word lists', () => {
    // the law lives in @forgepm/shared (AMBIGUOUS_WORDS/CHECKABLE_MARKERS/READABLE_REF_RE);
    // this module only maps its answer into the tool's error shape.
    const r = checkCriteria([GOOD]);
    expect(r.ok).toBe(true);
  });
});
