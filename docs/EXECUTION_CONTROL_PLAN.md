# Execution Control Plan — «سیستم کنترل اجرای ایجنت» در ForgePM (PE‑0 … PE‑12)

> **وضعیت:** پیش‌نویس پلن — **هیچ کدی در این مرحله نوشته نمی‌شود.** > **منبع نیاز:** پرامپت اجرایی «Agent Execution Control» + ضمیمهٔ ۱ (بخش‌های G تا K).
> **خانوادهٔ مستندات:** `EXECUTION_PLAN.md` (§3b قراردادها، §8 MCP، §12 مدل داده، §14 امنیت) —
> این سند فازهای `PE-*` را **پس از** `v1.0.0-rc.1` و به همان قراردادها اضافه می‌کند.
> **قاعدهٔ حاکم (بدون تغییر):** هر چیزی که نباید قابل دور زدن باشد، **کد قطعی** است؛
> هر چیزی که قضاوت می‌خواهد، **پرامپت/LLM**. هیچ منطق Gate یا ریسک داخل پرامپت نمی‌رود.

---

## ۰. خلاصهٔ اجرایی (۱۰ خط)

1. یک ماژول **اختیاری ولی سخت‌گیر** به نام `exec_control` ساخته می‌شود که Ledger (منبع حقیقت
   پایدار) + ابزارهای MCP + Finalization Gate + بازبین خصمانه + سیاست ریسک است.
2. **Ledger فقط PostgreSQL است** — هیچ پایگاه دوم (`.agent-ledger/ledger.db`، `better-sqlite3`)
   ساخته نمی‌شود؛ دیتابیس موجود هست و منبع حقیقت واحد باید همان باشد (مالک، ۲۰۲۶‑10‑17).
   Gate سمت سرور اجرا می‌شود و تاریخچهٔ مکالمه هیچ‌وقت منبع حقیقت نیست. کش آفلاین اختیاری
   یک **فایل JSON فقط‑خواندنی** است (بدون DB)، پیش‌فرض خاموش (§۱۳).
3. **Ledger کارها = WorkItem** در پروژه؛ هر رکورد ledger یک `work_item_id` والد دارد تا
   UI، audit، approval و accessibility از قبل رایگان دربیاید.
4. **Gate یک نقطه دارد:** `assertCompletionAllowed()` در `packages/core/src/exec/gate.ts`
   که هم از MCP `exec_task_complete` و هم از Guard ثبت‌شده روی `work_item_transition`
   (به حالت `completed`) صدا زده می‌شود. هیچ مسیر دیگری `done` تولید نمی‌کند.
5. **تأیید انسانی = `approval_requests` موجود** (action‌های جدید `exec.*`)؛ ایجنت هیچ
   ابزاری برای تأیید، waive، drop یا پایین‌آوردن سطح ریسک ندارد.
6. **قوانین غیرقابل‌دور‌زدن در DB هم سخت می‌شوند:** trigger فقط‑افزودنی روی
   `exec_events`، `CHECK` روی وضعیت‌ها، و **REVOKE UPDATE/DELETE** روی سه جدول append‑only.
7. **بازبین خصمانه = موتور review موجود** با `kind:'exec'` و ورودی ایزوله‌شدهٔ قطعی
   (۵ منبع، بدون تاریخچهٔ گفتگو) + ابطال نتیجه با `tree_hash`.
8. **۱۳ فاز (PE‑۰ تا PE‑۱۲)** با تست خودکار در پایان هر فاز؛ `npm run verify` + `schema:check` +
   `gen:api:check` + `docs:check` + `migration-hash` باید در هر فاز سبز بمانند.
9. **سناریوی پذیرش نهایی به اسکریپت اجراشدنی تبدیل می‌شود:** `npm run exec:e2e`
   (بخش ۵ پرامپت اصلی + ۶ مورد ضمیمه) که در CI اجرا می‌شود.
10. **حجم و بازه:** سقف «۴۰۰–۸۰۰ خط» پرامپت **لغو** شد (مالک: «هدف تحقق کامل ارزش است، خط مهم
    نیست»): برآورد ~۵۰۰۰–۶۰۰۰ خط و **۲۶–۳۰ روز‌مهندس** برای ۱۳ فاز کامل (A–K + پنل کامل + ۲۸ ابزار).
    سقف **کیفی** پابرجاست: ≤ ۴۰۰ خط/فایل، ≤ ۶۰ خط/تابع، بدون وابستگی غیرضروری.
11. **نتیجهٔ تست مطابق استاندارد امنیتی**: این پلتفرم **هیچ‌وقت کد مخزن را اجرا نمی‌کند** — نه روی
    host، نه در container (D‑08 بازبینی‌شده، مالک ۲۰۲۶‑۱۰‑۱۷). نتیجه فقط از **لاگ CI** همان `commit_sha`
    خوانده و parse می‌شود؛ لاگ نبود ⇒ قاعدهٔ ۱۲ **رد**. هیچ `runner`/host‑exec وجود ندارد (§۱۳، PE‑8).

---

## ۱. ممیزی مخزن و تطبیق پرامپت با استک واقعی

پرامپت با عبارت «اگر پروژهٔ من استک دیگری دارد، سازگار با آن بساز و در یک خط گزارش بده»
راهنمایی کرده است. جدول زیر نشان می‌دهد چه چیزی **بازاستفاده** می‌شود و چه چیزی **نو** است.

| نیاز پرامپت                                   | وضعیت در ForgePM                                                                                                           | تصمیم اجرایی                                                                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| زبان TS، Node ≥ ۲۰                            | ✅ Node 22 (`engines: >=22 <23`)                                                                                           | بدون تغییر؛ هدف Node 22                                                                                                                             |
| ذخیره‌سازی SQLite + `.agent-ledger/ledger.db` | ❌ Postgres تنها منبع حقیقت پایدار (`README`/`ARCHITECTURE`)                                                               | **فقط Postgres**؛ بدون DB دوم؛ کش آفلاین = JSON فقط‑خواندنی، پیش‌فرض خاموش (D‑01، تأییدشده)                                                         |
| MCP server                                    | ✅ Streamable HTTP روی `POST /mcp`؛ باینری inbound با نام `forgepm-mcp` وجود ندارد (D‑061)                                  | **یک MCP واحد**: ابزارها در `ToolRegistry` با اسکوپ‌های `ledger:*`؛ `forgepm-mcp` فقط نام `serverInfo` است و ورودی ایجنت `/mcp` است (D‑02/D‑061) |
| اعتبارسنجی zod                                | ✅ `packages/shared` (zod contracts)                                                                                       | همهٔ ورودی‌ها و خروجی‌ها؛ `strictObject` + `forbidNonWhitelisted`                                                                                   |
| تراکنش                                        | ✅ `unitOfWork` (domain + audit + outbox در یک تراکنش)                                                                     | هر نوشتن ledger داخل `unitOfWork`؛ `exec_events` همان‌جا append می‌شود                                                                              |
| شناسهٔ خوانا (`T-001`)                        | ⚠️ UUIDv7                                                                                                                  | الگوی `allocateNumber` (UPDATE…RETURNING اتمیک) برای کد خوانا در هر پروژه                                                                           |
| تأیید انسانی / approval                       | ✅ `approval_requests` + `approval_decide` (human only) + `self‑approval` ممنوع                                            | action‌های جدید `exec.*`؛ پنل Approvals بدون تغییر منطقی                                                                                            |
| بازبین با LLM + ایزولاسیون ورودی              | ✅ `review/engine.ts`، `contract.ts` (evidence)، `stub-provider` (تست قطعی)، `diff-slot`، `sources.ts` (`REPO_MOUNT_ROOT`) | `kind:'exec'` + مراحل `exec:*`؛ تست‌ها با stub provider                                                                                             |
| WorkItem سلسله‌مراتب + روابط                  | ✅ `parent_id`، `work_item_relations(blocks/relates_to/duplicates)`، `acceptance_criteria jsonb`                           | زیرتسک = `parent_id`؛ **وابستگی با چرخه‌سنجی در جدول جدید `exec_task_deps`** (§H)                                                                   |
| موتور گراف/چرخه                               | ✅ `packages/core/src/graph.ts`                                                                                            | تست‌محور برای `task_split` و `req_link`                                                                                                             |
| ماژول‌های اختیاری + enable flag               | ✅ `ModuleRegistry` (`modules.<name>.enabled`)                                                                             | `exec_control` ثبت ولی خاموش پیش‌فرض                                                                                                                |
| Settings با واریث سیستم←سازمان←پروژه          | ✅ `settings-registry.ts` + `getEffective`                                                                                 | سیاست ریسک و هارنس به‌جای `policy.json` روی فایل (§۲ D‑05)                                                                                          |
| audit trail                                   | ✅ `recordAudit` (شکست = rollback)                                                                                         | هر mutation ledger یک `audit_event`                                                                                                                 |
| لاگ فراخوانی ابزار                            | ✅ `mcp_tool_calls` (mask + cap 50KB)                                                                                      | `exec_events` فقط برای تغییر وضعیت‌ها؛ ردیابی خام از `mcp_tool_calls`                                                                               |
| CLI انسانی                                    | ❌ فقط `scripts/*.ts` با tsx (بدون باینری `bin` در مخزن)                                                                   | **استاندارد خودِ مخزن**: `scripts/ledger-cli.ts` + `npm run ledger -- …` روی REST (بدون SQL مستقیم)؛ پکیج npm جدا **نه** (D‑11)                     |
| `test_command` اجراشده توسط کد                | ⚠️ اجرای کد مخزن در پروسهٔ خودی ممنوع                                                                                      | **بدون اجرا**: نتیجه فقط از لاگ CI همان `sha` خوانده می‌شود؛ نبود لاگ ⇒ قاعدهٔ ۱۲ رد (D‑08، §۱۳)                                                    |
| Hookها (PreToolUse)                           | ✅ `scripts/claude-hook.mjs` + تست ورودی ساختگی (PE‑5 F.9)                                                                  | تا PE‑6 نمونهٔ `.claude/settings.json` اختیاری است؛ قفل اصلی همچنان سمت سرور/ledger است                                                        |

**نتیجه:** ~۶۵٪ زیرساخت لازم وجود دارد. کار اصلی، **قلمرو جدید داده + دروازهٔ قطعی +
جدول سیاست + ایزولاسیون بازبینی + journal/resume** است، نه ساخت اپلیکیشن جدید.

---

## ۲. انحراف‌های آگاهانه از پرامپت — **تصمیم‌های مالک ثبت و نهایی شد**

همهٔ بندهای زیر در PE‑۰ به‌عنوان `exec_decisions` (سه‌تای `approval`) و `exec_events` ثبت می‌شوند؛
ستون آخر «وضعیت» است، نه سؤال باز.

| id   | انحراف                                                                                                                              | چرا                                                                                                                                                                                                | ریسک / راه‌حل                                                                                                                                                                                                | وضعیت                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| D‑01 | Ledger فقط Postgres؛ هیچ DB دوم (SQLite حذف شد)                                                                                     | Gate باید مستقل از ماشین ایجنت باشد؛ چند‌مستأجیری؛ بکاپ/ریالتن/`schema:check` موجود                                                                                                                | سرور پایین ⇒ ابزار نوشتن **fail closed** با خطای روشن؛ کش آفلاین فقط‑خواندنی و اختیاری (پیش‌فرض خاموش)                                                                                                       | ✅ **approved** (مالک)            |
| D‑02 | یک MCP واحد (`POST /mcp`)؛ نه `agent-ledger` جدا، نه بریج جدید. `forgepm-mcp` فقط `serverInfo.name` است (D‑061) | جلوگیری از دو منبع حقیقت؛ استفاده از auth/scope/audit/rate-limit/`mcp_tool_calls` موجود | حجم `tools/list` با توضیح ≤ ۲۰۰ کاراکتر + سقف خروجی کنترل می‌شود (نه با حذف ابزار — D‑12) | ✅ **approved** (مالک) |
| D‑03 | تسک‌ها روی `work_items` نگاشت می‌شوند                                                                                               | بدون دوگانگی وضعیت؛ پنل/audit/approval رایگان                                                                                                                                                      | همگام‌سازی دوطرفه ⇒ تک‌نویس: فقط `exec` وضعیت ledger را تغییر می‌دهد؛ `work_item_transition` به `completed` با guard + مهر گیت مسدود است (I‑1) و UI از همین endpoint‌ها می‌نویسد                             | ✅ approved (PE‑0)                |
| D‑04 | `AGENTS.md` مخزن «منبع حقیقت پلن فاز» است؛ قوانین جدید در `docs/LEDGER_RULES.md`                                                    | `docs:check` + `EXECUTION_PLAN` منبع حقیقت‌اند؛ جلوگیری از تضاد                                                                                                                                    | دو فایل → `AGENTS.md` فقط ۱ بخش ارجاع + «ممنوعه‌ها» (≤ ۲۰ خط اضافه)                                                                                                                                          | بی‌خطر                            |
| D‑05 | `policy.json` → تنظیم `exec.policy` (JSONB، zod، override در سطح سازمان/پروژه)                                                      | منبع حقیقت واحد + بدون restart + قابل audit + واریث                                                                                                                                                | ویرایش فایل ساده‌تر است ⇒ `npm run policy:print/set` + صفحهٔ `exec-policy` در پنل همان سهولت را می‌دهند                                                                                                      | ✅ approved (PE‑0)                |
| D‑06 | API در شروع تسک `start_ref` را از Git اندازه می‌گیرد؛ اگر Git/commit موجود نباشد، manifest hash-only را خودش ثبت می‌کند | هیچ `start_ref` یا فهرست فایل از agent پذیرفته نمی‌شود؛ adapter فقط Git read-only و فایل‌خوانی/hash انجام می‌دهد                                                                 | اگر هر دو اندازه‌گیری شکست بخورند، Rule 11 fail-closed است؛ فقط waive انسانیِ ناموجودبودن منبع scope می‌تواند باز کند | ✅ اجراشده در PE‑8 |
| D‑07 | حجم ~۵۰۰۰–۶۰۰۰ خط، نه ۴۰۰–۸۰۰                                                                                                       | ضمیمه دامنه را به ۱۱ بخش + پنل کامل + ۲۸ ابزار گسترش داد                                                                                                                                           | مالک: «تعداد خط مهم نیست، تحقق کامل ارزش مهم است» ⇒ سقف خط لغو، سقف فایل/تابع و «وابستگی غیرضروری ممنوع» باقی می‌ماند (تست ساختاری C.11)                                                                     | ✅ approved (مالک)                |
| D‑08 | **(بازبینی مالک ۲۰۲۶‑۱۰‑۱۷)** baseline فقط از **لاگ CI** خوانده می‌شود؛ ForgePM هیچ کدی اجرا نمی‌کند — نه host، نه container/docker | مالک: «وارد docker نشو؛ docker چرا لازم است؟». اجرای تست کارِ CI خودِ مخزن است و لاگش منبع قابل‌بازبینی همان اجرا؛ یک runner یعنی یک سطح حمله + یک وابستگی استقرار اضافه، بدون ارزش افزودهٔ امنیتی | نبودِ لاگ CI ⇒ قاعدهٔ ۱۲ **رد** (`BASELINE_UNAVAILABLE`)، نه `skipped`؛ عبور فقط با waive صریح انسانی که در گزارش نهایی برجسته می‌شود. کلیدهای `exec.runner.*` و فایل‌های `scripts/runner/*` از پلن حذف شدند | ✅ approved (مالک)                |
| D‑09 | افزودن `0010_exec.migration.ts` (۱۷ جدول) و **یک خط** به `schema-check.ts` (anchors)                                                | `schema:check` بلوک §H را نمی‌شناسد                                                                                                                                                                | تنها تغییر کد خارج از قلمرو ماژول؛ در فاز PE‑0                                                                                                                                                               | بی‌خطر                            |
| D‑10 | ارجاع `out_of_scope` در نسخهٔ ۱ فقط `open_item(type=out_of_scope)` است نه WorkItem جدا                                              | جلوگیری از تورم موجودیت                                                                                                                                                                            | گم‌شدن → همه در `req_coverage`/`ledger_status`/پنل دیده می‌شوند                                                                                                                                              | بی‌خطر                            |
| D‑11 | `ledger-cli` = اسکریپت مخزن (`scripts/ledger-cli.ts` + `npm run ledger`)، نه باینری npm                                             | «مطابق استانداردها» = استاندارد خودِ مخزن: همهٔ ابزارها `scripts/*.ts` با tsx (۱۴ مورد)، بدون `bin`                                                                                                | کشف‌پذیری برای تیم بیرونی ⇒ در `README` + `docs/RUNBOOK.md` مستند؛ در صورت نیاز بعداً به پکیج `@forgepm/ledger-cli` منتقل می‌شود (بدون تغییر API)                                                            | ✅ approved                       |
| D‑12 | **هر ۲۸ ابزار** ساخته و فعال می‌مانند؛ هیچ سطح «core/full» و هیچ ابزار مخفی                                                         | مالک: «ابزار کامل باشه»                                                                                                                                                                            | هزینهٔ context با ۴ مکانیزم: توضیح ≤ ۲۰۰ کاراکتر، `readOnlyHint/destructiveHint`، سقف خروجی + `truncated`، و `session_start` به‌عنوان تنها «نقطهٔ شروع»                                                      | ✅ approved (ریسک ثبت → PE‑6 D.3) |
| D‑13 | **پنل کامل** (۲ صفحه + تب تسک + فرم‌های تأیید) به‌جای فقط‑خواندنی                                                                   | پنل تنها مسیر مطمئن برای تأیید انسانی است؛ CLI نباید تنها راه باشد                                                                                                                                 | هزینهٔ UI + i18n + a11y ⇒ PE‑1۲ جدا با تست‌های موجود (`i18n-check`, `chain.spec`, contrast)                                                                                                                  | ✅ approved                       |

