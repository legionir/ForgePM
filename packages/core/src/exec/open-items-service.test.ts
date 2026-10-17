import { describe, expect, it } from 'vitest';
import { parseOpenItemCreate, parseOpenItemResolve, sourceForActor } from './open-items-service';
import { validateNewOpenItem } from './open-items';

/**
 * Acceptance A.5 (docs/EXECUTION_CONTROL_PLAN.md §6): a malformed ledger write is
 * answered with a structured error that says what to fix — never a crash, never a
 * silent accept. The service parses at its own boundary instead of trusting the
 * caller (tool, REST route or CLI) to have validated anything.
 */
const valid = {
  title: 'gate ignores waivers without an approval id',
  type: 'bug',
  blocks_completion: true,
};

describe('open-item create input (A.5)', () => {
  it('accepts the documented shape and strips the routing field', () => {
    const r = parseOpenItemCreate({ ...valid, task_ref: 'T-001', detail: 'seen in run 39073122374' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe(valid.title);
      expect((r.value as unknown as Record<string, unknown>).task_ref).toBeUndefined();
    }
  });

  const cases: [string, unknown][] = [
    ['title shorter than 5 chars', { ...valid, title: 'bug' }],
    ['title longer than 500 chars', { ...valid, title: 'x'.repeat(501) }],
    ['unknown item type', { ...valid, type: 'todo' }],
    ['missing title', { type: 'bug' }],
    ['missing type', { title: valid.title }],
    ['extra unknown field', { ...valid, assignee: 'me' }],
    ['detail over the cap', { ...valid, detail: 'd'.repeat(8001) }],
    ['title is not a string', { ...valid, title: 42 }],
    [
      'why_not_blocking too short',
      { ...valid, type: 'commitment', blocks_completion: false, why_not_blocking: 'later' },
    ],
    ['blocks_completion not a boolean', { ...valid, blocks_completion: 'true' }],
    ['type as a number', { ...valid, type: 7 }],
    ['null payload', null],
    ['undefined payload', undefined],
    ['array payload', [valid]],
    ['string payload', 'file a bug'],
    ['prototype-polluting key', { ...valid, __proto__: { admin: true } }],
  ];
  it.each(cases)('refuses %s with needed_action instead of a crash', (_name, raw) => {
    let out: ReturnType<typeof parseOpenItemCreate> | undefined;
    expect(() => {
      out = parseOpenItemCreate(raw);
    }).not.toThrow();
    expect(out?.ok).toBe(false);
    if (out && !out.ok) {
      expect(out.code).toBe('VALIDATION_ERROR');
      expect(out.message.length).toBeGreaterThan(10);
      expect(out.needed_action).toMatch(/fix|send|docs\/EXECUTION_CONTROL_PLAN/);
    }
  });

  it('does not accept a reason-only downgrade dressed up as blocking', () => {
    // blocks_completion omitted on a default-blocking type stays blocking.
    const r = parseOpenItemCreate({ title: valid.title, type: 'incomplete_requirement' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.blocks_completion).toBeUndefined();
  });
});

describe('open-item resolve input (A.5/A.3)', () => {
  it('accepts a real closure note', () => {
    const r = parseOpenItemResolve({
      item_ref: 'OI-004',
      status: 'resolved',
      note: 'fixed in 2edeeb9, chain.spec.ts asserts it now',
    });
    expect(r.ok).toBe(true);
  });

  const bad: [string, unknown][] = [
    ['a status that is not a transition', { item_ref: 'OI-1', status: 'closed', note: 'x'.repeat(30) }],
    ['a note shorter than the 20-char floor', { item_ref: 'OI-1', status: 'resolved', note: 'done' }],
    ['no note at all', { item_ref: 'OI-1', status: 'resolved' }],
    ['missing item_ref', { status: 'resolved', note: 'x'.repeat(30) }],
    ['an extra field', { item_ref: 'OI-1', status: 'resolved', note: 'x'.repeat(30), silent: true }],
    ['status capitalised', { item_ref: 'OI-1', status: 'Resolved', note: 'x'.repeat(30) }],
    ['note not a string', { item_ref: 'OI-1', status: 'resolved', note: 42 }],
  ];
  it.each(bad)('refuses %s', (_name, raw) => {
    const r = parseOpenItemResolve(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('VALIDATION_ERROR');
  });
});

describe('shape is not the law (A.5 vs A.3/A.7)', () => {
  it('the shape accepts a blocking downgrade and the state machine refuses it', () => {
    const shape = parseOpenItemCreate({ title: valid.title, type: 'commitment', blocks_completion: false });
    expect(shape.ok).toBe(true); // the field is present and well-typed
    const law = validateNewOpenItem({
      type: 'commitment',
      title: valid.title,
      blocks_completion: false,
      actorType: 'agent',
    });
    expect(law.ok).toBe(false); // ...but a commitment may not become a footnote without a reason
    if (!law.ok) expect(law.needed_action.length).toBeGreaterThan(5);
  });

  it('a ref is only length-checked here; whether it exists is the ledger that answers', () => {
    expect(parseOpenItemResolve({ item_ref: 'not a ledger ref', status: 'resolved', note: 'x'.repeat(30) }).ok).toBe(
      true,
    );
    expect(parseOpenItemResolve({ item_ref: 'ab', status: 'resolved', note: 'x'.repeat(30) }).ok).toBe(false);
  });
});

describe('source attribution (0010 source CHECK)', () => {
  it('derives the source from who is acting', () => {
    expect(sourceForActor('agent')).toEqual({ ok: true, source: 'agent' });
    expect(sourceForActor('human')).toEqual({ ok: true, source: 'human' });
  });

  it('makes a system writer name the role it writes as', () => {
    const r = sourceForActor('system');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.needed_action).toContain('exit_report');
  });

  it('lets the promotion path claim exit_report/reviewer but never human', () => {
    expect(sourceForActor('agent', 'exit_report').ok).toBe(true);
    expect(sourceForActor('agent', 'reviewer').ok).toBe(true);
    expect(sourceForActor('agent', 'human').ok).toBe(false);
    expect(sourceForActor('agent', 'ghost').ok).toBe(false);
  });
});
