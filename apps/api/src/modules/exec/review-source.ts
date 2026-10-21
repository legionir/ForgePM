import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { constants, type Dirent } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { AppError } from '@forgepm/shared';
import {
  hashExecFactFile,
  hashExecFactSymlink,
  makeScopeManifest,
  type ChangedFile,
  type ExecReviewSnapshot,
  type ExecReviewSource,
  type ScopeFileManifest,
  type ScopeManifestFile,
} from '@forgepm/core';

const MAX_CHANGED_FILES = 250;
const MAX_FILE_PATCH_BYTES = 160_000;
const MAX_TOTAL_PATCH_BYTES = 800_000;
const MAX_HASH_FILE_BYTES = 32 * 1024 * 1024;
const MAX_HASH_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_HASH_FILES = 10_000;
const MAX_MANIFEST_FILES = 10_000;
const MAX_MANIFEST_TOTAL_BYTES = 512 * 1024 * 1024;
const MANIFEST_EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', '.cache', '.next', '.nuxt', '.output', '.parcel-cache',
  '.svelte-kit', '.turbo', 'build', 'coverage', 'dist', 'out', 'target',
]);
const GIT_TIMEOUT_MS = 30_000;

/**
 * Read-only Git worktree source for execution review. All Git calls use
 * execFile with fixed subcommands/argument arrays (never a shell); paths are
 * filtered against the administrator's prefix-safe roots before reading.
 */
export class GitExecReviewSource implements ExecReviewSource {
  private readonly root: string;

  constructor(root = process.cwd()) {
    this.root = resolve(root);
  }