**قانون (به‌روز):** همهٔ D‑ها **مؤیَد**اند و پیاده‌سازی می‌شوند؛ همچنان در PE‑۰ با
`req_add` + `ledger_record_decision` ثبت و (برای D‑01/02/07/08) با
`npm run ledger -- approve <D-id>` در Ledger تأیید رسمی می‌شوند — تا آن ثبت، Gate PE‑0 باز نمی‌ماند
(خود‑آزمایی: این سیستم باید روی ساختن خودش هم اجرا شود).

---

## ۳. معماری هدف

```
 agent (Claude Code / Cursor / Codex …)
   │  یک MCP واحد: Streamable HTTP `POST /mcp`؛ بدون inbound stdio proxy (D‑061) — [اختیاری] JSON snapshot فقط‌خواندنی
   ▼                                                        .agent-ledger/status.json (بدون DB، پیش‌فرض خاموش)
 POST /mcp  (dispatch.ts: scope, rate, module gate, idempotency, mcp_tool_calls)
   ▼
 apps/api/src/modules/exec/{mcp-tools.ts, routes.ts, service.ts}
   ▼
 packages/core/src/exec/*            ← تمام منطق قطعی: gate, policy, evidence, scope,
   │                                   baseline, journal, facts, requirements, codes
   ├─ Postgres  exec_* (17 جدول)     ← تنها منبع حقیقت؛ triggerها + REVOKE append‑only
   ├─ approval_requests (human)      ← تأیید/رد/answer/waive/drop/promote
   ├─ review engine (kind 'exec')   ← بازبین خصمانه، ورودی ایزوله، tree_hash
   ├─ work-items guard              ← transition به 'completed' بدون Gate = FORBIDDEN
   └─ worker: بررسی دوره‌ای hash فکت‌ها (`exec.verify_facts`) و jobهای review از outbox

   baseline هرگز با اجرای کد ساخته نمی‌شود: `exec_baseline_tests` فقط از **لاگ CI** همان
   `sha` پر می‌شود (fetch + parse). لاگ نبود ⇒ قاعدهٔ ۱۲ رد — fail closed (D‑08).

### ۳.۱ لایه‌بندی و مسیر فایل‌ها

| لایه | مسیر | محتوا |
|---|---|---|
| قرارداد | `packages/shared/src/schemas-exec.ts` | zod: `exitReportSchema`, `openItemSchema`, `policySchema`, `reqSchema`, `factSchema`, `journalSchema`, `toolOutputs` |
| enum‌ها | `packages/shared/src/enums.ts` | افزودن `EXEC_*` enum‌ها (بدون حذف مقدار قبلی) |
| خطاها | `packages/shared/src/error-codes.ts` | §۳.۳ |
| دامنه/کد قطعی | `packages/core/src/exec/` | هستهٔ ledger و چرخهٔ facts (زیر) |
| سرویس/REST | `apps/api/src/modules/exec/` | `module.ts`, `service.ts`, `mcp-tools.ts`, `routes.ts`, `approvals.ts` |
| worker | `apps/worker/src/handlers.ts`, `fact-verification-job.ts`, `fact-file-source.ts` | بررسی hash فکت‌ها هر ۱۵ دقیقه با mount فقط‌خواندنی |
| CLI انسان | `scripts/ledger-cli.ts` (+ `npm run ledger`، `npm run policy:print/set`) | §۹.۵ — استاندارد مخزن: اسکریپت tsx، بدون پکیج npm جدا (D‑11) |
| پنل (کامل) | `pages/exec-tasks.ts`, `pages/exec-ledger.ts`, `pages/exec-policy.ts`, تب `exec` در `work-item-detail` | §۱۳ (PE‑12) — مشاهده + تمام قفل‌گشایی‌ها (fa/en، RTL) |
| مستند | `docs/EXECUTION_CONTROL.md`, `docs/LEDGER_RULES.md`, افزودن §H به `DATA_MODEL.md` | §۱۴ |

`packages/core/src/exec/`:
`codes.ts` (شناسه خوانا) · `open-items.ts` (ماشین وضعیت + قوانین بستن) · `evidence.ts`
(اعتبارسنجی ref) · `policy.ts` (طبقه‌بندی ریسک) · `exit-report.ts` (تبدیل به آیتم + validate) ·
`facts.ts` + `fact-evidence.ts` + `fact-verification.ts` (hash/stale/supersede/promote/query) · `scope.ts` (glob + diff · test weakening) ·
`journal.ts` (started→unknown) · `session.ts` (بستهٔ اولویت‌دار با سقف) · `baseline.ts` (parse لاگ CI
+ fail‑closed) · `types.ts`. **`runner.ts` وجود ندارد**: کد مخزن هیچ‌گاه اجرا نمی‌شود. تنها مرز
فرایند در execution-control، `apps/api/src/modules/exec/review-source.ts` است: یک adapter حسابرسی‌شده
با Gitهای ثابت و read-only، محدود به `exec.allowed_repo_roots`. گارد ساختاری فقط همین فایل را مجاز
می‌داند و allowlist فرمان‌ها را بررسی می‌کند؛ تمام مسیرهای دیگر در `packages/core/src/exec/**` و
`apps/api/src/modules/exec/**` spawn-free می‌مانند (`tests/unit/exec-no-spawn.test.ts`, D‑041/D‑062).

### ۳.۲ اصول تغییرناپذیری (Invariant‌ها) — همان‌ها که تست می‌شوند

- **I‑1** تنها نقطهٔ نوشتن `status='done'` تابع `exec_gate_complete` است؛ هر مسیر دیگر
  (`work_item_transition` به `completed` وقتی تسک در ledger است) باید رد شود.
- **I‑2** هیچ رکورد ledger حذف نمی‌شود. `exec_events`، `exec_evidence`، `exec_action_journal`
  در DB با `BEFORE UPDATE OR DELETE` trigger + `REVOKE UPDATE, DELETE` محافظت می‌شوند.
- **I‑3** ایجنت نمی‌تواند وضعیت یک آیتم مسدودکننده را به `accepted|deferred|wont_fix` ببرد
  (نه ابزار، نه REST، نه CLI با کلید ایجنت — کلید `fpm_` با اسکوپ `ledger:decide` انسان است).
- **I‑4** سطح ریسک فقط از `touches + reversible` + جدول سیاست محاسبه می‌شود؛ فیلد ارسالی
  ایجنت به نام `risk_level` در schema **وجود ندارد** (ورودی ناشناخته = خطا).
- **I‑5** `verified` روی معیار پذیرش فقط با evidence معتبر + نتیجهٔ تستِ نام‌دارِ CI با SHA دقیق set می‌شود؛ ایجنت هرگز `verified` نمی‌نویسد و ForgePM هیچ کد مخزنی را اجرا نمی‌کند.
- **I‑6** نتیجهٔ بازبینی به `tree_hash` گره خورده است؛ تغییر diff ⇒ اعتبار باطل.
- **I‑7** خروجی همهٔ ابزارهای خواندنی: سقف بایت + `truncated: true` + شمارندهٔ «و N مورد دیگر».
- **I‑9** هر ۲۸ ابزار همیشه ثبت و visible‌اند (تصمیم D‑12)؛ کنترل هزینه فقط از راه توصیف کوتاه،
  سقف خروجی و `session_start` به‌عنوان نقطهٔ شروع. `tools/list` هیچ‌وقت ابزاری را برای یک کلید
  `ledger:*` پنهان نمی‌کند (مگر ماژول خاموش باشد).
- **I‑10** هیچ کدی از مخزن اجرا نمی‌شود — نه روی host/worker، نه در container (D‑08). تنها منبع
  baseline لاگ CI همان `sha` است؛ نبودش ⇒ `BASELINE_UNAVAILABLE` و **رد** قاعدهٔ ۱۲ (fail closed).
- **I‑8** هر نوشتن = یک `exec_events` + یک `audit_event` در **همان تراکنش** (شکست = rollback).

### ۳.۳ قرارداد خطا (اضافه‌شدنی به `error-codes.ts`)

```

LEDGER_NOT_FOUND 404 · LEDGER_STATE_INVALID 409 · LEDGER_TRANSITION_NOT_ALLOWED 409
GATE_FAILED 409 · CRITERION_NOT_CHECKABLE 422 · EVIDENCE_INVALID 422
SCOPE_VIOLATION 422 · JOURNAL_UNRESOLVED 409 · FACT_STALE 409
REQUIREMENT_UNCOVERED 409 · REVIEW_STALE 409 · REVIEW_OUTPUT_INVALID 422
BASELINE_UNAVAILABLE 503 (no CI log for this sha → rule 12 fails closed)
APPROVAL_PENDING 409 · SELF_APPROVAL_FORBIDDEN 403 (موجود: FORBIDDEN_SELF_APPROVAL)

```

پیام هر خطا **قابل‌اقدام** است (قاعدهٔ ضمیمه §۴): `code` + `what_is_wrong` + `needed_action` +
`tool_to_call` + `refs`. مثال:
`{ code:'GATE_FAILED', blocked_by:[{rule:2, ref:'OI-004', needed:'resolve with note or ask_human', tool_to_call:'ledger_resolve_item'}] }`.

---

## ۴. مدل داده (مهاجرت `0010_exec` — ۱۷ جدول)

قراردادها رعایت می‌شوند: `organization_id` در همه، `UNIQUE(id, organization_id)`، FK مرکب
`(project_id, organization_id) → projects`، UUIDv7، `timestamptz`، JSONB فقط برای دادهٔ نیمه‌ساختار.

| # | جدول | ستون‌های کلیدی | نکات الزامی |
|---|---|---|---|
| 1 | `exec_tasks` | `id, organization_id, project_id, work_item_id→work_items, code 'T-###', title, description, status('not_started','in_progress','awaiting_review','blocked','done'), parent_id, start_ref, tree_hash_start, allowed_paths jsonb, blocked_on_kind('task','question','decision','external'), blocked_on_ref, blocked_reason, unblock_condition, created_at, closed_at` | `CHECK`: اگر `status='blocked'` آنگاه `unblock_condition IS NOT NULL`؛ `CHECK` اگر `status='done'` آنگاه `closed_at IS NOT NULL`؛ `parent_id` self‑FK |
| 2 | `exec_criteria` | `id, task_id→exec_tasks, req_id→exec_requirements NULL, code 'C-#', text, status('pending','verified','waived'), verified_at, waiver_approval_id NULL→approval_requests` | `CHECK waived ⇒ waiver_approval_id NOT NULL`؛ `UNIQUE(task_id, code)` |
| 3 | `exec_evidence` | `id, criterion_id→exec_criteria, task_id, kind('test_output','diff','file','command_output','manual_check'), ref, summary, sha256, size_bytes, meta jsonb, created_at, recorded_by` | append‑only (trigger + REVOKE)؛ `size_bytes ≤ exec.evidence_max_bytes` |
| 4 | `exec_open_items` | `id, task_id, code 'OI-###', title, detail, type(9 مقدار پرامپت), blocks_completion, source('agent','exit_report','reviewer','human','hook'), status(8 مقدار), resolution_note, resolved_by('agent','human'), decision_id NULL, created_at, updated_at` | `CHECK` قطعی: `blocks_completion AND status IN ('accepted','deferred','wont_fix') ⇒ resolved_by='human' AND resolution_note <> ''`؛ `CHECK resolved/na ⇒ resolution_note <> ''` |
| 5 | `exec_decisions` | `id, task_id, code 'D-###', title, context, options jsonb, selected, rationale, touches text[], reversible, risk_level('auto','review','approval'), approval_state('not_required','pending','approved','rejected'), approval_id→approval_requests, status('proposed','active','superseded','needs_revisit'), review_trigger jsonb, created_at` | `risk_level` فقط computed؛ `CHECK approval ⇒ approval_id NOT NULL` |
| 6 | `exec_questions` | `id, task_id, code 'Q-###', question, options jsonb, recommendation, why_it_matters, blocking, answer, answered_by, status('open','answered','canceled'), created_at, answered_at, approval_id` | پاسخ فقط از مسیر انسانی (`ledger:decide`)؛ `blocking ⇒` تسک `awaiting_review`+`blocked_on_kind='question'` |
| 7 | `exec_reviews` | `id, task_id, round, review_run_id→review_runs, verdict('pass','fail'), findings jsonb, checked jsonb, tree_hash, created_at` | `UNIQUE(task_id, round)`؛ `round ≤ exec.max_review_rounds` |
| 8 | `exec_events` | `id, ts, organization_id, task_id NULL, entity, entity_code, action, actor_type('agent','human','system'), actor_id, tool NULL, payload jsonb` | **append‑only در DB**؛ `INDEX (task_id, ts)` |
| 9 | `exec_requirements` | `id, organization_id, project_id, code 'REQ-###', text, quote, source('user_message','doc','human','agent_derived'), source_ref, kind('functional','non_functional'), priority, status('active','changed','dropped'), drop_reason, dropped_by, created_at, updated_at` | `CHECK status='dropped' ⇒ dropped_by<>'agent'`؛ `agent_derived ⇒ source_ref NOT NULL` |
| 10 | `exec_reports` | `id, organization_id, task_id→exec_tasks, payload jsonb, status('submitted','gate_passed','gate_failed'), created_at, updated_at` | گزارش خروجیِ تکمیل؛ دروازهٔ Gate نتیجه را به همین ردیف پیوند می‌دهد |
| 11 | `exec_task_deps` | `task_id, depends_on_task_id, created_at` | `CHECK task_id <> depends_on_task_id`؛ چرخه در کد (گراف) |
| 12 | `exec_facts` | `id, code 'F-###', key, value, kind('fact','assumption'), source('code','docs','human','tool_output','agent_guess'), source_ref, files jsonb, file_hashes jsonb, verified_at, status('active','stale','rejected','superseded'), superseded_by, created_at` | `kind='fact' ⇒ source<>'agent_guess'`؛ `(project_id, key)` unactive یکتای جزئی |
| 13 | `exec_fact_decisions` | `fact_id, decision_id, created_at` | پل stale → needs_revisit |
| 14 | `exec_baseline_tests` | `id, task_id, test_name, result_at_start('pass','fail','skip'), assertion_count, source('ci','human'), provenance jsonb, captured_at` | فقط writer = کد (parser لاگ CI)؛ `source='human'` **فقط** با approval انسانی و در گزارش نهایی برجسته؛ `provenance` = `{run_id, sha, job, started_at, exit_code, sha256_log}` |
| 15 | `exec_action_journal` | `id, task_id, code 'AJ-###', action, target, idempotent, expected_effect, pre_state_ref, status('started','done','failed','unknown'), started_at, finished_at, result_ref, note` | `started` بازنشانی خودکار به `unknown` در `session_start` |
| 16 | `exec_code_seq` | `project_id, prefix('T','C','OI','D','Q','F','REQ','AJ'), seq` | شمارندهٔ کد خوانا؛ `allocateLedgerCode` با `SELECT … FOR UPDATE` (تست همزمانی PE‑0.5) |
| 17 | `exec_gate_checks` | `id, task_id, report_id, ok, blocked_by jsonb, gate_version, tree_hash, run_source, file_manifest jsonb NULL, created_at` | **مهرِ Gate**: هر ارزیابی (شامل رد) یک ردیف غیرقابل‌حذف؛ `file_manifest` در Gate موفق snapshot hash-only فایل‌ها/ریشه‌ها برای drift پس از بستن است |

**افزودنی‌های سازگار (additive) به جداول موجود** (هیچ ستون/جدول قبلی حذف یا ویرایش نمی‌شود):

- `work_items`: `exec_task_id uuid NULL REFERENCES exec_tasks(id)` (ستون add-only)
  + ایندکس جزئی `WHERE exec_task_id IS NOT NULL`.
- `settings`: بدون تغییر ساختار؛ کلیدهای جدید (§۳.۴).
- `approval_requests`: بدون تغییر ساختار؛ فقط مقدار جدید در `action` (متن آزاد است).
- `exec_gate_checks.file_manifest jsonb NULL`: مهاجرت add-only `0011_exec_journal_reconcile`، snapshot هش‌محور در Gate موفق؛ ورودی فقط‌خواندنی به `exec.allowed_repo_roots` محدود و سپس به globهای `task.allowed_paths` همان تسک فیلتر می‌شود؛ هیچ محتوای فایلی ذخیره نمی‌شود.
- همان مهاجرت، trigger journal را برای چرخهٔ `started → unknown → done|failed` به‌روزرسانی می‌کند؛ settlement فقط یک‌بار مجاز است و ستون‌های ادعا تغییرناپذیرند.

**DROP در مهاجرت بعدی فقط اگر لازم شد:** هیچ. همه چیز با add-only پیش می‌رود.

### ۴.۱ کلیدهای `SETTING_DEFINITIONS` (جدید)

```

modules.exec_control.enabled bool = false
exec.policy jsonb = POLICY_DEFAULT (§۶) (قابل override در پروژه)
exec.test_command string = '' (فقط می‌گوید کدام کار CI این نتایج را تولید می‌کند؛ اجرا در CI خودِ مخزن)
exec.test_result_parser jsonb = { "pass":[…], "fail":[…], "skip":[…], "test_line":"" } regex واژگان خلاصهٔ CI؛ baseline فقط وقتی کامل است که نتیجهٔ نام‌دارِ هر تست قابل استخراج باشد
exec.protected_test_globs array = ["**/*.test.ts","**/test/**/*.ts","**/e2e/**/*.spec.ts"]
exec.allowed_repo_roots array = [] (prefix-safe، مثل github/config.ts)
exec.baseline_source enum = 'auto' | 'ci' | 'off' (auto = تلاش برای خواندن لاگ CI همان sha)
exec.ci_log_endpoint string = '' (endpoint HTTPS با `{sha}` که JSON `{sha,run_id,job,provider?,log}` برمی‌گرداند؛ بدون placeholder، `?sha=` اضافه می‌شود)
exec.ci_log_secret_name string = '' (نام توکن read-only در encrypted `secrets` store؛ فقط header Bearer و هرگز در پاسخ/لاگ)
exec.evidence_max_bytes int = 131072
exec.session_output_max_bytes int = 8192
exec.tool_output_max_bytes int = 16384
exec.max_review_rounds int = 2
exec.require_review_for_done bool = true
exec.block_transition_when_gate_fails bool = true
exec.stale_check_on_start bool = true

````

