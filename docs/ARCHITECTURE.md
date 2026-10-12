# Architecture

Full contracts: `EXECUTION_PLAN.md` §3 and §3b. This file is the quick map.

## Stack (monorepo, npm workspaces)

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 22 LTS (`.nvmrc`, `engines`) |
| Language | TypeScript `strict`, backend emits CommonJS |
| Backend | Fastify + `fastify-type-provider-zod` (validation + OpenAPI) |
| Validation | one shared Zod layer in `packages/shared` |
| DB | PostgreSQL 16 (single source of truth), typed SQL via Kysely |
| Queue | Redis 7 + BullMQ — queue and locks only, no durable data |
| Frontend | Angular (latest stable major), Standalone + Signals, Bootstrap 5 RTL, ngx-translate |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP + stdio |
| GitHub | `@octokit/app` + `@octokit/webhooks` (GitHub App, never PAT) |
| Panel auth | httpOnly session cookies + argon2id + CSRF |
| Machine auth | SHA-256 hashed API keys with scopes (`fpm_` prefix) |
| Logging | structured pino, `request_id` per request, credential masking |
| Tests | Vitest (unit + integration), Playwright (E2E), no external network |
| Deploy | Docker Compose: `api`, `worker`, `web`, `postgres`, `redis` |

## Layout

```
packages/shared    zod schemas, enums, error codes (API+MCP+panel contract)
packages/core      infrastructure: db (Kysely+migrations), unitOfWork, scopedDb,
                   module registry, queue client, settings, crypto, logging, env
apps/api           Fastify bootstrap + modules/<name>/{routes,service,repository,
                   schema,mcp-tools,index,*.test}; src/infrastructure re-exports core
apps/worker        outbox dispatcher, job sweeper, queue handlers
apps/web           Angular panel
tests/             integration suites, lint fixtures, schema snapshots
scripts/           seed, backup, restore, publish, doctor, schema-check, docs-check
```

## Enforced boundaries (ESLint, see `eslint.config.mjs`)

- Dependency direction: `routes` ← `service` ← `repository`; a module never
  imports another module's `repository`; raw DB/queue connections exist only
  in `@forgepm/core` infrastructure.
- The core never imports the github module (GitHub-independence principle).

## Cross-cutting contracts (§3b)

1. **Optional module lifecycle:** always registered; enabled from
   `modules.<name>.enabled` at runtime (≤5s cache, invalidated on change);
   every entry point starts with `requireModule(name)`; disabled → REST/Webhook
   `503 MODULE_DISABLED`, MCP tool hidden and rejected if called directly, jobs
   not enqueued; enable runs `validateConfig()` first; no restart needed.
   Secrets from the panel are AES-256-GCM encrypted in `secrets`; env vars are
   bootstrap-only.
2. **Tenancy:** explicit `organization_id` on top-level tables;
   `UNIQUE(id, organization_id)` on projects with composite FKs from every
   project-bearing table; every repository query goes through `scopedDb(ctx)`.
3. **Transaction / idempotency / outbox:** `unitOfWork(ctx, fn)` wraps domain
   + audit + outbox in one transaction; services never push to BullMQ directly;
   dispatcher uses `FOR UPDATE SKIP LOCKED`; at-least-once + idempotent
   handlers; `jobs` registry with `heartbeat_at`; sweeper every 5 min;
   idempotency scope `(actor_id, operation, key)`.
4. **Migrations:** forward-only `NNNN_slug`; CI runs fresh + upgrade-from-tag.
5. **Schema Contract:** `DATA_MODEL.md` DDL precedes migrations;
   `npm run schema:check` compares real schema to the doc.
6. **Runtime authorization order (all REST + MCP):** credentials → module →
   organization → project → scope/permission → approval policy → rate limit →
   idempotency. `tools/list` is never a security control.
7. **Performance budgets:** see `PERFORMANCE_BUDGET.md`.
