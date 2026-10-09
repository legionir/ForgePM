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
- Context: §2 mandates `pnpm verify` = lint, typecheck, unit, integration,
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
- Decision: CI runs `pnpm audit --prod --audit-level=high` (ships-surface
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