**۱۸ کلید** جدید؛ همه در تست واحد با `z` خودِ registry اعتبارسنجی می‌شوند (الگوی `env.test.ts`) و
هیچ‌کدام `secret: true` نیست (توکن CI فقط در جدول `secrets` رمزنگاری‌شده، اینجا فقط **نام** کلید است).
**کلیدهای لغو‌شده نسبت به پیش‌نویس:** `exec.tools.level` (D‑12)، `exec.harness.enabled`،
`exec.allow_host_test_command` و پنج کلید `exec.runner.*`/`exec.runner_timeout_sec`/
`exec.runner_max_output_bytes` — D‑08 بازبینی‌شده: هیچ مسیر اجرایی وجود ندارد، پس تنظیماتش هم معنا
ندارد. شمار کلیدهای `exec.*` در پیاده‌سازی: **۱۶** (تست واحد این شمارش را قفل می‌کند).

---

### ۴.۰ فهرست کامل ابزارهای MCP — **همه ۲۸ ابزار ساخته و فعال می‌مانند** (تصمیم مالک)

| ابزار | اسکوپ | نوشتن | فاز | اولویت شروع |
|---|---|---|---|---|
| `exec_task_start` | ledger:write | ✓ | PE‑2 | ✓ |
| `exec_ledger_status` | ledger:read | ✗ | PE‑2 | ✓ |
| `ledger_list_open` | ledger:read | ✗ | PE‑2 | ✓ |
| `ledger_add_open_item` | ledger:write | ✓ | PE‑2 | ✓ |
| `ledger_resolve_item` | ledger:write | ✓ | PE‑2 | ✓ |
| `ledger_add_evidence` | ledger:write | ✓ | PE‑4 | ✓ |
| `ledger_record_decision` | ledger:write | ✓ | PE‑4 | ✓ |
| `ledger_ask_human` | ledger:write | ✓ | PE‑4 | ✓ |
| `exec_policy_check` | ledger:read | ✗ | PE‑5 | ✓ |
| `exec_submit_exit_report` | ledger:write | ✓ | PE‑3 | ✓ |
| `exec_task_complete` | ledger:write | ✓ | PE‑3 | ✓ |
| `session_start` | ledger:read | ✗ | PE‑10 | ✓ |
| `exec_plan_view` | ledger:read | ✗ | PE‑9 | |
| `task_split` | ledger:write | ✓ | PE‑9 | |
| `task_block` | ledger:write | ✓ | PE‑9 | |
| `exec_link_dep` | ledger:write | ✓ | PE‑9 | |
| `req_add` / `req_link_task` / `req_change` / `req_coverage` | ledger:read+write | ✓ (۳ تای اول) | PE‑9 | |
| `fact_record` / `fact_query` / `fact_verify` / `fact_promote` | ledger:read+write | ✓ (۳ تای اول) | PE‑11 | |
| `scope_check` | ledger:read | ✗ | PE‑8 | |
| `baseline_capture` | ledger:write | ✓ (نتیجه را کد می‌نویسد) | PE‑8 | |
| `journal_start` / `journal_done` / `journal_fail` | ledger:write | ✓ | PE‑10 | |
| `exec_ledger_reconcile` | ledger:read | ✓ (رویداد) | PE‑10 | |
| `review_task` | review | ✓ | PE‑7 | |

**۲۸ ابزار، همه در `tools/list`** (بدون سطح core/full، بدون ابزار مخفی). ۱۲ ابزار ستون آخر فقط
«برچسب اولویت» در `docs/LEDGER_RULES.md` است (همان‌ها که در `session_start` یادآوری می‌شوند) و
هیچ اثری بر دید/دسترسی ندارد. کنترل هزینهٔ context (ضمیمه §۴) با ۴ مکانیزم قطعی:
توضیح هر ابزار ≤ ۲۰۰ کاراکتر (تست واحد روی registry)، سقف `exec.tool_output_max_bytes` +
`truncated: true`، `readOnlyHint/destructiveHint/idempotentHint` درست، و این‌که
وقتی ابزار `session_start` در PE‑10 به MCP ثبت شود، تنها «نقطهٔ شروع» معرفی‌شده در قوانین خواهد بود؛
تا آن زمان، راهنمای PE‑6 از ابزار موجود `exec_ledger_status` برای شروع/ادامه استفاده می‌کند. اگر در
تست رفتاری PE‑6 ابزاری هرگز صدا زده نشد، **حذف نمی‌شود**؛ در گزارش نهایی با دلیل فهرست می‌شود (D‑12).

**هیچ ابزار حذف/ویرایش مستقیمی برای ایجنت وجود ندارد:** نه `*_delete`، نه `*_set_risk`،
نه `criterion_waive`، نه `req_drop`، نه `policy_set`. تنها مسیر انسانی اسکوپ `ledger:decide`
(REST/پنل/`ledger-cli`) است.

---

## ۵. PE‑0 — پایه‌ریزی ماژول (بدون منطق Gate)

**هدف:** داربست کامل، بدون رفتار: ماژول ثبت، مهاجرت، تنظیمات، envelope ابزارها.

**محدودهٔ تغییر:**
1. `packages/core/src/db/migrations/0010_exec.migration.ts` (۱۷ جدول: ۱۶ جدول `exec_*` + `exec_code_seq` برای شمارندهٔ کد + trigger
   `exec_append_only()` روی ۳ جدول + `REVOKE UPDATE, DELETE … FROM forgepm_app`) و
   ثبت در `migrations/index.ts`؛ سپس `node scripts/check-migration-hashes.mjs --update`.
2. `packages/core/src/exec/codes.ts`: `allocateLedgerCode(tx, project, 'T'|'C'|'OI'|'D'|'Q'|'F'|'REQ'|'AJ')`
   — الگو: `UPDATE projects SET next_*` **نه**؛ جدول شمارنده نمی‌سازیم؛ از
   `SELECT max(seq) FOR UPDATE` درون تراکنش + retry روی serialization failure استفاده می‌شود
   (توضیح در §۴ جدول 16 و تست همزمانی ۲۰‌تایی → کدهای یکتای پیوسته).
3. `apps/api/src/modules/exec/module.ts` (`execControlModule`) + ثبت در `app/modules.ts`
   + `validateConfig` (بررسی schema `exec.policy`).
4. `packages/shared/src/schemas-exec.ts` + `error-codes.ts` + `enums.ts`.
5. `scripts/schema-check.ts`: افزودن `'CREATE TABLE exec_tasks'` به `anchors[]` و افزودن بلوک
   §H در `docs/DATA_MODEL.md` (الزام D‑09).
6. `docs/EXECUTION_CONTROL.md` (این سند به‌روز، منبع فازها) + لینک در `README.md` و `docs/EXECUTION_PLAN.md`.

**معیارهای پذیرش PE‑0** (نتیجهٔ اجرای PE‑0 در ۲۰۲۶‑۱۰‑۱۷؛ `local:` = همان‌جا اجرا شد)

- [x] PE‑0.1 اجرای `npm run migrate` روی DB **خالی و واقعی**: سبز (`0010_exec` اعمال شد) و
      اجرای دوم **idempotent** (بدون خطا، بدون مهاجرت جدید). `check-migration-hashes.mjs` سبز
      (۹ مهاجرت در manifest). نکتهٔ محیط: DB از همان راه بومی مخزن گرفته شد —
      `node apps/web/scripts/dev-postgres.mjs` (embedded‑postgres، بدون docker؛ الگوی D‑001).
- [x] PE‑0.2 `npm run schema:check` روی Postgres زنده: **«schema:check OK — 60 contract tables
      verified»** (بلوک §H با ۱۷ جدول و ۱۹ ایندکس + anchor `CREATE TABLE exec_tasks`). برابری
      ستون/نوع/ایندکس «دیتامدل ↔ مهاجرت» هم آفلاین تأیید شد (۱۷/۱۷، ۱۹/۱۹).
- [x] PE‑0.3 آپ‑فوری/تک‌نشینی: `exec_events`، `exec_evidence`، `exec_gate_checks` با
      `exec_append_only()`؛ `exec_action_journal` با `exec_journal_settle_only()` (ثبت فقط یک‌بار،
      ستون‌های ادعا تغییرناپذیر) + `REVOKE`. تست: `exec-ledger-invariants.test.ts`.
      **انحراف ثبت‌شده (D‑039):** پلن سه جدول append‑only می‌گفت؛ journal نمی‌تواند کامل
      append‑only باشد چون `started → done|failed|unknown` ستون وضعیت را تغییر می‌دهد —
      بنابراین DELETE کامل ممنوع و UPDATE فقط «تسویهٔ یک‌باره» است.
- [x] PE‑0.4 هیچ `*_delete` در رجیستری وجود ندارد (تست روی `buildToolRegistry`)؛ اسکوپ‌های
      `ledger:read|ledger:write|ledger:decide` به `API_KEY_SCOPES` اضافه شد (decide فقط انسان).
- [x] PE‑0.5 `allocateLedgerCode` روی `exec_code_seq` با `FOR UPDATE` + retry؛ تست ۲۰ فراخوانی
      همزمان (یکتا و پیوسته) نوشته شد. جدول شمارنده برخلاف توضیح سطر ۲ همین بخش **ساخته
      می‌شود** (طبق جدول §۴ شمارهٔ 16 و سطر ۱ همان بخش)؛ `projects.next_*` وجود ندارد (D‑040).
- [x] PE‑0.6 `execControlModule` ثبت شد، پیش‌فرض خاموش (`modules.exec.enabled=false`)،
      `validateConfig` اسکیماهای `exec.*` را در لحظهٔ فعال‌سازی چک می‌کند؛ `tools/list` بدون
      ابزار exec باقی می‌ماند (تست module-off در همان فایل integration).
- [x] PE‑0.7 `local:` lint سبز · typecheck (همهٔ ورک‌اسپیس‌ها) سبز · `test:unit` سبز
      (۲۲۱ تست، از جمله ۱۰۱ تست exec و ۴ تست گارد ساختاری J.7c) · build سبز · `docs:check` سبز ·
      `npm run test:integration` با `FORGEPM_TEST_NO_REDIS=1`: **۱۸۳/۱۹۰ سبز** — از جمله
      `exec-ledger-invariants.test.ts` **۱۳/۱۳** (همین اجرا ۳ باگ واقعی را بیرون کشید و رفع شد).
      ۴ فایل قرمز (= ۷ تست) تماماً محیطی‌اند و ربطی به exec ندارند: `outbox`، `phase5-worker`
      (به Redis لازم دارند؛ در این سندباکس بالا نمی‌آید — `redis-memory-server` هم باینری نداشت)
      و `phase7-backup`/`phase7-system` (به `pg_dump`/`psql` واقعی). `remote:` در جدول پایین.
