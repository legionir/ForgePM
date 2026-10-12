# FINAL REPORT — ForgePM v1.0.0-rc.1

Plan §16 (فاز نهایی: پوش روی GitHub و تحویل). Generated 2026-10-10.

## Delivery status

- local: pass
- remote: pass

Neither line is claimed unless its gate actually ran. `local` = a real
`npm run verify` + `npm run gen:api:check` + full E2E + `npm run perf` on this machine
(`.verify-local` evidence marker). `remote` = GitHub Actions on the pushed
commit, watched to completion via `gh run watch`.

| Item | Value |
| --- | --- |
| Repository | https://github.com/legionir/ForgePM (private) |
| Released commit | `7711811943444b9a79f7ef00cfe32c1e9249e9d6` (tag `v1.0.0-rc.1`) |
| Remote CI run (release commit) | https://github.com/legionir/ForgePM/actions/runs/38022178098 — success |
| Remote CI run (docs report commit `8b4c0b1`) | https://github.com/legionir/ForgePM/actions/runs/38023131314 — success |
| Remote CI run (docs commit `692988a`) | https://github.com/legionir/ForgePM/actions/runs/38024069551 — success |
| Phase-7 completion CI run | https://github.com/legionir/ForgePM/actions/runs/38021165268 — success |
| Tags | `v0.0.0` `v0.1.0` `v0.2.0` `v0.3.0` `v0.4.0` `v0.5.0` `v0.6.0` `v0.7.0` `v1.0.0-rc.1` |

## §16 acceptance gates — as actually executed

- [x] `gitleaks detect` over full history: **no leaks** (default rules; one
  narrow regex allowlist entry for the documented CI throwaway placeholder that
  was forward-fixed out of the tip — D-037).
- [x] Local Verification: `npm run verify` green (39 test files / 269 tests;
  lint + typecheck + unit + integration + coverage + build), `gen:api:check`,
  `schema:check` (43 contract tables), `docs:check`, migration-hash guard,
  `e2e.sh` (flagship + full §11 chain + axe/RTL/overflow), `e2e-perf.sh` (P-05,
  203 ms), `npm run perf` (P-01 34 ms / P-02 62 ms / P-03 40 ms p99, all inside
  thresholds at 20 connections).
- [x] Clean-clone check: `git clone` + `npm ci` green
  locally. `docker compose up -d && npm run smoke` runs in CI (Docker is
  unavailable in this sandbox — B-001/B-002; CI uses postgres:16 + redis:7
  services and the compose job ships green on the same commits).
- [x] `CHANGELOG.md` + `1.0.0-rc.1` in all workspace `package.json` files +
  OpenAPI document; tags `v0.0.0`..`v0.7.0` present before `v1.0.0-rc.1`.
- [x] Remote repo `origin` (taken per step 5; idempotent).
- [x] `git push -u origin main --follow-tags` + `git push origin --tags` — no
  force, no tag moves.
- [ ] Branch protection: **not applied** — the token lacks the scope; publish
  step 7 tolerates this and records it here (plan §4.13/B-004).
- [x] `git ls-remote origin` shows `refs/heads/main` + all nine tags; CI on
  the pushed sha is `success` (this file links it).
- [x] `scripts/publish.sh` run twice back-to-back: second pass completed with
  `Everything up-to-date`, created nothing duplicate, exit 0.
- [x] No real secret or `.env` in the remote: `git ls-files` has no `.env`
  entry (only `.env.example`); the gitleaks pass above covers history.

## What shipped (phases 0–7)

- **Phase 0** monorepo (pnpm workspace, TS strict, ESLint module-boundary +
  raw-DB rules, husky/commitlint), Fastify skeleton with the runtime module
  registry, Kysely infra migration (outbox/jobs/idempotency/settings),
  `unitOfWork`/`scopedDb`, worker with outbox dispatcher (FOR UPDATE SKIP
  LOCKED) + sweeper, Angular bootstrap, compose (5 services), CI, all reference
  docs + the DATA_MODEL Schema Contract with `schema:check`.
- **Phase 1** auth (argon2id sessions, CSRF, login rate limit), API keys
  (SHA-256, scopes, show-once), orgs/memberships/roles, projects with readable
  keys + archive/soft-delete, three-level settings with inheritance + registry,
  audit-in-transaction, cursor pagination; tenancy isolation tests.
- **Phase 2** work items (7 types, workflow categories, atomic numbering,
  transitions), relations with cycle detection, features with dual
  `work_progress`/`release_readiness`, milestones, labels, saved views,
  comments/activity, external links, bulk + idempotency, tsvector search.
