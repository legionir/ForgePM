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
Status: **backend complete, local pass; remote pending push** — shared review
engine + Code Review + Refactor Review in core; REST + 8 MCP tools + worker
webhook auto-run; settings registry incl. 422 redeclaration rule; migration
`0008_reviews` matches Schema Contract §G (43 tables verified). 54 new tests;
suite 227 green; `pnpm verify` green; CI-equivalent gates (fresh-DB migrate,
schema:check + selftest, docs:check, migration-hash guard, phase-report
selftest) all re-run green. Panel Reviews page + octokit diff/comment writers
deferred with the panel (B-007/B-008, same family as B-005).

## Phase 7 — v0.7.0
Status: not started.

Last commit: (this commit).
Remaining gates before tagging:
- Push phase/6 + squash-merge + tag v0.6.0 after Remote CI is green on the
  merged commit.
- Panel UI (login/setup, projects, settings, users, API keys, audit, jobs,
  Reviews) — recorded as deviation D-013 / B-005 (backend-first run).
- Playwright E2E for setup→project→override→API key — pending panel.
Next step: Phase 7 (panel completion, security/performance hardening) then
the final release phase (§16).
