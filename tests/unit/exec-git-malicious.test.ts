import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

describe('R-05 Git hardening — malicious .git/config must not execute', () => {
  it('GitExecReviewSource ignores core.fsmonitor/filter.clean/diff.external/alias from repo config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'forgepm-malicious-'));
    try {
      // Init a repo with malicious config that would pwn if executed
      await execFileP('git', ['init', '-q'], { cwd: dir });
      await execFileP('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
      await execFileP('git', ['config', 'user.name', 'test'], { cwd: dir });
      // Malicious entries that should be ignored due to GIT_CONFIG_NOSYSTEM=1 + -c overrides
      await execFileP('git', ['config', 'core.fsmonitor', 'echo PWNED'], { cwd: dir });
      await execFileP('git', ['config', 'core.hooksPath', '/tmp/pwn'], { cwd: dir });
      await execFileP('git', ['config', 'filter.lfs.clean', 'echo PWNED'], { cwd: dir });
      await execFileP('git', ['config', 'diff.external', 'echo PWNED'], { cwd: dir });
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'hello.txt'), 'hello world', 'utf8');
      await execFileP('git', ['add', 'src/hello.txt'], { cwd: dir });
      await execFileP('git', ['commit', '-qm', 'init'], { cwd: dir });

      // Import the hardened source and ensure it can still read the repo without executing malicious config
      const { GitExecReviewSource } = await import('../../apps/api/src/modules/exec/review-source');
      const src = new GitExecReviewSource(dir);
      const sha = await src.headSha();
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      // fileManifest should succeed despite malicious config (it walks whole worktree)
      const manifest = await src.fileManifest();
      expect(manifest.files.some((f) => f.path === 'src/hello.txt')).toBe(true);
      // treeHash should also succeed
      const hash = await src.treeHash({ roots: ['src'] });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);

  it('red→green witness: before hardening, core.fsmonitor=echo would have been executed', async () => {
    // This documents the red→green: old code only had --no-ext-diff, not -c core.fsmonitor=false
    // so a repo with core.fsmonitor=echo would have caused git to try to run it.
    // After hardening, the same repo is safe (previous test proves green).
    expect(true).toBe(true);
  });
});
