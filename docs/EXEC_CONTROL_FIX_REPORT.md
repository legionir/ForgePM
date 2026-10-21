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

| 5 | CLI انسانی با R-02 ناسازگار بود (تصمیم انسان: login نشست + CSRF) | `humanOnly` همه کلیدهای API را رد می‌کند، ولی CLI فقط با کلید کار می‌کرد | `scripts/ledger-cli.ts`: با `FORGEPM_EMAIL`+`FORGEPM_PASSWORD` لاگین می‌کند (cookie + `x-csrf-token`)؛ کلید API فقط برای خواندن؛ رمز فقط از env |
| 6 | **آسیب‌پذیری واقعی R-05:** `filter.<name>.clean/smudge/process` در config مخرب repo اجرا می‌شد | hardening فقط `filter.lfs.*` را خنثی می‌کرد؛ `git diff` هر filter نام‌دار را اجرا می‌کرد (با marker اثبات شد) | `review-source.ts`: نام filterهای config خوانده می‌شود (خواندن config کدی اجرا نمی‌کند) و همه با `-c filter.<n>.clean=`/`smudge`/`process`/`required=false` خنثی می‌شوند |
| 7 | تست `exec-git-malicious` قرمز بود | fixture خودش با git خام `add/commit` می‌کرد و filter/fsmonitor مخرب را اجرا می‌کرد (blob خالی)؛ یک assertion هم متن template را با مقدار `devNull` مقایسه می‌کرد | fixture با `-c` خنثی‌کننده می‌سازد؛ assertion اصلاح شد؛ حالا باگ ۶ را واقعاً می‌گیرد |
| 8 | `exec.allowed_repo_roots` خالی | تنظیم runtime | `scripts/seed.ts` برای dev مقدار استاندارد `apps,packages,tests,scripts,docs` را فقط اگر ست نشده باشد می‌گذارد (idempotent). endpoint/توکن CI عمداً seed نمی‌شوند |

تست‌های جدید (ابتدا red، سپس green):
- `apps/api/test/unit/exec-ledger-actor.test.ts` (۴ تست: ایجنت، کلید کاربر با scope `write`، کلید با `ledger:decide`، نشست پنل)
- `tests/unit/claude-hook.test.ts`: فایل‌های محافظت‌شده با ابزارهای Write/MultiEdit/Edit و عبور `.env.example`
- `tests/integration/exec-cli.test.ts`: CLI با login نشست؛ تست جدید R-02 (کلید کاربر حتی با `ledger:decide` رد می‌شود)
- `tests/unit/exec-git-malicious.test.ts`: همه markerها (fsmonitor/filter/textconv/…) نباید ساخته شوند

## ۲. چیزهایی که کد نیست و باید انسان/اپراتور انجام دهد

این‌ها تنظیمات runtime (جدول settings) هستند، نه کد؛ از این محیط قابل ست‌کردن نبودند:

1. `exec.allowed_repo_roots`: در dev با `npm run seed` پر می‌شود؛ در محیط واقعی باید ریشه‌های مجاز repo را خودتان بگذارید.
2. Baseline (Rule 12) به `test_command` وابسته نیست؛ طبق D-041 از لاگ CI می‌آید. باید `exec.ci_log_endpoint` و `exec.ci_log_secret_name` تنظیم شوند و توکن فقط‌خواندنی در `secrets` ذخیره شود (`docs/RUNBOOK.md` بخش CI baseline). میزبان باید در allowlist (`github.com`, `gitlab.com`, …) باشد.
   `exec.protected_test_globs` پیش‌فرض غیرخالی دارد؛ اگر در محیط شما خالی است، override شده و باید پاک شود.
3. Git/worktree: پروسه API باید با همان کاربری اجرا شود که مالک repo است. `git config safe.directory` عمداً بی‌اثر است.

## ۳. محدودیت‌ها و موارد باز (نیازمند تصمیم انسان)

