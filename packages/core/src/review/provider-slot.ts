import type { AiProvider } from '../ai/provider';

/**
 * Review provider injection point (plan §10). The engine never builds providers
 * itself: the api sets a resolver at startup (org's enabled ai_providers, or a
 * per-run fixture in tests) and the worker sets one from its own env. Keeping
 * the slot in core means neither app imports the other (single-writer rule).
 */
export type ReviewProviderResolver = (orgId: string, runId?: string) => Promise<AiProvider | null>;

let RESOLVER: ReviewProviderResolver = async () => null;

export function setReviewProviderResolver(fn: ReviewProviderResolver): void {
  RESOLVER = fn;
}

export async function resolveReviewProvider(orgId: string, runId?: string): Promise<AiProvider | null> {
  return RESOLVER(orgId, runId);
}
