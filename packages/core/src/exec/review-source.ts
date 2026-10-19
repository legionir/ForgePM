import type { ReviewInputParts } from './review-input';
import type { ChangedFile, ScopeFileManifest } from './scope';

export interface ExecReviewSnapshot {
  files: ReviewInputParts['diff'];
  /** SHA-256 of the current worktree content under the configured roots. */
  tree_hash: string;
  /** True when the source had to omit any part of the changed-file input. */
  truncated?: boolean;
}

/** Read-only boundary used by execution review and the completion gate. */
export interface ExecFactFileSource {
  /** Hash only named paths; missing paths are omitted only during verification. */
  hashFiles?(input: { roots: string[]; files: string[]; allowMissing?: boolean }): Promise<ScopeFileManifest>;
  /** Resolve a caller-supplied commit to a canonical commit SHA, if Git is available. */
  resolveCommit?(ref: string): Promise<string>;
  /** Compatibility fallback for sources which only capture a full root manifest. */
  fileSnapshot?(input: { roots: string[] }): Promise<ScopeFileManifest>;
}

export interface ExecReviewSource extends ExecFactFileSource {
  snapshot(input: { start_ref: string; roots: string[] }): Promise<ExecReviewSnapshot>;
  treeHash(input: { roots: string[] }): Promise<string>;
  /** Code-measured diff used by Rule 11; report.changed_files is never a source. */
  changedFiles?(input: { start_ref: string }): Promise<ChangedFile[]>;
  /** Current repository revision, read by the API adapter rather than supplied by an agent. */
  headSha?(): Promise<string>;
  /** True only when the CI-comparable commit is also the measured worktree. */
  isWorktreeClean?(): Promise<boolean>;
  /** Hash-only fallback for scope measurement when no Git commit is available. */
  fileManifest?(): Promise<ScopeFileManifest>;
  /** Captured immediately before journal_start; fixed read-only Git commands only. */
  captureJournalPreState?(): Promise<string>;
  /** Read-only file pair for protected-test weakening analysis. */
  readFilePair?(input: { start_ref: string; path: string; status: ChangedFile['status'] }): Promise<{
    before: string | null;
    after: string | null;
  }>;
}

let SOURCE: ExecReviewSource | null = null;

/** Installed by the API at startup; tests may replace it with an offline fixture. */
export function setExecReviewSource(source: ExecReviewSource | null): void {
  SOURCE = source;
}

export function resolveExecReviewSource(): ExecReviewSource | null {
  return SOURCE;
}
