# Changelog

All notable changes to ForgePM, per plan phase. Format loosely follows
Conventional Commits groupings. Tags map to plan §17.

## [0.7.0] — Phase 7 (2026-10-10, panel-completion increment)

### Added

- **System panel REST surface.** `GET /api/v1/jobs`, `POST /api/v1/jobs/:id/retry`
  (DB-only re-queue; the worker sweeper re-enqueues per §3b-3), `GET
  /api/v1/system/health` (db/redis/module flags), `POST /api/v1/system/backup`
  (admin, runs `scripts/backup.sh` + audits) and `GET /api/v1/mcp/calls` (§8.11
  masked tool-call log) — the endpoints `docs/API_CONTRACTS.md` promised and the
  backend-first phases left for the panel.
- **All remaining §11 panel pages** as thin clients over the tested REST surface
  (lazy routes, standalone + signals, OnPush): Work Items List+Board (HTML5 drag
  → server transitions), item detail (comments/activity/transition), Features +
  Milestones (dual `work_progress`/`release_readiness`), Planner (create →
  generate with the `fake` provider → approve → apply, separate actions),
  Approvals queue, Reviews (runs/findings/dismiss/accept/create-issue;
  guidance-only while modules are off), AI Providers, GitHub config + repo
  linking, MCP call log, full Settings inheritance matrix (override / back-to-
  inherited / source badges), System health + jobs + module toggles + backup,
  Users + Audit.
- **Panel i18n + RTL.** Bilingual `en`/`fa` dictionaries with a signal-driven
  `lang`/`dir` switch and `apps/web/scripts/i18n-check.mjs` (CI key-parity gate,
  120 keys). Hand-rolled rather than ngx-translate for the bundle budget (D-034).
- **Accessibility + layout.** axe sweep (no serious/critical violations), fa/RTL
  assertion and 360/1280 px no-horizontal-overflow checks in the flagship chain
  spec; light/dark, logical-property responsive stylesheet.
- **Performance tooling.** `pnpm seed:perf` (PERFORMANCE_BUDGET dataset: 10k
  projects, a 200k-item project + 300k background items, ANALYZE, seeded login
  + API key), `pnpm perf` (P-01..P-03 via autocannon, 20 conns / 30s warm-up /
  60s measure / p95 thresholds; p99 stand-in per D-035) and the P-05 first-paint
  Playwright gate (`apps/web/e2e-perf.sh`).
- **Migration `0009_perf`** (forward-only, contract-synced): partial
  `(project_id|organization_id, created_at DESC, id DESC) WHERE deleted_at IS
  NULL` cursor indexes the §12 contract requires. The load run found P-02
  scanning ~310k rows (p95 ~6s); these bring it to ~70ms (D-036).

### Fixed

- Dev-server proxy contexts narrowed `/api` → `/api/v1` (+ `/mcp`) so the
  `/api-keys` SPA route is no longer swallowed by the Angular dev-server proxy.
- `fake` `ai_providers` rows now generate a deterministic plan offline (was an
  inert empty response), powering the §11 "plan with the fake provider" step.
- `e2e.sh` runs each spec against a per-file DB reset so every flow starts on a
  brand-new install (the §11 chain begins at first-run setup).

### Tests / gates

- 7 red-first integration tests for the System surface (jobs pagination +
  `jobs:read` matrix + cross-org 404, retry re-queue + 409, health flags,
  audited backup, MCP call log). Full backend suite 39 files / 269 tests green;
  `pnpm verify`, `gen:api:check`, `schema:check`, `docs:check`, migration-hash
  guard and `pnpm perf` green; flagship E2E + §11 chain + P-05 green locally.


## [0.7.0-rc] — Phase 7 flagship subset (2026-10-09)

### Added

- **Angular panel (apps/web) — flagship path shipped.** Standalone + Signals,
  lazy routes, OnPush, i18n-free bilingual shell with a data-testid contract.
  Pages: `/auth` (first-run Setup + Login), `/projects` (list + create +
  archive), `/api-keys` (list + create with raw-key-shown-exactly-once +
  revoke). Session/CSRF handled by `ApiClient` (reads `fpm_csrf` cookie and
  echoes it as `x-csrf-token` on every mutating request).
