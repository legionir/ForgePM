# Decisions log

Format per plan §2: Context / Decision / Reason.

## D-001 — Sandbox lacks Docker; local services used instead

- Context: Phase 0 requires `docker compose up` and Testcontainers-based
  integration tests. The execution sandbox has no Docker daemon (and no
  nested virtualisation).
- Decision: run Postgres and Redis natively in the sandbox for Local
  Verification; ship the same `docker-compose.yml` (and CI service containers)
  as the reproducible path; `docker compose up` itself is verified in Remote
  CI only.
- Reason: keeps the "tests use real Postgres/Redis, no mocks for storage"
  rule true locally, and compose correctness is still gated in CI. Recorded
  in BLOCKERS.md as B-001.

## D-002 — PostgreSQL 14 available locally; contract targets 16

- Context: the apt mirror in the sandbox offers only postgresql-14.
- Decision: write DDL compatible down to PG14: `NULLS NOT DISTINCT` replaced
  by the equivalent partial/expression unique indexes, which §12 explicitly
  allows as a choice; compose/CI images pin postgres:16 as the real target.
- Reason: forward-compatible, non-destructive; the schema contract remains the
  single source of truth and `schema:check` passes on both versions.

## D-003 — `verify` composition

- Context: §2 mandates `npm run verify` = lint, typecheck, unit, integration,
  build. Coverage thresholds are part of Definition of Done.
- Decision: `verify` runs `lint → typecheck → test (unit+integration with v8
coverage thresholds) → build`.
- Reason: matches the plan exactly and fails CI on coverage regressions.

## D-004 — Shared infrastructure lives in `packages/core`

- Context: §3 places db/queue/outbox/logging/crypto under `apps/api/src/
infrastructure/`, yet `apps/worker` needs the identical dispatcher/sweeper/
  db code with no duplication, and the ESLint rule forbids modules reaching
  for raw connections.
