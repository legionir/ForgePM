import { describe, expect, it } from 'vitest';
import { REVIEWER_PREAMBLE, buildReviewInput, parseReviewOutput, type ReviewInputParts } from './review-input';

const parts: ReviewInputParts = {
  user_request: [
    { code: 'REQ-1', text: 'the login endpoint must reject revoked tokens', quote: 'کاربر باید بتواند خارج شود' },
  ],
  criteria: [
    {
      code: 'C-1',
      text: 'POST /auth/logout returns 401 for a revoked token',
      status: 'verified',
      evidence: [{ ref: 'test:auth logout', kind: 'test_output', ok: true }],
    },
  ],
  diff: [{ path: 'packages/core/src/exec/gate.ts', change: 'M', patch: '@@ -1 +1 @@\n-old\n+new' }],
  ledger_status: { open_items: 0, criteria: { verified: 1 } },
  exit_report: { tests_executed: 1, tests_not_run: 0, incomplete: [] },
  requirements: [{ code: 'REQ-1', text: 'logout', covered_by: ['C-1'] }],
  scope_verdict: { measurable: true, outside: [] },
  baseline_verdict: { ok: true, newly_failing: [] },
  stale_facts: [{ code: 'F-1', key: 'node_version' }],
};

describe('adversarial reviewer isolation (plan §E, acceptance E.1–E.4)', () => {
  it('E.1 conversation-shaped inputs are refused at every nesting depth', () => {
    for (const k of ['messages', 'agent_history', 'chat', 'transcript', 'conversation', 'reasoning', 'scratchpad']) {
      expect(() => buildReviewInput({ ...parts, [k]: 'the whole chat so far' } as never), k).toThrowError(
        /not allowed/,
      );
    }
    expect(() => buildReviewInput({ ...parts, ledger_status: { task: { conversation: ['hidden'] } } })).toThrowError(/not allowed/);
    expect(() => buildReviewInput({ ...parts, exit_report: { messages: ['hidden'] } })).toThrowError(/not allowed/);
  });

  it('E.2 the prompt contains exactly the five documented sections, in order', () => {
    const built = buildReviewInput(parts);
    expect(built.meta.sections).toEqual(['user_request', 'criteria', 'diff', 'ledger_status', 'exit_report']);
    for (const sec of built.meta.sections) expect(built.prompt).toContain(sec);
    expect(built.prompt).toContain('کاربر باید بتواند خارج شود'); // verbatim human text is passed through
    expect(built.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.meta.bytes).toBe(Buffer.byteLength(built.prompt, 'utf8'));
  });

  it('redacts secret-shaped strings before the prompt is sent and counted', () => {
    const secret = 'ghp_' + 'z'.repeat(32);
    const built = buildReviewInput({
      ...parts,
      user_request: [{ code: 'REQ-1', text: 'keep credentials private', quote: `token=${secret}` }],
    });
    expect(built.prompt).not.toContain(secret);
    expect(built.meta.redacted_secrets).toBeGreaterThan(0);
    expect(built.meta.sha256).toBeTruthy();
  });

  it('E.2b the preamble states the isolation rule and the output contract', () => {
    expect(built_has(REVIEWER_PREAMBLE, ['adversarial', 'JSON', 'evidence_ref'])).toBe(true);
  });

  it('E.3 the byte budget caps the payload instead of failing silently', () => {
    const big: ReviewInputParts = { ...parts, diff: [{ path: 'a.ts', change: 'M', patch: 'y'.repeat(50_000) }] };
    const built = buildReviewInput(big, 4000);
    expect(built.meta.bytes).toBeLessThanOrEqual(4000 + Buffer.byteLength(REVIEWER_PREAMBLE, 'utf8'));
    expect(built.meta.excluded).toContain('overflow beyond maxBytes');
  });

  function built_has(text: string, needles: string[]): boolean {
    return needles.every((n) => text.toLowerCase().includes(n.toLowerCase()));
  }
});

