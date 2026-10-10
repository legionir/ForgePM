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
Status: **shipped on main, not tagged** (see docs/PHASE7_REPORT.md). Two PRs
merged: #1 (retention/metrics/rotation/backup/gen:api + the panel itself) and
#2 (setup/login route split to fix the flagship E2E race). `main` HEAD
`496814d` — CI run **38010279004** green (remote: pass); local `pnpm verify`
262 tests + `pnpm gen:api:check` + `pnpm test:e2e` 5/5 green (local: pass).

What is DONE here: §14 observability/retention/key-rotation/backup/EXPLAIN,
§11 OpenAPI-codegen with drift check + first-run setup + Projects + API Keys
(panel + E2E), and the plan-claimed `gen:api` script that Phase 1 deferred.
What is STILL OPEN (B-005 reduced): the remaining §11 pages (Board/Planner/
MCP/GitHub/Reviews/Settings), the 9-step E2E chain, i18n parity, axe, first-
paint perf (P-05) and Playwright-through-compose. Per AGENTS.md "only advance
to the next phase when all of this phase's gates are green", tag `v0.7.0`
is deferred until those gates are actually run green in a follow-up increment.

Last commit: `496814d` (main, merged).
Next step: Phase 7 follow-up increment closes the remaining §11 pages + i18n +
axe + P-05, then tag `v0.7.0`; finally §16 (v1.0.0-rc.1 push + FINAL_REPORT).