- **OpenAPI-generated client (`pnpm gen:api`).** `scripts/gen-api.ts` boots the
  Fastify app in-process, dumps `apps/api/openapi.json` (74 paths) and pipes it
  through `openapi-typescript` (pinned `7.13.0`) to
  `apps/web/src/api/schema.d.ts`. `pnpm gen:api:check` fails on any drift;
  wired into CI.
- **Reproducible E2E (`pnpm test:e2e`).** `apps/web/e2e.sh` resets a throwaway
  DB, builds the backend, starts Fastify on :3101, runs the Angular dev-server
  on :4200 via a proxy (`proxy.e2e.json`), and drives Chromium through the
  flagship flow (Setup → project → API key with raw-once assertion → logout →
  login) — passing locally. CI runs `playwright install --with-deps chromium`
  and executes the same script.
- **`GET /metrics` (plan §14 observability)** behind `METRICS_ENABLED`, using a
  dependency-free Prometheus registry in `packages/core/src/metrics.ts`.
  Exposes `http_requests_total{method,route,status}` (bounded cardinality),
  `http_request_duration_seconds` histogram, `forgepm_queue_length` +
  `forgepm_jobs_failed` gauges (derived live from `jobs`),
  `forgepm_ai_calls_total{purpose,status}` and
  `forgepm_mcp_tool_calls_total{tool,outcome}` counters incremented at their
  respective `ai_calls`/`mcp_tool_calls` insert points.
- **Nightly retention job (plan §14 scalability).** `runRetention` in core
  prunes `audit_events`, `mcp_tool_calls`, `ai_calls` and
  `webhook_deliveries` per each org's effective `retention.*_days` (system and
  org scopes honoured, tenancy-safe). `apps/worker/src/retention-job.ts` wires
  it into the worker bootstrap with a `system.retention` `audit_event` per
  pruned (org, table).
- **Key rotation (`scripts/rotate-secret.ts`, plan §14 / RUNBOOK).**
  `rotateDbSecrets(db, oldKey, newKey, newVersion)` re-encrypts every
  `secrets.ciphertext` and `ai_providers.encrypted_key` blob, tagging rows with
  the new `key_version`. Idempotent (already-current blobs are skipped).
- **EXPLAIN hot-query guard (PERFORMANCE_BUDGET P-04).**
  `tests/integration/phase7-explain.test.ts` runs 11 hot query shapes through
  `EXPLAIN` with `enable_seqscan = off` and asserts no `Seq Scan on <guarded>`
  appears — proving every named index exists and is usable by the planner.
  Guard verified non-vacuous (dropping an index makes the test fail).

### Fixed

- `scripts/backup.sh` exited 2 whenever no storage tarballs existed (the `ls`
  glob failed under `set -e -o pipefail`). Rewritten with a `prune()` helper
  that treats an empty glob as success. New
  `tests/integration/phase7-backup.test.ts` does a real
  backup → fresh empty DB → restore round-trip with row counts + checksum over
  200 seeded rows and also asserts `restore.sh` refuses a non-empty target.

### Notes

- `apps/web` is intentionally a **standalone pnpm workspace** (D-031): Angular
  22 pins TS 6.x, the backend pins 5.7.2. It is excluded from root
  `eslint`/`pnpm -r build`/`pnpm verify` and gated by its own build + E2E.
- Remaining §11 acceptance items (Board/Planner/MCP/GitHub/Reviews/Settings
  pages, i18n key parity, axe a11y sweep, 200k-item first-paint, full 9-step
  E2E chain, compose-backed E2E) remain **OPEN** in `BLOCKERS.md` (B-005,
  reduced). The backend surface for each is already covered by integration
  tests; the missing work is the thin panel client + gate.

## [0.6.0] — Phase 6 (2026-10-09)

### Added

- Migration `0008_reviews` implementing Schema Contract §G verbatim:
  `review_runs` (kind `code|refactor`, target/status CHECKs, composite FK to
  projects, `runs_project_created_idx`), `review_findings`
  (`UNIQUE(project_id, scope_key, fingerprint)`, severity + status CHECKs,
  full finding structure incl. impact/effort/risk) and
  `code_structure_index` (`UNIQUE(repository_id, commit_sha)`). Two additive
  helper columns documented in §G: `review_findings.unseen_streak` and
  `review_runs.input` (D-027).
