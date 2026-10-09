# Changelog

All notable changes to ForgePM, per plan phase. Format loosely follows
Conventional Commits groupings. Tags map to plan §17.

## [0.0.0] — Phase 0 (2026-10-09)

### Added

- pnpm workspace monorepo: `packages/shared` (zod contracts, enums, error
  codes, cursor pagination), `packages/core` (infrastructure), `apps/api`,
  `apps/worker`, `apps/web`, `tests`, `scripts`.
- Strict TypeScript (CommonJS backend), ESLint with module-boundary +
  raw-connection rules proven by forbidden fixtures, Prettier, commitlint,
  husky hook, `.nvmrc`, engines pinning.
- `pnpm verify` = lint → typecheck → unit+integration with coverage
  thresholds (80% lines/functions) → build.
- Env validation with Zod (`FORGEPM_SECRET_KEY` 32-byte base64 enforced),
  clear failure message + non-zero exit.
- Kysely + forward-only migrator; migration `0001_infra` implementing the
  Schema Contract §A exactly (outbox, jobs with `heartbeat_at`/`outbox_id` +
  unique `jobs(outbox_id)`, idempotency_keys with
  `UNIQUE(actor_id, operation, key)`, settings with the scope CHECK and the
  partial/expression unique equivalent of `NULLS NOT DISTINCT` — PG14-safe
  per DECISIONS D-002).
- `unitOfWork(ctx, fn)` transaction+outbox primitive; `scopedDb(ctx)` tenancy
  wrapper; application-side UUIDv7 generator.
- Module registry implementing §3b-1 lifecycle: always-registered, runtime
  `modules.<name>.enabled` (≤5s cache + invalidation), `requireModule` guard
  → `503 MODULE_DISABLED`, `validateConfig()` on enable, no-restart toggling
  (`GET /api/v1/modules`, `PUT /api/v1/modules/:name/enabled`). Sample module
  with routes registered while disabled.
- Effective settings resolution project ← organization ← system matching the
  exact `scope_id` (tenancy bug caught and fixed by the red acceptance test).
- AES-256-GCM secret cipher with `key_version` rotation layout; pino logging
  with credential redaction.
- Fastify app: unified error envelope `{ error: { code, message, details?,
  request_id } }`, `request_id` on every request, security headers, CORS
  pinned to `WEB_ORIGIN`, 1 MiB body limit, `GET /health/live`,
  `GET /health/ready` (503 when Postgres *or* Redis is down; live stays 200 —
  automated), OpenAPI 3.0 document at `/api/v1/openapi.json`.
- Worker: BullMQ outbox dispatcher (`FOR UPDATE SKIP LOCKED`, job registry
  row in one transaction, enqueue via BullMQ jobId dedupe, `dispatched_at`
  stamped after enqueue, crash between commit and enqueue recovers without
  duplicate effects) and job sweeper (stale `queued` re-enqueued, stale
  `running` heartbeat → `failed`), sample `system.ping` job executed purely
  through the outbox path with at-least-once idempotency.
- Vitest unit + integration suites (real Postgres/Redis; per-file isolated
  databases): 51 tests covering health, module lifecycle, settings
  constraints and inheritance/override, jobs CHECKs, unitOfWork rollback
  semantics, dispatcher exactly-one-effect + crash recovery, sweeper
  recovery, ESLint boundary fixtures failing as required.
- Docker: multi-stage Dockerfiles, `docker-compose.yml` (five services,
  healthchecks, persistent postgres volume) + `docker-compose.dev.yml`,
  `.env.example` with per-variable explanations.
- GitHub Actions CI (Node 22 + postgres:16/redis:7 services): lint,
  typecheck, migrate on empty DB, unit+integration+coverage, build,
  `schema:check` (incl. deliberate-diff self-test), `docs:check`,
  compose-up smoke of `/health/ready`, migration hash guard against editing
  merged migrations, `pnpm audit` failure gate.
- Docs: EXECUTION_PLAN copy + derived PRODUCT, ARCHITECTURE, DATA_MODEL
  (full schema contract), SECURITY, API_CONTRACTS, MCP_CONTRACTS, MCP client
  config, ACCEPTANCE_CRITERIA, PERFORMANCE_BUDGET, DECISIONS (D-001…D-009),
  BLOCKERS (B-001…B-004), GITHUB, REVIEWS, RUNBOOK, SCALING; AGENTS.md with
  plan §2 rules only; README quick start ≤ 5 commands.