- **Phase 3** provider-agnostic AI layer (anthropic/openai/openai_compatible/
  fake, AES-256-GCM keys, `ai_calls`, daily budgets), the planner state machine
  with immutable revisions, deterministic validation, separate approve/apply,
  full rollback + idempotent re-apply, manual plans without any provider, the
  `manual`/`auto_low_risk` approval policy with the low-risk operation matrix.
- **Phase 4** Streamable-HTTP MCP server (all 8 §8 tool groups, runtime scope +
  module + project checks in the 8-step order, pending_approval flow, masked
  `mcp_tool_calls` log, rate limit, 50 KB truncation flag) + stdio bridge +
  `mcp:smoke`; MCP client (4b) recorded as deviation B-006.
- **Phase 5** GitHub module: HMAC-verified webhook → `webhook_deliveries` +
  outbox in one tx → idempotent worker processing; PR/commit/branch/release
  tracking, key extraction links, one-way issue import with conflict
  detection, reconciliation; core stays GitHub-free (boot/tests with zero
  GitHub config).
- **Phase 6** shared review engine (stages, fingerprints, confidence gates,
  evidence validation with discard accounting, ignore globs, cost ceilings) +
  Code Review + Refactor Review (chunking ≤5k files/run, incremental reruns),
  shared `review.*` registry with the redeclaration rejection, 8 MCP tools,
  webhook auto-run.
- **Phase 7** §14 observability (`/metrics`, retention job, key rotation,
  backup/restore round-trip, EXPLAIN guards), §11 panel completion: System REST
  surface (jobs/retry/health/backup/mcp-calls), every §11 page
  (Work Items List+Board, item detail, Features/Milestones, Planner, Approvals,
  Reviews, AI Providers, GitHub, MCP log, Settings inheritance matrix, System,
  Users/Audit), bilingual fa/en + RTL + `i18n-check`, axe + overflow checks,
  the full 9-step flagship E2E chain, `seed:perf` + `npm run perf` + P-05, and the
  `0009_perf` cursor indexes the load run proved necessary.

## Decisions (docs/DECISIONS.md)

37 entries D-001..D-037; highlights: D-001 native services vs Docker, D-002
PG14-compatible equivalents for PG16 syntax, D-009 per-file isolated test DBs,
D-013 backend-first phases with the honest panel deferral (now closed), D-021
GitHub delivery logic in `@forgepm/core`, D-025/D-026 shared review engine with
injected offline slots, D-031 panel as its own workspace (TS 6.x), D-034
hand-rolled i18n for the bundle budget, D-035 p99 as the p95 stand-in, D-036
perf cursor indexes, D-037 gitleaks forward-fix.

## Blockers & open deviations (docs/BLOCKERS.md)

- B-001/B-002 (environment): Docker/PG16 unavailable locally — compose and
  PG16 paths are proven in CI instead; mitigations documented.
- B-003, B-004 (resolved/superseded as recorded).
- **B-005 CLOSED** — the whole §11 panel + gates shipped (this release).
- **B-007 CLOSED** — Reviews page shipped inside the §11 chain E2E.
- B-006 (deviation, still open): optional MCP *client* (phase 4b, behind
  `mcp.client.enabled`) is not implemented; the mandatory 4a server is shipped,
  tested and smoke-verified. Schema + SSRF helper are in place.
- B-008 (deviation, still open): octokit-backed diff fetch / review comment
  writers are slots with fake implementations; the webhook→outbox→worker
  auto-run path is proven end to end without them.
- Branch protection (§16 step 7) not applied — token scope; recorded above.

## Intentionally not in v1 (plan §17)

Automated code-change execution by ForgePM itself; complex multi-agent
pipelines; permanent whole-repo analysis; full two-way GitHub sync; advanced
enterprise org reporting; microservices/multi-region deployment; a general
workflow engine; Cycle/Sprint; email; billing. The architecture keeps each of
these additive rather than a core rewrite.

## Reproduce

```bash
git clone https://github.com/legionir/ForgePM && cd ForgePM
npm install && npm run verify
bash apps/web/e2e.sh          # flagship + §11 chain + axe/RTL/overflow
bash apps/web/e2e-perf.sh     # P-05 first paint
DATABASE_URL=... npm run seed:perf && npm run perf   # P-01..P-03
docker compose up -d --wait && npm run smoke      # clean machine (§16 step 3)
```
