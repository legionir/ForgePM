import { describe, expect, it } from 'vitest';
import { parseFactSourceRef, sourceRefPath } from './fact-evidence';

describe('fact source references (PE-11 / I.7)', () => {
  it('parses file paths with optional line numbers and legacy documentation paths', () => {
    expect(parseFactSourceRef('file:packages/core/src/exec/facts.ts:42')).toMatchObject({
      kind: 'file',
      path: 'packages/core/src/exec/facts.ts',
    });
    expect(parseFactSourceRef('docs/EXECUTION_CONTROL_PLAN.md')).toMatchObject({
      kind: 'file',
      path: 'docs/EXECUTION_CONTROL_PLAN.md',
    });
    expect(sourceRefPath('commit:'.concat('a'.repeat(40)))).toBeNull();
  });

  it('accepts only parseable commit hashes and named command journals', () => {
    expect(parseFactSourceRef(`commit:${'c'.repeat(40)}:packages/core/src/exec/facts.ts`)).toMatchObject({
      kind: 'commit',
      value: 'c'.repeat(40),
      path: 'packages/core/src/exec/facts.ts',
    });
    expect(parseFactSourceRef('cmd:AJ-007')).toMatchObject({ kind: 'cmd', value: 'AJ-007' });
    expect(() => parseFactSourceRef('commit:not-a-sha')).toThrow(/parseable/);
    expect(() => parseFactSourceRef('cmd:')).toThrow(/completed journal/);
  });

  it('rejects absolute paths, traversal, and unknown reference schemes', () => {
    expect(() => parseFactSourceRef('file:../secrets.txt')).toThrow();
    expect(() => parseFactSourceRef('/etc/passwd')).toThrow();
    expect(() => parseFactSourceRef('https://example.invalid/fact')).toThrow(/unsupported source_ref/);
  });
});
