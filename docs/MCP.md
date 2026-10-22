# MCP — connecting an agent

ForgePM exposes its inbound MCP server over Streamable HTTP at `/mcp`. The
transport and tool contract are documented in `MCP_CONTRACTS.md`. There is no
ForgePM stdio client/proxy executable in this repository; `forgepm-mcp` is the
MCP server's reported name, not a command you can run.

## Connect over Streamable HTTP

Replace the host and placeholder with your ForgePM URL and a key created for
the intended project. Store the real key in the MCP client's secret store; do
not commit it or paste it into shared config.

```json
{
  "mcpServers": {
    "forgepm": {
      "type": "http",
      "url": "https://forgepm.example.com/mcp",
      "headers": {
        "Authorization": "Bearer fpm_REPLACE_WITH_SECRET"
      }
    }
  }
}
```

The endpoint is `POST /mcp`; requests use `Authorization: Bearer …`. Use HTTPS
outside localhost.

## Execution-control key scopes

1. An organization owner/admin enables the execution-control module for the
target organization/project (`modules.exec.enabled=true`). When it is off,
execution-control tools do not appear in `tools/list`.
2. Give the agent only `ledger:read` and `ledger:write`, and restrict
`project_ids` to the project(s) it needs. Never give an agent `ledger:decide`;
that scope is for human decisions and approvals.
3. The API Keys page lets you tick several scopes for one key; its **MCP agent scopes**
button ticks exactly `ledger:read` and `ledger:write`, and the page shows copy-ready
connection samples. To restrict the key to specific projects (`project_ids`), an
organization owner/admin can create it through the authenticated
`POST /api/v1/api-keys` endpoint:

```json
{
  "name": "forgepm-execution-agent",
  "scopes": ["ledger:read", "ledger:write"],
  "project_ids": ["REPLACE_WITH_PROJECT_UUID"]
}
```

Replace the project placeholder with a project UUID. The raw key is returned
only once; transfer it directly to the MCP client's secret store. Do not use
`admin` as a shortcut for the two ledger scopes. A human who needs to decide
or approve uses a separate human-owned key with `ledger:decide`.

## Transport limitation

Do not configure `"command": "forgepm-mcp"`: no such stdio bridge is shipped.
The repo's implemented inbound transport is Streamable HTTP only. We are not
adding a second bridge; this keeps the single-server/no-new-bridge decision
(D-002) accurate. The separate outbound MCP client feature, where configured,
is not a stdio entry point into ForgePM.
