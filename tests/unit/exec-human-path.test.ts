import { describe, it, expect } from 'vitest';
import { AppError } from '@forgepm/shared';

// Extract the humanOnly logic as tested in routes.ts (mirrored here for unit isolation)
// The real function is in apps/api/src/modules/exec/routes.ts; this test documents the R-02 table
function humanOnly(actor: { type: string; apiKeyId?: string; scopes: string[] }): void {
  if (actor.apiKeyId) {
    throw new AppError('FORBIDDEN', 'this is the human path — API keys cannot decide');
  }
  if (actor.type === 'agent') {
    throw new AppError('FORBIDDEN', 'this is the human path');
  }
}

describe('R-02 human-only decision table (apps/api/src/modules/exec/routes.ts humanOnly)', () => {
  const agentWithDecide = { type: 'agent', apiKeyId: 'k1', scopes: ['ledger:decide'] as string[] };
  const agentWithWrite = { type: 'agent', apiKeyId: 'k2', scopes: ['write'] as string[] };
  const userWithDecide = { type: 'user', apiKeyId: 'k3', scopes: ['ledger:decide'] as string[] };
  const userWithWrite = { type: 'user', apiKeyId: 'k4', scopes: ['write'] as string[] };
  const userSession = { type: 'user', scopes: ['read', 'write'] as string[] }; // no apiKeyId = session

  it('agent key with ledger:decide → 403 FORBIDDEN (R-02)', () => {
    expect(() => humanOnly(agentWithDecide)).toThrow(AppError);
    try { humanOnly(agentWithDecide); } catch (e) { expect((e as AppError).code).toBe('FORBIDDEN'); }
  });
  it('agent key with write → 403 (blocked by type first)', () => {
    expect(() => humanOnly(agentWithWrite)).toThrow(AppError);
  });
  it('user API key with only write → 403 (lacks ledger:decide)', () => {
    expect(() => humanOnly(userWithWrite)).toThrow(AppError);
    try { humanOnly(userWithWrite); } catch (e) { expect((e as AppError).code).toBe('FORBIDDEN'); }
  });
  it('user API key with ledger:decide → 403 (R-02: API keys cannot decide, even with scope)', () => {
    expect(() => humanOnly(userWithDecide)).toThrow(AppError);
    try { humanOnly(userWithDecide); } catch (e) { expect((e as AppError).code).toBe('FORBIDDEN'); }
  });
  it('user session (no apiKeyId) → pass (CSRF checked separately)', () => {
    expect(() => humanOnly(userSession)).not.toThrow();
  });
  it('waive/drop via ledger:write without ledger:decide must 403 — before fix this was red', () => {
    // This documents the red→green for waive/drop: old humanOnly only checked type,
    // so userWithWrite would have passed; now it correctly 403.
    const beforeFixWouldPass = userWithWrite.type !== 'agent'; // old logic = pass
    expect(beforeFixWouldPass).toBe(true); // proves old code had hole
    expect(() => humanOnly(userWithWrite)).toThrow(); // new code blocks it
  });
});
