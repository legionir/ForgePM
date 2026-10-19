# AGENTS.md — ForgePM agent rules

This file contains only the operating rules for the executing agent and
references to the docs. Product details live in `docs/EXECUTION_PLAN.md` and
the derived documents — do not duplicate them here.

## Phase work loop (every phase)

1. Branch `phase/<N>-<slug>` from `main`.
2. Write the phase's acceptance-criteria tests first (red).
3. Implement until green; API and panel pages of that phase ship together.
4. **Local Verification:** `npm run verify` (lint, typecheck, unit, integration,
   coverage thresholds, build) must finish without errors. DB-backed gates are
   *not* optional and never need Docker (D-001): boot the repo's embedded
   PostgreSQL (`node apps/web/scripts/dev-postgres.mjs`, or the
   `@embedded-postgres/linux-x64` binaries with `initdb`/`pg_ctl`), then run
   `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<db>
   npm run migrate && npm run schema:check && npm run test:integration`.
   With no Redis available, prefix `FORGEPM_TEST_NO_REDIS=1` — queue-touching
   tests then fail loudly instead of silently passing, and the report says which
   suites were skipped and why (naming Redis/`pg_dump`, never "no Docker").
5. Update `CHANGELOG.md` + phase docs, commit, squash-merge to `main`, tag
   `v0.<N>.0`.
6. If a remote exists, push and pass **Remote CI**. Every phase report has two
   separate lines: `local: pass|fail` and `remote: pass|fail|not-configured`.
   Never declare a stage green unless that stage's criteria actually ran.
7. Only advance to the next phase when all of this phase's gates are green.

## Hard rules

- **Non-sensitive technical ambiguity:** take the simplest option consistent
  with the non-negotiable principles in `docs/PRODUCT.md` §1 and record it in
  `docs/DECISIONS.md` as Context / Decision / Reason. Do not ask.
- **Sensitive or irreversible decision:** always the safest default — repo
  `private`; code/data sent to external services only via a Provider the user
  configured in the panel; deletes are soft; permission/security changes only
  per the plan; no force-push, no remote branch deletion. Log each in
  `DECISIONS.md`.
- **Secrets:** no real secret/token is ever committed; only `.env.example` with
  sample values.
- **Migrations:** forward-only; editing an already-merged migration is banned.
- **Code size:** target ≤ 400 lines/file and ≤ 60 lines/function (guide, not
  hard cap); migrations, generated files, fixtures and schema/contract files
  are exempt. Single responsibility is the real measure.
- **Dependencies:** new deps must have a compatible license
  (MIT/Apache/BSD/ISC) and be pinned.
- **Tests:** none may be skipped or removed to go green; a broken test means a
  broken product.
- **Commits:** Conventional Commits (`feat(work-items): ...`), one logical
  change each.

## Definition of Done (per task)

Code (lint+typecheck clean), Tests (≥80% module line coverage + acceptance
tests green), Docs (OpenAPI/MCP/tool doc updated), Audit (every mutation emits
an `audit_event`, tested), Security (schema validation at boundaries, no string
concatenated SQL), Reproducibility (`docker compose up` works on a clean
machine).

## Blocked

If an external dependency is unavailable, continue with a mock/fake, record it
in `docs/BLOCKERS.md`, and surface it in the final report. **Execution-control
exception:** for a real task, if the Ledger tool/module is unavailable, stop
mutations and report the reason; never fake or replace ledger state. This is a
fail-closed rule, not a claim that acceptance passed. For other work, the only
allowed stop is missing GitHub credentials for push (EXECUTION_PLAN §16).

## Reference docs

- `docs/EXECUTION_PLAN.md` — the full plan (source of truth)
- `docs/PRODUCT.md`, `ARCHITECTURE.md`, `DATA_MODEL.md` (Schema Contract),
  `SECURITY.md`, `API_CONTRACTS.md`, `MCP_CONTRACTS.md`,
  `ACCEPTANCE_CRITERIA.md`, `PERFORMANCE_BUDGET.md`, `DECISIONS.md`,
  `BLOCKERS.md`, `GITHUB.md`, `REVIEWS.md`, `RUNBOOK.md`, `SCALING.md`,
  `MCP.md`

## Execution control (exec_control)

- At the start of a task and after every interruption, call `exec_ledger_status` before making changes; start new work with `exec_task_start`. Follow the trigger map and exit sequence in `docs/LEDGER_RULES.md`.
- Record observed evidence, decisions, assumptions, questions, and later work in the ledger as they arise. A tool failure is a stop condition: report it; never substitute chat memory, a local file, direct database writes, or another unlogged path for the ledger.
- **Never invent or choose a risk level**: the policy engine computes it from the recorded decision, so a guessed level would bypass policy.
- **Never apply an approval-level change before a human approves it**: a pending or rejected decision is not authorization.
- **Never soften-close a blocker, waive/drop a criterion, expand scope, or promote a guess to fact as the agent**: these are auditable human decisions that can change delivery or acceptance.
- **Never continue mutations when ledger tools are unavailable**: an unrecorded fallback cannot be reviewed or trusted by the exit gate.
