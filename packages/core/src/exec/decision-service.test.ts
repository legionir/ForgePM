import { describe, expect, it } from 'vitest';
import { parseDecision } from './decision-service';
import { parseQuestion } from './question-service';

/**
 * The shape checks of PE-4's two human-in-the-loop tools (plan §9.2, §9.3 —
 * acceptance B.9's I-4 and B.11).
 *
 * The parts that need a database (the row, the approval request, the task's
 * move to `awaiting_review`) are proved by the integration cases in
 * `tests/integration/exec-tools.test.ts`.
 */

const TASK = 'T-001';

describe('a decision is a choice with its reasons (B.9)', () => {
  const good = {
    task_ref: TASK,
    title: 'the shape of the public API',
    context: 'the endpoint changes and every client has to follow',
    options: ['keep the old shape and add a new one', 'replace the old shape'],
    selected: 'keep the old shape and add a new one',
    rationale: 'the old shape is used by two other services that cannot change in this release',
    reversible: true,
    touches: ['public_api'],
  };

  it('a good decision parses', () => {
    const r = parseDecision(good);
    expect(r.ok).toBe(true);
  });

  it('the agent may not send its own risk level (I-4)', () => {
    const r = parseDecision({ ...good, risk_level: 'auto' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/risk_level/);
  });

  it('the selected option must be one of the options', () => {
    const r = parseDecision({ ...good, selected: 'something nobody offered' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/selected/);
  });

  it('a rationale shorter than 40 characters is refused', () => {
    const r = parseDecision({ ...good, rationale: 'because' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/rationale/);
  });

  it("'none' cannot be combined with another category", () => {
    const r = parseDecision({ ...good, touches: ['none', 'public_api'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/none/);
  });
});

describe('a question is a question, not a note (B.11)', () => {
  const good = {
    task_ref: TASK,
    question: 'should the panel show the gate stamp next to the task?',
    options: ['yes, show it', 'no, keep the panel simple'],
    recommendation: 'yes, show it',
    impact_per_option: [
      'one more column in the board, and the drift becomes visible at a glance',
      'the board stays small, but a drifted task is only visible in the API',
    ],
    why_it_matters: 'a drifted task looks finished on the board while the ledger says it is not',
    blocking: true,
    kind: 'generic',
  };

  it('a good question parses', () => {
    const r = parseQuestion(good);
    expect(r.ok).toBe(true);
  });

  it('a recommendation that is not one of the options is refused', () => {
    const r = parseQuestion({ ...good, recommendation: 'do whatever you like' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/recommendation/);
  });

  it('the impact must have one entry per option', () => {
    const r = parseQuestion({ ...good, impact_per_option: ['only one impact'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/impact_per_option/);
  });

  it('a question with no impact at all is refused', () => {
    const { impact_per_option, ...without } = good;
    void impact_per_option;
    const r = parseQuestion(without);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/impact_per_option/);
  });

  it('a question with fewer than two options is refused', () => {
    const r = parseQuestion({ ...good, options: ['only one'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/options/);
  });
});
