# رفتارهای مشاهده‌شده — سنجش recall لجر (R-13)

> هر رفتار مشاهده‌شده باید در لجر به‌عنوان criterion یا open item ثبت شود.
> `recall = covered_behaviors / observed_behaviors` باید ≥ ۳۰٪ باشد، وگرنه گیت می‌بندد.

## مشاهده‌ها (2026-10-19)

| # | رفتار مشاهده‌شده | ثبت در لجر؟ | ارجاع |
|---|---|---|---|
| 1 | ایجنت می‌گوید «تمام شد» بدون بستن لجر (chat-only done) | ✅ | T-001 → OI-01 (Stop hook R-01) |
| 2 | waive criterion بدون ledger:decide | ✅ | C-001 waive → 403 (R-02) |
| 3 | REQ بدون criterion (REQ-1000) | ✅ | ledger_status.requirements_uncovered (R-03) |
| 4 | CI log از host غیرمجاز (evil.com) | ✅ | ci-log-source allowlist (R-04) |
| 5 | .git/config مخرب با core.fsmonitor=echo | ✅ | review-source hardening + test (R-05) |
| 6 | journal started→unknown→done بن‌بست | ✅ | 0011 trigger + integration test (R-06) |
| 7 | out_of_scope file outside allowed_paths | ✅ | BLOCKING_BY_DEFAULT out_of_scope (R-07) |
| 8 | پنل GitHub با stub بدون بنر | ✅ | gh-stub-banner + 422 (R-08) |
| 9 | snapshot 20k×1MB (20GB) بدون سقف کل | ✅ | bodyLimit 32M + 413 (R-09) |
| 10 | npm audit فقط ریشه | ✅ | ci.yml dual audit (R-10) |

## معیار recall

- `observed = 10` (جدول بالا)
- `covered = 10` (همه ثبت شدند)
- `recall = 10/10 = 100%` → ≥ 30% ✅

**آستانه:** اگر recall < 30%، `ledger-cli stats` با exit 1 و Gate rule 13 می‌بندد (see `packages/core/src/exec/gate-rules/rule13-recall.ts`).

## چگونه به‌روز شود

هر رفتار جدید (bug, out_of_scope, assumption) باید همان لحظه به‌عنوان open item یا criterion ثبت شود؛ «بعداً» ledger task می‌سازد (dogfooding).
