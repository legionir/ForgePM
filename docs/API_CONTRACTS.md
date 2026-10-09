# REST API Contracts

Source of truth: EXECUTION_PLAN §13. Implemented phase by phase.

- Prefix `/api/v1`, JSON `snake_case`, ISO 8601 UTC timestamps.
- Ids in URLs: UUID or human key (`FPM-12`) for work items / features.
- Lists: `?limit` (default 50, max 200) + `?cursor`;
  response `{ items, next_cursor }`.
- Writes: optional `Idempotency-Key` header; concurrent edits use `If-Match`
  (ETag from `updated_at`) → `412` on mismatch.
- Errors: `{ error: { code, message, details?, request_id } }` with the fixed
  codes in `packages/shared/src/error-codes.ts`.
- OpenAPI served at `/api/v1/openapi.json`; UI at `/api/docs` when
  `API_DOCS_ENABLED=true`.

## Endpoint groups (added in the phase named)

| Group | Endpoints | Phase |
| --- | --- | --- |
| Health | `GET /health/live`, `GET /health/ready` | 0 |
| Modules | `GET /api/v1/modules`, `PUT /api/v1/modules/:name/enabled` | 0 |
| Auth | `POST /auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/setup` | 1 |
| Users & Org | `GET/POST /users`, `PATCH /users/:id`, `GET/PATCH /organization`, `GET/POST /memberships` | 1 |
| API Keys | `GET/POST /api-keys`, `DELETE /api-keys/:id` | 1 |
| Projects | `GET/POST /projects`, `GET/PATCH /projects/:id`, `POST /projects/:id/archive`, `GET/PUT /projects/:id/members` | 1 |
| Settings | `GET /settings/effective?scope=&scope_id=`, `PUT/DELETE /settings/:scope/:scope_id/:key` | 1 |
| Work Items | `GET/POST /projects/:id/work-items`, `GET/PATCH/DELETE /work-items/:key`, `POST /work-items/:key/transition`, `POST /work-items/bulk`, comments, relations | 2 |
| Features / Milestones | CRUD + `GET /features/:key/progress` | 2 |
| Views / Search | `GET/POST /saved-views`, `GET /search` | 2 |
| Planner | `POST /projects/:id/plans`, `GET /plans/:id`, revisions/approve/apply/apply-status/diff | 3 |
| Approvals | `GET /approvals`, `POST /approvals/:id/decide` | 3 |
| AI Providers | `GET/POST /ai-providers`, `PATCH/DELETE /:id`, `POST /:id/test` | 3 |
| GitHub | webhook, status, repositories, project link, development tab | 5 |
| Reviews | code/refactor runs, findings, work-item creation | 6 |
| System | `GET /audit`, `GET /jobs`, `POST /jobs/:id/retry`, `GET /system/health`, `POST /system/backup` | 1/7 |

## Error codes

`VALIDATION_ERROR` 400, `AUTH_REQUIRED`/`AUTH_INVALID_CREDENTIALS` 401,
`FORBIDDEN`/`FORBIDDEN_SCOPE`/`FORBIDDEN_SELF_APPROVAL` 403, `NOT_FOUND` 404,
`CONFLICT`/`IN_PROGRESS`/`DEPENDENCY_CYCLE`/`BLOCKED_BY_OPEN_ITEMS` 409,
`PRECONDITION_FAILED` 412, `UNPROCESSABLE`/`PLAN_INVALID`/
`PLAN_GENERATION_INVALID`/`SSRF_BLOCKED`/`TOOL_NOT_ALLOWED` 422,
`RATE_LIMITED`/`AI_BUDGET_EXCEEDED` 429, `PROVIDER_ERROR` 502,
`MODULE_DISABLED` 503, `INTERNAL` 500.
