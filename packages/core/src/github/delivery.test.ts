import { describe, it, expect } from 'vitest';
import {
  extractItemKeys,
  extractClosingKeys,
  normalizePullRequestPayload,
  normalizeIssuePayload,
} from './delivery';

describe('github delivery helpers (plan §9.4)', () => {
  it('extractItemKeys finds unique PRJ-N keys (2-5 uppercase letters)', () => {
    expect(extractItemKeys('work on FPM-1 and FPM-2 and FPM-1 again')).toEqual(['FPM-1', 'FPM-2']);
    expect(extractItemKeys(null)).toEqual([]);
    expect(extractItemKeys('AB-1 ok')).toEqual(['AB-1']); // 2-letter prefix allowed by [A-Z]{2,5}
    expect(extractItemKeys('toolongkey-3 abcdef-9')).toEqual([]); // lowercase prefixes ignored
  });

  it('extractClosingKeys matches closes/fixes/resolves verbs with key', () => {
    expect(extractClosingKeys('this fixes FPM-13 and resolves FPM-4')).toEqual(['FPM-13', 'FPM-4']);
    expect(extractClosingKeys('closed FPM-9')).toEqual(['FPM-9']);
    expect(extractClosingKeys('fix FPM-1')).toEqual(['FPM-1']);
    expect(extractClosingKeys('no keywords here')).toEqual([]);
    // a bare key with no closing verb is not a "closes" reference
    expect(extractClosingKeys('fpm-1 mentioned alone')).toEqual([]);
  });

  it('normalizePullRequestPayload maps a GitHub shape', () => {
    const ev = normalizePullRequestPayload({
      action: 'closed',
      repository: { id: 42, full_name: 'a/b' },
      pull_request: { id: 7, number: 3, title: 't', state: 'closed', draft: false, merged: true, merged_at: '2026-01-01T00:00:00Z', user: { login: 'bob' }, head: { sha: 'abc', ref: 'feat/FPM-1' } },
    });
    expect(ev).not.toBeNull();
    expect(ev?.repository_external_id).toBe('42');
    expect(ev?.pr_external_id).toBe('7');
    expect(ev?.merged).toBe(true);
    expect(ev?.author).toBe('bob');
    expect(ev?.head_ref).toBe('feat/FPM-1');
  });

  it('normalizePullRequestPayload returns null on missing pieces', () => {
    expect(normalizePullRequestPayload({})).toBeNull();
    expect(normalizePullRequestPayload({ repository: { id: 1 } })).toBeNull();
  });

  it('normalizeIssuePayload maps an issues payload', () => {
    const r = normalizeIssuePayload({
      issue: { id: 1, number: 10, title: 't', body: 'b', state: 'closed', updated_at: '2026-01-01T00:00:00Z', labels: [{ name: 'bug' }, { name: 'urgent' }] },
      repository: { id: 99, full_name: 'o/r' },
    });
    expect(r).not.toBeNull();
    expect(r?.issue.issue_number).toBe(10);
    expect(r?.issue.labels).toEqual(['bug', 'urgent']);
    expect(r?.issue.remote_version).toBe('2026-01-01T00:00:00Z');
  });
});
