import { describe, expect, it } from 'vitest';
import { diffManifest, evaluateScope, isTransient, manifestOf } from './scope';

describe('scope enforcement (appendix §J, acceptance J.5)', () => {
  it('J.5a a change outside allowed_paths is reported as an offender needing approval', () => {
    const v = evaluateScope(['packages/**', 'docs/**'], [{ path: 'infra/main.tf', status: 'M' }], true);
    expect(v.measurable).toBe(true);
    expect(v.basis).toBe('git');
    expect(v.outside.map((f) => f.path)).toEqual(['infra/main.tf']);
    expect(v.needs_human).toBe(true);
    expect(v.offending_open_items[0].type).toBe('out_of_scope');
    expect(v.offending_open_items[0].title).toContain('infra/main.tf');
  });

  it('J.5b an in-scope change touches nobody', () => {
    const v = evaluateScope(['packages/**'], [{ path: 'packages/core/src/x.ts', status: 'M' }], true);
    expect(v.outside).toEqual([]);
    expect(v.needs_human).toBe(false);
    expect(v.touched).toBe(1);
  });

  it('a rename is in scope only if BOTH sides are', () => {
    expect(
      evaluateScope(['packages/**'], [{ path: 'packages/a.ts', status: 'R', from: 'infra/b.ts' }], true).outside,
    ).toHaveLength(1);
    expect(
      evaluateScope(['packages/**'], [{ path: 'packages/a.ts', status: 'R', from: 'packages/b.ts' }], true).outside,
    ).toHaveLength(0);
  });

  it('deleting a file needs a human even when it is inside the scope', () => {
    const v = evaluateScope(['packages/**'], [{ path: 'packages/x.ts', status: 'D' }], true);
    expect(v.outside).toEqual([]);
    expect(v.deleted).toHaveLength(1);
    expect(v.needs_human).toBe(true);
  });

  it('J.5c without a start_ref AND without a manifest nothing can be measured ⇒ human', () => {
    const v = evaluateScope(['packages/**'], [{ path: 'packages/x.ts', status: 'M' }], false);
    expect(v.measurable).toBe(false);
    expect(v.basis).toBe('none');
    expect(v.needs_human).toBe(true);
  });

  it('the manifest is a fallback basis when git is unavailable (D-06)', () => {
    const v = evaluateScope(['packages/**'], [{ path: 'packages/x.ts', status: 'M' }], false, 12);
    expect(v.measurable).toBe(true);
    expect(v.basis).toBe('manifest');
  });

  it('lockfiles and debug logs are transient noise, not scope violations', () => {
    expect(isTransient('package-lock.json')).toBe(true);
    expect(isTransient('repo/.gitignore')).toBe(true);
    expect(isTransient('packages/core/src/gate.ts')).toBe(false);
    const v = evaluateScope(['packages/**'], [{ path: 'package-lock.json', status: 'M' }], true);
    expect(v.outside).toEqual([]);
    expect(v.needs_human).toBe(false);
  });

  it('manifestOf is order-insensitive and content-sensitive', () => {
    const a = manifestOf({ 'x.ts': '1', 'y.ts': '2' });
    expect(a).toEqual(manifestOf({ 'y.ts': '2', 'x.ts': '1' }));
    expect(a.hash).not.toBe(manifestOf({ 'x.ts': '1', 'y.ts': '3' }).hash);
    expect(a.size).toBe(2);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('diffManifest classifies add/modify/delete', () => {
    expect(diffManifest({ a: '1', b: '2' }, { a: '1', b: '9', c: '3' })).toEqual([
      { path: 'b', status: 'M' },
      { path: 'c', status: 'A' },
    ]);
    expect(diffManifest({ a: '1' }, {})).toEqual([{ path: 'a', status: 'D' }]);
  });
});
