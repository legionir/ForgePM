import { describe, expect, it } from 'vitest';
import { checkEvidence, extractCounts, parseRef, redactSecrets, sha256, underRoot, type EvidenceFsLike } from './evidence';

const LONG = `RUN START\n${'x'.repeat(240)}\nTests  12 passed | 0 failed (12)\nTest Files  3 passed (3)\nRUN END`;
const fsOk: EvidenceFsLike = { exists: () => true, read: (p) => (p.endsWith('.png') ? null : `contents of ${p}`) };
const base = { actorType: 'agent' as const, roots: ['packages', 'docs', 'apps'], fs: fsOk };
const SUMMARY = 'ran the vitest suite for the exec gate, 12 passed 0 failed';

describe('evidence verification (acceptance B.10)', () => {
  it('B.10a a real test output with a readable ref is accepted and hashed', () => {
    const r = checkEvidence({ ...base, kind: 'test_output', ref: 'file:packages/core/src/exec/gate.ts:40', payload: LONG, summary: SUMMARY });
    expect(r.ok).toBe(true);
    expect(r.sha256).toBe(sha256(LONG));
    expect(r.meta?.passed).toBeGreaterThanOrEqual(12);
  });

  it('B.10b a paraphrase is rejected: too short, and with no result line', () => {
    expect(checkEvidence({ ...base, kind: 'test_output', ref: 'test:x', payload: 'all tests passed, I am sure', summary: SUMMARY }).ok).toBe(false);
    const noResult = checkEvidence({ ...base, kind: 'test_output', ref: 'test:x', payload: 'y'.repeat(400), summary: SUMMARY });
    expect(!noResult.ok && noResult.message).toContain('no result line');
  });

  it('a CI ref is a legitimate substitute for pasted output', () => {
    expect(checkEvidence({ ...base, kind: 'test_output', ref: 'ci:4321:unit', summary: SUMMARY }).ok).toBe(true);
  });

  it('B.10c manual_check is a human-only kind', () => {
    const r = checkEvidence({ ...base, kind: 'manual_check', ref: 'file:docs/x.md', summary: 'looked at it and it seems fine to me' });
    expect(r.ok).toBe(false);
    expect(r.needed_action).toContain('human');
    expect(checkEvidence({ ...base, kind: 'manual_check', actorType: 'human', ref: 'file:docs/x.md', summary: 'looked at it and it seems fine to me' }).ok).toBe(true);
  });

  it('B.10d a ref to a file outside the allowed roots, or a missing file, is refused', () => {
    const outside = checkEvidence({ ...base, kind: 'file', ref: 'file:/etc/passwd', summary: 'a file that certainly exists outside the repo roots' });
    expect(outside.code).toBe('SCOPE_VIOLATION');
    const sneaky = checkEvidence({ ...base, kind: 'file', ref: 'file:packages/../secrets/id_rsa', summary: 'trying to walk out of the root with a dot-dot' });
    expect(sneaky.code).toBe('SCOPE_VIOLATION');
    const gone = checkEvidence({ ...base, kind: 'file', ref: 'file:docs/missing.png', summary: 'a file that is not readable at all' , fs: { exists: () => true, read: () => null } });
    expect(gone.code).toBe('EVIDENCE_UNAVAILABLE');
  });

  it('B.10e an unreadable ref grammar is refused with the exact alternatives', () => {
    const r = checkEvidence({ ...base, kind: 'file', ref: 'trust me', summary: 'the summary is long enough to pass the first check' });
    expect(r.ok).toBe(false);
    expect(r.needed_action).toContain('commit:<sha>:<path>');
  });

  it('an oversized payload is refused with a redirect to a ref', () => {
    const r = checkEvidence({ ...base, kind: 'command_output', ref: 'cmd:npm run build', payload: 'z'.repeat(5000), summary: SUMMARY, maxBytes: 1024 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('max 1024');
    expect(r.needed_action).toContain('reference it instead');
  });

  it('diff evidence needs a commit ref or the diff text', () => {
    expect(checkEvidence({ ...base, kind: 'diff', ref: 'test:x', summary: 'the diff is right here, promise' }).ok).toBe(false);
    expect(checkEvidence({ ...base, kind: 'diff', ref: 'commit:1a2b3c4:packages/core/src/exec/gate.ts', summary: 'the diff is right here, promise' }).ok).toBe(true);
    expect(checkEvidence({ ...base, kind: 'diff', ref: 'file:docs/x.md', summary: 'the diff is right here, promise', payload: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new' }).ok).toBe(true);
  });

  it('parseRef understands every documented shape (and a bare path)', () => {
    expect(parseRef('file:docs/A.md:12')).toEqual({ kind: 'file', path: 'docs/A.md', line: 12 });
    expect(parseRef('packages/core/src/x.ts')).toEqual({ kind: 'file', path: 'packages/core/src/x.ts', line: undefined });
    expect(parseRef('commit:abc1234:docs/A.md')).toEqual({ kind: 'commit', sha: 'abc1234', path: 'docs/A.md' });
    expect(parseRef('ci:99:unit')).toEqual({ kind: 'ci', run: '99', job: 'unit' });
    expect(parseRef('test:a > b')).toEqual({ kind: 'test', test: 'a > b' });
    expect(parseRef('cmd:echo hi')).toEqual({ kind: 'cmd', test: 'echo hi' });
    expect(parseRef('http://x/y').kind).toBe('unknown');
  });

  it('underRoot is prefix-safe and blocks escapes', () => {
    expect(underRoot('packages/core/x.ts', ['packages'])).toBe(true);
    expect(underRoot('packages', ['packages'])).toBe(true);
    expect(underRoot('packages-evil/x', ['packages'])).toBe(false);
    expect(underRoot('./packages/x', ['packages/'])).toBe(true);
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'C:\\windows']) expect(underRoot(bad, ['a'])).toBe(false);
  });

  it('extractCounts reads runner summary lines only', () => {
    expect(extractCounts('Tests  12 passed | 3 failed | 1 skipped (16)')).toEqual({ passed: 12, failed: 3, skipped: 1 });
    expect(extractCounts('nothing here').passed).toBe(0);
  });

  it('secrets are redacted before anything is stored', () => {
    const { text, hits } = redactSecrets('token=ghp_1234567890abcdefghij password: "hunter2hunter2" normal words');
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain('ghp_1234567890abcdefghij');
    expect(text).not.toContain('hunter2hunter2');
    expect(text).toContain('normal words');
  });
});
