import { z } from 'zod';
import { AppError } from '@forgepm/shared';
import {
  applyPullRequestEvent,
  normalizePullRequestPayload,
  type Db,
  type McpCallContext,
  type McpToolDefinition,
} from '@forgepm/core';
import { listRepositories } from './service';

/**
 * FakeGitHubClient (plan §9 test-only): the shape of the small surface we
 * need from GitHub. In production the octokit-based client implements it;
 * in tests we inject a scripted fake so the suite runs offline.
 */
export interface PullRequestSummary {
  id: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  body: string | null;
  head_sha: string;
  head_ref: string;
  author: string;
  merged: boolean;
  merged_at: string | null;
}

export interface IssueSummary {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  updated_at: string;
}

export interface GithubClient {
  listRepositories(org: string): Promise<{ external_id: string; full_name: string }[]>;
  listPullRequests(fullName: string): Promise<PullRequestSummary[]>;
  getPullRequest(fullName: string, number: number): Promise<PullRequestSummary | null>;
  getCommit(fullName: string, sha: string): Promise<{ sha: string; message: string; author: string } | null>;
  getIssue(fullName: string, number: number): Promise<IssueSummary | null>;
}

/** A scripted fake used by tests; each method reads from injected tables. */
export class FakeGithubClient implements GithubClient {
  constructor(private data: { repos?: { external_id: string; full_name: string }[]; prs?: PullRequestSummary[]; issues?: IssueSummary[]; commits?: { sha: string; message: string; author: string }[] } = {}) {}
  async listRepositories() { return this.data.repos ?? []; }
  async listPullRequests(fullName: string) { return (this.data.prs ?? []).filter((p) => p.head_ref && fullName); }
  async getPullRequest(_full: string, number: number) { return (this.data.prs ?? []).find((p) => p.number === number) ?? null; }
  async getCommit(_full: string, sha: string) { return (this.data.commits ?? []).find((c) => c.sha === sha) ?? null; }
  async getIssue(_full: string, number: number) { return (this.data.issues ?? []).find((i) => i.number === number) ?? null; }
}

// In-process registry so both api/worker handlers resolve a client for tests
// without importing each other's modules.
let CLIENT: (() => GithubClient | null) = () => null;
export function setGithubClientFactory(fn: () => GithubClient | null): void {
  CLIENT = fn;
}
export function githubClient(): GithubClient | null {
  return CLIENT();
}

/** Register the five github_* tools. All are module-gated on 'github'. */
export function buildGithubTools(db: Db): McpToolDefinition[] {
  // module gating is enforced at call time by the MCP dispatcher via the
  // `module: 'github'` field (plan §3b-1.3), so tools need not re-check.
  const actor = (ctx: McpCallContext) => ctx.actor;
  const tool = (t: McpToolDefinition): McpToolDefinition => t;

  return [
    tool({
      name: 'github_list_repositories',
      description: 'List repositories connected to the org.',
      inputSchema: z.object({}),
      scopes: ['github'],
      annotations: { readOnlyHint: true },
      module: 'github',
      handler: async (args, ctx) => {
        void args;
        return { items: await listRepositories(db, actor(ctx).organizationId) };
      },
    }),
    tool({
      name: 'github_list_pull_requests',
      description: 'List PRs for a repository (via the configured or fake client).',
      inputSchema: z.object({ repository_full_name: z.string().max(200) }),
      scopes: ['github'],
      annotations: { readOnlyHint: true },
      module: 'github',
      handler: async (args, _ctx) => {
        const c = githubClient();
        if (!c) return { error: 'NO_CLIENT' };
        return { items: await c.listPullRequests(args.repository_full_name as string) };
      },
    }),
    tool({
      name: 'github_get_pull_request',
      description: 'Get a single PR by repository + number.',
      inputSchema: z.object({ repository_full_name: z.string().max(200), number: z.number().int().min(1) }),
      scopes: ['github'],
      annotations: { readOnlyHint: true },
      module: 'github',
      handler: async (args, _ctx) => {
        const c = githubClient();
        if (!c) return { error: 'NO_CLIENT' };
        const pr = await c.getPullRequest(args.repository_full_name as string, args.number as number);
        return pr ? { pr } : { error: 'NOT_FOUND' };
      },
    }),
    tool({
      name: 'github_get_commit',
      description: 'Get a commit by repository + sha.',
      inputSchema: z.object({ repository_full_name: z.string().max(200), sha: z.string().max(80) }),
      scopes: ['github'],
      annotations: { readOnlyHint: true },
      module: 'github',
      handler: async (args, _ctx) => {
        const c = githubClient();
        if (!c) return { error: 'NO_CLIENT' };
        const cm = await c.getCommit(args.repository_full_name as string, args.sha as string);
        return cm ? { commit: cm } : { error: 'NOT_FOUND' };
      },
    }),
    tool({
      name: 'github_link_pull_request',
      description: 'Link an existing PR (via a normalized payload) to work items.',
      inputSchema: z.object({
        organization_id: z.string().uuid(),
        event: z.record(z.unknown()),
      }),
      scopes: ['github'],
      annotations: { destructiveHint: false, idempotentHint: true },
      module: 'github',
      handler: async (args, _ctx) => {
        const ev = normalizePullRequestPayload(args.event as Record<string, unknown>);
        if (!ev) throw new AppError('VALIDATION_ERROR', 'event must contain pull_request + repository');
        return applyPullRequestEvent(db, args.organization_id as string, ev, async () => false);
      },
    }),
  ];
}


