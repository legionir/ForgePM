# Scaling

**R-11 limiter (D-016) — current in-process Map, TTL 60s, cap 10k, trustProxy explicit (`isTrustedProxy`), key = `req.ip` when `trustProxy=false` so `X-Forwarded-For` cannot bypass. Multi-instance: each process has its own Map, so a 120/min limit becomes N×120 across N replicas — documented, not hidden. Redis-backed limiter is the future path.**

Path of growth (documented, not implemented in v1 — plan §14):

- **PgBouncer** in front of Postgres (transaction pooling); app already uses a
  bounded pool and parameterised statements, so no sticky-session assumptions.
- **Read replicas** for panel list/search endpoints (single writer services
  stay on the primary).
- **Separate worker hosts**: workers are stateless; `docker compose up --scale
  worker=N` today, dedicated machines tomorrow. Review jobs run on the
  `forgepm.review` queue with per-queue concurrency.
- **Object storage** for future artifacts (attachments, review snapshots) via
  the `storage` abstraction; nothing durable leaves Postgres in v1.
- **Partitioning**: `audit_events`, `mcp_tool_calls`, `ai_calls`,
  `webhook_deliveries` partition by month on `created_at`; nightly retention
  job honours `retention.*_days`.
- "Unlimited projects" is real: no artificial caps in code/config; capacity is
  hardware-bound (§1 principle 6).
