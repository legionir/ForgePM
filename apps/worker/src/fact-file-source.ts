import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { AppError } from '@forgepm/shared';
import {
  hashExecFactFile,
  hashExecFactSymlink,
  makeScopeManifest,
  type ExecFactFileSource,
  type ScopeFileManifest,
  type ScopeManifestFile,
} from '@forgepm/core';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 10_000;

/** Filesystem-only verifier for workers sharing the configured read-only repo mount. */
export class LocalFactFileSource implements ExecFactFileSource {
  private readonly root: string;

  constructor(root = process.env.REPO_MOUNT_ROOT || process.cwd()) {
    this.root = resolve(root);
  }

  async hashFiles(input: { roots: string[]; files: string[]; allowMissing?: boolean }): Promise<ScopeFileManifest> {
    const roots = validateRoots(input.roots);
    if (!Array.isArray(input.files) || input.files.length > MAX_FILES) {
      throw unavailable('fact source contains too many paths to hash safely');
    }
    const paths = [...new Set(input.files)];
    const first = await this.capture(roots, paths, input.allowMissing === true);
    const second = await this.capture(roots, paths, input.allowMissing === true);
    if (first.hash !== second.hash) throw unavailable('fact files changed while hashes were captured');
    return second;
  }

  private async capture(roots: string[], paths: string[], allowMissing: boolean): Promise<ScopeFileManifest> {
    const files: ScopeManifestFile[] = [];
    let totalBytes = 0;
    for (const path of paths) {
      assertSafePath(path);
      if (!underAnyRoot(path, roots) || path.split('/').includes('.git')) {
        throw unavailable(`fact file '${path}' is outside exec.allowed_repo_roots`);
      }
      const absolute = resolve(this.root, path);
      assertInsideRoot(this.root, absolute);
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
        assertInsideRoot(this.root, realTarget);
        files.push({ path, sha256: hashExecFactSymlink(stat.mode, target) });
        continue;
      }
      if (!stat.isFile()) throw unavailable(`fact path '${path}' is not a regular file`);
      if (stat.size > MAX_FILE_BYTES || totalBytes + stat.size > MAX_TOTAL_BYTES) {
        throw unavailable('fact files exceed the safe content-hash size limit');
      }
      let real: string;
      try {
        real = await realpath(absolute);
      } catch {
        throw unavailable(`fact file '${path}' changed while being inspected`);
      }
      assertInsideRoot(this.root, real);
      let content: Buffer;
      try {
        content = await readBounded(real);
      } catch {
        throw unavailable(`fact file '${path}' exceeds the safe read limit or cannot be read`);
      }
      totalBytes += content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw unavailable('fact files exceed the safe content-hash size limit');
      files.push({ path, sha256: hashExecFactFile(stat.mode, content) });
    }
    try {
      return makeScopeManifest(files);
    } catch {
      throw unavailable('fact file snapshot contains an invalid or duplicate path');
    }
  }
}

function validateRoots(raw: string[]): string[] {
  if (!Array.isArray(raw) || !raw.length || raw.some((root) => typeof root !== 'string')) {
    throw unavailable('exec.allowed_repo_roots must be a non-empty list of relative paths');
  }
  const roots = [...new Set(raw.map((root) => root.trim().replace(/\/+$/, '')))];
  for (const root of roots) {
    if (
      !root || root.startsWith('/') || root.includes('\\') || hasControlChars(root) ||
      ['*', '?', '[', ']'].some((character) => root.includes(character)) ||
      root.split('/').some((part) => !part || part === '.' || part === '..') || root === '.git' || root.startsWith('.git/')
    ) {
      throw unavailable('exec.allowed_repo_roots must contain prefix-safe relative paths');
    }
  }
  return roots;
}

function assertSafePath(path: string): void {
  if (
    !path || path.startsWith('/') || path.includes('\\') || hasControlChars(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw unavailable('fact source path is not a safe relative file path');
  }
}

function hasControlChars(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function underAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function assertInsideRoot(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    throw unavailable('fact source path resolves outside the repository mount');
  }
}

async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw unavailable('fact source is not a regular file or exceeds its safe read limit');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) throw unavailable('fact source grew beyond its safe read limit');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function unavailable(message: string): AppError {
  return new AppError('EVIDENCE_UNAVAILABLE', message, {
    needed_action: 'mount the project repository read-only and configure exec.allowed_repo_roots',
  });
}
