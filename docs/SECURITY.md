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

## Dependencies

`npm audit` runs in CI at `--omit=dev --audit-level=high`: the gate applies to the
**production dependency tree** (the shipped surface). Dev-only advisories are
reviewed, not silently ignored. Documented exceptions (plan §14: "مگر با
استثنای مستند"):

- `uuid@9` (moderate, via `bullmq`) — transitive, below the high gate; will be
  re-checked when bullmq ships a bumped dependency.
- dev tree (`vitest`, `@typescript-eslint`, `eslint`, `braces` — no upstream
  patch for `braces`): never shipped in the api/worker/web images; kept out of
  the audit gate by `--prod`. Re-evaluated at each dependency update.

## Headers & input

- helmet-equivalent headers, CORS limited to `WEB_ORIGIN`, strict CSP for panel.
- Zod validation at every boundary; body ≤ 1 MiB (webhook routes 5 MiB).
- SQL is parameterised only (Kysely); ESLint forbids raw connections outside
  infrastructure.

## SSRF

Provider `base_url`, external MCP server URLs and CI-log endpoints are checked
against loopback/private/link-local/multicast IPv4 and IPv6 ranges and reserved
IPv4 ranges, including DNS results. CI logs require HTTPS, fail closed when DNS cannot be
validated, and never follow redirects. Private targets require the explicit
`network.allow_private_targets` opt-in.

## Execution control: scope and CI baseline

- Rule 11 measures changed paths from a server-captured Git start SHA or a content-hash-only server manifest. Agent-authored `changed_files` claims do not affect scope; if neither source is measurable, the gate fails closed unless a human records an explicit scope waiver. Manifest snapshots store paths and digests, not file contents, and are bounded.
- Rule 12 never executes repository tests or scripts. It accepts only named per-test results read from an administrator-configured HTTPS CI-log endpoint for the exact server-measured commit SHA. Redirects, oversized/slow responses, private/reserved targets (unless explicitly allowed), and mismatched or incomplete logs are refused. Only a human can waive missing baseline evidence; that approval is tied to an append-only event. Report/test-output claims cannot substitute for CI provenance.
- The read-only Git adapter is the only execution-control source allowed to call `execFile`; it uses fixed non-shell Git commands. The structural test `tests/unit/exec-no-spawn.test.ts` forbids other process boundaries in execution-control modules.

## Prompt injection

PR/code/comment content is always marked untrusted in prompts; model output is
never executed — it only passes schema + domain validation. The model has no
write tools; writes happen only inside the controlled pipeline.

## Data lifecycle

Soft-delete only for domain rows; destructive schema changes via
expand/contract across two releases.