- Shared review engine in **core** (`packages/core/src/review/*`, D-025):
  contracts (fingerprint = sha256(project|category|file|normalized title|
  hash(normalized evidence)) — line-independent; scope keys `pr:<repo>:<n>` /
  `repo:<repo>`; glob matcher), evidence validation against the run's commit
  snapshot (+ diff-hunk containment for code findings; ≤20-line evidence;
  `min_confidence` floor; invalid → `run.stats.discarded`), finding upsert
  (rerun touches `last_seen_run_id` instead of duplicating; DB UNIQUE enforced),
  `not_seen` → `fixed` lifecycle that only counts COMPLETE runs (streak ≥ 2),
  the shared issue policy (record_only / human_approval via approval_requests /
  auto_high_severity with kind floors 0.8/0.85, cap 10/run, idempotent per
  finding_id; created items typed bug|refactor, source code_review|refactor_review,
  `agent-ready` label + acceptance criteria), effective config resolver
  (project ← organization ← system ← registry default) and the GitHub output
  slot (`off` ⇒ zero write calls; one `<!-- forgepm:review -->` comment
  updated in place; D-030).
- Deterministic Repository Analyzer (no AI, plan §10.6.2): file/language/LOC
  counts, TS/JS function metrics (length, cyclomatic complexity, params),
  rolling-hash duplicate blocks (≥6 lines / 50-token rule), import graph with
  cycle + fan-in/out detection, compact `code_structure_index` JSON per commit;
  partitioned staged analysis (§10.6.4, cursor on run stats, D-029) and
  incremental scope = changed files + direct neighbours (§10.6.5).
- Review code sources (§10.6.1): `local` read-only mount under
  `REPO_MOUNT_ROOT` guarded against traversal, `github` fetch through an
  injected fetcher staged into a temp worker dir that is ALWAYS removed —
  success or failure (`withStagedRepo`).
- `code_review` + `refactor_review` modules registered always, default OFF
  (`modules.<name>.enabled`), enabled/disabled at runtime without restart.
- Settings registry: `review.max_attempts`, `review.max_cost_tokens`,
  `review.github_output`, `review.ignore_globs`, `code_review.{max_diff_bytes
  (200 KB default), skip_drafts, custom_rules}`,
  `refactor_review.{min_severity, max_files_per_run (5000), categories}`.
  Redeclaring a shared `review.*` key under a module prefix is rejected with
  **422** (§10; `isReviewKeyRedeclaration`).
- REST (`apps/api/src/modules/reviews/*`), every endpoint module-gated 503:
  `GET /api/v1/review/runs` + `/runs/:id` + `/runs/:id/cancel`,
  `POST /review/code-runs`, `POST /review/refactor-runs`,
  `GET /review/findings` (cursor-paginated, severity/status/kind filters),
  `POST /review/findings/:id/decision`,
  `POST /review/findings/:id/create-work-item` (202 pending_approval under
  human_approval). New matrix actions `review:run` / `review:decide`.
- MCP: the eight §13 tools `review_start_code_review`, `review_get_report`,
  `review_list_findings`, `review_update_finding`,
  `review_create_work_item_from_finding`, `refactor_review_start`,
  `refactor_review_get_report`, `refactor_review_list_findings` — scope
  `review`, gated on either review module (hidden from `tools/list` AND
  rejected at call time when both are off; `McpToolDefinition.module` now
  accepts an any-of array).
- Worker: PR deliveries with action `opened|synchronize|ready_for_review`
  enqueue `review.code_run` outbox jobs only when the project has
  `code_review` enabled + `review.auto_run`; the handler runs the SAME core
  engine as REST (runtime re-check of gates), system actor, one job per
  connected project. `StubProvider` + provider/diff/output slots keep the
  whole suite offline (D-026).

### Tests

- 22 core unit cases: fingerprint/normalization/globs, evidence validation
  (bad file/range/mismatch/out-of-hunk/long evidence), partition counts,
  issue-policy eligibility floors, analyzer (long fn / duplication / cycle /
  languages), partitioning (12 000 → 3×5 000 deterministic), import resolver.
- 5 sources unit cases: temp-clone removal on success AND failure, mount-root
  traversal guard, fetcher slot, incremental scope.
- 17 phase-6 integration cases: both modules off ⇒ 503 + no MCP tools + no
  auto jobs; enable without restart; fake-provider run completes with the full
  required finding shape; discarded counter; rerun dedupe + `last_seen_run_id`
  + line-shift ≠ duplicate; DB UNIQUE enforced; not_seen(1) → fixed(2) with a
  truncated run NOT counting; truncation + ignore globs never reach the
  provider; record_only / human_approval (queue once, approve, create exactly
  one, idempotent replay) / auto_high_severity (floors + cap 10); 422 on
  redeclaration; github_output summary (one comment, updated) and off (zero
  calls); MCP tools/list + tools/call through an agent key; cancel; audit on
  every mutation.
