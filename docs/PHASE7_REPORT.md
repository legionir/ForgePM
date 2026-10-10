# Phase 7 report

- local: pass
- remote: pass

Generated at 2026-10-10T00:53:23.484Z. Neither status is claimed unless its
gate actually ran (local: `.verify-local` marker from a real `pnpm verify`;
remote: GitHub check-runs for the pushed commit).

## Evidence

- local `pnpm verify`: 38 files, 262 tests, exit 0 (backend suite unchanged
  from Phase 6 plus 19 new Phase-7 tests across retention / retention-job /
  metrics / rotate / backup / explain). Coverage thresholds met.
- local `pnpm gen:api:check`: committed OpenAPI + typed client are up to date.
- local Playwright flagship E2E (`bash apps/web/e2e.sh`): 5 consecutive green
  runs from clean state, each ~2.5 s against the real Fastify API + Angular
  dev-server (no mocks).
- remote CI: run **38010279004** on `main` HEAD `496814d` — success (PR #2),
  and prior PR #1 run 38005568466. https://github.com/legionir/ForgePM/actions/runs/38010279004

## §11 acceptance — what shipped vs. still open

**Shipped green (evidence above):** first-run Setup→Login (routes split so the
E2E is race-free); Projects list/create/archive; API Keys with the §11 rule
"raw key visible only at creation" asserted directly; `/metrics` behind
`METRICS_ENABLED` (§14); nightly retention job wired into worker with an audit
event per pruned slice (§14); `scripts/rotate-secret.ts` re-encrypting every
`secrets` + `ai_providers.encrypted_key` by `key_version` (§14); real backup
→ empty DB → restore round-trip with row-count + checksum over 200 rows (§14,
which also fixed a real bug where `backup.sh` exited 2 without storage);
`EXPLAIN` guard proving every hot query has an index path (P-04); OpenAPI
client generated via `pnpm gen:api` with CI drift check (§11).

**Still open (tracked in B-005 reduced):** Work Items/Board, Planner/Approvals,
MCP settings, GitHub and Reviews pages, the full Settings page matrix; the full
9-step §11 E2E chain (this PR ships the flagship setup→project→apikey→logout→
login subset); the i18n key-parity script and `fa`/RTL coverage; the axe
accessibility sweep; the 200k-item first-paint Playwright measurement
(P-05); and Playwright executed *through docker compose* (B-001 — Docker is
unavailable locally, so `e2e.sh` drives the API directly while the compose
job runs in CI). None of these are claimed green; each remains a real gate to
close in a follow-up increment before §16 (v1.0.0-rc.1).
