# POU-18: Fix IP spoofing and rate limiting

| توضیح تسک | معیار پذیرش | وضعیت |
|---|---|---|
| Create trusted proxy list in app.ts (readXForwardedFor) and make trustProxy use explicit list | Only proxied IPs from trusted list are respected; direct requests use real connection IP | کامل |
| Update auth/service.ts login() to use properly validated IP + account-bounded rate limit | 11th attempt returns 429; direct API + proxy scenarios both work; cross-instance store supported | کامل |
| Add integration tests for IP spoofing and rate limiting scenarios | Tests pass covering direct API, proxied request, and 11th-attempt 429 | کامل |
| Mark POU-18 as done in Linear | Linear issue status updated to Completed | کامل |

---

# POU-36: GitHub App production config validation

| توضیح تسک | معیار پذیرش | وضعیت |
|---|---|---|
| Update validateConfig to check all three secrets (app_id, private_key, webhook_secret) | All three required; missing any throws VALIDATION_ERROR with clear message | کامل |
| Add unit tests for validateConfig covering missing secrets | 3 failure cases + 1 success case all green | ناقص (vitest runner unavailable on host) |
| Mark POU-36 as done in Linear | Linear issue status updated to Completed | کامل |
