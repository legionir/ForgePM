import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolRegistry, maskInput, capOutput, type McpCallContext } from '@forgepm/core';

/**
 * Contract test with the REAL MCP SDK client (plan §8 acceptance "test
 * integration with the SDK client itself"). A low-level SDK McpServer is
 * populated from our own ToolRegistry, and a real SDK Client drives
 * initialize/tools-list/tools-call over the SDK's in-memory transport. The
 * same registry also backs the Streamable-HTTP /mcp endpoint (see
 * tests/integration/phase4.test.ts) so both surfaces share one contract.
 */
function fakeActor(): McpCallContext['actor'] {
  return { type: 'agent', id: 'a', organizationId: 'o', orgRole: 'owner', projectRole: () => null, scopes: ['read', 'write'], projectIds: null };
}

function bridge(registry: ToolRegistry): McpServer {
  const server = new McpServer({ name: 'forgepm-mcp', version: '1.0.0' });
  for (const t of registry.all()) {
    const shape = (t.inputSchema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ?? {};
    server.tool(t.name, t.description, shape, async (raw: Record<string, unknown>) => {
      const ctx: McpCallContext = { actor: fakeActor(), requestId: 'sdk-1' };
      const out = await t.handler(raw as never, ctx);
      const capped = capOutput(out);
      return { content: [{ type: 'text' as const, text: JSON.stringify(capped.payload) }] };
    });
  }
  return server;
}

describe('real MCP SDK client ↔ tool registry (plan §8)', () => {
  it('initialize + listTools + callTool round-trip through the SDK', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echo back',
      inputSchema: z.object({ message: z.string() }),
      scopes: ['read'],
      annotations: { readOnlyHint: true },
      handler: async (args: Record<string, unknown>) => ({ echoed: args.message }),
    });

    const server = bridge(registry);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    // The SDK auto-initializes on connect(); verify handshake info is present.
    expect((client.getServerVersion() ?? {}).name).toBe('forgepm-mcp');

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toContain('echo');

    const res = await client.callTool({ name: 'echo', arguments: { message: 'hi' } });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toEqual({ echoed: 'hi' });

    await client.close();
    await server.close();
  });

  it('maskInput hides key-like fields (call logging, plan §8.8/§14)', () => {
    const masked = maskInput({ message: 'hi', api_key: 'fpm_secret', nested: { token: 'abc', keep: 1 } });
    const s = JSON.stringify(masked);
    expect(s).not.toContain('fpm_secret');
    expect(s).not.toContain('abc');
    expect((masked as Record<string, unknown>).message).toBe('hi');
  });
});
