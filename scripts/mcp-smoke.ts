/**
 * pnpm mcp:smoke — real SDK client against a running server.
 * Requires FORGEPM_URL and FORGEPM_API_KEY env or --url/--key args.
 * Exercises initialize→tools/list→tools/call against `/mcp` via StreamableHTTP.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const url = process.env.FORGEPM_URL ?? 'http://127.0.0.1:3001';
const key = process.env.FORGEPM_API_KEY;

async function main(): Promise<void> {
  if (!key) {
    console.error('FORGEPM_API_KEY required');
    process.exit(1);
  }
  const endpoint = new URL('/mcp', url).toString();
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'forgepm-smoke', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('tools:', tools.tools.map((t) => t.name).join(','));
  if (!tools.tools.find((t) => t.name === 'project_list')) {
    console.error('project_list missing');
    process.exit(2);
  }
  const list = await client.callTool({ name: 'project_list', arguments: { limit: 1 } });
  console.log('project_list ok:', JSON.stringify(list).slice(0, 120));
  await client.close();
  console.log('mcp:smoke PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
