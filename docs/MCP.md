# MCP — connecting a client

The built-in MCP server ships in Phase 4. Contract in `MCP_CONTRACTS.md`;
example client configuration below, verified by `pnpm mcp:smoke`.

## Streamable HTTP

```json
{
  "mcpServers": {
    "forgepm": {
      "type": "http",
      "url": "https://forgepm.example.com/mcp",
      "headers": { "Authorization": "Bearer fpm_YOUR_API_KEY" }
    }
  }
}
```

## stdio (proxy binary)

```json
{
  "mcpServers": {
    "forgepm": {
      "command": "forgepm-mcp",
      "env": { "FORGEPM_URL": "https://forgepm.example.com", "FORGEPM_API_KEY": "fpm_..." }
    }
  }
}
```

Create the key in the panel (API Keys) with the minimum scopes needed —
`read` for analysis-only agents; add `write`/`plan`/`review`/`admin` per role,
and pin `project_ids` to the projects the agent may touch. Sensitive
operations return `pending_approval`; a human approves in the panel.
