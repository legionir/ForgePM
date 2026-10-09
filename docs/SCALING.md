# Scaling

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