- 5 phase-6 worker cases: module off ⇒ no enqueue; auto_run off ⇒ no enqueue;
  module+auto on ⇒ exactly one outbox job; handler runs the shared engine
  offline; gate re-check at run time skips without a run row.
- Refactor cases: analyzer-without-AI (long fn ≥110 lines/complexity, dup pair,
  import cycle stored), finding shape incl. impact/effort/risk, partitioned
  12 000-file coverage [1,2,0], incremental rerun sends only changed file +
  neighbours, 503 when the module is off.
- Suite: **227 tests** (54 new: 22 core-review unit + 5 sources unit + 17
  phase-6 + 5 phase-6-worker + 5 refactor); `pnpm verify` green;
  `schema:check` 43 tables; migration hash manifest updated for `0008_reviews`.

### Known gaps (recorded)

- Panel Reviews page + Playwright E2E and the octokit-backed diff/comment
  writers ship with the phase-7 panel (B-007, B-008).

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

## [0.2.0] — Phase 2 (2026-10-09)

### Added

- Migration `0003_domain`: workflow_states, milestones, features, work_items
  (composite FKs, assignee one-of CHECK, acceptance_criteria jsonb,
  search_vector generated + GIN), work_item_relations, labels,
  work_item_labels, comments, saved_views, work_item_external_links,
  feature_dependencies. DATA_MODEL §C updated with the composite
  `UNIQUE(id, organization_id)` targets required by §3b-2.
- Work items: CRUD + transition + relations + comments + external links +
  activity (from audit) + full-text search + bulk create (idempotency).
  Default workflow auto-seeded per project (Backlog/Todo/In Progress/In Review/
  Done/Canceled). Item key `PRJ-N` with atomic `UPDATE ... RETURNING` numbering
  — 50 parallel creates yield contiguous unique numbers.
- Blockers: transition to `completed` refused with 409 BLOCKED_BY_OPEN_ITEMS;
  blocking-cycle detection (2- and 3-node) returns 409 DEPENDENCY_CYCLE.
- Features: dual `work_progress` (completed/(total−canceled)) and
  `release_readiness` (ticked AC); `released` requires 100% readiness unless an
  owner overrides (override recorded in audit).
- Milestones with computed progress; Saved Views (personal/shared); Labels
  on-the-fly; Comments (user/agent author types).
- Core helpers: `idempotency` (begin/store/abandon, `UNIQUE(actor,op,key)`),
  pure `graph.ts` (findCycle, workProgress, releaseReadiness) with unit tests,
  `schemas-domain.ts` zod contracts, work-items module `index.ts` public
  surface (cross-module calls go through it, ESLint boundary intact).
- Tests: 13 Phase-2 integration cases (numbering concurrency, blockers,
  cycles, dual progress + override, bulk idempotency + body-mismatch 422,
  assignee CHECK, soft-delete/list/search/audit, activity, combined filters,
  milestones, saved views, comments) + graph unit suite. Suite: 100 tests
  green; `pnpm verify` passes.

### Known gaps (recorded)

- Panel Board/List UI + Playwright E2E deferred with the rest of the panel
  (B-005 / D-013).
- 200k-item p95 <200ms perf budget is a Remote-CI nightly measurement, not a
  per-PR gate (PERFORMANCE_BUDGET.md).

## [0.3.0] — Phase 3 (2026-10-09)

### Added

- Migration `0005_planner`: ai_providers (kind CHECK + AES-256-GCM
  `encrypted_key` + `key_last4`), ai_calls, plans (status CHECK for the
  10-state lifecycle), plan_revisions (immutable, `UNIQUE(plan_id,revision_no)`),
  replan_suggestions, approval_requests (org/project composite FK).
- AiProvider interface + FakeProvider (deterministic, offline fixture list),
  OpenAiCompatibleProvider, AnthropicProvider; keys decrypted only in the
  resolver, never exposed. AES-256-GCM cipher with key_version for rotation.
- Planner state machine + pure validators (`validatePlan`, `findCycle`,
  `similarity`, `revisionHash`) with unit tests; the plan §7 lifecycle
  table encoded in `TRANSITIONS`.