- Decision: create `packages/core` for infrastructure; `apps/*` hold only
  app wiring and module code; the rule text ("no raw connection outside
  infrastructure") is enforced as "outside @forgepm/core + worker queue
  infra".
- Reason: single implementation of the transactional outbox pattern across
  api/worker without weakening the boundary; the alternative (duplicate code
  in both apps) violates one-responsibility and drifts.

## D-005 — UUIDv7 implemented in code

- Context: §12 requires app-generated UUIDv7 primary keys. Node 22.23's
  `crypto.randomUUID()` ignores a `version` option (returns v4) — caught by a
  failing unit test.
- Decision: implement RFC 9562 v7 generation in `packages/core/src/id.ts`.
- Reason: keeps time-ordered PKs (index locality + cursor correctness);
  dependency-free; tested.

## D-006 — getEffective matches exact scope_id (bug found by red test)

- Context: initial implementation keyed inheritance on scope only; the
  Phase 0 integration test for two projects with different overrides failed.
- Decision: resolve project→organization→system by matching the specific
  `scope_id`, nearest level wins; source is reported with the value.
- Reason: tenancy isolation is non-negotiable (§3b-2); a project override
  leaking to another org/project would have been a Phase-1 product bug baked
  into the core.

## D-007 — jsonb scalar encoding helper

- Context: `pg` passes JS strings/numbers as text for jsonb parameters
  ("invalid input syntax for type json"); caught by tests.
- Decision: one `toJsonb()` helper in core used by every jsonb write.
- Reason: single point of correctness; services keep passing plain values.

## D-008 — Sensitive-default posture decisions (plan §2)

- Context: plan mandates safest defaults without asking.
- Decision applied so far: repository `private` (already true of origin); no
  external service calls at all in Phase 0; soft-delete only (no DELETE on
  domain data from Phase 1); no force-push; branch protection requested via
  CI settings, not silently enforced.
- Reason: as required by §2.

## D-009 — Tests use a per-file isolated database instead of Testcontainers

- Context: §3 pins Testcontainers for integration; D-001 says the sandbox has
  no Docker, so Testcontainers cannot start containers here.
- Decision: integration harness creates a fresh isolated Postgres database
  (createdb/dropdb against the localhost server), plus a namespaced BullMQ
  queue per test file; CI services provide the same servers.
- Reason: real DB/Redis with per-file isolation and no Docker dependency;
  swapping to Testcontainers later is a harness-only change.

## D-010 — Panel: Phase 0 serves a static bilingual placeholder; Angular joins Phase 1

- Context: §4.7 asks for an Angular placeholder with fa/RTL + en, and §4.8
  mandates a five-service compose. A full Angular toolchain (CLI, ngx-translate,
  Playwright) in Phase 0 adds no Phase-0 acceptance gate that actually exercises
  it, and §2 forbids declaring any stage green unless its gate really ran.
- Decision: `apps/web` is a real, served web service backed by a hand-written
  static bilingual page (fa/RTL + en) under `apps/web/public/`, copied into
  nginx in the `web` Dockerfile. All five compose services come up and are
  healthchecked (compose gate met literally). The Angular standalone+signals
  project replaces the placeholder in Phase 1 together with login/setup and the
  first E2E gate.
- Reason: satisfies the five-service compose requirement honestly (the service
  exists, builds and serves) without pretending a tested panel exists; i18n/RTL
  are present at the level Phase 0 can genuinely verify.

## D-011 — CI audit gate scoped to production dependencies

- Context: the §14 rule "pnpm audit high+ breaks CI unless documented as an
  exception" collided with dev-tree advisories that have no upstream patch
  (e.g. `braces`, a transitive of the eslint-boundaries test parser) and with
  the test runner's own advisories. None of these ship in any image.
- Decision: CI runs `npm audit --omit=dev --audit-level=high` (ships-surface
  gate). Dev tooling moved to devDependencies where it is purely a build/test
  consumer (tests package). Every finding is listed with rationale in
  docs/SECURITY.md "Dependencies"; the list is re-reviewed at each dep update.
- Reason: the principle is about what is deployed; documenting each exception
  (plan §14's "استثنای مستند") satisfies the rule honestly instead of skipping
  the audit entirely.

## D-012 — v0.0.0 tag kept as-is (no force-push) after CI-fix follow-up commits

- Context: per the phase loop the squash-merge commit was tagged v0.0.0 and
  pushed. Remote CI then surfaced three real integration issues (YAML step-name
  quoting, tsx scripts needing shared+core built first, empty-string admin env
  vars) which were fixed as follow-up commits on main until CI went green at
  HEAD. Re-pointing the tag would require a force-push, which plan §2 forbids.
- Decision: keep v0.0.0 where it is (it marks the Phase 0 merge); the CI-green
  Phase 0 state is main HEAD. docs/PHASE0_REPORT.md is generated from HEAD and
  records local/remote both pass. Future phases: tag only after Remote CI is
  green for the exact commit.
- Reason: honour the no-force-push rule; never rewrite published tags; the
  phase's acceptance evidence is the green CI run linked in the report, not an
  assumption baked into the tag.

## D-013 — Phase 1 backend-first; panel deferred as a recorded deviation

- Context: plan §2 requires the Angular panel to ship alongside each phase, and
  §5 lists many panel pages. Building a full bilingual Angular panel plus the
  entire backend for all 8 phases in one continuous agent run is not feasible;
  the backend carries the strongest automated acceptance gates (services,
  permissions, tenancy, idempotency, outbox, MCP) that MUST be green.
- Decision: deliver the Phase 1 backend completely (auth, org/project,
  settings with inheritance + registry, API keys, permissions matrix, audit,
  users/members, pagination, CSRF, rate limit) with passing integration tests;
  defer the panel UI and record it in BLOCKERS.md as a `deviation`. Continue to
  later phases backend-first; the panel is added as a dedicated effort once the
  core API surface for all phases is complete and stable.
- Reason: honest reporting (never claim a green that didn't run) + maximizes
  verified functionality per the non-negotiable principles. Backend is the
  single source of truth for REST/MCP; the panel is a client of it.

## D-014 — argon2id via native `argon2` package

- Context: §3 pins argon2id for panel password hashing; a pure-JS option would
  drift from the native memory-hard parameters.
- Decision: use the `argon2@0.45.1` native binding (MIT), pinned; parameters
  m=64MiB, t=3, p=1.
- Reason: canonical argon2id, matches §3; native build works in sandbox + CI.

## D-015 — API-key raw format fpm\_ + 40 hex; prefix = first 12 chars

- Context: §5.4 requires prefix `fpm_`; §14 redaction greps `fpm_[a-z0-9]{20,}`.
- Decision: raw = `fpm_` + 40 lowercase hex (20 random bytes); store only
  SHA-256(raw); display prefix = `raw.slice(0,12)` (safe, matches grep length).
- Reason: lowercase hex guarantees the §14 grep catches any accidental leak;
  only the 12-char prefix is ever logged/returned after creation.

## D-016 — In-process login rate limiter (IP+email, 10/15min)

- Context: §5.3 mandates 10 attempts / 15 min per IP+email; a Redis-backed
  limiter couples the API hot path to Redis for auth.
- Decision: per-process Map limiter keyed `ip|email`, 15-min window, throws
  RATE_LIMITED beyond 10; @fastify/rate-limit is registered for global use.
- Reason: satisfies the acceptance test deterministically; a distributed
  limiter is a scaling concern documented in SCALING.md, not Phase 1.

## D-017 — Planner provider injection via app-level resolver + test fixtures

- Context: §7 requires generation to use the org's configured provider, be
  deterministic with the `fake` provider for tests, and never contact the
  network in the test suite.
- Decision: the planner service resolves providers through a single injected
  `ProviderResolver`. `buildApp` installs it from the org's enabled
  ai_providers row (fake/openai/openai_compatible/anthropic). Tests register
  per-planId fixture responses (Map) so `POST /plans/:id/generate` is fully
  offline and deterministic. When no provider is configured the resolver returns
  null and the plan stays `generating` — the manual revision+approve path
  remains available (plan §7 acceptance "planner works with no provider").
- Reason: keeps the domain service transport-agnostic, satisfies determinism,
  and honours the no-network test rule.

## D-018 — applyPlan rollback via transaction abort + out-of-tx status write

- Context: §7 requires that an injected mid-apply failure leaves NO partial
  data and lands the plan in `apply_failed`.
- Decision: applyPlan runs its writes in one `db.transaction()`. A failure is
  thrown so Kysely aborts the transaction (all domain writes rolled back), then
  the plan row is set to `apply_failed` in a SEPARATE transaction (so the
  failure state itself persists). No compensating deletes needed.
- Reason: uses the DB's atomicity guarantee instead of a hand-rolled rollback;
  the separate status write is what makes the failure observable.

## D-019 — Approval gate returns 202 pending_approval, not an error

- Context: §7 under `manual` an agent write must create an approval_request and
  NOT create the item; MCP contract says such ops return a pending object.
- Decision: createWorkItem for an agent under a policy that disallows the op
  inserts an approval_requests row and returns a `{pending, approval_request_id}`
  result; the REST route maps it to HTTP 202 { status: pending_approval }.
- Reason: matches the plan's "returns { status: pending_approval, ... }" shape
  and keeps HTTP semantics (accepted, not an error).

## D-020 — Phase 4b (optional MCP client) deferred; server (4a) complete

- Context: plan §8 marks 4b (MCP client for external servers) optional behind
  `mcp.client.enabled`. The mandatory Phase-4 deliverable is the internal
  Streamable-HTTP MCP Server, exercised with the real SDK client.
- Decision: ship 4a complete (Streamable HTTP `/mcp`, scope+module+rate gates,
  `mcp_tool_calls` log with masked input, idempotency, planner contract,
  real-SDK-client integration + `npm run mcp:smoke` against a live server).
  4b is implemented as a follow-up effort; the mcp_servers table + `read`-only
  allowlist shape already exist. Recorded in BLOCKERS B-006.
- Reason: honours "MCP Server internal is mandatory in v1" while deferring the
  optional client; honest reporting of what ran (all 4a gates green).

## D-021 — GitHub delivery processing lives in @forgepm/core, not api

- Context: plan §1.2 forbids two writers and §3 forbids cross-app imports.
  The webhook job runs in the worker; the manual PR/issue/release paths live in
  the api. Both must apply identical logic.
- Decision: place `applyPullRequestEvent`, `importIssueEvent`, `recordRelease`,
  normalizers and key-extraction in `packages/core/src/github/delivery.ts`.
  The api's processPullRequest/importIssue and the worker's
  github.process_delivery handler all delegate to it.
- Reason: single source of behaviour; no cross-app imports; keeps the module
  boundary ESLint rules intact while remaining actor-free for the worker.

## D-022 — One process-wide cipher holder (`setActiveCipher`/`activeCipher`)

- Context: plan §3b-1.5 keeps env as bootstrap only and DB as source of truth.
  The api installed its own cipher singleton; the worker would need to
  duplicate that (or the api's) to decrypt the same values.
- Decision: install a single Cipher at startup (`app.buildApp`, `worker.main`)
  via `setActiveCipher(createCipher(Buffer.from(FORGEPM_SECRET_KEY,'base64')))`;
  every secret access uses `activeCipher()`. `secrets.ts` helpers take the
  cipher as a parameter (testability) but the callers use `activeCipher()`.
- Reason: one authoritative key per process; env bootstrap copy-in happens in
  the read helper so a config saved from the panel is picked up automatically.

## D-023 — Webhook signature verification uses raw bytes captured by a custom

- Context: §9.1 requires constant-time HMAC over the _exact_ received body;
  fastify's default JSON parser already re-serialises, breaking byte equality.
- Decision: replace the JSON content-type parser with one that parses as string
  first, stores `req.rawBody`, then JSON-parses. The webhook handler verifies
  against `rawBody`. `verifyWebhookSignature` rejects a length mismatch BEFORE
  timingSafeEqual so a truncated prefix cannot be forged.
- Reason: matches GitHub's spec and avoids a real-world timing side-channel.

## D-024 — github.issue_sync_mode rejects export/two_way at write-time with 422

- Context: plan §9.5 says v1 only supports `off` and `import`; the other values
  are "not available" (columns exist for the future). Zod enum alone would
  return 400; §13 maps "not available in this version" to UNPROCESSABLE (422).
- Decision: the registry keeps the 4-valued enum (so the value is well-formed),
  but the settings route rejects `export|two_way` with 422 + a clear message.
- Reason: the response is a semantic "not implemented yet", not a schema
  violation; matches the acceptance text verbatim.

## D-025 — Review engine lives in @forgepm/core; api and worker share one path

- Context: §10 requires Code Review + Refactor Review to run identical
  semantics (evidence validation, fingerprint upsert, not_seen/fixed sweep,
  issue policy), reachable from REST, MCP and the webhook worker.
- Decision: `packages/core/src/review/*` holds contracts, validation, findings,
  engine, config resolver, analyzer, sources and injection slots
  (provider / diff / github-output). The api assembles RunInput + calls
  `executeReviewRun`; the worker's `review.code_run` handler calls the same
  engine via `runCodeReviewForPr`. Neither app imports the other (D-021).
- Reason: single writer + identical semantics for every entry point, enforced
  by structure, not discipline.

## D-026 — Offline review runs use injected slots (StubProvider fixtures)

- Context: plan §10 acceptance runs every review case with a `fake` provider
  and never touches the network; the suite is hermetic (D-009, §15).
- Decision: core keeps module-level slots — `setReviewProviderResolver`,
  `setDiffProvider`, `setGithubReviewApi`/`setReviewOutputWriter`,
  `setRepoFetcher` — with production code installing DB/GitHub-backed
  implementations at boot and tests installing deterministic stubs.
  `StubProvider` returns fixture findings through the same zod-validated path
  as real providers.
- Reason: same injection pattern as `FakeGithubClient`; tests exercise the
  real engine, not a parallel fake engine.

## D-027 — Helper columns `unseen_streak` + `review_runs.input` (§12 additive rule)

- Context: the not_seen → fixed lifecycle needs a consecutive-complete-run
  counter, and webhook/worker reruns need the validated hunks+snapshot without
  re-fetching code; the contract §G predates both.
- Decision: two additive helper columns (documented in DATA_MODEL §G next to
  the migration): `review_findings.unseen_streak` and
  `review_runs.input jsonb`. No contract column removed or re-meaned.
- Reason: §12 explicitly allows helper columns; storing them in the run row
  keeps a run self-describing (re-runs and debugging).

## D-028 — Refactor review accepts a file snapshot in the request body

- Context: the deterministic analyzer + evidence validation need actual file
  contents at a commit; the sandbox cannot clone repos and v1 keeps GitHub
  optional (plan §1.4). Sources are `github` (worker clone) or `local`
  (REPO_MOUNT_ROOT read-only mount) — both need a machine-independent path.
- Decision: the REST/MCP entry point takes a bounded `files[]` snapshot
  (≤20k files, ≤1 MiB each, validated by zod); the engine derives the snapshot
  lines itself. Worker-side clone sources stage into a temp dir that is always
  removed (`withStagedRepo`, tested for success AND failure).
- Reason: one tested code path everywhere; no fs/network assumption in the
  engine; mount-root traversal guarded by `assertUnderRoot`.

## D-029 — Partition cursor carried on run stats, modulo group count

- Context: §10.6.4 covers big repos in consecutive runs with a cursor in
  `run.stats.partition_cursor`; no extra table exists for it.
- Decision: the newest refactor run's `stats.partition_cursor` for
  (project, repository) is the next batch index, wrapped by `groups.length`;
  a fully analysed repo wraps to 0 so coverage repeats fresh after changes.
- Reason: stateless per-repo cursor from data that must exist anyway; 12 000
  files at cap 5 000 verify as exactly 3 runs [1,2,0].

## D-030 — github_output posts through an injected writer; off ⇒ zero calls

- Context: §10 requires one marked PR comment updated in place and "with `off`
  no write call to GitHub at all".
- Decision: the engine calls the injected `ReviewOutputWriter` slot only for
  code runs when policy ≠ `off`. Tests count writer invocations
  (2 runs summary ⇒ 2 publishes updating one comment; `off` ⇒ 0). The real
  octokit writer ships with the phase-7 GitHub panel wiring.

## D-031 — Panel is a standalone npm project (TS 6.x), outside root `verify`

- Context: Phase 7 ships the long-deferred Angular panel (B-005/D-013). Angular
  22's compiler requires TypeScript 6.x; the backend pins TS 5.7.2. A shared
  root workspace would force one TS major on both, breaking either `ng build`
  or the backend `tsc`.
- Decision: `apps/web` is its own npm project (not listed in the root `workspaces`,
  own `node_modules` + `package-lock.json`), excluded from root `eslint`/
  `npm run build --workspaces`/`npm run verify`. It has independent gates: `ng build` (bundle
  budget) and `bash apps/web/e2e.sh` (Playwright against the real API). CI runs
  both explicitly. The panel consumes the OpenAPI client produced by
  `npm run gen:api`.
- Reason: honest isolation — the backend suite stays green and reproducible on
  TS 5.7 while the panel builds on its required TS major; no version compromise
  or `any`-casting to force a shared toolchain.

## D-032 — E2E proxy to :3101 because the sandbox reserves :3001

- Context: the executing sandbox already runs a system `mcp-server` on :3001,
  the plan/compose default API port.
- Decision: the Angular dev-server proxy used by E2E points at the API on
  :3101 (`proxy.e2e.json`); the default `proxy.conf.json` and
  `docker-compose.yml` keep :3001 for real dev/compose use. `e2e.sh` starts the
  API on :3101 with a throwaway DB (`forgepm_e2e`), so setup always sees a blank
  first-run state.
- Reason: avoids a port collision in the sandbox without changing the shipped
  compose contract; recorded so a reviewer sees why two proxy files exist.

## D-033 — Flagship E2E scoped to the flows the panel renders today

- Context: §11 lists a long E2E chain (setup → project → Feature + 5 items →
  Board → plan → API key → MCP log → GitHub → Code Review). The backend surface
  for every one of those is already covered by integration tests; the panel now
  implements Setup/Login, Projects and API Keys pages.
- Decision: the shipped Playwright test covers the panel-only flagship: first-run
  setup → create project → create API key (raw shown exactly once) → logout →
  login, asserting the §11 "raw key visible only at creation" rule. Additional
  panel pages (Work Items/Board, Planner, GitHub, Reviews, Settings) are the
  remaining B-005 work tracked there, not silently claimed green here.
- Reason: never declare a gate green that did not run; ship a real, reproducible
  E2E for what the panel actually renders now.
- Reason: keeps core GitHub-free (§1.4) while making the acceptance property
  directly observable in tests.

## D-034 — Panel i18n: hand-rolled key dictionaries instead of ngx-translate

- Context: plan §3 names ngx-translate for the bilingual fa/en panel and §11
  requires "همه‌ی صفحه‌ها در fa (RTL) و en بدون متن ترجمه‌نشده" plus a
  "اسکریپت بررسی کلیدهای i18n". The initial bundle budget is 500 KB gzip and
  the panel ships 15 pages.
- Decision: a ~50-line `I18n` service with flat `en`/`fa` dictionaries
  (`apps/web/src/app/i18n/*.ts`), signal-driven lang/dir switching on
  `<html>`, and `apps/web/scripts/i18n-check.mjs` failing CI on any key-set
  drift or unknown key used in a template. No runtime i18n dependency.
- Reason: same feature contract (key parity gate + RTL toggle) at ~0 KB extra
  dependency weight; keeps P-06 bundle headroom. Non-sensitive technical
  ambiguity resolved to the simplest option per §2 hard rules.

## D-035 — npm run perf asserts p99 as the p95 stand-in

- Context: §3b-7 fixes the measurement as "p95 زمان پاسخ HTTP سرتاسری با
  autocannon". autocannon 8 exposes latency percentiles p50/p90/p99 — p95 is
  not among them.
- Decision: `scripts/perf.ts` compares the p99 against the same thresholds
  (150/200/250 ms) and the 20% fail bands. p99 ≤ threshold implies p95 ≤
  threshold, so the gate is strictly stronger than the plan's letter.
- Reason: keep the plan's tool (autocannon) and environment (20 conns, 30 s
  warm-up, 60 s measure) without inventing an off-the-cuff percentile.

## D-036 — 0009_perf: partial cursor indexes discovered by the load run

- Context: with the seeded dataset, `npm run perf` measured P-02 (filtered list
  on the 200k-item project) at p95 ≈ 6 s: the planner picked
  workitems_org_created_idx and filtered out ~310k rows from other projects.
  §12 mandates list indexes that start with project_id/organization_id and
  cover the (created_at DESC, id DESC) cursor.
- Decision: forward-only migration 0009_perf adds the partial indexes
  workitems_project_cursor_idx (project_id, created_at DESC, id DESC) WHERE
  deleted_at IS NULL and workitems_org_cursor_undel_idx (org, same order),
  synced into docs/DATA_MODEL.md (schema:check green). Purely additive —
  expand/contract rule untouched. P-02 now measures ~70 ms.
- Reason: a real bug found by actually running the gate, fixed at the schema
  layer the contract prescribes; not a tuning hack.

## D-037 — gitleaks: forward-fix the CI placeholder, narrow-allowlist history

- Context: §16 step 1 requires `gitleaks detect` clean over the full history.
  It flagged one line: `.github/workflows/ci.yml`'s committed
  `FORGEPM_SECRET_KEY: Zm9yZ2VwbS1jaS10aHJvd2F3YXkta2V5LTMyYnl0ZXM=` (base64 of
  "forgepm-ci-throwaway-key-32bytes"). That value was never a real credential —
  CI generates its key per run, and the app encrypts with keys from the
  `secrets` table, not this literal — but §16 also bans rewriting pushed
  history (no force-push).
- Decision: remove the literal from the branch tip and have CI mint a fresh
  `openssl rand -base64 32` per run (corrective commit); allowlist only the one
  exact base64 string in `.gitleaks.toml` (regex-scoped, not path-wide) so the
  history scan runs green without hiding any _other_ secret. Any new secret in
  ci.yml still trips the default rules.
- Reason: honest §16 compliance — the immutable historical line is a documented
  placeholder (auditable here), the live tree no longer contains it, and the
  allowlist is the minimal carve-out consistent with "no secret committed".

## D-038 — Package manager: pnpm → npm workspaces

- Context: the owner asked to drop pnpm and use plain npm.
- Decision: root `package.json` declares `workspaces` (shared, core, api, worker,
  tests — explicit order so `build`/`typecheck` run dependencies first);
  `workspace:*` became `*`; `pnpm-lock.yaml`/`pnpm-workspace.yaml`/`.npmrc` were
  removed in favour of `package-lock.json`. `apps/web` stays a separate npm
  project (own `package-lock.json`) per D-031. CI/Docker use `npm ci`;
  the audit gate is `npm audit --omit=dev --audit-level=high`.
- Reason: single, ubiquitous toolchain with no corepack step; dependency
  versions stay exact-pinned in each `package.json`.

## D-039 — Execution ledger: append-only is "no delete + settle-once" for the journal

- Context: PE-0.3/I-2 asked for `BEFORE UPDATE OR DELETE` + `REVOKE` on
  `exec_events`, `exec_evidence` and `exec_action_journal`. A journal row is
  _born_ `started` and must become `done|failed|unknown` (that is the whole resume
  design, appendix §K), so a blanket UPDATE ban would break the feature.
- Decision: full append-only (trigger + `REVOKE UPDATE, DELETE`) on
  `exec_events`, `exec_evidence`, `exec_gate_checks`; `exec_action_journal` gets
  `exec_journal_settle_only()`, which forbids DELETE outright and allows exactly
  one UPDATE that changes only `status/finished_at/result_ref/note` from
  `started`. `REVOKE DELETE` only, for that table.
- Reason: the invariant that matters is "an agent can never erase or rewrite the
  record of what it did"; a settled row keeping its outcome columns mutable is
  still that record, and everything it claims to have done is frozen.

## D-040 — Ledger code counters live in `exec_code_seq`, not on `projects`

- Context: plan §5 (PE-0 item 2) says "no counter table; use
  `SELECT max(seq) FOR UPDATE` + retry", while §4 table 16 and PE-0 item 1 define
  `exec_code_seq(project_id, prefix, seq)` with the same trigger/REVOKE work.
- Decision: `exec_code_seq` is the counter (as DATA_MODEL §H ships it).
  `allocateLedgerCode()` inserts the zero row `ON CONFLICT DO NOTHING`, then
  `UPDATE … FROM (SELECT … FOR UPDATE)` and retries on 40001/40P01. No column is
  added to `projects`.
- Reason: a per-prefix counter column on `projects` would serialise every ledger
  write behind one hot row and would need a new `work_items`-style migration for
  each prefix; the dedicated table is the only shape that keeps codes contiguous
  under 20 concurrent allocations (tested).

## D-041 — No test-execution runner: the baseline comes only from the CI log

- Context: `docs/EXECUTION_CONTROL_PLAN.md` (D-08) originally specified a
  three-source baseline: CI log → an ephemeral Docker runner (`exec.runner.*`,
  `scripts/runner/run-test.sh`, `docker-compose.runner.yml`, a
  `FORGEPM_TEST_DOCKER=1` test) → fail closed. The gate rule 12 needs
  "the tests were run and passed" as a _fact_, not as the agent's claim.
- Decision: the middle source is cancelled by the owner ("وارد docker نشو —
  docker چرا لازم است؟") and stays cancelled. ForgePM never executes repo
  code — not on the host, not in a container. `exec_baseline_tests.source` is
  `('ci','human')`; `exec.baseline_source` is `'auto'|'ci'|'off'`; the five
  `exec.runner*` settings keys are removed from the registry, and no
  runner/compose file exists. With no readable CI log for the task's
  `commit_sha`, rule 12 fails closed (`BASELINE_UNAVAILABLE`) and only an
  explicit human waiver passes, surfaced prominently in the final report.
- Reason: the runner existed only to make "untrusted code was executed
  safely" verifiable; deleting the execution channel satisfies the same
  OWASP CI/CD risks (CICD-SEC-4/5) with no new attack surface, no extra
  deployment dependency, and no image supply-chain to pin. Fail-closed
  behaviour is preserved, so nothing bypassable now rests on the agent's word.
  It also removed the only "environment-bound" acceptance item in the plan:
  no criterion is `not-run` because of Docker anymore.

## D-042 — DB-bound gates are verified locally with the repo's own embedded Postgres

- Context: PE-0's gates (`migrate`, `schema:check`, `test:integration`) and
  every later exec phase need a real PostgreSQL, and the earlier honest report
  said `not-run` "no Postgres/Redis/Docker" (B-009, plan OI-8/OI-9) — which
  conflated Docker with the database and made a fixable gap look structural.
- Decision: follow D-001 — obtain the database natively, not via containers.
  `apps/web/scripts/dev-postgres.mjs` (`embedded-postgres`, already a
  devDependency) boots a real PostgreSQL; with `DATABASE_URL` pointed at it,
  `npm run migrate` (empty DB + idempotent rerun), `npm run schema:check`
  (60 contract tables) and the exec integration suite all run. Suites that
  need a queue still cannot run, so `tests/integration/harness.ts` gained
  `FORGEPM_TEST_NO_REDIS=1`: `h.queue`/`h.redis` become `undefined` and any
  queue-touching test fails loudly rather than silently passing.
- Reason: "we have no Docker" is not a reason to skip a deterministic gate —
  the DB gates were the whole point of PE-0 and they were green in one command
  once the sandbox stopped depending on container tooling. The Redis suites
  stay `not-run` (with the exact reason named) because that dependency is real;
  the flag makes the split visible in the output instead of hidden in prose.

## D-043 — Committed tooling resolves paths relative to the file, never the author's box

- Context: `apps/web/scripts/e2e-reset.mjs` (added while Docker-free E2E resets were
  needed, per D-001) used `createRequire('/home/user/ForgePM/apps/api/package.json')`
  to reach `pg`. It passed on the machine that wrote it and failed in CI — and CI had
  been unable to start for a day, so the bug travelled through `main` unnoticed and
  now blocks every phase's remote gate (B-010).
- Decision: anchor such resolution to the module itself
  (`new URL('../../api/package.json', import.meta.url)`). Rule applied repo-wide: no
  absolute filesystem path of a developer/agent machine may appear in a tracked file;
  a repo-wide grep for `/home/` in `apps/`, `scripts/`, `packages/`, `.github/` is now
  part of the check before any script change lands.
- Reason: the sandbox is an implementation detail of one run. A path that only exists
  here turns a green local report into a red remote gate, and — as PE-0 showed — the
  red gate may not be read for hours. Determinism of the _verification harness_ is
  part of the product, so it gets the same "no environment assumptions" treatment as
  the runtime code.

## D-044 — Status tokens are tuned for the tint they generate, not just for the page

- Context: the §11 panel E2E (`chain.spec.ts`) runs axe over the major pages and
  failed on `main` with one serious violation: `.ui-badge--info` painted
  `color-mix(in srgb, var(--color-info) 12%, transparent)` as its background and the
  same `--color-info` (`#0969da`) as its text — 4.37:1, below the WCAG AA 4.5:1 the
  project claims. `npm run check:contrast` did not catch it because it only compared
  each token against `color-bg`/`color-surface`, where the hue passes at 4.83:1.
- Decision: darken the three light-theme status hues until every
  _self-tinted_ pair passes — `--color-ok: #166d2f`, `--color-warning: #845900`,
  `--color-info: #085abb` (`--color-error` already cleared it) — and extend
  `check:contrast` to derive those pairs from `styles.scss` itself: for every rule
  whose `background` is a `color-mix(in srgb, var(--color-X) N%, transparent)` and
  whose `color` is the same token, the token must hit ≥ 4.5:1 over the composite, on
  both `color-bg` and `color-surface`, in both themes.
- Reason: the golden rule of this repo is that anything which must not regress is
  deterministic code, not review. A palette cannot be validated against flat
  backgrounds only — half of the panel's status surfaces are the tokens mixed with
  their own background. Reading the rules out of the stylesheet means a future
  `12% → 20%` change fails the gate instead of shipping a11y debt, and pixel
  baselines (`VISUAL=1`, opt-in) stay a human concern.

## D-045 — Board drag in headless Chromium: diagnosed, deliberately not patched blind

- Context: after D-044 the §11 chain E2E had one failure left — `card.dragTo(column)`
  completed without error but the item's `state_name` never changed (60s poll). The
  board uses HTML5 DnD (`draggable` + `dragstart`/`dragover`/`drop`, key carried in
  `dataTransfer`), and a fallback that also remembered the key at `dragstart` was
  implemented and shipped in the same push — CI then still failed identically, which
  proves the `drop` handler never runs at all: headless Chromium does not enter a
  drag session for `dragTo` on this markup, so neither channel carries a key.
- Decision: the fallback was reverted (it fixed nothing and would have stayed as
  unverifiable code). The remaining work is a design choice about the interaction, not
  a bug fix, and it belongs to the panel owner: either (a) drive the board from
  pointer events (mouse/touch) with HTML5 DnD as an enhancement, which makes real
  dragging and headless dragging behave the same and is the a11y-honest option, or
  (b) keep HTML5 DnD and have the spec synthesise `DragEvent`s with a real
  `DataTransfer` via `page.evaluate` — which tests the wiring but no longer tests a
  browser drag. Raised as legionir/ForgePM#11 (with B-011) instead of choosing
  quietly.
- Reason: PE-0's contract is that nothing bypassable rests on judgement, and the same
  discipline applies to fixes: code that is not known to fix anything must not ride
  along inside another phase's PR. The contrast half was kept because CI proved the
  axe violation gone; this half has no such proof, and both candidate fixes change
  what the E2E means — a scope decision, which is the owner's.
- **Correction (same day, D-046).** The premise recorded above — "headless Chromium
  does not enter a drag session for `dragTo`" — was wrong, and the local real-browser
  run that D-046 enabled disproved it: `dragstart`/`dragover`/`drop` all fire, on the
  @sparticuz binary as well as on CI's chromium. What actually happened is that the
  drop landed on the right column but for the **wrong card** (see D-046/B-011). The
  revert itself was still correct: the fallback did not fix the failure, and keeping
  it would have left a "fix" with a false justification in the tree.

## D-046 — Board drag: pointer session + HTML5 enhancement; the E2E race was a scroll race

- Context: with a local real-browser E2E finally runnable (see the recipe added to
  FRONTEND*EXECUTION_PLAN), `chain.spec.ts:22` was instrumented instead of guessed.
  Result: `dragTo` DID start an HTML5 drag, the payload DID carry a key, and the drop
  DID fire on the intended column — but on `EPRJ-3`, while the spec polled `EPRJ-5`.
  Cause: `dragTo` releases at the target's centre; with five cards the target column is
  555px tall, its centre is below the fold, so Playwright scrolled the \_page* by
  ~196px (= two card rows) after the mouse was already down on the source. The app
  faithfully dragged whatever was under the pointer — the bug was the spec assuming
  `.first()` still denoted the same card after its own scroll, and the 60s poll then
  reported it as an app failure. Measured geometry is what settled it: card y 400→204
  between the two `boundingBox()` reads around one `dragTo`.
- Decision, in three parts, all shipped together because each is useless alone:
  1. **Spec** (`apps/web/e2e/chain.spec.ts`): pin `targetPosition: {x:20,y:60}` on the
     drop and assert the card under the pointer still contains the read key. Coverage
     strictly increases (a TOCTOU became visible), nothing was weakened, and the
     assertion "the item's `state_name` changes" is untouched.
  2. **App** (`apps/web/src/app/ui/board-drag.ts` + the pure reducer in `logic.ts`):
     the board no longer depends on the browser opening an HTML5 drag session. A
     pointer session (press → 4px threshold → release over a _foreign_ column) carries
     the same gesture; `dragstart` hands it over to the browser and the pointer path
     stands down, and one gesture may be applied once (a per-press token in
     `UiBoardDrag`), so the two paths cannot double-transition. Touch is deliberately
     left to the native path, and `dataTransfer` keeps working for real users.
  3. **CI** (`.github/workflows/ci.yml`): `npx ng test --configuration=coverage` now
     runs inside the panel step, so the panel's unit tests and the ≥80% coverage
     thresholds are gated remotely and not only in a sandbox — otherwise the 14 new
     deterministic drag tests (and every panel test before them) would be decorative.
- Reason: the failure had survived three pushes because each hypothesis was tested
  against CI alone, where the signal is one annotation per run. A local run gives the
  event log, the geometry and the request — that is the difference between guessing and
  measuring, and D-041's "CI is the arbiter" is about _acceptance_, not about diagnosis.
- Consequences: the drag works identically on binaries with and without HTML5 DnD
  support (Playwright's `dragTo` does not drive HTML5 DnD on Firefox/WebKit at all),
  the board gained visible drag affordances (`--drag`, `--over`), and a layout change
  (viewport-bounded columns with internal scroll) was NOT taken — it would be better
  ergonomically but invalidates all 14 stored visual baselines, which is a frontend
  owner call, not a bug-fix smuggled into PE-0.

## D-047 — PE‑1 closes at service+DB level; the tool‑facing criteria are proven in PE‑2

- Context: PE‑1's acceptance list (§6, A.1…A.9) is written as if the ledger tools
  already existed — A.1 asserts what `exec_ledger_status` returns, A.3 what
  `ledger_resolve_item` rejects, A.9 what the panel renders — while §7 puts all of
  those tools in PE‑2 and the panel pages in PE‑12. The alternative reading ("build
  the tools early so PE‑1 can be ticked") would ship the tool surface before the
  policy/scope plumbing it has to respect, then re-test it twice.
- Decision: PE‑1 ships and closes the layers it can close on its own — the pure
  state machine, the single supported write path (`exec/open-items-service.ts`), the
  DB laws (already in 0010: `done ⇒ closed_at`, closure note ≥ 20 chars + named
  closer, human-only soft closure, append-only + REVOKE) and the projection
  (`exec/ledger-view.ts`) that the status tool will return — with A.2/A.4/A.5/A.6/A.7/A.8
  ticked by tests, and A.3 ticked for the rule itself (service + CHECK) while the
  tool-shaped assertion is re-run in PE‑2 B.x. A.1 stays `[~]` with the reason (the
  loader and the tool are PE‑2 work; the projection they will use is here and tested,
  including a row→view case built from real DB rows) and A.9 moves to PE‑12, where
  the labels exist. Every one of these is written next to the criterion in
  docs/EXECUTION_CONTROL_PLAN.md, so nothing is quietly dropped by a tick.
- Reason: a phase gate is only worth what its weakest tick is worth; a tick that
  needs code from a later phase is a fiction. Splitting the _layer_ instead — laws
  now, wrappers later, each proven where it lives — keeps the sequence honest and
  leaves PE‑2 with thin tools rather than a second implementation.
- Consequence: no new migration was added for PE‑1. The one ledger rule that was
  still TypeScript-only — the dedup key for promoting exit-report lines — belongs to
  C.4, whose semantics are "skip/point at the existing item", not "reject the write",
  so a unique index would have turned an idempotent promotion into a failure. The
  service does the dedup pre-check and raises `CONFLICT` with the existing code, and
  the promotion path in PE‑9 can reuse the same key.

## D-048 — test and dev tooling may not depend on machine binaries (extends D-043)

- Context: running PE‑1's DB gates needed the embedded Postgres path (D-042) and hit
  two walls that were both about the machine, not the project: `tests/integration/harness.ts`
  created and dropped its per-file database by shelling out to `psql` (absent here —
  `@embedded-postgres` ships only server binaries), and `apps/web/scripts/dev-postgres.mjs`
  called `initialise()` unconditionally, so a second run against a perfectly good
  existing cluster died with `initdb: directory exists but is not empty`.
- Decision: the harness talks to the maintenance database over the `pg` client
  (`CREATE DATABASE` / `DROP DATABASE … WITH (FORCE)`, PG14+ — which also replaces
  the sleep-and-hope around draining pool sockets), and `dev-postgres.mjs`
  initialises only when `PG_VERSION` is absent, takes `FORGEPM_PGDATA/PGPORT/PGDBS`
  and tolerates an existing database. No `child_process` in either.
- Reason: the same argument as D-043, one layer down: a gate that only runs on the
  machine that wrote it is not a gate — and an _intermittently_ runnable one is worse,
  because it trains everyone to write `not-run` for a reason that isn't true. The
  19 → 21 integration tests in this phase only exist because the DB became reachable.
- Consequence: the integration suite needs only a reachable Postgres now; the
  Redis/`pg_dump`-bound files still fail here by design (`FORGEPM_TEST_NO_REDIS=1`
  makes queue-touching tests fail loudly rather than pass silently). The same line was
  found in `apps/web/e2e.sh` (it began with two `psql` calls, so the scripted panel E2E
  had never completed in this sandbox — only the hand-run recipe in
  docs/FRONTEND_EXECUTION_PLAN.md had); DB creation moved to `scripts/e2e-db.mjs`
  (`pg`, `DROP … WITH (FORCE)` with a retry), and `bash apps/web/e2e.sh` is now green here:
  chain + flagship 3/3 with `visual.spec`'s 14 opt-in skips (`VISUAL=1`) untouched.

## D-049 — PE‑2: what the ledger tools may and may not claim

- Context: the five mandatory tools had to be added on top of PE‑1's service without
  creating a second place where the rules live, and without letting a tool promise
  something the schema cannot keep.
- Decision (five separable calls, all recorded because each one is a rule an agent
  could otherwise game):
  1. **`tools/list` advertises the enforced shape.** `apps/api/src/modules/mcp/json-schema.ts`
     maps the real zod types (min/length, enum, uuid, int bounds, array bounds) and sets
     `additionalProperties: false` exactly when the schema is a `strictObject`; a plain
     `z.object` is _not_ claimed to be strict. The previous mapper emitted
     `{type:'string'}` per key plus `additionalProperties: true` for every tool, which
     invited clients to send keys the handler then refused.
  2. **`exec_task_start`'s `req_ids` declares; it does not cover.** There is no
     requirement↔task table in 0010, and inventing one was out of scope; coverage stays
     what gate rule 8 reads — a criterion _linked_ to the requirement and verified. The
     declared ids are validated (an unknown one is `NOT_FOUND`) and recorded in the
     `task.created` event, so the claim is auditable without ever counting as coverage.
  3. **An agent's `exec_task_start` inherits the work-item approval gate** (it creates a
     work item, so `work_item.create` policy applies) — and the _checkability_ law runs
     **before** the gate opens, so a payload that could never execute does not spend a
     human's approval queue. `pending_approval` writes no ledger row and no event.
  4. **`work_items.source` keeps its closed CHECK list**: the ledger's work items are
     created with `source='manual'`. 'exec_ledger' would need a migration and buys no
     acceptance criterion; provenance lives in `exec_events` + `audit_events`.
  5. **Project resolution is a rule, not a guess.** `project_ref` (id or PRJ‑key) wins;
     otherwise a key bound to exactly one project uses it; otherwise `VALIDATION_ERROR`
     naming both options. For task-scoped tools the project is found _from the task ref_,
     and a code that matches in two projects is refused rather than disambiguated.
- Reason: every one of these is the difference between "the tool returned an object" and
  "the ledger cannot be quietly inflated". B.1's strictness, rule 8's coverage, and the
  approval gate are exactly where a thin wrapper tends to grow its own opinion.
- Consequence: `exec/open-items-service.ts` remains the only writer of `exec_open_items`,
  and `createTask` (core) the only writer of `exec_tasks`+`exec_criteria`; the api layer
  adds scope/gate/audit/idempotency and nothing else. `scripts/ledger-cli.ts` (D‑11) is
  still PE‑later work: it must reuse these services rather than the tools' HTTP shapes.
