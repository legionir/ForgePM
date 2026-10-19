import { createHash } from 'node:crypto';

/** Stable per-file hashes shared by the API and periodic worker adapters. */
export function hashExecFactFile(mode: number, content: Uint8Array): string {
  return createHash('sha256')
    .update(`mode:${mode & 0o777}\0file:${content.byteLength}\0`)
    .update(content)
    .digest('hex');
}

export function hashExecFactSymlink(mode: number, target: string): string {
  return createHash('sha256').update(`mode:${mode & 0o777}\0symlink:${target}`).digest('hex');
}