- createPlan enqueues `planner.generate` via the outbox (services never touch
  BullMQ directly); generatePlan validates output, retries 2× on invalid,
  records `ai_calls`, transitions to `ready` / `needs_clarification` /
  `generation_failed`; a manual revision path exists so the planner works with
  **no** provider configured.
- approvePlan enforces `validation.ok`, `plan:approve`, and self-approval
  (`FORBIDDEN_SELF_APPROVAL`). applyPlan runs in ONE transaction with
  injectable-failure rollback proving zero-partial-data semantics and
  out-of-tx `apply_failed`; apply is a distinct `plan:apply` scope + never
  implied by approve.
- Daily token budget (`ai.daily_token_budget`, default 0 = unlimited) checked
  before each provider call → `AI_BUDGET_EXCEEDED`.
- Manual / auto_low_risk approval matrix (plan §7): agent writes routed through
  `classify()`; low-risk under `auto_low_risk` runs immediately, otherwise a
  `pending_approval` approval_request is created and the endpoint returns
  HTTP 202 `{ status: 'pending_approval', approval_request_id }`. Agents can
  never decide their own approvals; only human admins can.

### Known gaps (recorded)

- Panel Planner / Approvals / AI Providers pages deferred (B-005 / D-013).
- Replan-monitor daily job + `replan_suggestions` UI: schema in place; the
  scheduled job ships in Phase 7 alongside other maintenance jobs.

## [0.5.0] — Phase 5 (2026-10-09)

### Added

- Migration `0007_github`: repositories (composite `UNIQUE(id, organization_id)`
  target + `UNIQUE(provider, external_id)`), project_repositories (composite FKs
  to both projects and repositories), pull_requests (+`draft`/`body`/`merged_at`),
  commits, branches, webhook_deliveries (`organization_id`, `UNIQUE(delivery_id)`,
  `received|processing|done|failed`), external_issue_links (`remote_version`,
  `last_synced_at`, `local_modified_at` for conflict detection), releases.
- Core `secrets.ts`: put/get/find/delete encrypted application secrets using
  the process cipher (§3b-1.5). Env is bootstrap-only — first read copies into
  `secrets` so DB becomes the source of truth.
- `activeCipher()` process-wide cipher holder (installed once per app/worker
  bootstrap) — replaces the per-module `setCipher` and lets both apps share.
- `recordAudit` widened to `DbLike` so worker/one-shot audit writes are legal.
- `github/delivery.ts` (in **core**, so api + worker share one code path):
  `applyPullRequestEvent` (repo + PR upsert, key extraction from branch/title/
  body, auto-transition-on-merge via injected callback reading the project
  setting); `importIssueEvent` (off|import one-way with `sync_conflict` audit
  when local edit > last sync); `recordRelease`; `normalize{PullRequest,Issue}
  Payload`. `extractItemKeys`/`extractClosingKeys` (2-5 uppercase letters
  project-key regex) live here and are re-exported from the api.
- Webhook receiver `POST /integrations/github/webhook`: module-gated (503 when
  disabled), constant-time HMAC-SHA256 verification of `X-Hub-Signature-256`
  (401 on mismatch), stores `webhook_deliveries` + an `outbox` row in ONE
  transaction, replies 202. Duplicate `delivery_id` is a no-op still 202.
  Raw-body capture via the shared JSON content-type parser (installed once).
- `github.process_delivery` worker handler dispatches on the delivery event
  (pull_request / issues / release), is idempotent via the delivery status
  guard (at-least-once → exactly-one-effect), writes a `system` audit with
  counts. Registered in the same outbox→dispatcher→BullMQ path as `system.ping`.
- REST endpoints (all module-gated): `GET /repositories`,
  `POST /projects/:id/repositories` (connect),
  `POST /projects/:id/pull-requests` (manual PR link),
  `POST /projects/:id/issues/import` (returns 200/201 with `created|updated|
  conflict|skipped`), `POST /projects/:id/releases`,
  `GET /work-items/:key/development` (Development tab), `POST/GET
  /integrations/github/{config,status}` (secrets:manage, encrypted at rest).
- `github.issue_sync_mode` registry allows `off|import|export|two_way` per
  plan §12 (columns present) but v1 rejects `export|two_way` with **422** on
  write — the panel-facing "unavailable in this version" contract (plan §9.5).
