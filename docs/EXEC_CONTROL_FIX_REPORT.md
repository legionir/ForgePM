# گزارش رفع مشکلات سیستم Execution Control

تاریخ: 2026-10-21 · شاخه: `ccr-28a238aa-2so2le`

این فایل سه چیز را ثبت می‌کند: چه چیزی تغییر کرد، چه چیزی هنوز باز است، و کدام تست‌ها اجرا شدند.
ابزارهای ledger در این نشست وجود نداشتند؛ انسان صریحاً اجازه داد خارج از ledger کار شود
(قانون «Blocked» در `AGENTS.md`). هیچ وضعیت ledger جعل نشد و هیچ ریسکی توسط ایجنت انتخاب نشد.

## ۱. تغییرات انجام‌شده

| # | مشکل | ریشه | تغییر |
|---|------|------|-------|
| 1 | `resolved_by`/`source` برای کار ایجنت `human` ثبت می‌شد | `ledgerActor` فقط `type==='agent'` را ایجنت می‌دانست؛ کلید API متعلق به کاربر (بدون `agent_id`) `type:'user'` می‌گیرد، پس `human` می‌شد و قانون «ایجنت نمی‌تواند آیتم مسدودکننده را soft-close کند» دور زده می‌شد | `apps/api/src/modules/exec/context.ts`: هر کلید API ایجنت است؛ فقط نشست پنل (بدون `apiKeyId`) انسان است (مطابق R-02) |
| 2 | hook فقط روی `Bash` اجرا می‌شد | `matcher: "Bash"` در `.claude/settings.json`؛ منطق `Edit package.json` هرگز اجرا نمی‌شد | matcher به `Bash\|Edit\|Write\|MultiEdit` تغییر کرد؛ `scripts/claude-hook.mjs` برای `package.json`، فایل‌های `.env*` (به‌جز `.env.example`)، `.claude/settings*.json` و `scripts/hooks/` «ask» برمی‌گرداند |
| 3 | پیام خطای Git مبهم بود | `GIT_CONFIG_GLOBAL=/dev/null` عمداً تنظیم است، پس `safe.directory` هرگز کمک نمی‌کند | `review-source.ts`: اگر Git بگوید `dubious ownership`، پیام صریح می‌دهد که API باید با کاربرِ مالک repo اجرا شود (stderr خام برگردانده نمی‌شود) |
| 4 | تست `exec-scope-baseline` بدون DNS شکست می‌خورد | گارد SSRF میزبان `ci.example.test` را resolve می‌کند و بدون DNS fail-closed می‌شود | `tests/integration/exec-scope-baseline.test.ts`: `dns.lookup` با آدرس عمومی stub شد (گارد همچنان فعال است) |

تست‌های جدید (ابتدا red، سپس green):
- `apps/api/test/unit/exec-ledger-actor.test.ts` (۴ تست: ایجنت، کلید کاربر با scope `write`، کلید با `ledger:decide`، نشست پنل)
- `tests/unit/claude-hook.test.ts`: فایل‌های محافظت‌شده با ابزارهای Write/MultiEdit/Edit و عبور `.env.example`

## ۲. چیزهایی که کد نیست و باید انسان/اپراتور انجام دهد

این‌ها تنظیمات runtime (جدول settings) هستند، نه کد؛ از این محیط قابل ست‌کردن نبودند:

1. `exec.allowed_repo_roots` (پیش‌فرض خالی): مسیرهای نسبی ریشه‌های مجاز repo، برای `review_task`، evidence و فکت‌های فایل‌دار.
2. Baseline (Rule 12) به `test_command` وابسته نیست؛ طبق D-041 از لاگ CI می‌آید. باید `exec.ci_log_endpoint` و `exec.ci_log_secret_name` تنظیم شوند و توکن فقط‌خواندنی در `secrets` ذخیره شود (`docs/RUNBOOK.md` بخش CI baseline). میزبان باید در allowlist (`github.com`, `gitlab.com`, …) باشد.
   `exec.protected_test_globs` پیش‌فرض غیرخالی دارد؛ اگر در محیط شما خالی است، override شده و باید پاک شود.
3. Git/worktree: پروسه API باید با همان کاربری اجرا شود که مالک repo است. `git config safe.directory` عمداً بی‌اثر است.

## ۳. محدودیت‌ها و موارد باز (نیازمند تصمیم انسان)

- **CLI انسانی با R-02 ناسازگار است.** `scripts/ledger-cli.ts` با `FORGEPM_API_KEY` کار می‌کند، اما `humanOnly` در `routes.ts` همه کلیدهای API را رد می‌کند (و `ledger:decide` قابل‌اعطا نیست). نتیجه: دو تست `tests/integration/exec-cli.test.ts` (B.14 و «other human verbs») **از قبل red بودند و هنوز red هستند**. گزینه‌ها: (الف) CLI با login نشست + CSRF کار کند، (ب) یک نوع کلید «human» با کنترل جدید تعریف شود، (پ) R-02 برای CLI استثنا بخورد. این تصمیم امنیتی است و ایجنت نباید انتخابش کند.
- **تست unit قرمزِ قبلی:** `tests/unit/exec-git-malicious.test.ts` (R-05) روی tree تمیز هم fail می‌شود (`changedFiles` در حضور filter مخرب ۰ فایل برمی‌گرداند). علت بررسی نشد؛ احتمالاً رفتار Git 2.43 با `filter.*.clean`. چون به hardening امنیتی مربوط است، نیاز به بررسی جداگانه دارد.
- `fact_promote` با scope `ledger:decide` تعریف شده، ولی کلید نمی‌تواند آن را بگیرد؛ فقط مسیر پنل عملی است.
- سیاست ریسک (`exec.policy`) در settings است نه `policy.json`؛ قابل‌ویرایش از پنل (`pages/exec-policy.ts`) و `ledger-cli policy set`. ویرایش بدون تغییر کد اجرا نشد.
- سناریوی انتها‌به‌انتها (`scripts/exec-e2e.ts`) اجرا نشد.
- Redis در این محیط نبود (`FORGEPM_TEST_NO_REDIS=1`)؛ suiteهای وابسته به صف اجرا نشدند. `pg_dump` هم بررسی نشد.

## ۴. نتایج اجرا (محلی)

local: **fail** — تغییرات من سبز؛ باقی‌مانده‌ها قرمزِ قبلی‌اند.
remote: not-configured (push نشده/CI اجرا نشده).

| گام | نتیجه |
|-----|-------|
| `npm run lint` | pass |
| `npm run typecheck -w @forgepm/api` | pass |
| `npm run test:unit` | 450/451 pass؛ ۱ red قبلی: `exec-git-malicious` |
| `npm run migrate`, `schema:check` (Postgres 18 embedded) | pass |
| `test:integration` برای `exec-*` (117 تست) | 115 pass؛ ۲ red قبلی: `exec-cli` |
| `npm run build`, پوشش کد (≥80%), کل `npm run verify` | اجرا نشد |

## ۵. کارهای بعدی

1. تصمیم انسان درباره مسیر احراز هویت CLI (بند ۳) و سپس رفع دو تست `exec-cli`.
2. بررسی `exec-git-malicious` (R-05).
3. ست‌کردن تنظیمات بند ۲ در محیط واقعی و اجرای `journal_start`, `baseline_capture`, `review_task`.
4. اجرای `scripts/exec-e2e.ts` و `npm run verify` کامل؛ سپس Remote CI.
