import { describe, expect, it } from 'vitest';
import { maskSecrets, parseEvidenceAdd } from './evidence-service';

/**
 * The write path of `ledger_add_evidence` (plan §9.1, acceptance B.10/B.16).
 *
 * The parts that are pure live here: the shape check and the secret mask.
 * Everything that needs a database (the row, the criterion's verification, the
 * event) is proved by the integration case in `tests/integration/exec-tools.test.ts`.
 */

const SUMMARY = 'ran the vitest suite for the exec gate, 12 passed and 0 failed';

describe('the evidence payload is strict', () => {
  it('a good payload parses', () => {
    const r = parseEvidenceAdd({
      task_ref: 'T-001',
      criterion_ref: 'C-001',
      kind: 'test_output',
      ref: 'test:exec > gate',
      summary: SUMMARY,
      payload: `RUN START\n${'x'.repeat(240)}\nTests 12 passed | 0 failed (12)\nTest Files 3 passed (3)\nRUN END`,
    });
    expect(r.ok).toBe(true);
  });

  it('an unknown key is refused, not ignored', () => {
    const r = parseEvidenceAdd({
      task_ref: 'T-001',
      kind: 'test_output',
      ref: 'test:x',
      summary: SUMMARY,
      surprise: 'field',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/surprise/);
  });

  it('a test output with no real output is refused before the service sees it', () => {
    const r = parseEvidenceAdd({
      task_ref: 'T-001',
      kind: 'test_output',
      ref: 'test:x',
      summary: SUMMARY,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/payload/);
  });

  it('a CI ref is enough for a test output — the log lives in CI', () => {
    const r = parseEvidenceAdd({
      task_ref: 'T-001',
      kind: 'test_output',
      ref: 'ci:4321:unit',
      summary: SUMMARY,
    });
    expect(r.ok).toBe(true);
  });
});

describe('secrets never reach the ledger (B.16)', () => {
  it('a token in the payload is masked', () => {
    const out = maskSecrets({
      ref: 'test:x',
      summary: SUMMARY,
      payload: 'the run used token=ghp_abcdefghijklmnopqrstuvwxyz0123 to push',
    });
    expect(out.payload).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(out.redacted).toBeGreaterThan(0);
  });

  it('a password in the summary is masked', () => {
    const out = maskSecrets({
      ref: 'test:x',
      summary: 'the deploy used password: "hunter2hunter2" and it worked',
    });
    expect(out.summary).not.toContain('hunter2hunter2');
    expect(out.redacted).toBeGreaterThan(0);
  });

  it('an ordinary summary is left alone', () => {
    const out = maskSecrets({ ref: 'test:x', summary: SUMMARY });
    expect(out.summary).toBe(SUMMARY);
    expect(out.redacted).toBe(0);
  });
});
