import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- path globs

// Exec-local glob matcher with standard `**` semantics (a `**` segment may mean
// ZERO directories). The review module's matchGlob requires a directory after a
// double-star prefix, which would silently narrow a user-facing promise such as
// "every .test.ts file" — allowed paths and protected test globs are safety
// rules, so the forgiving (minimatch-style) reading is the correct one here.

export function matchPathGlob(pattern: string, path: string): boolean {
  return new RegExp(globSource(pattern), 's').test(path);
}

export function globSource(pattern: string): string {
  const clean = pattern.replace(/^\.\//, '');
  let out = '^';
  let i = 0;
  while (i < clean.length) {
    const rest = clean.slice(i);
    if (rest.startsWith('**/')) {
      out += '(?:[^/]+/)*';
      i += 3;
      continue;
    }
    if (rest === '**' || rest.startsWith('**')) {
      out += '.*';
      i += 2;
      continue;
    }
    const ch = clean[i];
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return `${out}$`;
}

/**
 * Scope measurement (appendix §J, acceptance J.1/J.5). Pure: the caller supplies
 * the changed-file list from `git diff --name-status <start_ref>` (or from the
 * file-hash manifest when the repo has no git), plus the recorded manifest.
 */

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'T';
  from?: string;
}

export interface ScopeManifestFile {
  path: string;
  /** Digest of file content plus mode, or of the symbolic-link target. */
  sha256: string;
}

export interface ScopeFileManifest {
  hash: string;
  files: ScopeManifestFile[];
}

/** Normalize and hash a server-measured, content-hash-only file manifest. */
export function makeScopeManifest(files: readonly ScopeManifestFile[]): ScopeFileManifest {
  if (files.length > 10_000) throw new Error('scope manifest contains too many files');
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const hash = createHash('sha256');
  for (const file of sorted) {
    if (
      !file.path || file.path.length > 1024 || file.path.startsWith('/') || file.path.includes('\\') ||
      hasUnsafeManifestPathCharacter(file.path) || file.path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      !/^[0-9a-f]{64}$/i.test(file.sha256) || seen.has(file.path)
    ) {
      throw new Error('scope manifest contains an invalid or duplicate file entry');
    }
    seen.add(file.path);
    hash.update(`${file.path}\0${file.sha256.toLowerCase()}\n`);
  }
  return { hash: hash.digest('hex'), files: sorted.map((file) => ({ path: file.path, sha256: file.sha256.toLowerCase() })) };
}

function hasUnsafeManifestPathCharacter(path: string): boolean {
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || code === 0xfffd) return true;
  }
  return false;
}

/** Keep post-close comparisons limited to the task's immutable allowed scope. */
export function restrictScopeManifest(manifest: ScopeFileManifest, allowedGlobs: readonly string[]): ScopeFileManifest {
  const matchers = allowedGlobs.map((pattern) => new RegExp(globSource(pattern), 's'));
  return makeScopeManifest(manifest.files.filter((file) => matchers.some((matcher) => matcher.test(file.path))));
}

/** Compare hash-only snapshots while preserving additions, modifications and deletions. */
export function diffScopeManifest(before: ScopeFileManifest, after: ScopeFileManifest): ChangedFile[] {
  const oldFiles = new Map(before.files.map((file) => [file.path, file.sha256]));
  const newFiles = new Map(after.files.map((file) => [file.path, file.sha256]));
  const changes: ChangedFile[] = [];
  for (const [path, sha] of newFiles) {
    const old = oldFiles.get(path);
    if (old === undefined) changes.push({ path, status: 'A' });
    else if (old !== sha) changes.push({ path, status: 'M' });
  }
  for (const path of oldFiles.keys()) if (!newFiles.has(path)) changes.push({ path, status: 'D' });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface ScopeVerdict {
  measurable: boolean;
  basis: 'git' | 'manifest' | 'none';
  outside: ChangedFile[];
  deleted: ChangedFile[];
  touched: number;
  offending_open_items: { path: string; title: string; type: 'out_of_scope' }[];
  needs_human: boolean;
}

const TRANSIENT = new Set(['.gitignore', 'package-lock.json', 'npm-debug.log']);

export function evaluateScope(
  allowedGlobs: readonly string[],
  changed: readonly ChangedFile[],
  hasStartRef: boolean,
  manifestSize?: number,
): ScopeVerdict {
  if (!hasStartRef && !manifestSize) {
    return {
      measurable: false,
      basis: 'none',
      outside: [],
      deleted: [],
      touched: 0,
      offending_open_items: [],
      needs_human: true,
    };
  }
  const basis = hasStartRef ? 'git' : 'manifest';
  const isAllowed = (p: string) => allowedGlobs.some((g) => matchPathGlob(g, p));
  // A rename is in scope only when BOTH sides are: moving a file out of a
  // protected area must not look like an ordinary in-scope edit.
  const outside = changed.filter(
    (f) => (!isAllowed(f.path) || (f.from ? !isAllowed(f.from) : false)) && !isTransient(f.path),
  );
  const deleted = changed.filter((f) => f.status === 'D');
  return {
    measurable: true,
    basis,
    outside,
    deleted,
    touched: changed.length,
    offending_open_items: outside.map((f) => ({
      path: f.path,
      title: `file ${f.status === 'D' ? 'deleted' : 'changed'} outside allowed_paths: ${f.path}`,
      type: 'out_of_scope' as const,
    })),
    // any deleted file needs approval (plan §F row "delete file/capability")
    needs_human: outside.length > 0 || deleted.length > 0,
  };
}

/** Snapshot used when the repo has no git: hash manifest at task start. */
export function manifestOf(files: Record<string, string>): { hash: string; size: number } {
  const keys = Object.keys(files).sort();
  const h = createHash('sha256');
  for (const k of keys) h.update(`${k}\u0000${files[k]}\n`);
  return { hash: h.digest('hex'), size: keys.length };
}

export function diffManifest(before: Record<string, string>, after: Record<string, string>): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const k of Object.keys(after)) {
    if (!(k in before)) out.push({ path: k, status: 'A' });
    else if (before[k] !== after[k]) out.push({ path: k, status: 'M' });
  }
  for (const k of Object.keys(before)) if (!(k in after)) out.push({ path: k, status: 'D' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function isTransient(path: string): boolean {
  return TRANSIENT.has(path.split('/').pop() ?? path);
}

/** Stable, opaque ledger reference for a specific measured scope finding. */
export function scopeIssueRef(path: string, status: ChangedFile['status']): string {
  const digest = createHash('sha256').update(`${status}\0${path}`).digest('hex');
  return `scope:${digest}`;
}