- Scripts: `schema:check`, `docs:check`, `seed`, `smoke`, `doctor`,
  `phase-report` (emits the two-line `local:`/`remote:` report; remote CI
  status via `gh`), `backup.sh` / `restore.sh` (restore refuses a non-empty
  target; the 10k-row restore equivalence test is a Phase-7 gate),
  `publish.sh` (idempotent §16 steps 5–8), commit-message husky hook.
- Panel: Phase 0 ships a static bilingual placeholder page (fa/RTL + en) in
  `apps/web/public/`. The Angular standalone+signals project (plan §4.7) is
  delivered with its first real screens in Phase 1 — DECISIONS D-010 records
  this explicit, honest scoping; the web service is therefore not part of
  `docker compose up` yet.

### Known gaps (recorded, nothing claimed green)

- `docker compose up` not runnable inside the execution sandbox (no Docker;
  BLOCKERS B-001/B-002) — the compose path is exercised by Remote CI instead;
  local verification used native Postgres 14 + Redis.

## [0.1.0] — Phase 1 (2026-10-09)

### Added

- Migration `0002_core`: organizations, users (argon2id hash + CHECK
  locale/status), memberships, sessions (token_hash + expiry indexes), agents,
  api_keys (key_hash unique, scopes[]/project_ids[], CHECK exactly one owner),
  secrets (AES-256-GCM ciphertext + key_version + last4), projects
  (`UNIQUE(id, organization_id)` + `UNIQUE(organization_id, key)` + key CHECK
  `^[A-Z]{3,5}$` + cursor index), project_members, audit_events — DDL matches
  DATA_MODEL §B exactly and `pnpm schema:check` now verifies §A+§B (14 tables).
- Auth module: `POST /auth/login` (argon2id verify, httpOnly SameSite=Lax
  session cookie + readable CSRF cookie, per-IP+email rate limit 10/15min →
  429, 401 AUTH_INVALID_CREDENTIALS on bad password/unknown user), `POST
  /auth/logout`, `GET /auth/me`, one-time `POST /auth/setup` (409 after first
  user), `GET /auth/csrf`. `bootstrapAdminFromEnv` honours FORGEPM_ADMIN_*.
- API-key auth (`Authorization: Bearer fpm_...`) resolved alongside sessions
  into a single Actor shape (plan §1.2); raw key = `fpm_` + 40 hex, only
  SHA-256 stored, minted once, revoked/expired keys rejected at call time.
- API Keys CRUD (`GET/POST/DELETE /api-keys`) — scopes, project_ids, expiry;
  admins manage all, users their own; raw shown only at creation.
- Permissions module: pure role matrix `can()/authorize()` (org owner/admin/
  member/viewer × project lead/contributor/viewer) + `assertProjectAccess`
  returning tenancy-correct 404-vs-403 (member not in a project ⇒ 404, viewer
  creating ⇒ 403) so no cross-project existence leaks.
- Projects CRUD + archive/unarchive + soft-delete + members
  (`GET/POST/PATCH/DELETE /projects`, `/archive`, `/unarchive`, `/members`),
  every mutation in one `unitOfWork` with an `audit_event`.
- Settings: registry (`SETTING_DEFINITIONS`, schema+default+category per key +
  pattern `modules.<name>.enabled`), effective resolution project←org←system
  with source reported, PUT/DELETE per scope (system/org owner-gated, project
  settings:system/lead-gated).
- Users & memberships admin routes (create user + membership, patch, list),
  Audit read (`GET /audit` cursor-paginated, admin only).
- Fastify app: cookie + @fastify/rate-limit plugins, per-route guards, unified
  error envelope, CSRF double-submit for mutating session requests.
- Tests: 22 Phase-1 integration cases (real Postgres/Redis) + permission-matrix
  unit suite covering every role/action; login rate limit, one-time setup,
  raw-key non-persistence (DB+audit grep), expired-key rejection, viewer/member
  403/404, api-key project restriction, two-org isolation + unique(org,key),
  settings inheritance + delete-to-inherit, audit-rollback via injected
  trigger, pagination cursor + limit>200 rejection. Suite: 81 tests green;
  `pnpm verify` passes (coverage 91.6% lines).

### Known gaps (recorded, nothing claimed green)

- Panel UI not built this run (BLOCKERS B-005, deviation D-013): login/setup/
  projects/settings/api-keys/users/audit/jobs pages and Playwright E2E are
  pending; all Phase-1 behaviour is verified via REST integration tests.
- `docker compose up` compose gate for Phase 1 exercised in Remote CI only
  (B-001 unchanged).

## Not yet delivered (per plan gating)

Phases 2–7 and the `v1.0.0-rc.1` release: work items, planner + AI layer, MCP
server, GitHub module, reviews, hardening; plus the panel UI above.

