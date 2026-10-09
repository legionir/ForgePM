import type { Hunk, SnapshotFile } from './contract';

/**
 * Diff/snapshot source slot for webhook-triggered Code Review (plan §10.6.A.2):
 * the real implementation fetches the PR diff + commit tree via the configured
 * GitHub client; tests inject a deterministic fake. Core owns the slot so the
 * worker never imports the api and the engine never imports GitHub.
 */
export type DiffProvider = (args: {
  organizationId: string;
  repositoryId: string;
  repositoryFullName: string;
  prNumber: number;
  headSha: string | null;
}) => Promise<{ hunks: Hunk[]; snapshot: SnapshotFile[] }>;

let PROVIDER: DiffProvider | null = null;

export function setDiffProvider(fn: DiffProvider | null): void {
  PROVIDER = fn;
}

export function diffProvider(): DiffProvider | null {
  return PROVIDER;
}