- [x] PE‑0.8 `remote: pass` — run **39076763818** روی `2edeeb9`: **هر ۲۲ گام job سبز**،
      از جمله `Verify` (lint+typecheck+unit+integration+سقف coverage+build) ·
      `Migrations on an empty DB` · `Migration hash guard` · `gen:api drift check` ·
      `Panel build (Angular) + Playwright flagship E2E` · `i18n key parity` ·
      `Performance budget` + `P-05 first paint` · `schema:check` (و تستِ ردِ اختلاف عمدی) ·
      `docs:check` · `phase-report` self‑test · `npm audit`. باقراردادِ «حداقل یک بار روی
      CI میزبان سبز شود» ⇒ PE‑0 بسته است. تاریخچهٔ قرمزی (تا سبز شدن، ۵ فرضیه، ۲ تای
      اول اشتباه): `dd13ed3` بیات‌بودن `openapi.json`/`schema.d.ts` · `1f5f541`
      مسیرِ non‑portable در `e2e-reset.mjs` (B‑010، D‑043) · `70cc11f` کنتراست بِج/چیپ
      (D‑044) · `45a491a` بازگرداندنِ فرضِ `dataTransfer` (D‑045) · `2edeeb9` ریشهٔ
      واقعی + رفع هر‌دو‌سو (**D‑046**، B‑011، issue #11).
- [x] PE‑0.9 (افزوده‌شده حین بستن PE‑0.8) — درگ بورد موتور‑مستقل شد و مسابقهٔ اسکرولِ
      خودِ spec رفع شد: `ui/board-drag.ts` (session با آستانهٔ ۴px، توکن یک‌بارمصرف برای
      «هر ژست حداکثر یک اعمال»، HTML5 DnD به‌عنوان مسیر مرورگر، touch بدون تغییر) +
      reducer خالص در `ui/logic.ts` + ۱۴ تست (`ui/board-drag.spec.ts`: ۶ ریدیوسر + ۸ DOM) +
      `targetPosition` و `expect(card).toContainText(key)` در `chain.spec.ts` — بدون
      هیچ تضعیف/حذف ادعایی. گیتِ جدید: `npx ng test --configuration=coverage` به گام پنلِ
      CI اضافه شد تا تست‌های یونیتِ پنل و سقف ۸۰٪ کاوراژ در میزبان هم الزامی باشند.
      `local:` chain.spec.ts ۱/۱ سبز روی chromium واقعی (هر دو مسیر درگ سنجیده شد).
      `Install` · `Migration hash guard` · `Migrations on an empty DB` ·
      `npm run verify` (شامل integration و سقف coverage) · `gen:api drift check` همه **سبز**
      شدند. تنها گام قرمز `Panel build + Playwright flagship E2E` بود که با پروبِ بدون‌تغییر
      روی `main` (PR #10) ثابت شد **از قبل روی main قرمز** بوده: `e2e-reset.mjs` مسیر
      مطلقِ ماشینِ نویسنده را hardcoded داشت (B‑010، D‑043) — در همین شاخه رفع شد، به‌همراه
      `openapi.json`/`schema.d.ts` بیاتِ main. تا سبز شدن **کل** job، PE‑0 بسته محسوب
      نمی‌شود (اصل ۱۲ پلن: fail closed، حتی علیه خودمان).

**راهنمای تکرار محلی (بدون docker):**
`node apps/web/scripts/dev-postgres.mjs` (پورت ۵۴۳۳) یا `@embedded-postgres/linux-x64` روی پورت دلخواه،
سپس `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/forgepm_test FORGEPM_TEST_NO_REDIS=1 npx vitest run --project integration tests/integration/exec-ledger-invariants.test.ts`.
**E2E پنل هم همین‌جا قابل اجراست** (این سندباکس chromium دارد؛ باورِ «قابل اجرا نیست» سه
رفت‌وبرگشتِ CI هزینه داد): دستور کامل در `docs/FRONTEND_EXECUTION_PLAN.md` ذیل «Local E2E
recipe» — `@sparticuz/chromium` با `LD_LIBRARY_PATH=/tmp/al2023/lib` (از `bin/al2023.tar.br`)،
API روی :3101، `ng serve --proxy-config proxy.e2e.json`، و هر spec یک‌جا ( آرگومان
`--single-process`.

---

## ۶. PE‑1 (بخش A) — Ledger: تسک، معیار، آیتم باز، رویداد، قوانین بستن

**کد قطعی:** `exec-open-items.ts` (ماشین وضعیت)، `exec-codes.ts`، قوانین `CHECK` DB.

**قوانین:** آیتم `blocks_completion=true` فقط با `resolved|not_applicable` و
`resolution_note ≥ 20 کاراکتر` بسته می‌شود؛ `accepted|deferred|wont_fix` فقط با
`resolved_by='human'` (مسیر انسانی = `approval_requests` یا CLI). تغییر وضعیت → `exec_events`.

**معیارهای پذیرش بخش A**

- [x] A.1 مکالمه پاک و نشست تازه → `exec_ledger_status` تمام وضعیت (تسک‌ها، آیتم‌ها،
      سؤالات، تصمیم‌ها، معیارهای بدون evidence) را از DB برمی‌گرداند؛ تست: call بعد از `reset()` harness.
      **بسته شد در PE‑2 (D‑047→D‑049):** `exec_ledger_status` روی همین projection سوار است و
      تستش با ردیف‌های واقعی DB و با `reset()` پروژه (پروژهٔ تازه = `{empty:true}`) سبز است.
      تصویر وضعیت در `exec/ledger-view.ts` خالص و تست‌شده است
      (۱۰ حالت: ready/blockers/missing‑evidence/questions/decisions/coverage + تکرارپذیری
      بایت‌به‌بایت با ورودی به‌هم‌ریخته) و یک تست integration آن را از **ردیف‌های واقعی DB**
      می‌سازد. `loadLedgerStatus` (core) همان ردیف‌های واقعی را می‌خواند و نشستِ تازه در
      تست B.5 با یک پروژهٔ seed‌شدهٔ مستقل سنجیده شده است — یعنی «مکالمه پاک» نه با
      حافظهٔ پروسه، که با نبودِ ردیف در DB معنا می‌شود.
- [x] A.2 هیچ مسیر حذفی نیست: لیست ابزارها، لیست routeها، و grep روی SQL مولد (تست واحد روی registry).
      `tests/unit/exec-no-delete.test.ts` (۶ حالت: سه الگوی حذف/write‑through/route + کنترل مثبتِ
      خودِ الگوها + «هر ژست دقیقاً یک `appendEvent`» و «فقط INSERT/UPDATE روی exec_open_items»)،
      و تست registry در `exec-ledger-invariants` («no tool … is a ledger delete path»).
- [x] A.3 `ledger_resolve_item(status:'deferred'|'accepted'|'wont_fix')` با actor=agent روی آیتم
      مسدودکننده → `LEDGER_TRANSITION_NOT_ALLOWED` (تست خودکار + تست actor=human سبز).
      قاعده در سه لایه سبز است: قوانین خالص، `resolveOpenItem` روی Postgres واقعی (رد **قبل از**
      نوشتن: نه ردیف عوض می‌شود نه رویداد)، و CHECK 0010 برای نویسنده‌ای که سرویس را دور می‌زند.
      شکلِ ابزار در PE‑2 B.x دوباره سنجیده می‌شود.
- [x] A.4 هر تغییر وضعیت دقیقاً یک ردیف `exec_events` با `payload.before/after` (تست شمارش).
      شمارش قبل/بعد روی DB واقعی برای create و resolve؛ هر دو سمت payload در تست
      «a resolution appends one event holding before and after».
- [x] A.5 ورودی نامعتبر (عنوان ۳ کاراکتر، enum غلط، UUID نامعتبر، فیلد اضافه) → خطای ساختارمند
      با `needed_action`، نه کرش، نه پذیرش (تست پارامتریک ۱۲ حالت).
      ۱۶ حالت روی `parseOpenItemCreate` + ۸ حالت روی `parseOpenItemResolve` (از `null`، آرایه،
      رشته، `__proto__` تا فیلد اضافه) + ۲ حالتی که مرز «شکل ≠ قانون» را قفل می‌کنند.
- [x] A.6 وضعیت تسک و `closed_at` با هم اتمیک؛ `done` بدون `closed_at` غیرقابل‌درج (CHECK).
      CHECK در migration 0010 و تست INSERT خامِ رد‌شده + پذیرش همان ردیف با `closed_at`.
- [x] A.7 `blocks_completion=true` و `status='resolved'` با نوت خالی/کوتاه → رد (تست).
      ردِ DB برای INSERT خام با نوت ۵ کاراکتری، و ردِ سرویس برای نوت ۱۹ کاراکتری (کف ۲۰).
- [x] A.8 آیتم بدون `task_id` مجاز نیست؛ FK ویرال → `NOT_FOUND` (نه orphan).
      `task_ref` ناشناخته → `AppError('NOT_FOUND')` و شمارش ردیف‌ها صفر می‌ماند (تست integration).
- [ ] A.9 ترجمه fa/en برچسب وضعیت‌ها در پنل با `i18n-check.mjs` سبز (parity).
      **موکول به PE‑12 (D‑047):** برچسب وضعیت ledger هنوز در پنل رندر نمی‌شود (صفحه‌های exec
      فاز PE‑12 است)؛ سبز کردن این تیک با کلیدهای بی‌مصرف گیت را توخالی می‌کرد.

**DoD این فاز (تکلیف PE‑0، D‑041):** سه بایت از `0010` که با برچسب
`-- PE-1 …` به تعویق افتاده بودند، **در PE‑1 هم نوشته نمی‌شوند** — چون با ابزار
درستِ همان کار تزاحم دارند: dedup کلید (C.4) باید «رد نکن، بگو همان آیتم قبلی
است» باشد، پس index یکتا ابزار اشتباه است؛ و skip تدریجی evidence (C.3) با
`NOT NULL` در تضاد است. تصمیم: در PE‑1 فقط dedup سمت سرویس با `CONFLICT` نوشته شد
(D‑047) و index یکتا عمداً افزوده نشد؛ migration 0011 برای این فاز وجود ندارد.
---

## ۷. PE‑2 (بخش B، هسته) — ابزارهای اجباری Ledger

**ابزارها:** `exec_task_start`, `ledger_list_open`, `ledger_status`,
`ledger_add_open_item`, `ledger_resolve_item`.

- `exec_task_start(title, description, acceptance_criteria[], req_ids[], allowed_paths[])` →
  ساخت `work_item` از نوع `task` + `exec_tasks` + `exec_criteria` (یک تراکنش، audit، outbox).
  `allowed_paths` **الزامی** (≥ ۱ گلاب) چون PE‑5 می‌آید؛ تا PE‑5 فقط ذخیره و در
  `plan_view` نمایش داده می‌شود.
- **تست‌پذیری معیار (کد، نه سلیقه):** `assertCheckable(text)` = طول ≥ ۲۵ + دارای فعل/شرط از
  واژه‌نامهٔ سبز (`must|shall|should|returns|passes|fails|rejects|displays|≤|≥|==|…` + معادل
  فارسی) + **نداشتن** واژه‌نامهٔ مبهم (`well|properly|robust|secure|good|fast|clean|به‌درستی|امن|سریع`)
  + ارجاع‌پذیری (حداقل یک `ref` از `test:NAME`, `file:path`, `commit:hex7-40`, `cmd:` یا `ui:`).
  شکست → `CRITERION_NOT_CHECKABLE` با راهنما و ۲ مثال خوب.

**معیارهای پذیرش PE‑2**

- [x] B.1 هر ابزار schema دقیق + `strict`؛ تست پارامتریک «فیلد ناقص/اضافه» برای ۵ ابزار (۲۰+ حالت).
      `task-start.test.ts` ۱۸ حالت: ۵ تست shape (یکی ۱۲ زیرحالتِ «فیلد ناقص/غیرمنتظم» را می‌زند،
      یکی ۴ زیرحالتِ کلید ناشناخته) و ۱۳ تست قانون معیار. `mcp-json-schema.test.ts` ۱۱ حالت:
      تبلیغ `tools/list` باید همان چیزی باشد که handler اجرا می‌کند — `additionalProperties:false`
      فقط برای `strictObject`، و صفرِ «دروغ» در types (D‑049 بند ۱). برای دو ابزار open‑item،
      ۱۶+۸ حالت PE‑1 و ۲ حالت ردِ فیلد اضافه در `exec-tools.test.ts` سبز است.
- [x] B.2 `exec_task_start` با معیار مبهم (`"the feature works well"`, `"امن باشد"`) رد؛
      با معیار قابل‌بررسی پذیرفته (جدول ۱۰ مثال مثبت/منفی در تست واحد، از جمله مثال فارسی).
      جدول ۱۰ ردیف در `packages/core/src/exec/task-start.test.ts` (۵ پذیرفتنی/۵ رد، شامل
      `کد باید تمیز باشد و خوب کار کند`)؛ قانون در `assessCheckable` مشترک است، نه این‌جا بازنویسی شده.
- [x] B.3 `ledger_add_open_item(type:'commitment'|'incomplete_requirement', blocks_completion:false)`
      بدون `why_not_blocking ≥ 40` کاراکتر → رد (تست). کف ۴۰ در `openItemInputSchema` و قانون
      `validateNewOpenItem` در سرویس؛ تست‌های shape و law جدا (۱۶ حالت PE‑1 + مسیر ابزار).
- [x] B.4 خروجی `task_start` شامل `task_id`, `code`, `criterion_ids` و `allowed_paths` است و
      `work_item_id` معتبر ساخته شده (تست integration). `tests/integration/exec-tools.test.ts`:
      کار‌آیتم + ردیف `exec_tasks` + معیارها + یک `exec_events` و یک `audit_events` در **یک** تراکنش.
- [x] B.5 `ledger_status` با ۰ تسک، خروجی `{empty:true}` با هدایت به `exec_task_start` (تست).
      پروژهٔ تازه‌ای با seed مستقل؛ پاسخ `{empty:true, tasks:[], needed_action:'exec_task_start…'}`.
- [x] B.6 هر فراخوانی در `mcp_tool_calls` ثبت می‌شود (ورودی ماسک‌شده) — تست با dispatch واقعی.
      یک `callTool` واقعی با کلید ناشناخته: رد هم ثبت می‌شود و `api_key` در `input_summary`
      مقدار `[MASKED]` دارد (رشتهٔ رمز در ستون پیدا نمی‌شود).
- [x] B.7 rate limit و scope check بدون تغییر رفتار: کلید `read`-only نمی‌تواند بنویسد (`FORBIDDEN_SCOPE`).
      همان تست: نوشتن با scopeRead رد می‌شود و `exec_open_items` تکان نمی‌خورد، در حالی که
      `exec_ledger_status` با همان کلید می‌پاسخ.
- [x] B.8 idempotency: تکرار `exec_task_start` با `idempotency_key` یکسان = یک تسک (تست).
      `beginIdempotency`/`storeIdempotencyResult` در همان تراکنش و `abandonIdempotency` روی خطا؛
      پاسخ دوم `replayed:true` است و شمارش `exec_tasks` ثابت می‌ماند.
---

## ۸. PE‑3 (بخش B, C + PE‑4 ادامه) — Exit Report و **Finalization Gate**

### ۸.۱ `exec_submit_exit_report`

`exitReportSchema = z.strictObject({ task_id, summary, changed_files, completed_items,
incomplete, assumptions, decisions_made, risks_found, tests_executed[], tests_not_run[],
out_of_scope_findings, criteria_status[], req_ids_covered, scope_deviations, facts_recorded,
none_confirmed: z.strictObject({ incomplete, assumptions, decisions_made, risks_found,
tests_not_run, out_of_scope_findings, req_ids_covered, scope_deviations }).optional() })`

- **قانون «هیچ» صریح:** هشت فیلد بالا یا آرایهٔ ناتهی دارند یا `none_confirmed.<field>=true`
  (دو حالت دیگر → `UNPROCESSABLE`). **حذف فیلد = خطا** (strict). `partial` و `default` ممنوع.
- `tests_executed[].evidence_id` باید به ردیف موجود در `exec_evidence` اشاره کند؛ در غیر این صورت `EVIDENCE_INVALID`.
- `changed_files` بعداً با diff واقعی (PE‑5) تطبیق داده می‌شود؛ اختلاف = `SCOPE_VIOLATION` آیتم.

### ۸.۲ `exec_task_complete` = دروازهٔ واحد (۱۳ قاعده)

```ts
// packages/core/src/exec/gate.ts
export async function runGate(tx: Tx, taskId: string, opts: { reportId, actorType }): Promise<GateResult>
// GateResult = { ok: true, finalReport } | { ok: false, blocked_by: BlockedRef[] }
````

هر قاعده یک تابع خالص جدا (`rule01…rule13`) با `evalRule(ctx)` → `BlockedRef[]`.
**ترتیب و شمارهٔ قاعده ثابت است و در مستندات و تست‌ها قفل می‌شود** (`gate.rules.test.ts` یک
snapshot از شماره‌ها می‌گیرد تا افزودن/جابه‌جایی تصادفی ممکن نباشد).

| قاعده | شرط                                                                | منبع | پیاده‌سازی                                |
| ----- | ------------------------------------------------------------------ | ---- | ----------------------------------------- |
| 1     | گزارش کامل و معتبر                                                 | A/C  | validate + ارجاع `report_id`              |
| 2     | صفر آیتم `blocks_completion` در `open/blocked/awaiting_human`      | A    | `exec_open_items`                         |
| 3     | هر معیار ≥ ۱ evidence معتبر یا `waived` با approval                | A/B  | `exec_criteria/evidence`                  |
| 4     | صفر decision `pending/rejected` با تغییر اعمال‌شده                 | F    | join `approval_requests` + journal `done` |
| 5     | صفر سؤال `blocking` بی‌پاسخ                                        | B    | `exec_questions`                          |
| 6     | صفر تست `fail`؛ `not_run` فقط با دلیل + آیتم متناظر                | C    | `tests_*` + open_item مطابقت              |
| 7     | بازبینی نسخهٔ فعلی انجام‌شده و آیتم‌هایش بسته                      | E    | `exec_reviews.tree_hash = worktree_hash`  |
| 8     | پوشش ۱۰۰٪ REQهای وصل‌شده (معیار verified + evidence)               | G    | `exec_criteria.req_id`                    |
| 9     | فرزندان `done` (یا لغو با تأیید) + پیش‌نیازها `done`               | H    | `parent_id`, `exec_task_deps`             |
| 10    | صفر فکت `stale/rejected` که تصمیم فعال به آن وابسته است            | I    | `exec_fact_decisions`                     |
| 11    | هیچ فایل خارج از `allowed_paths` بدون تأیید                        | J    | `scope.ts` + `tree_hash`                  |
| 12    | نتیجهٔ CI با start/current SHA دقیق: صفر تست baseline شکسته/ناپدید/تضعیف | J    | `baseline.ts` + per-test CI log capture   |
| 13    | صفر ردیف journal در `started/unknown`                              | K    | `journal.ts`                              |

خروجی رد: `{ ok:false, blocked_by:[{ rule, ref, title, needed, tool_to_call }] }` و وضعیت
تسک `awaiting_review` (یا `in_progress` اگر فقط قاعدهٔ ۲/۳ شکست خورده باشد — تابع
`deriveStatus` خالص و تست‌شده). پیش از پذیرش/رد، **مهر Gate** در `exec_gate_checks` نوشته می‌شود (`ok`, `blocked_by`,
`gate_version`, `tree_hash`, `run_source`)؛ `done` تنها وقتی معتبر است که جدیدترین مهر با
`tree_hash` فعلی برابر و `ok=true` باشد (تقویت I‑1؛ حتی اگر کسی با SQL مستقیم بنویسد).
در قبول: `status='done'`, `closed_at=now()`, آیتم‌های
`open` خودکار `resolved/resolved_by=human` **نمی‌شوند** (فقط بسته‌شدن مجاز رد می‌شود)، و
`finalReport` از Ledger تولید می‌شود: `buildFinalReport(tx, taskId)` = «انجام‌شده /
پذیرفته‌شده / معوق / تصمیم‌ها / نیازمند بررسی انسان / فرض‌ها» — هر بخش با شمارش و کدها.

### ۸.۳ اتصال به WorkItem (I‑1)

- `apps/api/src/modules/exec/module.ts` هنگام enable، `completionGuard` را در یک
  registry سبک (`packages/core/src/modules/guards.ts`، ۳۰ خط) ثبت می‌کند؛
  `work-items/service.ts` پیش از transition به حالت `category='completed'` اگر
  `exec_task_id` ست شده باشد، `guard.assert(...)` را صدا می‌زند → `GATE_FAILED`/`FORBIDDEN`.
  (هسته import ماژول نمی‌کند؛ فقط interface.)
- تست **نفوذ**: همان تسک را از `work_item_transition` (MCP و REST) و از `PATCH` پنل ببند → همه رد.

**معیارهای پذیرش PE‑3/4**

- [x] C.1 یک آیتم مسدودکننده باز ⇒ همیشه `ok:false` (تست، ۳ ورودی متفاوت).
- [x] C.2 معیار بدون evidence ⇒ تسک بسته نمی‌شود؛ با evidence سبز می‌شود.
- [x] C.3 حذف `incomplete` از Exit Report → `UNPROCESSABLE`؛ `incomplete:[]` بدون
      `none_confirmed` → `UNPROCESSABLE`؛ با `none_confirmed.incomplete=true` → سبز.
- [x] C.4 هر آیتم `incomplete`/`assumption`/`risks_found`/`tests_not_run`/`out_of_scope_findings`
      **توسط کد** در `exec_open_items` با `source='exit_report'` ظاهر می‌شود (تست شمارش + dedup با ref).
- [x] C.5 هیچ مسیر دیگری `done` نمی‌کند (تست نفوذ: `work_item_transition`, REST, SQL مستقیم، CLI).
- [x] C.6 `finalReport` دقیقاً با محتوای Ledger برابر است: تست با مقایسهٔ count/کدها (نه متن آزاد).
- [x] C.7 قاعدهٔ ۴: decision `approval` با journal `done` ولی بدون approved → رد؛ بعد از approve → سبز.
- [x] C.8 قاعدهٔ ۶: تست `fail` و `not_run` بدون آیتم متناظر → رد.
- [x] C.9 قاعدهٔ ۱۳: journal `started` → رد؛ پس از `journal_done` → سبز.
- [x] C.10 خروجی `blocked_by` برای هر ۱۳ قاعده با fixture جدا تست می‌شود (۱۳ تست unit).
- [x] C.9b مهر Gate: درج دستی `status='done'` بدون مهر معتبر ⇒ `exec_ledger_status` و
      `exec_ledger_reconcile` آن را به‌عنوان `drift: gate stamp missing` گزارش می‌کنند (تست).
- [x] C.11 `gate.ts` ≤ ۴۰۰ خط و هر قاعده ≤ ۶۰ خط (تست با خواندن فایل، مثل `tests/unit/eslint-boundaries.test.ts`).

> **وضعیت PE‑3 (۲۰۲۶‑۱۰‑۱۸):** پیاده‌سازی و تست‌ها نوشته شده‌اند، اما **گیت محلی و CI هنوز اجرا
> نشده‌اند** — این سشن اجرای تست و CI را تا آزاد شدن کاربر قفل کرده است؛ حکم نهایی در
> `docs/PROGRESS.md` آمده است. سه نکتهٔ دقیق: (۱) C.9b در این مرحله `exec_ledger_status` و خودِ
> gate را گزارش می‌کند؛ `exec_ledger_reconcile` هنوز ابزاری ندارد و در PE‑4 می‌آید. (۲) نیمهٔ
> سرتاسریِ C.7 و C.9 (ابزارهای `ledger_ask_human`/تأیید و `journal_done`) در PE‑4 است؛ خودِ قاعده‌ها
> اینجا تست واحد دارند. (۳) در آن مقطع، قواعد ۱۱ و ۱۲ هنوز به ادعای عامل متکی بودند؛ PE‑8 این
> پیاده‌سازی را با اندازه‌گیری Git/manifest و CI با SHA دقیق جایگزین کرد (ضمیمهٔ J).
>
> **سه تصمیمی که در همین فاز گرفته شد:** (۱) `scope_deviations` هم مثل بقیهٔ یافته‌ها در
> `exec_open_items` با `type='out_of_scope'` ثبت می‌شود (D‑054) — `changed_files` چیزی است که قاعدهٔ ۱۱
> می‌سنجد و `scope_deviations` چیزی است که عامل خودش اعلام می‌کند؛ گزارش پایانی باید نامش را ببرد.
> (۲) تسک بسته‌شده (`done` با مهر معتبر) دوباره بسته نمی‌شود و `exec_task_complete` آن را با
> `LEDGER_STATE_INVALID` رد می‌کند؛ ولی `done` دستی بدون مهر «drift» است و گیت آن را به وضعیت
> درست برمی‌گرداند (D‑055). (۳) نام فیلد در پاسخ `final_report` است (snake_case، مثل بقیهٔ پاسخ‌ها)؛
> `finalReport` در طرح، نام داخلیِ همان گزارش است.
>
> **دو چیزی که طرح ۰۰۱۰ تحمیل کرد و رعایت شد:** (۱) `exec_gate_checks.report_id` یک کلید خارجی
> `NOT NULL` است، پس مهر همیشه به یک گزارش تعلق دارد: تسکی که هنوز گزارش ندارد، مهر نمی‌گیرد و فقط
> یک `exec_events` می‌ماند (قاعدهٔ ۱ رد می‌کند و پاسخ همان است). (۲) `exec_tasks` وقتی
> `status ∈ {blocked, awaiting_review}` می‌شود باید `blocked_on_kind` و `unblock_condition` (≥ ۱۰
> کاراکتر) و برای `blocked` هم `blocked_reason` داشته باشد؛ پس دروازهٔ نهایی وقتی رد می‌کند،
> شرطِ بازشدن را هم می‌نویسد.

---

## ۹. PE‑4 (بخش B ادامه) — Evidence، Decision، ask_human، policy_check، CLI و REST

### ۹.۱ `ledger_add_evidence` (ادعای بی‌مدرک ممنوع)

| kind             | قواعد `ref`                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_output`    | `payload_inline` یا `ref = "ci:<run_id>:<job>"`؛ نرمال‌سازی ANSI؛ ≥ ۱ خط نتیجه از `exec.test_result_parser`؛ `pass/fail/skip` استخراج و در `meta` ذخیره؛ در دسترس نبودن ref → `EVIDENCE_UNAVAILABLE` |
| `diff` / `file`  | `ref = "path:…"` یا `"commit:<7-40 hex>:path"`؛ `path` داخل `exec.allowed_repo_roots` (prefix-safe، الگو: `github/config.ts`)؛ hash فایل = `sha256(content)`؛ فایل ناموجود → `EVIDENCE_INVALID`      |
| `command_output` | `ref="cmd:<journal id>"` یا inline با `summary ≥ 40` + خروجی ≥ ۲۰۰ کاراکتر                                                                                                                           |
| `manual_check`   | `actor_type='human'` الزامی (ایجنت نمی‌تواند manual_check ثبت کند)                                                                                                                                   |

سایز inline ≤ `exec.evidence_max_bytes`؛ بیش از حد → `UNPROCESSABLE` با راهنمای «از journal/ref استفاده کن».
مخزن inline: `exec_evidence.meta.inline_sha256` + متن در `meta.inline` (mask secrets قبل از ذخیره،
با helper موجود `secrets.ts`) — **هیچ secret در ledger ذخیره نمی‌شود** (تست با fixture کلید `fpm_` و `aws`).

### ۹.۲ `ledger_record_decision`

`options[] ≥ 2`, `selected ∈ options`, `rationale ≥ 40`, `reversible` الزامی،
`touches ⊂ {none, public_api, db_schema, auth, secret, deps_add, deps_upgrade, delete_data, delete_file,
config_deploy, ci, migration, destructive_command, rename_bulk, scope_expansion, drop_requirement,
waive_requirement, baseline_change, fact_promote_from_guess, cancel_subtask}`.
`risk_level` محاسبه و درج می‌شود؛ اگر `approval` → `approval_state='pending'` + ساخت
`approval_requests(action='exec.decision', risk='sensitive')` + خروجی صریح:
`"do_not_apply_until_human_approval": true`. `review_trigger` → `exec_fact_decisions`.

### ۹.۳ `ledger_ask_human`

`options ≥ 2`, `recommendation` (باید یکی از `options` باشد), `why_it_matters ≥ 40`,
`impact_per_option[]` هم‌طول `options`. `blocking=true` → `approval_requests(action='exec.question')`

- تسک `awaiting_review` با `blocked_on_kind='question'`. سکوت ≠ تأیید: هیچ timeout تأییدی وجود ندارد
  (تست: پاسخ‌ندادن پس از ۲۴ ساعت، Gate همچنان رد).

### ۹.۴ `exec_policy_check`

ورودی `(action_kind, target, details, reversible)` → خروجی
`{ level:'auto'|'review'|'approval'|'deny', matched_rules:[…], required: {approval_id|null, tool_to_call}, explanation }`.
بدون `journal_start` برای `approval/deny` ایجنت هشدار عملی می‌گیرد.

### ۹.۵ مسیرهای انسانی (REST + CLI + پنل)

`/api/v1/exec/approvals/:id/decide` (POST, `exec:decide` + human), `/api/v1/exec/items/:code/resolve`,
`/api/v1/exec/questions/:code/answer`, `/api/v1/exec/criteria/:code/waive`,
`/api/v1/exec/requirements/:code/drop`, `/api/v1/exec/scope/:taskId/expand`,
`/api/v1/exec/facts/:code/promote`, `/api/v1/exec/gate/:taskId` (dry-run), `/api/v1/exec/status`.
`scripts/ledger-cli.ts`: `list | show <code> | resolve <OI-code> --status --note | answer <Q> "…" |
approve <D> | reject <D> --reason | req drop <REQ> --note | approve-scope <T> | fact promote <F> | policy print|set`
— با `FORGEPM_URL` + `FORGEPM_API_KEY`، بدون اتصال مستقیم DB، خروجی ≤ ۴۰ سطر/صفحه با `--json`.

**معیارهای پذیرش PE‑4**

- [x] B.9 `record_decision(touches:['public_api'])` **همیشه** `approval`؛ حتی اگر ایجنت
      `reversible:true` و متن «بدون ریسک» بفرستد (تست؛ ورودی `risk_level` هم reject می‌شود — I‑4).
      (پیاده‌سازی شد: `ledger_record_decision` + `decision-service.ts`؛ تست‌ها نوشته شده‌اند ولی در این
      سشن اجرا نشده‌اند.)
- [x] B.10 `add_evidence(ref:'src/does-not-exist.ts')` → `EVIDENCE_INVALID`؛ `test_output` ۳ خطی
      بدون خط نتیجه → `EVIDENCE_INVALID`؛ با خروجی واقعی → `verified_at` + معیار `verified`.
      (پیاده‌سازی شد: `ledger_add_evidence` + `evidence-service.ts`؛ تست‌ها نوشته شده‌اند ولی در این
      سشن اجرا نشده‌اند — D‑057 دربارهٔ کدِ فایلِ ناموجود.)
- [x] B.11 `ask_human` بدون `recommendation` یا بدون `impact_per_option` هم‌طول → رد.
      (پیاده‌سازی شد: `ledger_ask_human` + `question-service.ts`؛ تست‌ها نوشته شده‌اند ولی در این سشن
      اجرا نشده‌اند.)
- [x] B.12 `policy_check('run_destructive_command',{cmd:'git push --force'})` → `approval`؛
      `('write_secret',…)` → `deny`.
      (پیاده‌سازی شد: `exec_policy_check` + `policy-tools.ts`؛ تست واحد نوشته شده ولی در این سشن اجرا نشده.)
- [x] B.13 `ledger_status` در نشست تازه بدون هیچ context دیگری کامل است (تست با harness reset + tools/call).
      (پیاده‌سازی شد: پروژهٔ جدا با ردیف‌های نشستِ دیگر (تسک + معیار + آیتم باز + الزام) مستقیماً در
      DB نوشته شد و بعد **اولین** فراخوانیِ این نشست، `exec_ledger_status` کل تصویر را داد: معیارِ
      بدون مدرک، blocker، `requirements_uncovered` و `ready_to_submit=false`. تست در
      `tests/integration/exec-tools.test.ts` نوشته شده ولی در این سشن اجرا نشده است.)
- [x] B.14 `ledger-cli resolve OI-004 --status deferred --note "…"` (کاربر human) → موفق، با audit.
      (پیاده‌سازی شد: `scripts/ledger-cli.ts` + مسیرهای `/api/v1/exec/*`؛ تست نوشته شده ولی در این سشن
      اجرا نشده است.)
- [x] B.15 همان دستور با کلید API یک **ایجنت** → `FORBIDDEN_SCOPE` (CLI از مسیر انسانی استفاده نمی‌کند).
      (کامل شد: مسیرهای `/api/v1/exec/*` با scope `ledger:decide` (انسانی‌تنها) محافظت می‌شوند و کلیدِ
      بدون این scope خطای `FORBIDDEN_SCOPE` می‌گیرد؛ CLI هم ساخته شد و از همین مسیرهای REST استفاده
      می‌کند — هرگز مستقیم به DB وصل نمی‌شود. تست اکنون یک کلیدِ **واقعاً ایجنت** می‌سازد
      (`agents` row + `api_keys.agent_id`، بدون `owner_user_id`) و همان دستور `FORBIDDEN_SCOPE`
      می‌گیرد — چون `ledger:decide` هرگز به کلیدِ ایجنت داده نمی‌شود (D‑040).)
- [x] B.16 ثبت secret در `summary/ref/evidence` باعث `VALIDATION_ERROR`/mask می‌شود (تست ۶ الگو).
      (پیاده‌سازی شد: `maskSecrets` روی هر سه ستون پیش از نوشتن در `exec_evidence`؛ تست ۶ الگو
      (`fpm_`، کلید PEM، `AKIA`، `ghp_`، `sk-`، `password: "…"`) را در `summary`/`ref`/`payload`
      می‌نویسد و می‌آزماید که هیچ‌کدام عیناً در لجر ذخیره نشده‌اند. تست نوشته شده ولی در این سشن
      اجرا نشده است.)
- [x] B.17 OpenAPI و `schema.d.ts` بازتولید و commit شده‌اند: `npm run gen:api:check` سبز.
      (بازتولید شد: ۹۲ مسیر (۸۶ → ۹۲ با افزودن مسیرهای انسانیِ §۹.۵) و `schema.d.ts` هم‌زمان؛
      `npm run gen:api:check` سبز است.)
- [x] B.18 پنل Approvals، `exec.decision|question|scope|waive|drop|promote` را با ترجمهٔ fa/en
      و ارجاع `task code` نمایش می‌دهد (تست e2e flagship: approve یک decision از پنل).
      (پیاده‌سازی شد: `GET /api/v1/exec/approvals` ردیف‌های `exec.*` را با **کدِ لجر** و **کدِ تسک**
      برمی‌گرداند؛ صفحهٔ Approvals پنل آن‌ها را با برچسبِ ترجمه‌شده (fa/en) و دکمه‌های تأیید/رد
      نشان می‌دهد (همان `POST /api/v1/approvals/:id/decide` که اثرِ لجری را در همان تراکنش اعمال
      می‌کند). شش گونه: `exec.decision`، `exec.question`، `exec.scope_expansion`،
      `exec.waive_criterion`، `exec.drop_requirement`، `exec.fact_promotion` (D‑059). تست e2e
      flagship هنوز نوشته نشده.)

---

## ۱۰. PE‑5 (بخش F) — سیاست ریسک + `exec_events`

`policy.ts`: `POLICY_DEFAULT` (دقیقاً جدول پرامپت + ۵ ردیف ضمیمه)، `classify(touches, reversible, ctx)`:

```
level = max(levels(matchedRules)); unknown_category ⇒ 'review'
reversible === false ⇒ level = max(level, 'review')؛ اگر هر دستهٔ حساس ⇒ 'approval'
deny در هر قاعده ⇒ deny (غالب بر همه)
```

`exec.policy` در settings (zod) با override در سطح سازمان/پروژه (`getEffective`).
`npm run policy:print` / `policy:set --from file.json` (admin) → «تغییر بدون تغییر کد» (D‑05).

**معیارهای پذیرش PE‑5**

- [x] F.1 `exec.policy` همهٔ ردیف‌های سیاست را دارد (golden snapshot روی `EXEC_POLICY_DEFAULT.rules`:
      ۲۷ ردیف، شامل دسته‌ها، سطح و توضیح هرکدام؛ `validatePolicyShape` هم required/hard-deny/duplicate را می‌بندد).
- [x] F.2 `policy:set --from file.json` تغییر `deps_add: review→approval` را در سازمان می‌نویسد و
      فراخوانی بعدی `exec_policy_check` بلافاصله `approval` می‌بیند؛ `getEffective` مستقیم از DB می‌خواند
      و در حال حاضر cache پنج‌ثانیه‌ای ندارد، پس invalidation لازم نیست. آزمون integration نوشته شده است.
- [x] F.3 `touches=['db_schema']` → `approval` + `approval_state='pending'`؛ integration روی ابزار و
      Gate rule 4 خالصاً رد را می‌سنجد؛ پس از `approved` rule 4 دیگر مانع نیست.
- [x] F.4 فیلد ورودی `risk_level` همچنان رد می‌شود (B.9)؛ تست F.3 ادعای «بدون ریسک» در rationale را
      می‌فرستد و نشان می‌دهد سطح محاسبه‌شده پایین نمی‌آید.
- [x] F.5 دستهٔ ناشناخته → `review`؛ `touches=['none']` با `reversible=false` هم حداقل `review` می‌شود.
- [x] F.6 ترکیب چند دسته → بالاترین سطح؛ `['public_api','deps_add']` → `approval`.
- [x] F.7 `write_secret`/`delete_root_folder`/`rm -rf /` → `deny` و `exec_events.action='policy.denied'` با
      `payload.outcome='blocked'`; سه مسیر در integration سنجیده می‌شوند.
- [x] F.8 `approval_state='rejected'` + journal `status='done'` با `target` برابر کد تصمیم → قاعدهٔ ۴
      رد می‌کند؛ journal نامرتبط false-positive نمی‌دهد.
- [x] F.9 `scripts/claude-hook.mjs`: `Bash(git push*)` و `Edit` روی `package.json` → `ask`؛
      `Bash(rm -rf*)` → `deny`. تست، stdout JSON واقعی را با ورودی ساختگی می‌خواند و Claude Code نمی‌خواهد.

**وضعیت PE‑5 در این سشن:** پیاده‌سازی و تست‌ها نوشته شده‌اند؛ هیچ تست/CI اجرا نشده است (دستور کاربر).
فایل hook هنوز پیکربندی `.claude/settings.json` ندارد؛ hook sample اختیاری در PE‑6 می‌ماند. برای F.8،
اگر journal یک تصمیم را اجرا می‌کند، `exec_action_journal.target` همان کد ledger تصمیم (مثلاً `D-001`) است.

---

## ۱۱. PE‑6 (بخش D) — فایل قوانین رفتار ایجنت

- `docs/LEDGER_RULES.md`: بلوک‌های «چرا / شروع / محرک‌ها / کِی بپرسم / حین کار / پایان / ممنوع»،
  جدول محرک→ابزار، ۶ نمونهٔ `ledger-cli` و قاعدهٔ توقف در صورت نبودن ابزار Ledger. چون `session_start`
  تا PE‑10 هنوز MCP tool نیست، راهنمای PE‑6 از `exec_ledger_status` برای شروع/ادامه استفاده می‌کند.
- `AGENTS.md`: افزودن بخش `## Execution control (exec_control)` با ارجاع به قوانین و چهار منعِ مستدل؛
  بقیهٔ فایل دست‌نخورده می‌ماند.
- `docs/MCP.md` و `docs/MCP_CONTRACTS.md`: فقط اتصال inbound با Streamable HTTP و حداقل اسکوپ‌های
  Ledger؛ اصلاح ادعای نادرست stdio. `forgepm-mcp` فقط `serverInfo.name` است، نه باینری.
- انحراف حمل‌ونقل ثبت‌شده در D‑061: به‌دلیل قاعدهٔ «بدون بریج جدید» (D‑002) و نبودن اجرایی در مخزن،
  stdio پیکربندی/ادعا نمی‌شود؛ هیچ `.claude/settings.json` نمونه‌ای لازم نیست.

**معیارهای پذیرش PE‑6**

- [x] D.1 `docs/LEDGER_RULES.md` در شمارش ایستا ۵۷ خط است و همهٔ bulletهای محرک، `→` و نام ابزار دارند؛
      guard محلی پاس شد (`tests/unit/ledger-rules-doc.test.ts`).
- [x] D.2 چهار منع صریحِ مستدل نوشته شده و guard محلی پاس شد؛ هر سه assertion فایل guard سبز بودند.
- [ ] D.3 **آزمون رفتاریِ سه تسک واقعی: اجرا نشده**. کاربر اجرای خودِ D.3 را مجاز کرد، اما preflight
      نشان داد `FORGEPM_URL` و `FORGEPM_API_KEY` در محیط unset هستند و هیچ پروژه/تسک واقعی برای اجرا
      معرفی نشده؛ هیچ API requestی ارسال نشد. `DATABASE_URL` نیز unset است، اما برای اجرای remote
      لازم نیست. نرخ ≥ ۸/۱۰ و پیشنهادهای انسانی اثبات نشده‌اند. اجرای محلی `test:unit` هیچ شاهدی برای
      D.3 نیست؛ GitHub CI نیز اجرا نشد.
- [x] D.4 `docs:check` سبز: ۲۲ سند الزامی و لینک‌ها تأیید شدند. چون `tsx` محلی نصب نبود، همان
      `npm run docs:check` با `npm exec --yes --package=tsx@4.19.2 -- …` اجرا شد؛
      `node apps/web/scripts/i18n-check.mjs` نیز با ۱۹۹ کلید سبز شد.
- [x] D.5 بازبینی دستی انجام شد؛ بخش AGENTS با `docs/EXECUTION_PLAN.md` سازگار است. تصمیم‌های
      Context/Decision/Reason در `docs/DECISIONS.md` ثبت شده‌اند.

---

## ۱۲. PE‑7 (بخش E) — بازبین خصمانه

**ورودی ایزوله (قطعی، `exec/review-input.ts`):** دقیقاً پنج بخش: (1) متن خام درخواست از
`exec_requirements.quote`، (2) معیارها و وضعیت evidence، (3) diff/hash از adapter فقط‌خواندنی Git
و محدود به `exec.allowed_repo_roots`، (4) snapshot وضعیت Ledger، (5) Exit Report. تاریخچهٔ گفتگو
هرگز وارد prompt نمی‌شود؛ `exec_reviews.input_meta` ثبت می‌کند کدام بخش‌ها، اندازه/hash prompt،
redactionها و hash درخت استفاده شدند. prompt سقف بایت دارد و دادهٔ مخرب داخل snapshot صرفاً شاهد است،
نه دستور. خروجی strict parse می‌شود؛ هر finding باید `evidence_ref` معتبر و witness-bound داشته باشد.

مراحل ثابت: `exec:requirements_coverage`, `exec:evidence_claims`, `exec:unrecorded_decisions`,
`exec:behavior_regression`, `exec:edge_cases`, `exec:out_of_scope`. مدل tool/file/work-item write ندارد.
هر round در `review_runs`, `exec_reviews`, `review_findings`, `ai_calls` و audit پایدار می‌شود؛
findingها به `exec_open_items(source='reviewer')` تبدیل می‌شوند. `verdict=fail` یا هر finding
`blocks_completion=true` قاعدهٔ ۷ را می‌بندد. خروجی نامعتبر (از جمله JSON خراب یا witness مفقود/نامعتبر)
یک تلاش اصلاحی دارد؛ اگر بار دوم هم نامعتبر بود، run با `review_failed` بسته می‌شود و fail-closed است.

سقف `exec.max_review_rounds` حداکثر ۲ دور است. پس از شکست دور آخر، `open_item(type='risk',
blocks_completion=true, title='human arbitration required')` ثبت می‌شود؛ `related_ref` به task، شمارهٔ
round و همان `tree_hash` مقید است. تنها بستن همین آیتم توسط انسان (`resolved_by='human'`) می‌تواند
verdict ناموفق همان round/hash را بپذیرد؛ یک finding مشابه یا آیتم داوری قدیمی‌تر معتبر نیست. این
رأی انسانی نه تازگی را دور می‌زند (hash همچنان باید برابر باشد)، نه سایر blockerهای فعال را می‌بندد. Findingهای
blocking و دیگر موانع باید جداگانه حل شوند؛ بنابراین Gate هرگز خودکار سبز نمی‌شود.

**ابطال:** پس از review و دوباره هنگام بارگذاری Gate، `exec_reviews.tree_hash` با hash فعلی worktree
مقایسه می‌شود؛ اختلاف یا hash غیرقابل‌محاسبه ⇒ Rule 7 رد. `review_task` بودجهٔ `exec.max_cost_tokens`
و بودجهٔ روزانه را رعایت می‌کند؛ هر تلاش provider، از جمله retry و رد ناشی از بودجه، در `ai_calls`
ثبت می‌شود.

**معیارهای پذیرش PE‑7**

- [x] E.1 پنج بخش به ترتیب ثبت می‌شوند و تست رد هرگونه conversation/history را ثابت می‌کند
      (`review-input.test.ts`, `exec-review.test.ts`).
- [x] E.2 stub provider برای معیار ناقص، finding نوع `incomplete_requirement` را با شاهد واقعی
      در ledger می‌نویسد و Rule 7 را مسدود می‌کند (`exec-review.test.ts`).
- [x] E.3 `TODO: later` در diff به finding نوع `commitment` با شاهد و blocker تبدیل می‌شود.
- [x] E.4 پاسخ نامعتبر یک retry دارد؛ پس از آن `review_failed` ثبت و هر دو فراخوانی AI حساب می‌شوند.
- [x] E.5 تغییر tree hash حین/پس از review verdict را `stale` می‌کند؛ Rule 7 آن را رد می‌کند.
- [x] E.6 حداکثر دو دور؛ تلاش سوم provider را صدا نمی‌زند و blocker داوری انسانی می‌سازد.
- [x] E.7 هیچ ابزار ویرایش/`work_item_update` در اختیار مدل نیست؛ تست ثابت می‌کند وضعیت و `updated_at`
      work item دست‌نخورده می‌ماند؛ فقط دادهٔ review، AI، finding/open-item و audit نوشته می‌شود.
- [x] E.8 budget preflight فراخوانی provider را متوقف می‌کند و refusal با صفر token در `ai_calls` ثبت
      می‌شود؛ مصرف واقعی هر فراخوانی نیز ثبت و جمع می‌شود.
- [x] Rule 7: فقط آیتم داوریِ `source='reviewer'`, `type='risk'`, با عنوان دقیق، بسته‌شده توسط انسان
      می‌تواند verdict شکست را override کند؛ تست واحد ثابت می‌کند hash stale و blocker دیگر همچنان رد می‌شوند.
- **Local verification (2026‑10‑18):** root build/typecheck/lint سبز، unit tests **380/380 در 43 فایل**
  سبز، و batch اصلی PostgreSQL-backed شامل هفت فایل execution integration سبز با **90/90 تست** بود.
  پس از سخت‌سازی provenance داوری (اتصال آیتم به task/round/tree hash)، `exec-review` نیز دوباره با
  **6/6 تست** پاس شد. `docs:check` (۲۲ سند)، `migrate` (up to date)، `schema:check` (۶۰ جدول)،
  `gen:api:check`، migration-hash check و `git diff --check` نیز سبز شدند. GitHub CI اجرا نشد؛ push و
  merge انجام نشدند.

---

## ۱۳. PE‑8 تا PE‑11 (ضمیمهٔ ۱)

### PE‑8 (بخش J) — Scope + Baseline

**مرز اعتماد:** scope از `exec_tasks.start_ref` که API از Git اندازه می‌گیرد یا از manifest hash-only که API موقع شروع تسک می‌سازد می‌آید؛ `exit_report.changed_files` هرگز ورودی Rule 11 نیست. Baseline فقط از CI log envelope با SHA دقیق می‌آید؛ `tests_executed`/`test_output` ادعاشده توسط agent هرگز ورودی Rule 12 نیست. ForgePM هیچ test، build یا کد مخزن را اجرا نمی‌کند — نه روی host و نه در container.

- **Scope / Rule 11:** adapter فقط دستورهای ثابت و read-only Git (`diff`, `ls-files`, `rev-parse`, `status`, `show`) را با `execFile` و بدون shell اجرا می‌کند. بدون Git، API در آغاز کار manifest مرتبِ `{path, sha256}` ثبت می‌کند؛ digest فایل شامل محتوا و mode است، symlink فقط target را hash می‌کند، و محتوا/secret فایل‌ها در event ذخیره نمی‌شود. مسیرهای dependency/build/cache ثابت (`node_modules`, `.git`, `dist`, `build`, `.next`, …) حذف می‌شوند؛ سقف تعداد/حجم و دو پیمایش پایدار باعث fail-closed شدن snapshot ناپایدار یا بیش‌ازحد بزرگ می‌شود. Diff manifest، افزودن/تغییر/حذف را می‌سنجد. خارج از `allowed_paths` و هر حذف، Rule 11 را مسدود می‌کند و در completion یک open item با `source='hook'` می‌سازد؛ تغییر محدوده فقط از تصمیم انسانی ثبت‌شده می‌گذرد. Waive انسانیِ scope فقط وقتی منبع قابل‌اندازه‌گیری نیست پذیرفته می‌شود و هیچ‌وقت تخلفِ اندازه‌گیری‌شده را دور نمی‌زند.
- **Baseline / Rule 12:** `baseline_capture` فقط `{task_ref}` می‌گیرد؛ SHA، log یا نتیجه از caller پذیرفته نمی‌شود. `exec.ci_log_endpoint` باید HTTPS باشد و برای SHA خواسته‌شده JSON `{sha,run_id,job,provider?,log}` برگرداند. پاسخ/زمان محدود، redirect ممنوع و SSRF guard فعال است؛ توکن read-only فقط با نام `exec.ci_log_secret_name` از encrypted `secrets` خوانده می‌شود. log خام ذخیره یا به caller برگردانده نمی‌شود؛ `exec_baseline_tests` نتیجه‌های start را با provenance ذخیره می‌کند و event نتیجهٔ current شامل SHA-256 log است. parser باید outcome نام‌دار برای تست‌ها داشته باشد و summary با markerهای per-test سازگار باشد؛ totals تنها، log ناقص یا SHA نامنطبق `BASELINE_UNAVAILABLE` است.
- Rule 12 تست pass baseline که ناپدید/failed/skipped شده، تست جدید غیرسبز، و تضعیف فایل‌های `exec.protected_test_globs` (کاهش assertion شمرده‌شده یا افزودن `.skip`/`.only`/`xit`/`xdescribe`/`@Ignore`/`skip: true`) را از CI دقیق SHA و pair فایلِ read-only تشخیص می‌دهد. هر blocker Gate مستقیم باقی می‌ماند؛ waive انسانی فقط برای **نبود baseline/log** است، نه برای نتایج CI قرمز یا تضعیف تست.
- تنظیمات اپراتور: `exec.baseline_source`, `exec.ci_log_endpoint`, `exec.ci_log_secret_name`, `exec.test_result_parser`, `exec.protected_test_globs`, و `network.allow_private_targets`. قرارداد و envelope در `docs/MCP_CONTRACTS.md` و راه‌اندازی امن در `docs/RUNBOOK.md` ثبت می‌شود.

**چرا بدون runner؟** D‑08 مالک ساخت/اجرای runner را رد کرد: CI خود مخزن منبع نتیجه است؛ ForgePM فقط log همان SHA را می‌خواند و secret را هرگز به کد مخزن نمی‌دهد. هیچ کلید `exec.allow_host_test_command` یا `exec.runner.*` و هیچ مسیر اجرای مخزن اضافه نمی‌شود.

- [ ] J.1 تغییر خارج از `allowed_paths` (از Git diff یا manifest) و حذف هر فایل—حتی اگر داخل scope باشد—Rule 11 را رد می‌کند و یافتهٔ کدساخته ثبت می‌شود.
- [ ] J.2 تست pass در start CI که در current CI ناپدید شده Gate را رد می‌کند؛ logهای هر دو SHA باید نام تست را داشته باشند.
- [ ] J.3 `fail`/`skip` per-test و weakening با `.skip` یا `.only` Gate را رد می‌کند.
- [ ] J.4 claims در exit report یا `ledger_add_evidence(kind:'test_output')` baseline نیستند؛ فقط event سیستم با SHA و provenance دقیق پذیرفته می‌شود.
- [ ] J.5 scope expansion فقط انسانی و audit‌شده است؛ measurement waiver فقط وقتی منبع scope ناموجود است. waiver نه یافتهٔ خارج‌از‌محدودهٔ اندازه‌گیری‌شده و نه حذف را دور نمی‌زند.
- [ ] J.7a parser totals-only/بدون named outcomes fail-closed؛ J.7b secret masking؛ J.7c guard ساختاری `tests/unit/exec-no-spawn.test.ts` اجازهٔ child-process را فقط در adapter read-only می‌دهد و runner artifact وجود ندارد.
- [ ] J.8 بدون Git، task start یک manifest hash-only محدود و دوپیمایشی می‌گیرد و با manifest فعلی مقایسه می‌کند؛ اگر capture ناپایدار/ناممکن باشد Rule 11 fail-closed می‌شود. `start_ref=null` در baseline همچنان fail-closed است تا CI SHA موجود باشد یا انسان baseline را waive کند.

**وضعیت این پیاده‌سازی:** PE‑8 کامل و locally verified (۲۰۲۶‑۱۰‑۱۸ UTC): build/typecheck/lint، ۴۰۴ تست unit، batchهای PostgreSQL-backed (۹۰ + rerun متمرکز ۳)، docs/schema/migration/API generation و diff checks پاس شدند؛ D.3 اجرا نشده است.

### PE‑9 (بخش‌های G + H) — الزامات و پلن

`requirements.ts`: `req_add` (quote عین متن، رد مبهم با همان `assessCheckable`)،
`req_link_task`، `req_change` (معیارها به `pending` برمی‌گردند، evidence append-only و فقط به‌عنوان تاریخچه می‌ماند، decisionهای وابسته `needs_revisit` می‌شوند؛ برای هر تسک `done` مرتبط یک `open_item(blocks=true)` ساخته و تسک باز می‌شود)، `req_coverage()`، drop فقط انسانی. مطابق D‑049/D‑058، فقط `exec_criteria.req_id` پوشش محسوب می‌شود؛ `req_ids` در شروع task صرفاً declaration است.
**قانون شروع:** REQ فعالِ بدون assignment، حتی اگر چند REQ با `req_ids` روی task اعلام شوند، مانع `exec_task_start` با `REQUIREMENT_UNCOVERED` است تا REQها به task اعلام شوند؛ سپس criterion باید جداگانه با `req_link_task` پیوند بخورد تا Gate آن را پوشش بداند.
`plan.ts`: `task_split` (چرخه با `graph.ts` → `DEPENDENCY_CYCLE`)، `task_start` با پیش‌نیاز `done`نبوده → رد با فهرست دقیق، `task_block` (reason/kind/unblock condition الزامی؛ ref برای مانعِ غیر external)، رفع خودکار مانع با پاسخ سؤال/تأیید decision/`done` پیش‌نیاز + علامت `task.unblocked` در `session_start`، `exec_plan_view` درختی. لغو زیرتسک فقط از REST انسانی `/api/v1/exec/tasks/:parentRef/children/:childRef/cancel`، با approval و waiver ثبت‌شده برای Gate والد.

- [x] G.1 درخواست پنج‌جمله‌ای به پنج ورودی مجزای `req_add` شکسته می‌شود؛ هر quote دقیقاً از متن کاربر است و quote تغییریافته با `UNPROCESSABLE` رد می‌شود (فیکسچر واحد + مسیر MCP).
- [x] G.2 REQ بدون تسک در `session_start`، `req_coverage` و `exec_plan_view`؛ `task_start` رد.
- [x] G.3 Gate تسکی که REQ وصل‌شده‌اش معیار بدون evidence دارد → رد (Rule 8 unit test).
- [x] G.4 `req_change` → criteria به `pending` (evidence حفظ می‌شود)، decision وابسته `needs_revisit` + آیتم مسدودکننده برای هر تسک done.
- [x] G.5 ایجنت ابزار drop/waive الزام ندارد؛ `req drop` فقط مسیر CLI/REST انسانی با `approval` (تست رد REST با کلید ایجنت).
- [x] G.6 تعارض دو REQ (هم‌پوشانی `kind`+`priority` و `contradicts` صریح) → `open_item(type='design_gap', blocks=true)` + `ask_human`.
- [x] H.1 وابستگی چرخه‌ای رد (۳ حالت: خود، ۲‌تایی، ۳‌تایی).
- [x] H.2 `task_start` با پیش‌نیاز ناتمام → رد با کدهای دقیق `pending_deps`.
- [x] H.3 `task_block` بدون `unblock_condition` → رد؛ با شرط → `status='blocked'`.
- [x] H.4 پاسخ سؤال/تأیید decision/اتمام dependency مسدودکننده → تسک خودکار `in_progress` + `task.unblocked` در `session_start`.
- [x] H.5 Gate والد با یک فرزند ناقص → `ok:false`; لغو زیرتسک با REQ وصل‌شده فقط از مسیر انسانی و با approval/waiver ثبت‌شده.
- [x] H.6 `exec_plan_view` درخت کامل را بدون context دیگری برمی‌گرداند؛ تفکیک `blocked` و `awaiting_human`.
- [x] H.7 تسک blocked در projection وضعیت «in progress» نمی‌گیرد و work item از category `started` خارج می‌شود (serializer/integration test).

**وضعیت این پیاده‌سازی:** PE‑9 کامل و به‌صورت محلی تأیید شد (۲۰۲۶‑۱۰‑۱۸ UTC): build/typecheck/lint، ۴۹ فایل unit با ۴۱۷ تست، و batch متمرکز PostgreSQL با ۵ فایل و ۸۰ تست پاس شدند؛ `docs:check`، migrate، `schema:check` (۶۰ جدول)، OpenAPI generation/check (۹۵ مسیر)، migration hashes و diff نیز پاس شدند. بازهٔ integration کامل به‌دلیل نیاز برخی suiteهای نامرتبط به Redis و ابزارهای `psql`/`pg_dump` ادعا نمی‌شود. `session_start` فعلاً فقط uncovered REQ و unblocks اخیر PE‑9 را برمی‌گرداند؛ reconciliation و بسته‌بندی اولویت‌دار در PE‑10 می‌ماند. هیچ migration یا جدول REQ↔task اضافه نشده است.

### PE‑10 (بخش K) — Resume + Journal

`journal_start` پیش از اقدام، `pre_state_ref` را از Git read-only می‌گیرد (`git rev-parse HEAD:.` +
`git status --porcelain`)؛ `journal_done/fail` ردیف `started` یا `unknown` را دقیقاً یک‌بار settle
می‌کنند. در `session_start`، ردیف `started` به `unknown` می‌رود و رویداد/ممیزی ثبت می‌شود.
**قفل نشست (کد قطعی، نه پرامپت):** ابزارهای نوشتن عادی با `JOURNAL_UNRESOLVED` متوقف می‌شوند؛
استثناها: خواندنی‌ها، `journal_done/fail`، `ledger_ask_human`، `exec_ledger_reconcile` و
`ledger_record_decision` فقط وقتی سیاست واقعاً approval می‌طلبد. retry فقط برای یک ردیف `unknown`
با `idempotent=true` و task/action/target/expected_effect دقیقاً یکسان مجاز است و `exec_events` ثبت می‌کند.
`session_start()` بستهٔ ثابت ۶ بخشی را در سقف `min(exec.session_output_max_bytes, 50 KiB - 512 bytes)` می‌فرستد تا از cap خروجی MCP عبور نکند؛ شمارنده و
راهنمای خواندنِ باقی‌مانده حفظ می‌شود. Gate موفق، manifest هش‌محور فایل‌ها را در مهر append-only
ذخیره می‌کند؛ `exec_ledger_reconcile()` drift پس از بسته‌شدن، Gate stamp نامعتبر/مفقود، فکت stale،
journal باز و اختلاف diff واقعی با `changed_files` را گزارش می‌کند.

- [x] K.1 journal شبیه‌سازی‌شدهٔ نیمه‌تمام در نشست تازه `unknown` و اولین مورد بخش journal می‌شود؛ status و رویداد/audit بررسی می‌شوند.
- [x] K.2 ابزار نوشتن با `unknown` باز → `JOURNAL_UNRESOLVED`؛ پس از `journal_done` قفل برداشته می‌شود.
- [x] K.3 retry غیرتکرارپذیر رد؛ retry دقیق با `idempotent=true` مجاز و رویداد `journal.retry_started` ثبت می‌شود.
- [x] K.4 هش فایل‌های داخل `task.allowed_paths` پس از `closed_at` اختلاف مسیر را در `exec_ledger_reconcile` نشان می‌دهد؛ فکت‌های stale، journalهای unsettled و diff اندازه‌گیری‌شده در برابر `changed_files` نیز گزارش می‌شوند.
- [x] K.5 با ۲۰۰ آیتم باز، خروجی حداکثر در `min(exec.session_output_max_bytes, 50 KiB - 512 bytes)` می‌ماند؛ تست جداگانه نیز سقف dispatch پنجاه KiB را با setting بزرگ‌تر بررسی می‌کند. شش بخش، `truncated:true` و شمارنده حفظ می‌شوند.
- [x] K.6 Gate هر دو وضعیت journal `started/unknown` را با قاعدهٔ ۱۳ رد می‌کند.
- [x] K.7 قرارداد `SessionSnapshot` در تست خروجی اعتبارسنجی می‌شود؛ hook شروع نشست اختیاری است و نصب نشده است.

### PE‑11 (بخش I) — دانش پروژه

`fact_record` محتوای فایل را سمت سرور hash می‌کند؛ `kind='fact' + source='agent_guess'` رد می‌شود،
منابع `file:` باید زیر `exec.allowed_repo_roots` موجود باشند، `commit:` باید به commit واقعی resolve شود،
و `cmd:` باید به journal تکمیل‌شده با `result_ref` اشاره کند. کلید تکراری ردیف جدید می‌سازد و ردیف فعال/کهنهٔ قبلی را با `superseded_by` حفظ می‌کند. `fact_query` مقدارهای stale را فقط با `status:'stale'` و هشدار می‌دهد. `fact_verify` hash را بازمی‌خواند؛ خودکارسازی در `session_start`، پیش از `task_complete` و job دوره‌ای worker اجرا می‌شود. Stale ⇒ تصمیم فعال وابسته `needs_revisit` + آیتم `risk` مسدودکننده روی هر task وابسته. `fact_promote` فقط انسانی است، reason/evidence لازم دارد و در policy، `fact_promote_from_guess` همچنان `deny` است.

- [x] I.1 `fact_record(kind:'fact', source:'agent_guess')` → رد با پیام «یا `kind:'assumption'` یا منبع واقعی».
- [x] I.2 تغییر یک فایل مرجع ⇒ در اجرای بعدی (`session_start`) فکت `stale` (تست hash).
- [x] I.3 stale ⇒ تصمیم وابسته `needs_revisit` + آیتم مسدودکننده + رد Gate (تست زنجیره‌ای).
- [x] I.4 کلید تکراری ⇒ نسخهٔ قبلی `superseded` با `superseded_by` (هر دو ردیف باقی‌اند؛ تست شمارش).
- [x] I.5 `fact_promote` بدون evidence/دلیل انسانی → رد؛ با تأیید انسانی و reason → `active` + audit.
- [x] I.6 `fact_query` فکت stale را با `status:'stale'` + `warning` برمی‌گرداند، نه به‌عنوان واقعیت.
- [x] I.7 هیچ `fact` با `source_ref` غیرقابل‌بازدید باقی نمی‌ماند (`file:` موجود، `commit:` parseable و `cmd:` journalشده).

### PE‑12 — **پنل کامل**، README، سناریوی E2E، مستندات

**پنل کامل (D‑13)** — همه از REST انسانی/اداری، بدون هیچ مسیر نوشتن مستقیم به DB:

| صفحه/جزء             | مسیر                                       | محتوا                                                                                                                                                                                 |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| تسک‌های اجرا         | `pages/exec-tasks.ts` + route `exec-tasks` | درخت `exec_plan_view`؛ ستون‌های `code/status/open items/blocked_on/unblock_condition/gate summary`؛ تفکیک رنگی `blocked` و `awaiting_human`؛ project picker و cursor pagination موجود |
| جزییات تسک           | drawer همان صفحه (`exec-tasks/:code`)      | معیارها + evidence با `provenance`، آیتم‌های باز، تصمیم‌ها، سؤالات، دورهای بازبینی، journal، REQهای وصل‌شده، دکمهٔ **Dry‑run Gate** با نمایش `blocked_by`                             |
| قفل‌گشایی انسانی     | فرم‌های همان صفحه                          | `resolve`(note) · `answer Q` · `approve/reject D` · `waive C` · `drop REQ` · `approve-scope` · `fact promote` — هرکدام با `reason` الزامی و preview تأثیر                             |
| سیاست ریسک           | `pages/exec-policy.ts`                     | جدول `exec.policy` قابل ویرایش (admin) + validation zod + diff قبل از ذخیره (معادل `policy:print/set`)                                                                                |
| تب تسک در WorkItem   | `pages/work-item-detail.ts`                | بخش «Execution control» (وضعیت gate، `exec_events` اخیر)؛ دکمهٔ Done در `gate ok:false` **غیرفعال + tooltip دلیل** (سرور هم رد می‌کند)                                                |
| افزوده روی Approvals | `pages/approvals.ts`                       | `exec.decision/question/scope/waive/drop/promote` با لینک به تسک (منطق approval بدون تغییر)                                                                                           |

_قراردادهای پنل:_ کلیدهای i18n جدید با برابری `fa/en` (`i18n-check.mjs`)، `contrast-check.mjs`،
`raw-value-check.mjs`، کامپوننت‌های `ui/*` موجود، تست واحد کامپوننت + مسیر `apps/web/e2e/chain.spec.ts`.

**بدون بریج/پروکسی جدید (D‑02/D‑061):** ایجنت از Streamable HTTP `POST /mcp` استفاده می‌کند؛ باینری inbound stdio در مخزن وجود ندارد.
تنها افزوده‌ها: (الف) قطعهٔ پیکربندی + ساخت کلید API با اسکوپ‌های `ledger:*` در `docs/MCP.md`؛
(ب) رفتار fail‑closed: سرور پایین ⇒ ابزار نوشتن `MODULE_UNAVAILABLE` با پیام «ادعا نکن، صبر کن»؛
(ج) **اختیاری، پیش‌فرض خاموش، بدون DB:** `npm run ledger -- snapshot --out .agent-ledger/status.json`
(JSON فقط‑خواندنی + TTL، برچسب `"advisory_only": true`)؛ (د) `scripts/claude-hook.mjs` (PE‑5 F.9) و پیکربندی
خواندن لاگ CI (`exec.ci_log_endpoint` + `exec.ci_log_secret_name`) در `docs/RUNBOOK.md` مستند می‌شود.
**هیچ** Dockerfile/compose/runner ساخته نمی‌شود و **هیچ وابستگی جدیدی** اضافه نمی‌شود: نه
`better-sqlite3`/`sqlite3` (D‑01)، نه ابزار container (D‑08).

- `docs/EXECUTION_CONTROL.md`: جدول وضعیت ۱۱۱ معیار پذیرش A–K با ستون «تست متناظر» و خط‌های
  `local:`/`remote:` (الگوی `npm run report:phase`)؛ `README.md`: بخش «Execution control».
- مستندات لازم دیگر: §H در `docs/DATA_MODEL.md` (قرارداد ۱۷ جدول)، `docs/API_CONTRACTS.md`
  (endpoint‌های `/api/v1/exec/*`)، `docs/MCP_CONTRACTS.md` (جدول ۲۸ ابزار + اسکوپ‌ها)،
  `docs/SECURITY.md` (threat model «نبودِ اجرای کد»)، `docs/RUNBOOK.md`، `docs/DECISIONS.md` (D‑01…D‑13)،
  `CHANGELOG.md`، و بازتولید `openapi.json`/`schema.d.ts` با `npm run gen:api`.

**PE‑12 — سناریوی انتهای-به-انتها (`scripts/exec-e2e.ts`, `npm run exec:e2e`)** — ۱۳ صحنه:

| #   | صحنه                                                                               | انتظار                                                    |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | درخواست ۱۲ جمله‌ای «افزودن ورود با توکن»                                           | ۱۲ REQ با quote                                           |
| 2   | یکی بدون تسک                                                                       | `exec_task_start` رد (`REQUIREMENT_UNCOVERED`)            |
| 3   | `task_split` با وابستگی                                                            | شروع زودهنگام رد                                          |
| 4   | «بعداً refresh token را اضافه می‌کنم»                                              | `OI-###` مسدودکننده                                       |
| 5   | `touches=['public_api']`                                                           | `approval/pending`؛ اعمال بدون تأیید → `APPROVAL_PENDING` |
| 6   | `task_complete` زودهنگام                                                           | `ok:false` با `blocked_by` دقیق                           |
| 7   | فایل خارج از `allowed_paths`                                                       | آیتم مسدودکننده                                           |
| 8   | حذف تست baseline (fixture از لاگ CI یک commit سبز + نسخهٔ تغییریافته برای حالت رد) | قاعدهٔ ۱۲ رد                                              |
| 9   | تغییر فایل مرجع فکت                                                                | stale → needs_revisit → رد                                |
| 10  | کرش میانهٔ migration                                                               | `unknown` اول؛ تکرار مسدود                                |
| 11  | بازبینی (stub provider)                                                            | TODO جاافتاده → finding                                   |
| 12  | تأییدهای انسانی از CLI **و** پنل                                                   | approve + answer + waive (دو مسیر، یک نتیجه در ledger)    |
| 13  | `task_complete` نهایی                                                              | `done` + گزارش از Ledger (تطابق شمارش‌ها)                 |

اسکریپت exit code غیرصفر در هر انحراف؛ در CI به‌عنوان یک step مستقل اجرا می‌شود (با harness DB).

**معیارهای پذیرش PE‑12**

- [ ] L.1 `npm run exec:e2e` در CI سبز (۱۳ صحنه، ۰ خطای موردانتظار).
- [ ] L.2 یک MCP واحد: هر ۲۸ ابزار از Streamable HTTP `/mcp` دیده/خوانده می‌شوند؛ `forgepm-mcp`
      فقط `serverInfo.name` است و stdio proxy وجود ندارد (D‑061؛ تست SDK/JSON-RPC) + «ماژول خاموش ⇒ صفر ابزار ledger».
- [ ] L.3 حالت offline: سرور down ⇒ ابزار نوشتن `MODULE_UNAVAILABLE` (fail closed)؛ هیچ ادعای
      محلی ثبت نمی‌شود و هیچ `done` محلی ممکن نیست.
- [ ] L.4 `snapshot` فقط JSON است: تست — نبود هرگونه نوشتن ledger از روی فایل + صفر مورد
      `better-sqlite3|sqlite3` در `package-lock.json` (تست وابستگی، تضمین «یک دیتابیس»).
- [ ] L.4b پنل کامل: هر ۶ جزء جدول بالا رندر/تست‌شده؛ فرم‌های قفل‌گشایی دقیقاً endpoint‌های انسانی
      را صدا می‌زنند (unit با mock + `chain.spec.ts`: approve decision و waive criterion).
- [ ] L.4c دفاع لایه‌ای در Done: دکمهٔ غیرفعال در UI **و** `FORBIDDEN` از guard سرور (تست e2e + integration).
- [ ] L.5 i18n parity + RTL: `node scripts/i18n-check.mjs` سبز؛ صفحهٔ جدید بدون سرریز در ۳۶۰/۱۲۸۰.
- [ ] L.6 `npm run verify`، `schema:check`، `gen:api:check`، `docs:check`، `migration-hash`، `perf`
      (P‑02 بدون رگرسیون > ۱۰٪ برای `exec_ledger_status` با ۱۰۰۰ آیتم) سبز.
- [ ] L.7 پوشهٔ تست واحد `exec.*` ≥ ۸۰٪ خطوط/توابع (thresholds موجود).

---

## ۱۴. استراتژی تست (نگاشت معیار → تست)

| نوع                                | کجا                                                                                                                                                                                                                                                                        | نمونه                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| واحد (کد قطعی، بدون DB)            | `packages/core/src/exec/*.test.ts`, `packages/shared/src/schemas-exec.test.ts`, `tests/unit/*`                                                                                                                                                                             | policy، ۱۳ قاعدهٔ gate، assertCheckable، scope glob، parser لاگ CI، journal، session pack، codes                        |
| Integration (Postgres+Redis واقعی) | `tests/integration/exec-*.test.ts` با `createHarness()`                                                                                                                                                                                                                    | ledger, gate روی تسک واقعی، approvals، stale/review، req coverage، resume                                               |
| MCP contract                       | `apps/api/test/integration/phase4-sdk.test.ts` (registry/SDK) + `scripts/mcp-smoke.ts` (live Streamable HTTP `/mcp`); no inbound stdio proxy (D‑061)                                                                                                                      | tools/list با/بدون enable، scope، rate limit، idempotency، envelope خطا                                                 |
| E2E پذیرش                          | `scripts/exec-e2e.ts` + `npm run exec:e2e` (CI)                                                                                                                                                                                                                            | ۱۳ صحنهٔ §۱۳ (PE‑12)                                                                                                    |
| پنل                                | `apps/web/src/app/pages/{exec-tasks,exec-policy}.spec.ts` + `apps/web/e2e/chain.spec.ts`                                                                                                                                                                                   | درخت تسک، dry‑run gate، approve/waive از پنل، RTL/contrast/raw‑check                                                    |
| نبودِ اجرای کد مخزن (D‑08/D‑041) | `tests/unit/exec-no-spawn.test.ts`: هیچ مسیر `child_process` جز Git adapter دقیقِ `review-source.ts`؛ خودآزمایی pattern، allowlist فرمان‌های read-only و نبود `docker-compose.runner.yml`; به‌علاوه `packages/core/src/exec/ledger.test.ts` (CI log و `source`) | اجرای کد مخزن همچنان ممنوع است؛ snapshot خواندنی Git فقط در یک فایل ممیزی‌شده مجاز است (D‑062) |
| مهر گیت                            | `tests/integration/exec-gate-stamp.test.ts`                                                                                                                                                                                                                                | `done` بدون مهر معتبر = drift؛ `tree_hash` متفاوت = رد                                                                  |
| دروازهٔ ساختاری                    | تست‌های موجود                                                                                                                                                                                                                                                              | `schema:check`, `docs:check`, `gen:api:check`, `check-migration-hashes`, `eslint-boundaries`                            |
| نفوذ/امنیت                         | `tests/integration/pou-exec-security.test.ts`                                                                                                                                                                                                                              | حذف رکورد، حذف مسیر، secret mask، path traversal، SQL injection در `ref` (کوتاه‌ترین مسیر: همه از Kysely parameterized) |
| عملکرد                             | `scripts/exec-perf.mjs` (تولید ۱۰۰۰ OI)                                                                                                                                                                                                                                    | p95 `ledger_status < 150ms`, `session_start < 250ms`, gate dry-run < 120ms                                              |

هر فاز با **تست قرمز اول** شروع می‌شود (الگوی `AGENTS.md`) و سبز شدن همان تست، معیار اتمام آن فاز است.
معیار پذیرشی که تست خودکار ندارد، در `docs/EXECUTION_CONTROL.md` با برچسب `manual:` و دستور اجرایش ثبت می‌شود.

---

## ۱۵. امنیت، ریسک‌ها و محدودیت‌ها

| ریسک                                                                   | کاهش                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| اجرای `test_command` = RCE (CICD‑SEC‑4)                                | **ساخته نمی‌شود**: هیچ مسیر اجرایی در کد نیست (نه host، نه container، نه compose). نتیجه فقط از **لاگ CI** همان `commit_sha` خوانده/parse می‌شود؛ نبودش ⇒ `BASELINE_UNAVAILABLE` و **رد** قاعدهٔ ۱۲ (fail closed)؛ waive فقط انسانی و برجسته در گزارش نهایی؛ تست J.7 + گارد ساختاری J.7c |
| نشت secret به لاگ ذخیره‌شده                                            | CI token و raw CI log هرگز ذخیره یا در خروجی برگردانده نمی‌شوند؛ فقط outcomeهای parse‌شده و SHA-256 log نگه‌داری می‌شود. تست integration نبود token/raw log در پاسخ و event ledger را می‌سنجد.                                                                                                                                        |
| ابطال/جعل نتیجهٔ baseline                                              | `provenance` (run_id/sha/sha256 log) در `exec_baseline_tests`؛ writer فقط کد؛ `run_source` در مهر `exec_gate_checks`؛ تست J.4                                                                                                                                                            |
| **تورم ۲۸ ابزار MCP → context و فراموشی ثبت** (ریسک پذیرفته‌شدهٔ D‑12) | همه فعال؛ کنترل فقط با: توضیح ≤ ۲۰۰ کاراکتر (تست registry)، `exec.tool_output_max_bytes` + `truncated`، `session_start` به‌عنوان تنها نقطهٔ شروع، و **الزام رفتاری** D.3؛ ابزارهای استفاده‌نشده در گزارش نهایی فهرست می‌شوند (حذف خودسرانه ممنوع)                                        |
| Ledger به‌عنوان منبع نشت secret                                        | mask قبل از ذخیره (الگوی `maskInput`) + تست B.16 + رد الگوهای `fpm_`/PEM/AWS                                                                                                                                                                                                             |
| Write amplification (هر فراخوانی = event)                              | batch در یک تراکنش؛ ایندکس `(task_id, ts)`؛ ریلین `exec_events` با retention موجود (`retention.ts`)                                                                                                                                                                                      |
| قفل شدن تسک‌ها در حلقهٔ بی‌پایان بازبینی                               | سقف ۲ دور + ارجاع انسانی (E.6)                                                                                                                                                                                                                                                           |
| هم‌زمانی ایجنت‌های متعدد روی یک تسک                                    | `idempotency_key` الزامی برای نوشتن‌های idempotent؛ `SELECT … FOR UPDATE` روی شمارنده‌ها؛ تست همزمانی A.5/PE‑0.5                                                                                                                                                                         |
| انحراف `done` در UI توسط انسان                                         | guard فقط برای تسک‌های دارای `exec_task_id`؛ اقدام انسان مجاز است ولی `exec_events` با `actor_type='human'` + `open_item(source='human')` ثبت می‌شود                                                                                                                                     |
| نبود `start_ref`/Git commit                                               | API در شروع hash-only manifest می‌گیرد؛ اگر آن هم موجود/پایدار نباشد، Rule 11 fail-closed است و عبور فقط با waive انسانیِ scope ناموجود ممکن است                                                                                                                                          |
| هزینهٔ LLM بازبینی                                                     | `exec.max_cost_tokens` + `ai_calls` (E.8) + حداکثر ۲ دور                                                                                                                                                                                                                                 |
| پنل کامل = سطح حملهٔ جدید (فرم‌های قفل‌گشایی)                          | همه از endpoint‌های انسانی با `exec:decide` + self‑approval ممنوع + audit + `reason` الزامی + preview تأثیر؛ UI هیچ قدرت اضافه‌ای نسبت به CLI ندارد (A‑8)؛ تست L.4b/L.4c                                                                                                                 |
| فشار برای «اجرای تست توسط خود پلتفرم»                                  | این قابلیت ساخته نمی‌شود (D‑08 بازبینی‌شده): منبع فقط لاگ CI است؛ نبودش ⇒ قاعدهٔ ۱۲ رد + waive انسانی (بدون silent downgrade و بدون host/container)                                                                                                                                      |

**تهدیدهای پذیرفته‌شده و صریح (باید در گزارش نهایی برای انسان بیایند):** (۱) باور لاگ CI یعنی باور
خروجی یک pipeline بیرونی — کاهش‌اش: تطبیق `commit_sha` + `run_id` در `provenance` و رد لاگ بدون خط
نتیجه؛ (۲) خواندن لاگ با توکن read‑only یعنی وابستگی به یک CI بیرونی — در self‑host بدون CI،
`baseline_source='off'` + waive انسانی فعال است (و این **شکست امنیتی** است، نه دور زدن گیت)؛ (۳) اگر CI
مخزن اصلاً تست اجرا نکند، قاعدهٔ ۱۲ همیشه قرمز می‌ماند — عمداً همین‌طور است: «خودم اجرا می‌کنم» به
«در CI سبز است» ترجیح داده نمی‌شود.

`docs/SECURITY.md` به‌روزرسانی: § جدید «exec_control» (تهدیدها/کاهش‌ها + جدول منابع baseline)،
`docs/RUNBOOK.md`: «قفل شدن تسک → dry‑run گیت از CLI/پنل»، «پاکسازی journal معلّق»،
«پیکربندی `exec.ci_log_endpoint` + توکن read‑only»، «restore از بکاپ + verify».

---

## ۱۶. ترتیب اجرا، وابستگی‌ها و برآورد

| فاز            | محتوا                                                                   | وابسته به            | روز‌مهندس (کد+تست+مستند) |
| -------------- | ----------------------------------------------------------------------- | -------------------- | ------------------------ |
| PE‑0           | داربست، مهاجرت ۱۷ جدول (+trigger/REVOKE)، codes، settings، schema:check | —                    | ۱٫۵–۲                    |
| PE‑1 (A)       | ledger + ماشین وضعیت + invariants                                       | PE‑0                 | ۱–۱٫۵                    |
| PE‑2 (B هسته)  | task_start/status/list_open/add_item/resolve                            | PE‑1                 | ۲                        |
| PE‑3 (C)       | Exit Report + Gate ۱۳ قاعده + guard تسک                                 | PE‑2                 | ۲٫۵–۳                    |
| PE‑4 (B ادامه) | evidence/decision/ask_human/policy_check + REST + CLI + approvals       | PE‑3                 | ۳                        |
| PE‑5 (F)       | policy engine + policy config + hook template                           | PE‑4                 | ۱                        |
| PE‑6 (D)       | LEDGER_RULES.md + AGENTS.md + تست رفتاری ۳ تسک                          | PE‑2..PE‑5           | ۱                        |
| PE‑7 (E)       | بازبین خصمانه (`kind:'exec'`) + ابطال hash                              | PE‑3, PE‑4           | ۲–۲٫۵                    |
| PE‑8 (J)       | scope + baseline (فقط لاگ CI + fail closed) + test weakening            | PE‑0, PE‑3           | ۱٫۵–۲                    |
| PE‑9 (G+H)     | requirements registry + plan/deps/blocked                               | PE‑1..PE‑3           | ۲                        |
| PE‑10 (K)      | journal + session_start + reconcile                                     | PE‑3                 | ۱٫۵                      |
| PE‑11 (I)      | facts + verify + links                                                  | PE‑10 (session hook) | ۲                        |
| PE‑12          | **پنل کامل** (۶ جزء) + README/docs + e2e + CI step                      | همه                  | ۳–۳٫۵                    |
| **جمع**        | ۱۳ فاز، ~۵۰۰۰–۶۰۰۰ خط کد                                                |                      | **۲۶–۳۰ روز‌مهندس**      |

**قاعدهٔ ترتیب (به‌روز):** دامنه **کاهش نمی‌یابد** (تصمیم مالک)؛ ترتیب فقط برای حداکثرکردن
ارزش زودرس است: PE‑0…PE‑7 (حلقهٔ کنترل اصلی) → PE‑9 (الزامات/پلن؛ جلوی «حذف بی‌صدای الزام») →
PE‑8 (scope/baseline) → PE‑10 → PE‑11 → PE‑12. تنها حالت کاهش دامنه: تصمیم صریح انسانی
ثبت‌شده با `waive`/`open_item(type='out_of_scope')` — نه تصمیم ایجنت. هیچ فازی با
`skip`/`TODO` تحویل نمی‌شود؛ اگر چیزی لازم شد و در این پلن نبود → `open_item` و توقف.
هیچ معیاری به docker وابسته نیست (D‑08 بازبینی‌شده)، پس هیچ ردیف `not-run`ی از این بابت در گزارش فاز
ثبت نمی‌شود. تنها `not-run`های مشروع همان‌ها هستند که به سرویس بیرونی نیاز دارند (مثلاً لاگ یک run
واقعی در J.7، یا remote CI روی self‑host).

**نقشهٔ شاخه/تگ:** هر فاز = `phase/exec-<N>-<slug>` از `main`، squash‑merge،
تگ `v1.<N>.0-rc.<m>` پس از سبز شدن remote CI (قرارداد `AGENTS.md`).

---

## ۱۷. تعریف «تمام» (Definition of Done) برای این پروژه

1. **۱۱۱ معیار پذیرش A–K + PE‑0/PE‑12 (§۵ تا §۱۳)** تیک‌خورده — شامل افزوده‌های این بازبینی
   (C.9b، J.6b، J.7b، J.7c، L.4b، L.4c)؛ فهرست نهایی با شمارهٔ پایدار در `docs/EXECUTION_CONTROL.md`
   و در `docs/ACCEPTANCE_CRITERIA.md` (جدول فاز `PE-*`). هرکدام با برچسب
   `auto:` به فایل تست یا `manual:` به دستور اجرایی مشخص (قاعدهٔ `AGENTS.md`: بدون اجرای
   واقعی دروازه، سبز اعلام نمی‌شود).
2. `npm run verify` سبز (lint, typecheck, unit, integration, coverage ≥ 80, build) +
   `schema:check` + `docs:check` + `gen:api:check` + `migration-hash` + `i18n-check`.
3. `npm run exec:e2e` سبز در CI (۱۳ صحنه) — **سناریوی بخش ۵ + ۶ مورد ضمیمه**.
4. `docs/LEDGER_RULES.md` + `AGENTS.md` + `docs/EXECUTION_CONTROL.md` + `docs/MCP.md` +
   `docs/API_CONTRACTS.md` + `docs/MCP_CONTRACTS.md` + `docs/DATA_MODEL.md` (§H) +
   `docs/SECURITY.md` + `docs/RUNBOOK.md` + `README.md` + `CHANGELOG.md` به‌روز.
5. تصمیم‌های D‑01…D‑13 در **همین Ledger** به‌عنوان `exec_decisions` با
   `approval_state='approved'` و rationale مالک ثبت شده‌اند (خود‑آزمایی سیستم روی ساخت خودش)؛
   سقف تعداد خط هم به‌صورت یک تصمیم لغو‌شده ثبت می‌شود (نه حذف بی‌صدا).
6. گزارش نهایی **توسط همین سیستم** تولید می‌شود: `exec_ledger_status` + `buildFinalReport`
   (موارد باز، فرض‌ها، تصمیم‌های بدون تأیید، `waived`ها، `not-run`های تست baseline، و
   ابزارهای هرگز‌استفاده‌نشده در §۱۸).
7. خط‌های `local: pass|fail` و `remote: pass|fail|not-configured` در گزارش هر فاز (قاعدهٔ مخزن:
   بدون اجرای واقعی دروازه، سبز اعلام نمی‌شود).

---

---

## ۱۸. وضعیت تصمیم‌ها (OI‑1…OI‑7 **بسته شدند**) و فرض‌های باقی‌مانده

**پاسخ‌های مالک (۲۰۲۶‑10‑17) — مبنای رسمی پیاده‌سازی.** در PE‑۰ به‌عنوان
`exec_open_items(status='resolved', resolved_by='human', source='human', resolution_note=<پاسخ زیر>)`
و `exec_decisions(approval_state='approved')` ثبت می‌شوند تا خودِ سیستم هم گواهی تاریخِ تصمیم داشته باشد.

| ref  | سؤال                                    | پاسخ مالک                                                               | نتیجه در این پلن                                                                                                                                             |
| ---- | --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OI‑1 | Postgres یا SQLite محلی؟                | **Postgres** («وقتی دیتابیس داریم، نیاز به دیتابیس دیگر نیست»)          | D‑01: بدون DB دوم؛ `.agent-ledger/` فقط JSON اختیاریِ فقط‑خواندنی (پیش‌فرض خاموش)                                                                            |
| OI‑2 | ابزارها در `forgepm-mcp` یا MCP مستقل؟  | **یک MCP واحد**                                                         | D‑02/D‑061: همان `ToolRegistry` روی HTTP `/mcp`؛ stdio باینری وجود ندارد؛ بدون بریج و بدون پکیج جدید                                                        |
| OI‑3 | سقف ۸۰۰ خط یا تحقق کامل؟                | **تحقق کامل؛ تعداد خط مهم نیست**                                        | D‑07: سقف خط لغو؛ هر ۱۳ فاز کامل؛ برآورد ۲۶–۳۰ روز؛ سقف کیفی فایل/تابع و «وابستگی غیرضروری ممنوع» پابرجا                                                     |
| OI‑4 | اجرای `test_command` روی سرور یا از CI؟ | **«مطابق استانداردها»**، سپس بازبینی مالک ۲۰۲۶‑۱۰‑۱۷: «وارد docker نشو» | D‑08: **هیچ‌کدام** — نتیجه فقط از لاگ CI خوانده می‌شود؛ OWASP CI/CD SEC‑4 با _نساختنِ_ کانال اجرا رعایت می‌شود. کلیدهای `run_on_host`/`runner.*` وجود ندارند |
| OI‑5 | CLI باینری npm یا اسکریپت مخزن؟         | **«مطابق استانداردها»**                                                 | D‑11: `scripts/ledger-cli.ts` + `npm run ledger` (الگوی ۱۴ اسکریپت tsx موجود مخزن)                                                                           |
| OI‑6 | ۲۸ ابزار یا فقط ۱۲ ابزار core؟          | **ابزار کامل**                                                          | D‑12: هر ۲۸ ابزار ثبت و visible؛ `exec.tools.level` حذف شد؛ کنترل هزینهٔ context با ۴ مکانیزم (§۴.۰)                                                         |
| OI‑7 | پنل کامل یا فقط‑خواندنی + درگاه تأیید؟  | **پنل کامل**                                                            | D‑13: ۶ جزء UI در PE‑12 (جدول + جزییات + فرم‌های قفل‌گشایی + سیاست + تب تسک + Approvals) با تست i18n/contrast/e2e                                            |

**موارد باز جدید (کم‌اهمیت — شروع PE‑۰ را بلوکه نمی‌کنند):**

| ref   | عنوان                                                                                               | نوع        | نیازمند                                                                                                                                                                                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OI‑8  | ~~پذیرش `not-run` برای تست وابسته به docker~~                                                       | —          | **بی‌موضوع شد** (۲۰۲۶‑۱۰‑۱۷): با حذف runner، هیچ تستی به docker وابسته نیست؛ همهٔ معیارهای PE‑8 با Postgres اجرا می‌شوند                                                                                                                                                                                             |
| OI‑9  | self‑host بدون GitHub ⇒ لاگ CI نیست ⇒ `BASELINE_UNAVAILABLE` ⇒ waive انسانی برای هر تسک؛ قابل‌تحمل؟ | design_gap | **پاسخ مالک: docker راه‌حل نیست.** گزینه‌های مجاز: (الف) هر CIای که لاگش از `exec.ci_log_endpoint` خوانده شود (GitLab/Jenkins/Azure یا pipeline محلی — سازگار با `provider='generic'`)، (ب) `baseline_source='off'` + پذیرش اینکه قاعدهٔ ۱۲ فقط با waive انسانی عبور می‌کند. اجرای خودکار در container ساخته نمی‌شود |
| OI‑10 | تأیید انسانی با `admin` موجود یا اسکوپ جدید `exec:decide`؟                                          | design_gap | تصمیم PE‑4 (پیشنهاد: `exec:decide` — اصل کمترین دسترسی)                                                                                                                                                                                                                                                              |

**فرض‌های من (بدون تأیید؛ اگر اشتباه باشند هزینهٔ بازگشت دارند):**

- A‑1: ابزارهای `exec.*` برای actor نوع `agent` و `user` با اسکوپ `ledger:*` فعال‌اند؛ انسان‌ها
  عموماً از REST/پنل/CLI استفاده می‌کنند.
- A‑2: یک `exec_task` به یک `work_item` نگاشت می‌شود (۱:۱)، نه برعکسِ چندتایی.
- A‑3: `exec_events` جای `mcp_tool_calls` را نمی‌گیرد؛ لاگ خام همان‌جا می‌ماند (تکرار داده ممنوع).
- A‑4: واژه‌نامهٔ «معیار مبهم» برای انگلیسی و فارسی است؛ برای زبان‌های دیگر `CRITERION_NOT_CHECKABLE`
  محافظه‌کارانه رد می‌کند تا انسان بازبینی کند.
- A‑5: در نسخهٔ ۱، `waive` معیار فقط با `approval_requests` ممکن است (نه صرفاً با داشتن اسکوپ decide).
- A‑6: `exec_review` روی همان `review_runs` نوشته می‌شود تا پنل Reviews رایگان کار کند.
- A‑7 (از D‑12): اگر در تست رفتاری `D.3` نرخ ثبت < ۸/۱۰ شد، **اول `docs/LEDGER_RULES.md` اصلاح
  می‌شود**؛ تغییر تعداد/توضیح ابزارها فقط با تأیید انسان (حذف خودسرانهٔ ایجنت ممنوع).
- A‑8 (از D‑13): پنل هیچ endpoint نوشتن جدیدی (جز dry‑run گیت) ندارد و همان مسیرهای انسانی CLI را
  صدا می‌زند ⇒ UI قدرت اضافه‌ای ایجاد نمی‌کند.
- A‑9 (از D‑08): «استانداردها» در این مخزن یعنی داکر روی همان host (بدون K8s/VM اضافه)؛ اگر محیط
  اجازه نداد، منبع ۳ (blocked + waive انسانی) فعال می‌ماند و **هیچ fallback خاموشی اضافه نمی‌شود**.

**تصمیم‌های فنی این سند** (هر کدام در PE‑۰ با `ledger_record_decision` ثبت می‌شود؛
D‑01/02/07/08/11/12/13 به‌دلیل `touches` مرتبط در سطح `approval` و «approved by مالک» ثبت می‌شوند):
`Postgres-only ledger`، `single MCP surface`، `gate single entry + transition guard + gate stamp`،
`settings-based policy`، `code-allocated readable ids`، `approval_requests as the human channel`،
`review-engine reuse for adversarial`، `full tool inventory (no core/full levels)`،
`full panel`، `repo-script CLI`، `CI-log-only baseline (fail closed)`،
`fail-closed offline behavior`، `line-count cap revoked (owner decision)`.

---

## ۱۹. چک‌لیست شروع اجرا (گام‌های اول پس از تأیید این سند)

```
1) PE‑0 کد: ماژول + 0010_exec (۱۷ جدول، trigger/REVOKE) + ۱۸ کلید settings + codes.ts
2) npm run ledger -- enable exec_control        → modules.exec_control.enabled=true (+ audit)
3) req_add …  برای هر بند الزام این سند (هر § = یک REQ با quote عین متن؛ ~۲۱ REQ از §۲ و §۵…§۱۸)
4) record_decision برای D‑01…D‑13                → سطح ریسک را کد از touches تعیین می‌کند، نه ایجنت
5) npm run ledger -- approve <D-id>               → هفت تصمیم approval (مبنا: پاسخ‌های §۱۸)
6) ledger_add_open_item برای OI‑8…OI‑10 (blocks=false) + ask_human برای OI‑9
7) task_split: PE‑0…PE‑12 با depends_on طبق §۱۶ و allowed_paths هر فاز
8) fact_record(source=code) برای قراردادها (unitOfWork/outbox/ModuleRegistry/REPO_MOUNT_ROOT)
   + baseline_capture                            → منبع ci از لاگ CI؛ نبود ⇒ fail closed
9) exec_submit_exit_report + exec_task_complete برای PE‑0 → اگر چیزی باز بماند گیت باید رد کند
```

> **یادآوری خود‑ارجاع:** PE‑۰ تنها فازی است که «پیش از کامل بودن Ledger» اجرا می‌شود (چون Ledger را
> می‌سازد). برای همان فاز، قوانین `docs/LEDGER_RULES.md` دستی رعایت و در `exec_events` لاگ می‌شوند؛
> از PE‑۱ به بعد همه‌چیز از مسیر ابزار/گیت می‌رود. این استثنا یک‌بار‑مصرف است و در
> `docs/DECISIONS.md` ثبت می‌شود.
>
> **منتظر تأیید شما:** شروع از PE‑۰ (تا PE‑۱۲) یا هر بازه‌ای که تعیین کنید.
