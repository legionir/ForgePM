# Performance Budget

Per EXECUTION_PLAN §3b-7. `pnpm perf` (Phase 7) measures these nightly.

- **Reference environment:** 4 vCPU, 8 GB RAM, SSD, all services on one box via
  docker compose; PostgreSQL 16 with `shared_buffers=2GB`; Redis on; no
  application cache.
- **Seed dataset** (`pnpm seed:perf`, behind a flag): 10,000 projects; one
  200,000-item project + 9,999 others totalling 300,000 items.
- **Method:** end-to-end p95 HTTP latency with autocannon, 20 concurrent
  connections, 30 s warm-up + 60 s measurement; exceeding a threshold by 20 %
  fails the nightly run.

## Metrics

| ID | Endpoint / query | Method | Threshold (p95) | Fail beyond |
| --- | --- | --- | --- | --- |
| P-01 | `GET /projects?limit=50` on seeded dataset | autocannon, 20 conns | < 150 ms | 180 ms |
| P-02 | filtered work-item list on the 200k project | autocannon, 20 conns | < 200 ms | 240 ms |
| P-03 | `GET /search?q=` full-text | autocannon, 20 conns | < 250 ms | 300 ms |
| P-04 | list `EXPLAIN` — no seq scan on work_items/projects | `EXPLAIN` assertion in CI | index used | any seq scan |
| P-05 | first paint of the item list page (200k project) | Playwright | < 2 s | 2.4 s |
| P-06 | panel initial bundle | CI size check | ≤ 500 KB gzip | above cap |

Hot-path queries must be index-backed; an `EXPLAIN` CI test covers the 10
hottest queries (§14). The 5,000-file Refactor Review cap is per-run, not a
repository-size cap (phased analysis, Phase 6).
