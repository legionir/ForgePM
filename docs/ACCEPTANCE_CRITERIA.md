# Acceptance Criteria

The testable criteria live verbatim in `EXECUTION_PLAN.md`, per section:

| Phase | Tag | Section with criteria |
| --- | --- | --- |
| 0 | v0.0.0 | §4 |
| 1 | v0.1.0 | §5 |
| 2 | v0.2.0 | §6 |
| 3 | v0.3.0 | §7 |
| 4 | v0.4.0 | §8 |
| 5 | v0.5.0 | §9 |
| 6 | v0.6.0 | §10 |
| 7 | v0.7.0 | §11 + §14 + §15 |
| release | v1.0.0-rc.1 | §16 |
| global | — | §17 |

Rules of engagement (plan §2): an item is checked off only when an automated
test, a script run, or an executed command demonstrates it; every phase report
carries separate `local:` and `remote:` lines; nothing is declared green
without its gate actually having run.

Phase 0 status against §4 is recorded in `docs/PHASE0_REPORT.md` with
`local:` / `remote:` lines produced by `npm run report:phase`.