describe('reviewer output validation (acceptance E.4)', () => {
  const clean = { verdict: 'pass', checked: ['criteria C-1', 'diff'], findings: [] };
  it('accepts strict JSON and fenced JSON alike', () => {
    expect(parseReviewOutput(JSON.stringify(clean))).toMatchObject({ ok: true });
    expect(parseReviewOutput('```json\n' + JSON.stringify(clean) + '\n```').ok).toBe(true);
  });

  it('binds file:line witnesses to a changed line in this exact input', () => {
    const built = buildReviewInput(parts);
    const finding = {
      title: 'missing behavior for logout',
      type: 'bug',
      blocks_completion: true,
      evidence_ref: 'file:packages/core/src/exec/gate.ts:1',
      why: 'the changed implementation does not enforce the required behavior',
    };
    expect(parseReviewOutput(JSON.stringify({ verdict: 'fail', checked: ['diff'], findings: [finding] }), built.witness_refs).ok).toBe(true);
    expect(parseReviewOutput(JSON.stringify({ verdict: 'fail', checked: ['diff'], findings: [{ ...finding, evidence_ref: 'file:packages/core/src/exec/gate.ts:9' }] }), built.witness_refs).ok).toBe(false);
  });

  it('a "clean" verdict with nothing checked is not a review', () => {
    const r = parseReviewOutput(JSON.stringify({ ...clean, checked: [] }));
    expect(r.ok).toBe(false);
  });

  it('E.4a a finding without a witness is rejected', () => {
    const r = parseReviewOutput(
      JSON.stringify({
        verdict: 'fail',
        checked: ['diff'],
        findings: [{ title: 'no logout test', type: 'test_gap', why: 'x'.repeat(40) }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('evidence_ref is required');
  });

  it('E.4b a blocking finding cannot hide behind a "pass" verdict', () => {
    const blocking = {
      verdict: 'pass',
      checked: ['diff'],
      findings: [
        {
          title: 'auth bypass',
          type: 'bug',
          blocks_completion: true,
          evidence_ref: 'file:apps/api/src/x.ts:3',
          why: 'the token check is skipped when the header is missing',
        },
      ],
    };
    const r = parseReviewOutput(JSON.stringify(blocking));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('requires verdict="fail"');
  });

  it('E.4c a suggestion never blocks, even if the model says so', () => {
    const r = parseReviewOutput(
      JSON.stringify({
        verdict: 'pass',
        checked: ['diff'],
        findings: [
          {
            title: 'naming could improve',
            type: 'suggestion',
            blocks_completion: true,
            evidence_ref: 'file:a.ts:1',
            why: 'naming is unclear in this module today',
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('may not block completion');
    const ok = parseReviewOutput(
      JSON.stringify({
        verdict: 'pass',
        checked: ['diff'],
        findings: [
          {
            title: 'naming could improve',
            type: 'suggestion',
            blocks_completion: false,
            evidence_ref: 'file:a.ts:1',
            why: 'naming is unclear in this module today',
          },
        ],
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.findings[0].blocks_completion).toBe(false);
  });

  it('a fail verdict without any finding is nonsense and is refused', () => {
    expect(parseReviewOutput(JSON.stringify({ verdict: 'fail', checked: ['diff'], findings: [] })).ok).toBe(false);
  });

  it("prose instead of JSON is refused (one retry is the caller's job)", () => {
    const r = parseReviewOutput('I looked at the code and it seems fine to me.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(['output is not valid JSON']);
  });

  it('an unknown finding type is refused so categories cannot drift', () => {
    const r = parseReviewOutput(
      JSON.stringify({
        verdict: 'fail',
        checked: ['d'],
        findings: [
          {
            title: 'weird thing',
            type: 'vibe',
            evidence_ref: 'file:a.ts:1',
            why: 'it does not feel complete at all here',
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('type must be one of');
  });
});
