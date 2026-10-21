import { describe, expect, it } from 'vitest';
import type { Actor } from '../../src/app/auth-context';
import { ledgerActor } from '../../src/modules/exec/context';

/**
 * Who the ledger believes is acting decides whether the agent-only rules apply
 * (an agent may not soft-close a blocking item). Any API key, even a user-owned
 * one, is a machine caller (R-02) and is recorded as an agent; only a panel
 * session is the human.
 */
function actor(over: Partial<Actor>): Actor {
  return {
    type: 'user',
    id: 'u1',
    organizationId: 'o1',
    orgRole: 'member',
    projectRole: () => null,
    scopes: [],
    projectIds: null,
    requestId: 'r1',
    ...over,
  } as Actor;
}

describe('ledgerActor', () => {
  it('treats an agent-owned key as an agent', () => {
    expect(ledgerActor(actor({ type: 'agent', apiKeyId: 'k1' }), 'p1', 't').actorType).toBe('agent');
  });

  it.each([['write'], ['ledger:decide']])('treats a user-owned key with scope %s as an agent', (scope) => {
    const a = actor({ apiKeyId: 'k1', scopes: [scope] as never });
    expect(ledgerActor(a, 'p1', 't').actorType).toBe('agent');
  });

  it('treats a panel session as the human', () => {
    expect(ledgerActor(actor({}), 'p1', 't').actorType).toBe('human');
  });
});