  async snapshot(input: { start_ref: string; roots: string[] }): Promise<ExecReviewSnapshot & { truncated: boolean }> {
    const roots = validateRoots(input.roots);
    const startRef = input.start_ref.trim();
    if (!startRef || startRef.length > 128 || /[\0\r\n]/.test(startRef)) {
      throw unavailable('task has no usable start_ref; the reviewer cannot establish a baseline');
    }
    const startSha = (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${startRef}^{commit}`], 4096))
      .toString('utf8')
      .trim();
    if (!/^[0-9a-f]{40,64}$/i.test(startSha)) throw unavailable('task start_ref does not resolve to a commit');

    const beforeHash = await this.treeHash({ roots });
    const changed = parseNameStatus(
      await this.git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', startSha, '--'], 2 * 1024 * 1024),
    );
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard', '-z'], 2 * 1024 * 1024))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path, change: 'A' as const }));
    const untrackedPaths = new Set(untracked.map((file) => file.path));

    const byPath = new Map<string, { path: string; change: 'A' | 'M' | 'D' | 'R' }>();
    for (const file of [...changed, ...untracked]) {
      if (isGitMetadata(file.path) || !underAnyRoot(file.path, roots)) continue;
      assertSafePath(file.path);
      byPath.set(file.path, file);
    }
    const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    let truncated = files.length > MAX_CHANGED_FILES;
    const output: ExecReviewSnapshot['files'] = [];
    let totalBytes = 0;
    for (const file of files.slice(0, MAX_CHANGED_FILES)) {
      let patch: string;
      if (untrackedPaths.has(file.path)) {
        patch = await this.untrackedPatch(file.path);
        if (patch.includes('[SOURCE_PATCH_TRUNCATED]')) truncated = true;
      } else {
        const raw = await this.git(
          ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', startSha, '--', file.path],
          MAX_FILE_PATCH_BYTES + 1,
          true,
        );
        if (raw.length > MAX_FILE_PATCH_BYTES) truncated = true;
        patch = raw.subarray(0, MAX_FILE_PATCH_BYTES).toString('utf8');
        if (/^(?:Binary files .* differ|GIT binary patch)/m.test(patch)) truncated = true;
      }
      const size = Buffer.byteLength(patch, 'utf8');
      if (totalBytes + size > MAX_TOTAL_PATCH_BYTES) {
        truncated = true;
        break;
      }
      totalBytes += size;
      output.push({ path: file.path, change: file.change, patch });
    }
    if (files.length > output.length) truncated = true;

    const treeHash = await this.treeHash({ roots });
    if (treeHash !== beforeHash) {
      throw new AppError('REVIEW_STALE', 'REVIEW_STALE: worktree changed while the review input was being assembled');
    }
    return { files: output, tree_hash: treeHash, truncated };
  }

  /** Measure every changed path from task start; no repository content is executed. */
  async changedFiles(input: { start_ref: string }): Promise<ChangedFile[]> {
    const startSha = await this.resolveCommit(input.start_ref);
    const changed = parseScopeNameStatus(
      await this.git(
        ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', startSha, '--'],
        8 * 1024 * 1024,
      ),
    );
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard', '-z'], 8 * 1024 * 1024))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((path) => ({ path, status: 'A' as const }));
    const byPath = new Map<string, ChangedFile>();
    for (const file of [...changed, ...untracked]) {
      if (isGitMetadata(file.path)) continue;
      assertSafePath(file.path);
      byPath.set(file.path, file);
    }
    const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (files.length > 10_000) throw unavailable('scope diff contains too many paths to evaluate safely');
    return files;
  }

  async headSha(): Promise<string> {
    await this.assertGitRoot();
    const sha = (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'], 4096))
      .toString('utf8')
      .trim();
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw unavailable('current HEAD does not resolve to a commit');
    return sha;
  }

  async isWorktreeClean(): Promise<boolean> {
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all'], 2 * 1024 * 1024);
    return status.length === 0;
  }

  /** Capture exactly the read-only Git state required before a journalled action. */
  async captureJournalPreState(): Promise<string> {
    await this.assertGitRoot();
    let treeBytes: Buffer;
    let treeCommand = 'git rev-parse HEAD:.';
    try {
      treeBytes = await this.git(['rev-parse', 'HEAD:.'], 4096);
    } catch {
      // At the repository root Git does not treat `.` as a tracked tree path;
      // HEAD^{tree} is the exact root-tree equivalent. Keep the requested
      // HEAD:. command as the primary path and use this safe fallback only there.
      treeCommand = 'git rev-parse HEAD^{tree} (root equivalent of HEAD:.)';
      treeBytes = await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{tree}'], 4096);
    }
    const statusBytes = await this.git(['status', '--porcelain'], 2 * 1024 * 1024);
    const tree = treeBytes.toString('utf8').trim();
    if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw unavailable('the current HEAD did not resolve to a Git tree');
    const status = statusBytes.toString('utf8');
    const reference = `${treeCommand}\n${tree}\ngit status --porcelain\n${status}`;
    if (Buffer.byteLength(reference, 'utf8') > 2_100_000) throw unavailable('Git status is too large to store as a journal pre-state');
    return reference;
  }

  /**
   * Content-hash-only scope snapshot for environments without a Git checkout.
   * Generated/dependency directories are excluded; all other files are walked
   * without following symlinks or executing repository code. Two matching
   * passes are required so a concurrent edit cannot produce a mixed snapshot.
   */
  async fileManifest(): Promise<ScopeFileManifest> {
    await this.assertManifestRoot();
    const first = await this.captureFileManifest();
    const second = await this.captureFileManifest();
    if (first.hash !== second.hash) throw unavailable('worktree changed while the scope manifest was being captured');
    return second;
  }

  /** Bounded per-file hash snapshot, restricted to the configured review roots. */
  async fileSnapshot(input: { roots: string[] }): Promise<ScopeFileManifest> {
    const roots = validateRoots(input.roots);
    const beforeHash = await this.treeHash({ roots });
    const [trackedBytes, untrackedBytes] = await Promise.all([
      this.git(['ls-files', '--cached', '-z'], 8 * 1024 * 1024),
      this.git(['ls-files', '--others', '--exclude-standard', '-z'], 8 * 1024 * 1024),
    ]);
    const paths = [...new Set(
      [...trackedBytes.toString('utf8').split('\0'), ...untrackedBytes.toString('utf8').split('\0')].filter(Boolean),
    )]
      .filter((path) => !isGitMetadata(path) && underAnyRoot(path, roots))
      .sort();
    if (paths.length > MAX_MANIFEST_FILES) throw unavailable('configured review roots contain too many files to snapshot');

    const files: ScopeManifestFile[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      assertSafePath(path);
      const absolute = resolve(this.root, path);
      let stat;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw unavailable('a review file could not be inspected for reconciliation');
      }
      const digest = createHash('sha256');
      digest.update(`mode:${stat.mode & 0o777}\0`);
      if (stat.isSymbolicLink()) {
        let target: string;
        let realTarget: string;
        try {
          target = await readlink(absolute);
          realTarget = await realpath(absolute);
        } catch {
          throw unavailable('a review symlink is dangling or changed while being reconciled');
        }
        assertInsideWorktree(this.root, realTarget, 'a configured review symlink resolves outside the worktree');
        digest.update(`symlink:${target}`);
      } else {
        if (!stat.isFile()) throw unavailable('a review path is not a regular file');
        if (stat.size > MAX_HASH_FILE_BYTES || totalBytes + stat.size > MAX_MANIFEST_TOTAL_BYTES) {
          throw unavailable('configured review roots exceed the file-snapshot size limit');
        }
        let real: string;
        try {
          real = await realpath(absolute);
        } catch {
          throw unavailable('a review file changed while being reconciled');
        }
        assertInsideWorktree(this.root, real, 'a configured review file resolves outside the worktree');
        let content: Buffer;
        try {
          content = await readBoundedFile(real, MAX_HASH_FILE_BYTES);
        } catch {
          throw unavailable('a configured review file exceeds the safe read limit or could not be read');
        }
        totalBytes += content.byteLength;
        if (totalBytes > MAX_MANIFEST_TOTAL_BYTES) throw unavailable('configured review roots exceed the file-snapshot size limit');
        digest.update(`file:${content.byteLength}\0`);
        digest.update(content);
      }
      files.push({ path, sha256: digest.digest('hex') });
    }
    const afterHash = await this.treeHash({ roots });
    if (beforeHash !== afterHash) throw unavailable('worktree changed while the close/reconciliation snapshot was being captured');
    try {
      return makeScopeManifest(files);
    } catch {
      throw unavailable('file snapshot contains an invalid or duplicate path');
    }
  }

  /** Hash caller-selected files twice; no repository content is executed. */
  async hashFiles(input: { roots: string[]; files: string[]; allowMissing?: boolean }): Promise<ScopeFileManifest> {
    const roots = validateRoots(input.roots);
    if (!Array.isArray(input.files) || input.files.length > MAX_HASH_FILES) {
      throw unavailable('fact references contain too many paths to hash safely');
    }
    const paths = [...new Set(input.files)];
    const first = await this.captureNamedFiles(roots, paths, input.allowMissing === true);
    const second = await this.captureNamedFiles(roots, paths, input.allowMissing === true);
    if (first.hash !== second.hash) throw unavailable('fact files changed while their hashes were being captured');
    return second;
  }

  async readFilePair(input: { start_ref: string; path: string; status: ChangedFile['status'] }): Promise<{
    before: string | null;
    after: string | null;
  }> {
    assertSafePath(input.path);
    const startSha = await this.resolveCommit(input.start_ref);
    const before = input.status === 'A' ? null : await this.readAtCommit(startSha, input.path);
    const after = input.status === 'D' ? null : await this.readFromWorktree(input.path);
    return { before, after };
  }

  async treeHash(input: { roots: string[] }): Promise<string> {
    const roots = validateRoots(input.roots);
    const [trackedBytes, untrackedBytes, repoTop] = await Promise.all([
      this.git(['ls-files', '--cached', '-z'], 8 * 1024 * 1024),
      this.git(['ls-files', '--others', '--exclude-standard', '-z'], 8 * 1024 * 1024),
      this.git(['rev-parse', '--show-toplevel'], 4096),
    ]);
    const top = resolve(repoTop.toString('utf8').trim());
    if (top !== this.root) throw unavailable('review source root is not the Git worktree root');
    const files = new Set(
      [...trackedBytes.toString('utf8').split('\0'), ...untrackedBytes.toString('utf8').split('\0')].filter(Boolean),
    );
    const paths = [...files]
      .filter((path) => {
        if (isGitMetadata(path) || !underAnyRoot(path, roots)) return false;
        assertSafePath(path);
        return true;
      })
      .sort();
    if (paths.length > MAX_HASH_FILES) throw unavailable('configured review roots contain too many files to hash safely');

    const hash = createHash('sha256');
    let totalBytes = 0;
    for (const path of paths) {
      const absolute = resolve(this.root, path);
      const rel = relative(this.root, absolute);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
        throw unavailable('review path escaped the worktree');
      }
      let stat;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          hash.update(`${path}\0deleted\0`);
          continue;
        }
        throw unavailable('a file under the configured review roots cannot be inspected');
      }
      hash.update(`${path}\0mode:${stat.mode & 0o777}\0`);
      if (stat.isSymbolicLink()) {
        try {
          hash.update(`link\0${await readlink(absolute)}\0`);
        } catch {
          throw unavailable('a review symlink changed while the worktree was being hashed');
        }
        continue;
      }
      if (stat.isDirectory()) throw unavailable('Git submodules or directory replacements under review roots are not supported');
      if (!stat.isFile()) continue;
      if (stat.size > MAX_HASH_FILE_BYTES || totalBytes + stat.size > MAX_HASH_TOTAL_BYTES) {
        throw unavailable('configured review roots exceed the worktree hash size limit');
      }
      let real: string;
      try {
        real = await realpath(absolute);
      } catch {
        throw unavailable('a configured review file changed while the worktree was being hashed');
      }
      assertInsideWorktree(this.root, real, 'a configured review path resolves outside the worktree');
      let content: Buffer;
      try {
        content = await readBoundedFile(real, MAX_HASH_FILE_BYTES);
      } catch {
        throw unavailable('a configured review file changed or could not be read safely');
      }
      totalBytes += content.byteLength;
      if (totalBytes > MAX_HASH_TOTAL_BYTES) throw unavailable('configured review roots exceed the worktree hash size limit');
      hash.update(`file\0${content.byteLength}\0`);
      hash.update(content);
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  private async assertGitRoot(): Promise<void> {
    const top = resolve((await this.git(['rev-parse', '--show-toplevel'], 4096)).toString('utf8').trim());
    if (top !== this.root) throw unavailable('review source root is not the Git worktree root');
  }

  private async assertManifestRoot(): Promise<void> {
    let current = this.root;
    while (true) {
      const marker = resolve(current, '.git');
      try {
        await lstat(marker);
        if (current !== this.root) throw unavailable('manifest fallback cannot measure only a subdirectory of a Git worktree');
      } catch (error) {
        if (error instanceof AppError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw unavailable('repository metadata could not be inspected before manifest fallback');
        }
      }
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  async resolveCommit(ref: string): Promise<string> {
    await this.assertGitRoot();
    const clean = ref.trim();
    if (!clean || clean.length > 128 || /[\0\r\n]/.test(clean)) {
      throw unavailable('commit reference is empty or contains unsafe characters');
    }
    const sha = (await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${clean}^{commit}`], 4096))
      .toString('utf8')
      .trim();
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw unavailable('task start_ref does not resolve to a commit');
    return sha;
  }

  private async captureNamedFiles(roots: string[], paths: string[], allowMissing: boolean): Promise<ScopeFileManifest> {
    const files: ScopeManifestFile[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      assertSafePath(path);
      if (isGitMetadata(path) || !underAnyRoot(path, roots)) {
        throw unavailable(`fact file '${path}' is outside exec.allowed_repo_roots`);
      }
      const absolute = resolve(this.root, path);
      let stat;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw unavailable(`fact file '${path}' does not exist or cannot be inspected`);
      }
      if (stat.isSymbolicLink()) {
        let target: string;
        let realTarget: string;
        try {
          target = await readlink(absolute);
          realTarget = await realpath(absolute);
        } catch {
          throw unavailable(`fact file '${path}' is a dangling or changing symlink`);
        }
        assertInsideWorktree(this.root, realTarget, `fact file '${path}' resolves outside the worktree`);
        files.push({ path, sha256: hashExecFactSymlink(stat.mode, target) });
        continue;
      }
      if (!stat.isFile()) throw unavailable(`fact path '${path}' is not a regular file`);
      if (stat.size > MAX_HASH_FILE_BYTES || totalBytes + stat.size > MAX_HASH_TOTAL_BYTES) {
        throw unavailable('fact files exceed the safe content-hash size limit');
      }
      let real: string;
      try {
        real = await realpath(absolute);
      } catch {
        throw unavailable(`fact file '${path}' changed while it was being inspected`);
      }
      assertInsideWorktree(this.root, real, `fact file '${path}' resolves outside the worktree`);
      let content: Buffer;
      try {
        content = await readBoundedFile(real, MAX_HASH_FILE_BYTES);
      } catch {
        throw unavailable(`fact file '${path}' exceeds the safe read limit or cannot be read`);
      }
      totalBytes += content.byteLength;
      if (totalBytes > MAX_HASH_TOTAL_BYTES) throw unavailable('fact files exceed the safe content-hash size limit');
      files.push({ path, sha256: hashExecFactFile(stat.mode, content) });
    }
    try {
      return makeScopeManifest(files);
    } catch {
      throw unavailable('fact file snapshot contains an invalid or duplicate path');
    }
  }

  private async readAtCommit(sha: string, path: string): Promise<string> {
    const bytes = await this.git(['--literal-pathspecs', 'show', `${sha}:${path}`], 1_048_577, true);
    if (bytes.length > 1_048_576) throw unavailable('protected test file exceeds the safe analysis limit');
    return decodeText(bytes);
  }

  private async readFromWorktree(path: string): Promise<string> {
    const absolute = resolve(this.root, path);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      throw unavailable('protected test file changed while scope was being measured');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable('protected test file is not a regular file');
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw unavailable('protected test file changed while it was being read');
    }
    assertInsideWorktree(this.root, real, 'protected test file resolves outside the worktree');
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(real, 1_048_576);
    } catch {
      throw unavailable('protected test file exceeds the safe analysis limit or could not be read');
    }
    return decodeText(bytes);
  }

  private async untrackedPatch(path: string): Promise<string> {
    const absolute = resolve(this.root, path);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      throw unavailable('an untracked review file disappeared while being read');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return `--- /dev/null\n+++ b/${path}\n[binary or non-regular file omitted]\n+[SOURCE_PATCH_TRUNCATED]`;
    }
    if (stat.size > MAX_HASH_FILE_BYTES) throw unavailable('untracked review file exceeds the safe read limit');
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw unavailable('untracked review file changed while being read');
    }
    assertInsideWorktree(this.root, real, 'untracked review file resolves outside the worktree');
    let content: Buffer;
    try {
      content = await readBoundedFile(real, MAX_HASH_FILE_BYTES);
    } catch {
      throw unavailable('untracked review file changed or could not be read safely');
    }
    if (content.includes(0)) return `--- /dev/null\n+++ b/${path}\n[binary file omitted]\n+[SOURCE_PATCH_TRUNCATED]`;
    const text = content.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(content)) return `--- /dev/null\n+++ b/${path}\n[binary file omitted]\n+[SOURCE_PATCH_TRUNCATED]`;
    const wasTruncated = Buffer.byteLength(text, 'utf8') > MAX_FILE_PATCH_BYTES;
    const includedText = wasTruncated ? Buffer.from(text, 'utf8').subarray(0, MAX_FILE_PATCH_BYTES).toString('utf8') : text;
    const lines = includedText.split(/\r?\n/);
    const body = lines.map((line) => `+${line}`).join('\n');
    return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}${wasTruncated ? '\n+[SOURCE_PATCH_TRUNCATED]' : ''}`;
  }

  private async captureFileManifest(): Promise<ScopeFileManifest> {
    const pending = [this.root];
    const files: ScopeManifestFile[] = [];
    let totalBytes = 0;
    let visitedDirectories = 0;
    while (pending.length) {
      const directory = pending.pop();
      if (!directory) continue;
      visitedDirectories += 1;
      if (visitedDirectories > MAX_MANIFEST_FILES) throw unavailable('scope manifest contains too many directories');
      let entries: Dirent[];
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a regular directory');
        const real = await realpath(directory);
        assertInsideWorktree(this.root, real, 'a scope directory resolves outside the worktree');
        entries = await readdir(real, { withFileTypes: true });
      } catch {
        throw unavailable('scope manifest could not read a directory safely');
      }
      if (entries.length > MAX_MANIFEST_FILES) throw unavailable('scope manifest directory has too many entries');
      for (const entry of entries) {
        const absolute = resolve(directory, entry.name);
        const path = relative(this.root, absolute).split(sep).join('/');
        if (isGitMetadata(path)) continue;
        assertSafePath(path);
        if (entry.isDirectory()) {
          if (!MANIFEST_EXCLUDED_DIRS.has(entry.name)) pending.push(absolute);
          continue;
        }
        if (entry.isSymbolicLink()) {
          let target: string;
          let realTarget: string;
          try {
            target = await readlink(absolute);
            realTarget = await realpath(absolute);
          } catch {
            throw unavailable('a scope symlink is dangling or changed while the manifest was being captured');
          }
          assertInsideWorktree(this.root, realTarget, 'a scope symlink resolves outside the worktree');
          files.push({ path, sha256: createHash('sha256').update(`symlink:${target}`).digest('hex') });
        } else if (entry.isFile()) {
          let stat;
          try {
            stat = await lstat(absolute);
          } catch {
            throw unavailable('a scope file changed while the manifest was being captured');
          }
          if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable('a scope file changed type while being measured');
          if (stat.size > MAX_HASH_FILE_BYTES || totalBytes + stat.size > MAX_MANIFEST_TOTAL_BYTES) {
            throw unavailable('scope manifest exceeds the safe content-hash size limit');
          }
          let real: string;
          try {
            real = await realpath(absolute);
          } catch {
            throw unavailable('a scope file changed while the manifest was being captured');
          }
          assertInsideWorktree(this.root, real, 'a scope file resolves outside the worktree');
          let content: Buffer;
          try {
            content = await readBoundedFile(real, MAX_HASH_FILE_BYTES);
          } catch {
            throw unavailable('a scope file exceeded the safe read limit or could not be read');
          }
          totalBytes += content.byteLength;
          const digest = createHash('sha256').update(`mode:${stat.mode & 0o777}:`).update(content).digest('hex');
          files.push({ path, sha256: digest });
        } else {
          throw unavailable('scope manifest encountered a non-regular filesystem entry');
        }
        if (files.length > MAX_MANIFEST_FILES) throw unavailable('scope manifest contains too many files');
      }
    }
    try {
      return makeScopeManifest(files);
    } catch {
      throw unavailable('scope manifest contains an invalid or duplicate file entry');
    }
  }

  private git(args: string[], maxBuffer: number, allowTruncate = false): Promise<Buffer> {
    return new Promise((resolveOutput, reject) => {
      const env = { ...process.env };
      for (const key of [
        'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
      ]) delete env[key];
      env.GIT_CONFIG_NOSYSTEM = '1';
      env.GIT_CONFIG_GLOBAL = devNull;
      env.GIT_CONFIG_COUNT = '0';
      env.GIT_OPTIONAL_LOCKS = '0';
      env.GIT_PAGER = 'cat';
      env.GIT_TERMINAL_PROMPT = '0';
      env.GIT_ASKPASS = 'echo';
      // Plumbing hardening: no hooks, no fsmonitor/filter/external diff from repo config (R-05)
      // Use os.devNull for portability (Windows NUL vs Unix /dev/null)
      const hardening = [
        '-c', 'core.fsmonitor=false',
        '-c', `core.hooksPath=${devNull}`,
        '-c', 'core.pager=cat',
        '-c', 'core.protectHFS=false',
        '-c', 'diff.external=',
        '-c', 'protocol.allow=never',
        '-c', 'filter.lfs.process=',
        '-c', 'filter.lfs.required=false',
      ];
      execFile(
        'git',
        [...hardening, ...args],
        {
          cwd: this.root,
          encoding: 'buffer',
          maxBuffer,
          timeout: GIT_TIMEOUT_MS,
          env,
        },
        (error, stdout, stderr) => {
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
          if (!error) {
            resolveOutput(out);
            return;
          }
          const partial = (error as NodeJS.ErrnoException & { stdout?: Buffer | string }).stdout;
          if (allowTruncate && (error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && partial) {
            resolveOutput(Buffer.isBuffer(partial) ? partial : Buffer.from(partial));
            return;
          }
          // Global git config is ignored on purpose (hardening), so `safe.directory` cannot
          // help: the worktree must be owned by the user the API runs as. Say so, but never
          // echo git's raw stderr (it can carry paths).
          const dubious = /dubious ownership/i.test(Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''));
          reject(
            unavailable(
              dubious
                ? 'Git refused the worktree: it is owned by a different user than the API process; run the API as the repository owner'
                : 'Git could not safely read the configured worktree',
            ),
          );
        },
      );
    });
  }
}

function validateRoots(raw: string[]): string[] {
  if (!Array.isArray(raw) || raw.some((root) => typeof root !== 'string')) {
    throw unavailable('exec.allowed_repo_roots must be a list of relative paths');
  }
  const roots = [...new Set(raw.map((root) => root.trim().replace(/\/+$/, '')))];
  if (!roots.length) throw unavailable('exec.allowed_repo_roots is empty; configure a read-only review root first');
  for (const root of roots) {
    if (
      !root || root.startsWith('/') || root.includes('\\') || /[\0\r\n*?]/.test(root) || root.includes('[') || root.includes(']') ||
      root.split('/').some((part) => !part || part === '.' || part === '..') || root === '.git' || root.startsWith('.git/')
    ) {
      throw unavailable('exec.allowed_repo_roots must contain relative, prefix-safe paths without glob syntax');
    }
  }
  return roots;
}

function parseNameStatus(buffer: Buffer): { path: string; change: 'A' | 'M' | 'D' | 'R' }[] {
  const fields = buffer.toString('utf8').split('\0').filter(Boolean);
  const files: { path: string; change: 'A' | 'M' | 'D' | 'R' }[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (/^[RC]/.test(status)) {
      const from = fields[i++];
      const to = fields[i++];
      if (to) files.push({ path: to, change: 'R' });
      else if (from) files.push({ path: from, change: status[0] === 'C' ? 'A' : 'R' });
      continue;
    }
    const path = fields[i++];
    if (!path) continue;
    const change = status.startsWith('D') ? 'D' : status.startsWith('A') ? 'A' : 'M';
    files.push({ path, change });
  }
  return files;
}

function parseScopeNameStatus(buffer: Buffer): ChangedFile[] {
  const fields = buffer.toString('utf8').split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++] ?? '';
    if (/^[RC]/.test(status)) {
      const from = fields[i++];
      const to = fields[i++];
      if (from && to) files.push({ path: to, from, status: status[0] === 'C' ? 'A' : 'R' });
      continue;
    }
    const path = fields[i++];
    if (!path) continue;
    const mark = status[0];
    if (mark === 'U' || !['A', 'M', 'D', 'T'].includes(mark ?? '')) {
      throw unavailable('Git diff contains an unsupported or unmerged path status');
    }
    const change = mark as ChangedFile['status'];
    files.push({ path, status: change });
  }
  return files;
}

function decodeText(buffer: Buffer): string {
  if (buffer.includes(0)) throw unavailable('protected test input is binary and cannot be measured');
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw unavailable('protected test input is not valid UTF-8');
  return text;
}

function underAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function assertSafePath(path: string): void {
  if (
    !path || path.startsWith('/') || path.includes('\\') || hasUnsafePathCharacter(path) ||
    path.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw unavailable('Git returned a path that cannot be safely included in a review');
  }
}

function hasUnsafePathCharacter(path: string): boolean {
  for (const char of path) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || code === 0xfffd) return true;
  }
  return false;
}

function isGitMetadata(path: string): boolean {
  return path.split('/').includes('.git');
}

function assertInsideWorktree(root: string, target: string, message: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw unavailable(message);
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw unavailable('review file exceeds its safe read limit or is not a regular file');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw unavailable('review file grew beyond its safe read limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function unavailable(message: string): AppError {
  return new AppError('REVIEW_INPUT_UNAVAILABLE', `REVIEW_INPUT_UNAVAILABLE: ${message}`, {
    needed_action: 'configure an allowed repository root and a valid task start_ref, or ask a human to review the task manually',
  });
}
