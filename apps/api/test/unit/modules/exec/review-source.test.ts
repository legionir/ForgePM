import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffScopeManifest } from '@forgepm/core';
import { GitExecReviewSource } from '../../../../src/modules/exec/review-source';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gitRepo(): Promise<{ root: string; baseline: string }> {
  const root = await mkdtemp(join(tmpdir(), 'forgepm-exec-review-'));
  tempDirs.push(root);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'ForgePM test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'forgepm-test@example.invalid'], { cwd: root });
  await mkdir(join(root, 'packages/core/src'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'packages/core/src/base.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'docs/readme.md'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, baseline };
}

describe('GitExecReviewSource (read-only PE-7 input)', () => {
  it('limits the diff to configured roots, includes untracked files and hashes the current tree', async () => {
    const { root, baseline } = await gitRepo();
    await writeFile(join(root, 'packages/core/src/base.ts'), 'export const value = 2;\n');
    await writeFile(join(root, 'packages/core/src/new.ts'), 'export const added = true;\n');
    await writeFile(join(root, 'docs/readme.md'), 'outside the configured root\n');

    const source = new GitExecReviewSource(root);
    const snapshot = await source.snapshot({ start_ref: baseline, roots: ['packages'] });
    expect(snapshot.files.map((file) => file.path)).toEqual(['packages/core/src/base.ts', 'packages/core/src/new.ts']);
    expect(snapshot.files.find((file) => file.path.endsWith('new.ts'))?.patch).toContain('+export const added = true;');
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.tree_hash).toMatch(/^[0-9a-f]{64}$/);

    const before = await source.treeHash({ roots: ['packages'] });
    await writeFile(join(root, 'packages/core/src/base.ts'), 'export const value = 3;\n');
    const after = await source.treeHash({ roots: ['packages'] });
    expect(after).not.toBe(before);
  });

  it('marks omitted untracked content as truncated and hashes executable-mode changes', async () => {
    const { root, baseline } = await gitRepo();
    const file = join(root, 'packages/core/src/large.ts');
    await writeFile(file, 'x'.repeat(160_001));
    const source = new GitExecReviewSource(root);
    const snapshot = await source.snapshot({ start_ref: baseline, roots: ['packages'] });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.files[0]?.patch).toContain('[SOURCE_PATCH_TRUNCATED]');

    const beforeMode = await source.treeHash({ roots: ['packages'] });
    await chmod(file, 0o755);
    const afterMode = await source.treeHash({ roots: ['packages'] });
    expect(afterMode).not.toBe(beforeMode);
  });

  it('measures all changed paths from a start commit and reads protected-test file pairs', async () => {
    const { root, baseline } = await gitRepo();
    await writeFile(join(root, 'packages/core/src/base.ts'), 'export const value = 2;\n');
    await rm(join(root, 'docs/readme.md'));
    await writeFile(join(root, 'packages/core/src/new.test.ts'), 'it.only("focused", () => expect(true).toBe(true));\n');

    const source = new GitExecReviewSource(root);
    const changes = await source.changedFiles({ start_ref: baseline });
    expect(changes.map((file) => [file.path, file.status])).toEqual([
      ['docs/readme.md', 'D'],
      ['packages/core/src/base.ts', 'M'],
      ['packages/core/src/new.test.ts', 'A'],
    ]);
    expect(await source.headSha()).toBe(baseline);
    expect(await source.isWorktreeClean()).toBe(false);

    const pair = await source.readFilePair({
      start_ref: baseline,
      path: 'packages/core/src/new.test.ts',
      status: 'A',
    });
    expect(pair.before).toBeNull();
    expect(pair.after).toContain('it.only');
    const deleted = await source.readFilePair({ start_ref: baseline, path: 'docs/readme.md', status: 'D' });
    expect(deleted.before).toContain('baseline');
    expect(deleted.after).toBeNull();
  });

  it('captures and diffs a stable hash-only manifest when Git is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgepm-exec-manifest-'));
    tempDirs.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(root, 'src/change.ts'), 'export const value = 1;');
    await writeFile(join(root, 'src/delete.ts'), 'export const removed = true;');
    await writeFile(join(root, 'node_modules/pkg/ignored.js'), 'generated dependency');
    const source = new GitExecReviewSource(root);
    const before = await source.fileManifest();
    expect(before.files.map((file) => file.path)).toEqual(['src/change.ts', 'src/delete.ts']);
    expect(JSON.stringify(before)).not.toContain('export const value');
    const originalDigest = before.files.find((file) => file.path === 'src/change.ts')?.sha256;
    await chmod(join(root, 'src/change.ts'), 0o755);
    const modeChanged = await source.fileManifest();
    expect(modeChanged.files.find((file) => file.path === 'src/change.ts')?.sha256).not.toBe(originalDigest);

    await writeFile(join(root, 'src/change.ts'), 'export const value = 2;');
    await writeFile(join(root, 'src/delete.ts'), '');
    await rm(join(root, 'src/delete.ts'));
    await writeFile(join(root, 'src/add.ts'), 'export const added = true;');
    const after = await source.fileManifest();
    expect(diffScopeManifest(before, after)).toEqual([
      { path: 'src/add.ts', status: 'A' },
      { path: 'src/change.ts', status: 'M' },
      { path: 'src/delete.ts', status: 'D' },
    ]);
  });

  it('captures journal pre-state and bounded per-file hashes without returning file contents', async () => {
    const { root } = await gitRepo();
    const source = new GitExecReviewSource(root);
    const preState = await source.captureJournalPreState();
    expect(preState).toMatch(/git rev-parse HEAD:\.|HEAD\^\{tree\}/);
    expect(preState).toContain('git status --porcelain');
    expect(preState).not.toContain('export const value');

    const before = await source.fileSnapshot({ roots: ['packages'] });
    expect(before.files.map((file) => file.path)).toEqual(['packages/core/src/base.ts']);
    await writeFile(join(root, 'packages/core/src/base.ts'), 'export const value = 2;\n');
    const after = await source.fileSnapshot({ roots: ['packages'] });
    expect(diffScopeManifest(before, after)).toEqual([{ path: 'packages/core/src/base.ts', status: 'M' }]);
  });

  it('confirms a clean committed HEAD for CI SHA matching', async () => {
    const { root, baseline } = await gitRepo();
    const source = new GitExecReviewSource(root);
    expect(await source.isWorktreeClean()).toBe(true);
    expect(await source.headSha()).toBe(baseline);
    await writeFile(join(root, 'packages/core/src/base.ts'), 'export const value = 2;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'change'], { cwd: root });
    expect(await source.isWorktreeClean()).toBe(true);
    expect(await source.headSha()).not.toBe(baseline);
  });

  it('rejects a Git-less manifest symlink that resolves outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgepm-exec-manifest-'));
    const outside = await mkdtemp(join(tmpdir(), 'forgepm-exec-outside-'));
    tempDirs.push(root, outside);
    await writeFile(join(outside, 'secret.txt'), 'not part of the worktree');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await expect(new GitExecReviewSource(root).fileManifest()).rejects.toMatchObject({
      code: 'REVIEW_INPUT_UNAVAILABLE',
    });
  });

  it('does not mistake a subdirectory of a Git checkout for a Git-less workspace', async () => {
    const { root } = await gitRepo();
    const nested = join(root, 'packages/core/src');
    const source = new GitExecReviewSource(nested);
    await expect(source.headSha()).rejects.toMatchObject({ code: 'REVIEW_INPUT_UNAVAILABLE' });
    await expect(source.fileManifest()).rejects.toMatchObject({ code: 'REVIEW_INPUT_UNAVAILABLE' });
  });

  it('fails closed for traversal, absolute paths and glob-like roots', async () => {
    const { root } = await gitRepo();
    const source = new GitExecReviewSource(root);
    for (const invalid of ['../outside', '/etc', 'packages/**']) {
      await expect(source.treeHash({ roots: [invalid] })).rejects.toMatchObject({ code: 'REVIEW_INPUT_UNAVAILABLE' });
    }
  });
});
