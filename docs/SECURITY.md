# Security

Full text: EXECUTION_PLAN §14 and §3b-6. Enforced everywhere, verified in Phase 7.

## Runtime authorization order (every REST + MCP operation, §3b-6)

1. credential validity / expiry / revocation (session or API key)
2. module enabled (`requireModule`)
3. organization
4. authorized project
5. scope + operation permission
6. approval policy
7. rate limit
8. idempotency

`tools/list` is client convenience, never a security control.

## Secrets & crypto

- `FORGEPM_SECRET_KEY` (32-byte base64) encrypts provider keys and module
  secrets (AES-256-GCM, `secrets`/`ai_providers`), with `key_version` for
  rotation (`scripts/rotate-secret.ts`).
- Env vars are bootstrap-only; panel/DB is the source of truth after first copy.
- API keys: SHA-256 hash stored, raw shown once, prefix `fpm_`.
- Passwords: argon2id.
- Provider keys appear only as `last4` in responses and logs.
- Log redaction is global (pino redact paths: authorization, password, token,
  key, api_key, secret) — see `packages/core/src/logging.ts`.

## Headers & input

- helmet-equivalent headers, CORS limited to `WEB_ORIGIN`, strict CSP for panel.
- Zod validation at every boundary; body ≤ 1 MiB (webhook routes 5 MiB).
- SQL is parameterised only (Kysely); ESLint forbids raw connections outside
  infrastructure.

## SSRF

Provider `base_url` and external MCP server URLs are checked; private ranges
and `169.254.0.0/16` blocked unless `network.allow_private_targets` is
explicitly set.

## Prompt injection

PR/code/comment content is always marked untrusted in prompts; model output is
never executed — it only passes schema + domain validation. The model has no
write tools; writes happen only inside the controlled pipeline.

## Data lifecycle

Soft-delete only for domain rows; destructive schema changes via
expand/contract across two releases.
