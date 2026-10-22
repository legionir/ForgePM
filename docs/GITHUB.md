# GitHub Integration Guide (Phase 5)

Source: EXECUTION_PLAN §9. GitHub is an optional module: the core never
imports it; it is registered at startup and enabled at runtime via
`modules.github.enabled` with `validateConfig()` (App check) on enable.

## Setup

1. Panel → Integrations → GitHub: enter App ID, private key, webhook secret.
   They are stored encrypted in `secrets` (env vars `GITHUB_APP_ID`,
   `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` are bootstrap-only).
2. GitHub App minimum permissions: Metadata (read), Contents (read), Pull
   requests (read/write), Issues (read), Checks (write, optional).
3. Subscribe events: `pull_request`, `pull_request_review`, `push`, `create`,
   `delete`, `issues`, `issue_comment`, `release`, `installation`,
   `installation_repositories`.
4. Webhook → `POST /integrations/github/webhook` (disabled module →
   `503 MODULE_DISABLED`; bad `X-Hub-Signature-256` (constant-time compare) →
   `401`; valid → `webhook_deliveries` + `outbox` in one transaction, `202`;
   processing in the worker).

## Behaviour

- Project repositories: `GET /api/v1/projects/:id/repositories` lists the linked repositories and
  `DELETE /api/v1/projects/:id/repositories/:repositoryId` removes only the link (D-069). The GitHub page
  shows a green link icon for unconnected and a red unlink icon for connected repositories.

- Repositories: `installation` (created) and `installation_repositories` (added) deliveries
  upsert the repositories they list; removals are never deleted. Redeliver the
  `installation` delivery to backfill an install made earlier (D-068).

- Key extraction `[A-Z]{2,5}-\d+` from branch names, PR title/body, commit
  messages → `work_item_external_links`; `closes|fixes|resolves KEY` on merge
  transitions the item only when `github.auto_transition_on_merge=true`
  (default false).
- Issue sync: `off` (default) or `import` only (GitHub → ForgePM, idempotent
  via `external_issue_links`, local edits after last sync win and a
  `sync_conflict` audit event is recorded). `export`/`two_way` are not
  implemented in v1 and shown as unavailable.
- Releases tracked in `releases`; features whose `target_release` matches the
  tag are suggested for `released`.
- Nightly reconciliation job (PRs of the last 48 h, honouring `Retry-After`
  and ETags); the generic sweeper re-enqueues unprocessed deliveries.
- MCP tools: `github_list_repositories`, `github_list_pull_requests`,
  `github_get_pull_request`, `github_get_commit`, `github_link_pull_request`
  (scope `github`; listed only while the module is enabled).

## Testing without GitHub

Fake GitHub API (MSW) + real webhook payload fixtures under
`apps/api/test/fixtures/github/`. No test needs the internet. No source code
or secrets are stored — metadata only.
