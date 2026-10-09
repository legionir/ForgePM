import { describe, it, expect } from 'vitest';
import { estimateTokens, ProviderError } from './provider';
import { maskInput, capOutput, MCP_MAX_OUTPUT_BYTES, ToolRegistry } from '../mcp/registry';
import { requestHash } from '../idempotency';
import { isTerminal, canTransition, nextStatus } from '../planner/state';

describe('estimateTokens (plan §7)', () => {
  it('ceil(len/4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('maskInput (plan §8.8/§14)', () => {
  it('masks nested secret-ish keys', () => {
    const r = maskInput({ a: 'x', api_key: 'secret', nested: { token: 'tok', ok: 1 } });
    expect(r.a).toBe('x');
    expect(r.api_key).toBe('[MASKED]');
    expect((r.nested as Record<string, unknown>).token).toBe('[MASKED]');
    expect((r.nested as Record<string, unknown>).ok).toBe(1);
  });
  it('non-object returns empty', () => {
    expect(maskInput(null)).toEqual({});
    expect(maskInput('str')).toEqual({});
  });
});

describe('capOutput (plan §8.9)', () => {
  it('small payload passes through', () => {
    const r = capOutput({ hello: 'world' });
    expect(r.truncated).toBe(false);
    expect(r.payload).toEqual({ hello: 'world' });
  });
  it('big payload truncated + flagged', () => {
    const big = 'x'.repeat(MCP_MAX_OUTPUT_BYTES + 1000);
    const r = capOutput({ big });
    expect(r.truncated).toBe(true);
    expect(JSON.stringify(r.payload).length).toBeLessThan(big.length);
  });
});

describe('ToolRegistry.visible (plan §8.4/§3b-1.3)', () => {
  it('filters by scope and enabled module', async () => {
    const reg = new ToolRegistry();
    const t = (name: string, scopes: string[], module?: string) => ({
      name,
      description: name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { safeParse: (x: unknown) => ({ success: true, data: x }) } as any,
      scopes,
      annotations: {},
      module,
      handler: async () => ({}),
    });
    reg.register(t('read_tool', ['read']) as never);
    reg.register(t('write_tool', ['write']) as never);
    reg.register(t('gh_tool', ['read'], 'github') as never);

    const visible = await reg.visible(['read'], async (m) => m === 'github');
    expect(visible.map((v) => v.name).sort()).toEqual(['gh_tool', 'read_tool']);
    const noGh = await reg.visible(['read'], async () => false);
    expect(noGh.map((v) => v.name)).toEqual(['read_tool']);
  });
});

describe('requestHash (plan §3b-3)', () => {
  it('is stable + content-sensitive', () => {
    expect(requestHash({ a: 1 })).toBe(requestHash({ a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe('planner state helpers (plan §7)', () => {
  it('terminal states have no outgoing transitions', () => {
    expect(isTerminal('applied')).toBe(true);
    expect(isTerminal('canceled')).toBe(true);
    expect(isTerminal('superseded')).toBe(true);
    expect(isTerminal('ready')).toBe(false);
  });
  it('canTransition enforces the table', () => {
    expect(canTransition('ready', 'approved')).toBe(true);
    expect(canTransition('ready', 'applied')).toBe(false);
    expect(canTransition('applied', 'approved')).toBe(false);
  });
  it('nextStatus maps events; unknown event throws', () => {
    expect(nextStatus('generating', 'generate_ok')).toBe('ready');
    expect(() => nextStatus('generating', 'nope' as never)).toThrow(/unknown plan event/);
  });
});

describe('ProviderError', () => {
  it('carries retryable flag', () => {
    const e = new ProviderError('boom', true);
    expect(e.retryable).toBe(true);
    expect(e.message).toBe('boom');
  });
});
