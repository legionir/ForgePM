import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AnalyzerFile } from './analyzer';

/**
 * Refactor Review code sources (plan §10.6.1): `local` (a read-only directory
 * under REPO_MOUNT_ROOT) or `github` (contents fetched by an injected fetcher
 * and staged into a temp worker directory that is ALWAYS removed, including on
 * failure). The fetcher is injected so core never imports the github module
 * and the suite stays offline.
 */

export type RepoFetcher = (repositoryId: string, commitSha: string) => Promise<AnalyzerFile[]>;

let FETCHER: RepoFetcher | null = null;
export function setRepoFetcher(fn: RepoFetcher | null): void {
  FETCHER = fn;
}

export function githubFiles(repositoryId: string, commitSha: string): Promise<AnalyzerFile[]> {
  if (!FETCHER) throw new Error('no repo fetcher configured (github source unavailable)');
  return FETCHER(repositoryId, commitSha);
}

/**
 * Stage fetched files under a private temp dir, run the analysis, then delete
 * the dir in `finally` — the plan requires cleanup after success AND failure.
 */
export async function withStagedRepo<T>(files: AnalyzerFile[], fn: (dir: string) => Promise<T>): Promise<{ result: T; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'forgepm-clone-'));
  try {
    for (const f of files) {
      const target = join(dir, f.path);
      if (!target.startsWith(dir + '/')) continue; // defensive: never write outside the temp dir
      const idx = target.lastIndexOf('/');
      if (idx > 0) await mkdir(target.slice(0, idx), { recursive: true });
      await writeFile(target, f.content, 'utf8');
    }
    return { result: await fn(dir), dir };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Guard a local (mounted) source against path traversal out of the root. */
export function assertUnderRoot(root: string, target: string): void {
  const resolve = (s: string): string => {
    const parts: string[] = [];
    for (const seg of s.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return '/' + parts.join('/');
  };
  const r = resolve(root);
  const t = resolve(target);
  if (t !== r && !t.startsWith(r + '/')) throw new Error('repo path escapes REPO_MOUNT_ROOT');
}

/**
 * Incremental scope (plan §10.6.5): files changed since the previous analysed
 * commit, plus their direct importers/importees. `changedPaths` come from the
 * caller (git diff / GitHub compare); edges from the stored index.
 */
export function incrementalScope(changedPaths: string[], edges: { from: string; to: string }[]): string[] {
  const out = new Set(changedPaths);
  for (const e of edges) {
    if (changedPaths.includes(e.from)) out.add(e.to);
    if (changedPaths.includes(e.to)) out.add(e.from);
  }
  return [...out];
}
