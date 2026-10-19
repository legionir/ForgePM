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
