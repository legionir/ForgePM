import { describe, it, expect } from 'vitest';
import type { Actor } from '../../src/app/auth-context';
import { ledgerActor } from '../../src/modules/exec/context';

const ORG = '01a1363b-a5e0-740e-aa70-83bfb583030f';
const PROJECT = '01a1496e-66f2-73a7-bab3-038ebac16444';

function actor(over: Partial<Actor>): Actor {
  return { id: 'u1', type: 'user', organizationId: ORG, ...over } as Actor;
}

describe('ledgerActor (R-02: a machine caller is never the human)', () => {
  it('user-owned key is an agent', () => {
    const l = ledgerActor(actor({ type: 'user', apiKeyId: 'key-1' }), PROJECT, 'ledger_resolve_item');
    expect(l.actorType).toBe('agent');
    expect(l.projectId).toBe(PROJECT);
  });

  it('panel session is human', () => {
    expect(ledgerActor(actor({ type: 'user', apiKeyId: undefined }), PROJECT, 'ledger_resolve_item').actorType).toBe('human');
  });

  it('agent actor is an agent', () => {
    expect(ledgerActor(actor({ type: 'agent', apiKeyId: 'key-2' }), PROJECT, 'ledger_resolve_item').actorType).toBe('agent');
  });
});
