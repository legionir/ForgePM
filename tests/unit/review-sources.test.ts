import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { withStagedRepo, assertUnderRoot, incrementalScope, githubFiles, setRepoFetcher } from '../../packages/core/src';

describe('review code sources (plan §10.6.1)', () => {
  it('withStagedRepo removes the temp dir after success', async () => {
    let captured = '';
    const { result } = await withStagedRepo([{ path: 'a.ts', content: 'x' }], async (dir) => {
      captured = dir;
      expect(existsSync(dir)).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(existsSync(captured)).toBe(false); // cleaned up
  });

  it('withStagedRepo removes the temp dir even when the job fails', async () => {
    let captured = '';
    await expect(
      withStagedRepo([{ path: 'a.ts', content: 'x' }], async (dir) => {
        captured = dir;
        throw new Error('job crashed');
      }),
    ).rejects.toThrow('job crashed');
    expect(existsSync(captured)).toBe(false);
  });

  it('assertUnderRoot blocks path traversal out of REPO_MOUNT_ROOT', () => {
    expect(() => assertUnderRoot('/srv/repos', '/srv/repos/good/x')).not.toThrow();
    expect(() => assertUnderRoot('/srv/repos', '/etc/passwd')).toThrow();
    expect(() => assertUnderRoot('/srv/repos', '/srv/repos/../evil')).toThrow();
  });

  it('githubFiles requires an injected fetcher (core works without GitHub)', async () => {
    setRepoFetcher(null);
    expect(() => githubFiles('r', 'sha')).toThrow();
    setRepoFetcher(async () => [{ path: 'a.ts', content: 'x' }]);
    const files = await githubFiles('r', 'sha');
    expect(files).toHaveLength(1);
    setRepoFetcher(null);
  });

  it('incrementalScope = changed files + direct import neighbours only', () => {
    const edges = [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'b.ts', to: 'c.ts' },
      { from: 'd.ts', to: 'z.ts' },
    ];
    const scope = incrementalScope(['a.ts'], edges).sort();
    expect(scope).toEqual(['a.ts', 'b.ts']); // c/d/z untouched
  });
});
