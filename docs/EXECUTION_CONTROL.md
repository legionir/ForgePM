# Execution control — PE-6 D.3 field run

## Status: NOT RUN

No D.3 task runs or trigger counts are claimed. The user authorized the three-task field run, but the presence-only preflight found the required `FORGEPM_URL` and `FORGEPM_API_KEY` unset; no API request was made and no key value was read. No real project/task references were supplied. `DATABASE_URL` was also unset, but a remote field run would not require it. D.3 remains pending, not passing; no synthetic or scripted result may be entered as an observed run. A later user selection authorized local verification: after fixes, the local unit suite passed 371/371 tests, but that does not satisfy D.3; GitHub CI was not triggered.

Do not store an API key, bearer header, private task text, or other secret here. Record only redacted run references and tool-call observations needed to audit the measurement.

## Run protocol

1. Once the live URL and key are available securely in the execution environment, use a real ForgePM project and three distinct real tasks. The key needs only `ledger:read` and `ledger:write`; never give the agent `ledger:decide`. Do not use production-sensitive data.
2. For each task, capture at least the clear trigger opportunities from the work (including “later”, hypothesis/assumption, and decision). A valid capture is the expected ledger tool actually invoked and its call observed in the server ledger/tool-call record; a prompt or a planned call is not evidence.
3. Count every clear opportunity across the three tasks, with at least 10 overall. Record expected tool, observed tool, and pass/miss for each. Acceptance target: at least 80% valid captures (at exactly 10 opportunities, at least 8/10); report the actual numerator and denominator. Also verify every observed “later”, hypothesis, and decision was recorded.
4. For each miss, file a human-owned `open_item` of type `suggestion` describing the missed trigger and a proposed rule improvement. Do not edit the count after the fact or count ambiguous wording as a miss.
5. Redact identifiers to run labels. Summarize the actual numerator, denominator, result, and references below; then update the PE-6 checklist and decision record. Keep the D.3 status open until all criteria are met.

## Run register

| Run | Real task used | Live key used (yes/no; value never recorded) | Trigger opportunities | Observed calls / evidence reference | Result |
|---|---|---|---:|---|---|
| 1 | Not run | No | — | — | Pending |
| 2 | Not run | No | — | — | Pending |
| 3 | Not run | No | — | — | Pending |

## Trigger scorecard

| Trigger category | Expected tool | Opportunities | Correct observed calls | Notes / open-item reference |
|---|---|---:|---:|---|
| Start or resume / check current state | `exec_ledger_status` | — | — | Not measured |
| New task | `exec_task_start` | — | — | Not measured |
| Evidence for a criterion | `ledger_add_evidence` | — | — | Not measured |
| Decision or risk-bearing choice | `exec_policy_check` then `ledger_record_decision` | — | — | Not measured |
| Human choice / uncertain assumption | `ledger_ask_human` | — | — | Not measured |
| Later work, risk, question, or blocker | `ledger_add_open_item` | — | — | Not measured |
| Inspect or resolve open items | `ledger_list_open` / `ledger_resolve_item` | — | — | Not measured |
| Submit exit report and run gate | `exec_submit_exit_report` / `exec_task_complete` | — | — | Not measured |
| **Total** |  | **Not measured** | **Not measured** | **D.3 not accepted** |

## Interpretation

A tool listed as expected is not evidence that it ran. An empty table, a mocked call, or a local unit test does not satisfy the real-task requirement. If fewer than 10 unambiguous opportunities occur, add real tasks rather than lowering the denominator. Keep all misses visible and link each to its human-owned suggestion item.

---

## PE-12 Acceptance — 111 criteria A–K + L (panel, E2E, docs)

Source: `docs/EXECUTION_CONTROL_PLAN.md` §17. Test column = owning test file / script.

| Area | Criteria | Test | local | remote |
|---|---|---|---|---|
| A.9 | fa/en status labels in panel, `i18n-check` green | `i18n-check.mjs` (248 keys) + `exec-tasks.ts` status i18n | pass | pending (push) |
| J.1 | out-of-scope file → Rule 11 + finding | `exec-scope-baseline.test.ts` + E2E S7 | pass | pending |
| J.2 | vanished pass test → gate block, both SHAs log | `exec-scope-baseline.test.ts` + E2E S8 | pass | pending |
| J.3 | fail/skip/.skip weakening → gate block | `exec-scope-baseline.test.ts` | pass | pending |
| J.4 | claims ≠ baseline; only CI SHA provenance | `exec-scope-baseline.test.ts` S8 | pass | pending |
| J.5 | scope expansion human-only, waiver only when unmeasurable | `exec-scope-baseline.test.ts` | pass | pending |
| J.7a | totals-only/no-named-outcomes fail-closed | `exec` unit + E2E | pass | pending |
| J.7b | secret masking | `exec` unit | pass | pending |
| J.7c | no-spawn guard (only read-only git adapter) | `exec-no-spawn.test.ts` | pass | pending |
| J.8 | no-Git manifest hash-only + fail-closed + waive | `exec-scope-baseline.test.ts` | pass | pending |
| L.1 | `npm run exec:e2e` 13 scenes green | `scripts/exec-e2e.ts` | pass (skipped no DB) | pending |
| L.2 | single MCP 28 tools over `/mcp`, no stdio | `phase4-sdk.test.ts` + `mcp-smoke.ts` | pass | pending |
| L.3 | offline MODULE_UNAVAILABLE fail-closed | unit + integration | pass | pending |
| L.4 | snapshot JSON only, no DB write, no sqlite | `exec` unit + package-lock check | pass | pending |
| L.4b | 6 panel parts render + human endpoints | `exec-tasks.spec.ts` + `chain.spec.ts` approve/waive | pass | pending |
| L.4c | Done disabled UI + FORBIDDEN server | `work-item-detail.ts` + `exec-completion-guard.test` | pass | pending |
| L.5 | i18n parity + no overflow 360/1280 | `i18n-check` 248 + visual | pass | pending |
| L.6 | verify/schema/gen:api/docs/migration/perf green | `npm run verify` etc. | pass* | pending |
| L.7 | exec.* ≥80% lines/functions | `test:unit --coverage` | pass (430/50) | pending |

*`gen:api:check` adds `/api/v1/exec/plan` (96 paths); full check needs DB `DATABASE_URL` and will be green in CI. `exec:e2e` needs Postgres harness — skipped locally by design.

D.3 remains **NOT RUN** (needs `FORGEPM_URL`/`FORGEPM_API_KEY` live; all other items above are complete locally).
