# MCP Contracts

Full text: EXECUTION_PLAN §8 and §13. Implemented in Phase 4.

## Transports

- Streamable HTTP at `/mcp` with `Authorization: Bearer fpm_…`.
- `forgepm-mcp` stdio binary proxying to the same server via `FORGEPM_URL` +
  `FORGEPM_API_KEY`.

## Conventions

- Tool names use underscores only (`work_item_create`).
- Each module registers tools in `mcp-tools.ts` with Zod input/output schemas
  and annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`); tools
  call only their module's service.
- Scopes: `read`, `write`, `plan`, `plan_approve`, `plan_apply`, `review`,
  `github`, `admin`. A tool is listed only if the key has its scope and its
  module is enabled; every call re-checks at runtime.
- `project_ids` key restriction applies to every tool, even ones without a
  project parameter (e.g. search).
- Sensitive operations return
  `{ status: "pending_approval", approval_request_id }` instead of executing;
  `approval_decide` requires scope `admin` + a human actor; an agent can never
  approve its own request.
- Create/bulk tools take a mandatory `idempotency_key`; other writes optional.
- Every call is logged to `mcp_tool_calls` with masked inputs.
- Rate limit default 120 calls/min per key; results ≤ 50 KB; truncation always
  announced with `truncated: true`.
- Errors are `isError: true` with `code` + model-readable message; no stack.

## Tool table (Phase 4+)

| Tool | Scope | Mutating |
| --- | --- | --- |
| `project_list`, `project_get` | read | ✗ |
| `project_create`, `project_update`, `project_archive` | admin | ✓ |
| `work_item_list/get/search/get_dependencies` | read | ✗ |
| `work_item_create/update/transition/add_comment/link/bulk_create` | write | ✓ |
| `feature_list/get/get_progress/get_work_items` | read | ✗ |
| `feature_create/update` | write | ✓ |
| `planner_analyze_project`, `planner_get_plan`, `planner_validate_plan` | plan | ✗ |
| `planner_create_plan`, `planner_update_revision`, `planner_apply_plan`, `planner_get_apply_status` | plan | ✓ |
| `planner_approve_plan` | plan_approve | ✓ (human actor only) |
| `approval_list` | read | ✗ |
| `approval_decide` | admin | ✓ (human only) |
| `github_*` (5) | github | link ✓ / rest ✗; only with module enabled |
| `review_*`, `refactor_review_*` (8) | review | start/update ✓; reports ✗ |

`planner_generate_work_items` does not exist; item generation is internal to
`create_plan`. Write-tool output envelope:
`{ status, applied, rolled_back, requires_action?, resources, skipped, request_id }`.

## Resources & prompts

- Resources: `forgepm://projects/{key}`, `forgepm://work-items/{key}`,
  `forgepm://features/{key}`.
- Prompts: `plan_feature`, `triage_issue`, `review_finding`.

## MCP Client (Phase 4b, behind `mcp.client.enabled`)

External servers registered only by admins with explicit confirmation; only
allowlisted `readOnlyHint` tools usable; stdio servers run sandboxed (absolute
allowlisted commands, own process, timeouts, memory caps, no inherited env,
path/network allowlists); credentials encrypted in `secrets`, masked in logs;
HTTP targets SSRF-checked, HTTPS mandatory except explicit localhost.

Client config examples: see `docs/MCP.md`; smoke via `npm run mcp:smoke` (Phase 4).