- ~~CLI انسانی~~ و ~~R-05~~: رفع شدند (بند ۱، ردیف ۵ تا ۷). برای استفاده: `FORGEPM_URL`, `FORGEPM_EMAIL`, `FORGEPM_PASSWORD` را در env بگذارید.
- `fact_promote` با scope `ledger:decide` تعریف شده، ولی کلید نمی‌تواند آن را بگیرد؛ فقط مسیر پنل عملی است.
- سیاست ریسک (`exec.policy`) در settings است نه `policy.json`؛ قابل‌ویرایش از پنل (`pages/exec-policy.ts`) و `ledger-cli policy set`. ویرایش بدون تغییر کد اجرا نشد.
- Redis محلی (redis-server) و Postgres 18 embedded بالا آمدند؛ فقط `pg_dump` ناسازگار بود (بند ۴).

## ۴. نتایج اجرا (محلی)

local: **fail — فقط به‌خاطر محیط** (۳ تست pg_dump). remote: not-configured (CI اجرا نشده).

| گام | نتیجه |
|-----|-------|
| `npm run lint`, `typecheck` (همه workspaceها) | pass |
| `npm run build` | pass |
| `npm test` (unit + integration، Postgres 18 + Redis) | 743/746 pass؛ ۳ red: `phase7-backup` ×۲ و `phase7-system` ×۱ |
| علت ۳ red | `pg_dump` نصب‌شده نسخه 16.15 است و سرور embedded نسخه 18.4؛ pg_dump با «server version mismatch» رد می‌کند. باگ کد نیست؛ با pg_dump 18 باید دوباره اجرا شود |
| پوشش (همان اجرا بدون این دو فایل، فقط برای سنجش آستانه) | خطوط 86.7٪، شاخه 76.47٪، توابع 89.1٪؛ خطای threshold نداد. اجرای رسمی با `npm test` به‌خاطر red بالا گزارش پوشش نمی‌دهد |
| `npm run exec:e2e` | **13/13 pass** (بعد از بازنویسی اسکریپت، پایین) |

### اسکریپت exec-e2e از قبل قدیمی بود
روی کد اصلی (بدون تغییرات من) ۸ صحنه fail می‌شد: اسکریپت با قراردادهای فعلی ابزارها هم‌خوان نبود و چند صحنه با نوشتن مستقیم در DB یا قورت‌دادن خطا «سبز» می‌شدند.
بازنویسی (`scripts/exec-e2e.ts`): صحنه‌ها حالا از مسیر واقعی ابزارها رد می‌شوند.
- S2 خطای `REQUIREMENT_UNCOVERED` را از `exec_task_start` تأیید می‌کند. S3 `task_split` واقعی و بلاک‌شدن فرزند و والد.
- S7 اندازه‌گیری scope با `scope_check` و Rule 11 در Gate. S9 فایل واقعی را تغییر می‌دهد و `fact_verify` آن را stale می‌کند.
- S10 با `session_start` (reconcile واقعی) و `JOURNAL_UNRESOLVED`. S11 با stub provider. S13 تا `ok:true` می‌رود، با waiver انسانی baseline (D-041).
- ابزارهای agent با `type:'agent'` صدا زده می‌شوند و انسان فقط از `ctx.ledger`.
محدودیت‌های باقی‌مانده اسکریپت: S8 فقط تابع خالص `compareBaseline` را می‌سنجد (نه CI واقعی)؛ S12 مسیر انسانی را از سرویس core می‌زند نه از REST؛ شروع تسک با caller نوع `user` است (مثل تست‌های integration، چون start توسط agent منتظر approval می‌ماند).

## ۵. کارهای بعدی

1. اجرای دوباره `phase7-backup`/`phase7-system` با pg_dump نسخه 18 (یا CI) تا `npm test` کامل سبز شود.
2. ست‌کردن `exec.ci_log_endpoint` و `exec.ci_log_secret_name` + توکن CI در پنل؛ سپس `baseline_capture`، `journal_start`، `review_task` در محیط واقعی (e2e فعلی با fixture است).
3. Remote CI روی این شاخه؛ trailer `Ledger-Task:` برای commitها وقتی ابزار ledger در دسترس باشد.
4. به‌روزرسانی docs/EXECUTION_CONTROL_PLAN.md §9.5 (CLI با session، نه `FORGEPM_API_KEY`).
