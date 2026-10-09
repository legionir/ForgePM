# Progress log

Per plan §2 rule 5. After every phase we record status, last commit, remaining
gates and the next step so a resumed run knows exactly where to pick up.

## Phase 0 — v0.0.0
Status: **complete** (local pass, remote pass). See `PHASE0_REPORT.md`.

## Phase 1 — v0.1.0
Status: **complete** (local pass, remote pass — CI run 37874572807). Panel UI deferred (B-005).

## Phase 2 — v0.2.0
Status: **complete** (local pass, remote pass — CI run 37877395571; tag v0.2.0 = HEAD 890b743). Panel + Playwright E2E deferred (B-005).

## Phase 3 — v0.3.0
Status: **complete** (local pass, remote pass — CI run 37879871008; tag v0.3.0 = HEAD 40933f3). Panel deferred (B-005).

## Phase 4 — v0.4.0 (server side)
Status: **complete** — 4a shipped: Streamable-HTTP `/mcp`, real-SDK-client
integration test, `pnpm mcp:smoke` green against a running server.
4b (optional MCP client) deferred with B-006. Panel MCP settings deferred
with the rest of the panel (B-005).

## Phase 5 — v0.5.0
Status: **in progress** — backend complete (webhook+HMAC, PR/issue/release
processing shared by api+worker via core, module lifecycle, 5 MCP tools,
secrets at rest); 14 phase-5 tests + unit tests green; full verify green
(173 tests). Reconciliation daily job + panel page deferred to Phase 7 (B-005).

## Phase 6 — v0.6.0
Status: **complete** (local pass, remote pass — CI run 37907130578; tag v0.6.0 = HEAD 5bf5225) — shared review
engine + Code Review + Refactor Review in core; REST + 8 MCP tools + worker
webhook auto-run; settings registry incl. 422 redeclaration rule; migration
`0008_reviews` matches Schema Contract §G (43 tables verified). 54 new tests;
suite 227 green; `pnpm verify` green; CI-equivalent gates (fresh-DB migrate,
schema:check + selftest, docs:check, migration-hash guard, phase-report
selftest) all re-run green. Panel Reviews page + octokit diff/comment writers
deferred with the panel (B-007/B-008, same family as B-005).

## Phase 7 — v0.7.0
Status: **in progress — flagship panel path + §14 ops shipped; §11 not fully
green** — Angular (standalone + Signals) panel at `apps/web` with Setup/Login,
Projects and API Keys pages; OpenAPI client generated via `pnpm gen:api`
(`apps/api/openapi.json` + `apps/web/src/api/schema.d.ts`, drift check wired
into CI); reproducible Playwright flagship E2E (`bash apps/web/e2e.sh` —
setup → project → API key raw-once → logout → login) passing locally against
the real Fastify API + Angular dev-server; `/metrics` behind `METRICS_ENABLED`
(dependency-free Prometheus registry); nightly `runRetention` wired into the
worker with a `system.retention` audit event per (org, table);
`scripts/rotate-secret.ts` re-encrypts every `secrets` and
`ai_providers.encrypted_key` blob by `key_version`; `EXPLAIN` guard asserts
every hot query has a usable index path (11 shapes; verified non-vacuous);
`scripts/backup.sh` no longer exits 2 when no storage tarballs exist and a
real backup → fresh DB → restore round-trip test with row counts + checksum
guards §14 acceptance. Backend `pnpm verify` is green (262 tests). See
CHANGELOG `[0.7.0]` for details and DECISIONS D-031/D-032/D-033.

Still OPEN (B-005 reduced): Work Items/Board, Planner/Approvals, MCP settings,
GitHub, Reviews and Settings pages; the full 9-step §11 E2E chain; the i18n
key-parity script; the axe a11y sweep; the 200k-item first-paint performance
gate; and Playwright executed via compose (B-001: Docker unavailable locally
so the script drives the API directly; CI adds the compose variant). Tagging
`v0.7.0` is deferred until either (a) every §11 acceptance box is genuinely
green or (b) the remaining items are formally recorded as scoped-out of v0.7.0
in the plan itself.

Last commit: (this commit).
Next step: commit the Phase 7 increment on `phase/7-panel-hardening`, run
`pnpm verify` + `pnpm gen:api:check` + `pnpm test:e2e` locally, squash-merge
into `main` (or open a PR if the branch is protected), push and pass
**Remote CI**, then either close out the remaining panel pages under a v0.7.x
increment or record the scope cut as a decision and open §16 (final release).