- MCP: `buildGithubTools(db)` registers the five §13 github tools, each with
  `module: 'github'` so the dispatcher hides them from `tools/list` and rejects
  direct calls with MODULE_DISABLED when the module is off.
- `GithubClient` interface + `FakeGithubClient` (scripted in tests; the octokit
  HTTP path is left to the runtime `pnpm`-installed `@octokit/*` deps pinned in
  `apps/api/package.json`; tests never hit the network per plan §15).

### Tests

- 9 Phase-5 integration cases: boot with zero github config + core unaffected;
  503 MODULE_DISABLED; bad-signature 401 with no delivery row; valid signature
  + resend idempotency; PR key extraction from branch + title (2 links);
  merged+`fixes KEY` moves only that item to completed; secrets not in plaintext
  dump or audit; two repositories visible per project; issue-import mode off /
  import (create + no-dup update + local-edit-after-sync conflict path with
  `github.sync_conflict` audit); release persistence; `export|two_way` → 422.
- 5 worker-driven integration cases: PR delivery links items via keys;
  at-least-once re-run is a no-op; issues delivery imports (mode=import);
  release delivery records a row; the full **outbox → dispatcher → BullMQ →
  handler** path is exercised by a real Worker.
- New unit tests: `verifyWebhookSignature` (valid/Buffer/wrong secret/body
  mismatch/malformed headers/truncated sig), core `delivery.ts` helpers
  (`extractItemKeys` / `extractClosingKeys` / normalizers), the real HTTP
  providers (`OpenAiCompatibleProvider`, `AnthropicProvider`) against a
  loopback mock server (2xx/5xx/invalid-JSON), `maskInput`, `capOutput`,
  `ToolRegistry.visible` (scope + module filter), `estimateTokens`,
  `ProviderError`, `requestHash`, planner state helpers.
- Suite: **173 tests**, `pnpm verify` green (91.4% lines / 80% functions).

### Known gaps (recorded)

- Panel Integrations ← GitHub page (configure/install/sync mode/Development
  tab) and the daily reconciliation job ship in Phase 7 (schema is in place;
  `sync_origin`/`last_synced_at` columns already exist). Recorded in B-005.
- Issue `export`/`two_way` modes are refused with 422 per plan §9.5 (deliberate).

## [0.4.0] — Phase 4a (2026-10-09)

### Added

- Migration `0006_mcp`: `mcp_tool_calls` (call log) + `mcp_servers` (external
  client registry, 4b). Core `ToolRegistry` + `maskInput` + `capOutput` (50 KiB
  truncation per §8.9).
- `/mcp` Streamable-HTTP JSON-RPC handler: initialize / tools-list /
  tools-call / resources-list / prompts-list. Every call runs the §3b-6 order
  at call time (auth → scope → module-enabled → idempotency → service);
  `tools/list` filters by key scopes + enabled modules but is not the security
  control. `mcp_tool_calls` records masked inputs.
- 34 tools registered from projects/work-items/planner/approvals (final §8.4
  planner set with NO `planner_generate_work_items`; separate `plan_approve` /
  `plan_apply` scopes). Handlers only call module services.
- Real MCP SDK client round-trip contract test (Client + InMemoryTransport)
  proving our wire format matches spec-compliant clients; `pnpm mcp:smoke`
  executed green against a live server via `StreamableHTTPClientTransport`.
- Tests: 9 + 2 Phase-4 integration cases covering the full §8 acceptance
  matrix: unauth 401, scope filtering + direct FORBIDDEN_SCOPE, `project_ids`
  key restriction (NOT_FOUND not 403), bulk idempotency via
  `structuredContent`, 120/min rate limit, mask-in-call-log (no raw
  token/key), revoked key rejected at call time (not list), planner contract
  (approve/apply separate scopes, no `planner_generate_work_items`).

### Known gaps (recorded)

- 4b optional MCP client (stdio/HTTP to external servers) deferred behind
  `mcp.client.enabled` (BLOCKERS B-006, D-020). `mcp_servers` table +
  `network.allow_private_targets` are in place for the follow-up.
- Panel MCP settings + `mcp_tool_calls` log viewer deferred with the panel
  (B-005).

## Not yet delivered (per plan gating)

Phases 6–7 and the `v1.0.0-rc.1` release: Code/Refactor reviews, panel
completion (login/setup, projects, work items, planner, approvals, integrations,
MCP, settings, users, audit, jobs, backups, health) with Playwright E2E,
security/perf hardening.

