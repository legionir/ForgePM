import { describe, expect, it } from 'vitest';
import { parseExitReport } from './exit-report';

/**
 * Acceptance C.3 — the exit report must be COMPLETE, not merely present.
 *
 * "I forgot to mention it" and "there was nothing to mention" are different
 * statements. Only the second one may be made without saying so, and it has to
 * be said out loud (`none_confirmed.<field>=true`). The rule is a cross-field
 * one, so it cannot live inside a single field's schema — it is checked here,
 * in one place, for all eight fields at once.
 */

const SUMMARY = 'the gate now refuses to close a task whose criteria have no evidence at all';

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  task_ref: 'T-001',
  summary: SUMMARY,
  changed_files: ['packages/core/src/exec/gate.ts'],
  completed_items: ['the gate is split into one file per rule'],
  incomplete: [],
  assumptions: [],
  decisions_made: [],
  risks_found: [],
  tests_executed: [],
  tests_not_run: [],
  out_of_scope_findings: [],
  criteria_status: [],
  req_ids_covered: [],
  scope_deviations: [],
  facts_recorded: [],
  none_confirmed: {
    incomplete: true,
    assumptions: true,
    decisions_made: true,
    risks_found: true,
    tests_not_run: true,
    out_of_scope_findings: true,
    req_ids_covered: true,
    scope_deviations: true,
  },
  ...over,
});

describe('C.3 — the exit report is refused unless every "none" field is explicit', () => {
  it('a complete report parses', () => {
    const r = parseExitReport(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.taskRef).toBe('T-001');
      expect(r.value.changedFiles).toEqual(['packages/core/src/exec/gate.ts']);
    }
  });

  it('a missing field is an error — never a default', () => {
    const raw = base();
    delete (raw as Record<string, unknown>).incomplete;
    const r = parseExitReport(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('UNPROCESSABLE');
      expect(r.message).toMatch(/incomplete/);
    }
  });

  it('an empty list without none_confirmed is an error', () => {
    const raw = base();
    delete (raw as Record<string, unknown>).none_confirmed;
    const r = parseExitReport(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('UNPROCESSABLE');
      expect(r.message).toMatch(/incomplete/);
    }
  });

  it('an empty list WITH none_confirmed is accepted', () => {
    // The law is per field: an empty list is fine as long as that field is
    // confirmed. A field that has entries needs no flag at all.
    const r = parseExitReport(
      base({
        incomplete: [],
        assumptions: ['the CI log endpoint stays readable for this project'],
        none_confirmed: {
          incomplete: true,
          decisions_made: true,
          risks_found: true,
          tests_not_run: true,
          out_of_scope_findings: true,
          req_ids_covered: true,
          scope_deviations: true,
        },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('an empty field that is explicitly NOT confirmed is still refused', () => {
    // `false` is a legitimate answer for a field that has entries — but an
    // empty field may only be excused by `true`.
    const r = parseExitReport(
      base({
        incomplete: [],
        none_confirmed: {
          incomplete: false,
          assumptions: true,
          decisions_made: true,
          risks_found: true,
          tests_not_run: true,
          out_of_scope_findings: true,
          req_ids_covered: true,
          scope_deviations: true,
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/incomplete/);
  });

  it('claiming "none" while listing entries is a contradiction', () => {
    const r = parseExitReport(
      base({ incomplete: ['the migration is not written yet'], none_confirmed: { incomplete: true } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/incomplete/);
  });

  it('an unknown key is refused, not ignored', () => {
    const r = parseExitReport(base({ surprise: 'field' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/surprise/);
  });

  it('every one of the eight fields is checked, not just the first', () => {
    for (const field of [
      'incomplete',
      'assumptions',
      'decisions_made',
      'risks_found',
      'tests_not_run',
      'out_of_scope_findings',
      'req_ids_covered',
      'scope_deviations',
    ]) {
      const raw = base();
      (raw as Record<string, unknown>)[field] = [];
      delete (raw as Record<string, unknown>).none_confirmed;
      const r = parseExitReport(raw);
      expect(r.ok, field).toBe(false);
    }
  });

  it("the plan's two spellings are both accepted for the task and the evidence", () => {
    const withAliases = base({
      task_id: 'T-001',
      tests_executed: [{ name: 'gate > rejects', result: 'pass', evidence_ref: 'ev-1' }],
    });
    delete (withAliases as Record<string, unknown>).task_ref;
    const r = parseExitReport(withAliases);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.taskRef).toBe('T-001');
      expect(r.value.testsExecuted[0]?.evidenceId).toBe('ev-1');
    }
  });
});
