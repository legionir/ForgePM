# Execution Control Plan — «سیستم کنترل اجرای ایجنت» در ForgePM (PE‑0 … PE‑12)

> **وضعیت:** پیش‌نویس پلن — **هیچ کدی در این مرحله نوشته نمی‌شود.**
> **منبع نیاز:** پرامپت اجرایی «Agent Execution Control» + ضمیمهٔ ۱ (بخش‌های G تا K).
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

| نیاز پرامپت | وضعیت در ForgePM | تصمیم اجرایی |
|---|---|---|
| زبان TS، Node ≥ ۲۰ | ✅ Node 22 (`engines: >=22 <23`) | بدون تغییر؛ هدف Node 22 |
| ذخیره‌سازی SQLite + `.agent-ledger/ledger.db` | ❌ Postgres تنها منبع حقیقت پایدار (`README`/`ARCHITECTURE`) | **فقط Postgres**؛ بدون DB دوم؛ کش آفلاین = JSON فقط‑خواندنی، پیش‌فرض خاموش (D‑01، تأییدشده) |
| MCP server | ✅ `/mcp` استریمبل HTTP + `forgepm-mcp` (stdio proxy) | **یک MCP واحد**: ابزارها در `ToolRegistry` موجود با اسکوپ‌های `ledger:*`؛ ورود ایجنت همان `forgepm-mcp` است — سرور/بریج دوم نداریم (D‑02، تأییدشده) |
| اعتبارسنجی zod | ✅ `packages/shared` (zod contracts) | همهٔ ورودی‌ها و خروجی‌ها؛ `strictObject` + `forbidNonWhitelisted` |
| تراکنش | ✅ `unitOfWork` (domain + audit + outbox در یک تراکنش) | هر نوشتن ledger داخل `unitOfWork`؛ `exec_events` همان‌جا append می‌شود |
| شناسهٔ خوانا (`T-001`) | ⚠️ UUIDv7 | الگوی `allocateNumber` (UPDATE…RETURNING اتمیک) برای کد خوانا در هر پروژه |
| تأیید انسانی / approval | ✅ `approval_requests` + `approval_decide` (human only) + `self‑approval` ممنوع | action‌های جدید `exec.*`؛ پنل Approvals بدون تغییر منطقی |
| بازبین با LLM + ایزولاسیون ورودی | ✅ `review/engine.ts`، `contract.ts` (evidence)، `stub-provider` (تست قطعی)، `diff-slot`، `sources.ts` (`REPO_MOUNT_ROOT`) | `kind:'exec'` + مراحل `exec:*`؛ تست‌ها با stub provider |
| WorkItem سلسله‌مراتب + روابط | ✅ `parent_id`، `work_item_relations(blocks/relates_to/duplicates)`، `acceptance_criteria jsonb` | زیرتسک = `parent_id`؛ **وابستگی با چرخه‌سنجی در جدول جدید `exec_task_deps`** (§H) |
| موتور گراف/چرخه | ✅ `packages/core/src/graph.ts` | تست‌محور برای `task_split` و `req_link` |
| ماژول‌های اختیاری + enable flag | ✅ `ModuleRegistry` (`modules.<name>.enabled`) | `exec_control` ثبت ولی خاموش پیش‌فرض |
| Settings با واریث سیستم←سازمان←پروژه | ✅ `settings-registry.ts` + `getEffective` | سیاست ریسک و هارنس به‌جای `policy.json` روی فایل (§۲ D‑05) |
| audit trail | ✅ `recordAudit` (شکست = rollback) | هر mutation ledger یک `audit_event` |
| لاگ فراخوانی ابزار | ✅ `mcp_tool_calls` (mask + cap 50KB) | `exec_events` فقط برای تغییر وضعیت‌ها؛ ردیابی خام از `mcp_tool_calls` |
| CLI انسانی | ❌ فقط `scripts/*.ts` با tsx (بدون باینری `bin` در مخزن) | **استاندارد خودِ مخزن**: `scripts/ledger-cli.ts` + `npm run ledger -- …` روی REST (بدون SQL مستقیم)؛ پکیج npm جدا **نه** (D‑11) |
| `test_command` اجراشده توسط کد | ⚠️ اجرای کد مخزن در پروسهٔ خودی ممنوع | **بدون اجرا**: نتیجه فقط از لاگ CI همان `sha` خوانده می‌شود؛ نبود لاگ ⇒ قاعدهٔ ۱۲ رد (D‑08، §۱۳) |
| Hookها (PreToolUse) | ❌ | اسکریپت تولید + تست اسکیمای `.claude/settings.json`؛ تعهد = «مسدودسازی سمت سرور» (§۱۰، PE‑5 F.9) |

**نتیجه:** ~۶۵٪ زیرساخت لازم وجود دارد. کار اصلی، **قلمرو جدید داده + دروازهٔ قطعی +
جدول سیاست + ایزولاسیون بازبینی + journal/resume** است، نه ساخت اپلیکیشن جدید.

---

## ۲. انحراف‌های آگاهانه از پرامپت — **تصمیم‌های مالک ثبت و نهایی شد**

همهٔ بندهای زیر در PE‑۰ به‌عنوان `exec_decisions` (سه‌تای `approval`) و `exec_events` ثبت می‌شوند؛
ستون آخر «وضعیت» است، نه سؤال باز.

| id | انحراف | چرا | ریسک / راه‌حل | وضعیت |
|---|---|---|---|---|
| D‑01 | Ledger فقط Postgres؛ هیچ DB دوم (SQLite حذف شد) | Gate باید مستقل از ماشین ایجنت باشد؛ چند‌مستأجیری؛ بکاپ/ریالتن/`schema:check` موجود | سرور پایین ⇒ ابزار نوشتن **fail closed** با خطای روشن؛ کش آفلاین فقط‑خواندنی و اختیاری (پیش‌فرض خاموش) | ✅ **approved** (مالک) |
| D‑02 | یک MCP واحد (`forgepm-mcp`/`/mcp`)؛ نه `agent-ledger` جدا، نه بریج جدید | جلوگیری از دو منبع حقیقت؛ استفاده از auth/scope/audit/rate-limit/`mcp_tool_calls` موجود | حجم `tools/list` با توضیح ≤ ۲۰۰ کاراکتر + سقف خروجی کنترل می‌شود (نه با حذف ابزار — D‑12) | ✅ **approved** (مالک) |
| D‑03 | تسک‌ها روی `work_items` نگاشت می‌شوند | بدون دوگانگی وضعیت؛ پنل/audit/approval رایگان | همگام‌سازی دوطرفه ⇒ تک‌نویس: فقط `exec` وضعیت ledger را تغییر می‌دهد؛ `work_item_transition` به `completed` با guard + مهر گیت مسدود است (I‑1) و UI از همین endpoint‌ها می‌نویسد | ✅ approved (PE‑0) |
| D‑04 | `AGENTS.md` مخزن «منبع حقیقت پلن فاز» است؛ قوانین جدید در `docs/LEDGER_RULES.md` | `docs:check` + `EXECUTION_PLAN` منبع حقیقت‌اند؛ جلوگیری از تضاد | دو فایل → `AGENTS.md` فقط ۱ بخش ارجاع + «ممنوعه‌ها» (≤ ۲۰ خط اضافه) | بی‌خطر |
| D‑05 | `policy.json` → تنظیم `exec.policy` (JSONB، zod، override در سطح سازمان/پروژه) | منبع حقیقت واحد + بدون restart + قابل audit + واریث | ویرایش فایل ساده‌تر است ⇒ `npm run policy:print/set` + صفحهٔ `exec-policy` در پنل همان سهولت را می‌دهند | ✅ approved (PE‑0) |
| D‑06 | `start_ref` + `tree_hash` توسط **hook/اسکریپت سمت ایجنت** (`scripts/ledger-hook`) یا `baseline_capture`/`scope_check` خوانده می‌شود | سرور به clone ایجنت دسترسی ندارد (runner فقط برای اجرای تست mount می‌شود) | اگر هیچ‌کدام نبود → manifest از hash فایل‌ها، وگرنه `scope:'unknown'` و **رد قاعدهٔ ۱۱** (fail closed) | بی‌خطر |
| D‑07 | حجم ~۵۰۰۰–۶۰۰۰ خط، نه ۴۰۰–۸۰۰ | ضمیمه دامنه را به ۱۱ بخش + پنل کامل + ۲۸ ابزار گسترش داد | مالک: «تعداد خط مهم نیست، تحقق کامل ارزش مهم است» ⇒ سقف خط لغو، سقف فایل/تابع و «وابستگی غیرضروری ممنوع» باقی می‌ماند (تست ساختاری C.11) | ✅ approved (مالک) |
| D‑08 | **(بازبینی مالک ۲۰۲۶‑۱۰‑۱۷)** baseline فقط از **لاگ CI** خوانده می‌شود؛ ForgePM هیچ کدی اجرا نمی‌کند — نه host، نه container/docker | مالک: «وارد docker نشو؛ docker چرا لازم است؟». اجرای تست کارِ CI خودِ مخزن است و لاگش منبع قابل‌بازبینی همان اجرا؛ یک runner یعنی یک سطح حمله + یک وابستگی استقرار اضافه، بدون ارزش افزودهٔ امنیتی | نبودِ لاگ CI ⇒ قاعدهٔ ۱۲ **رد** (`BASELINE_UNAVAILABLE`)، نه `skipped`؛ عبور فقط با waive صریح انسانی که در گزارش نهایی برجسته می‌شود. کلیدهای `exec.runner.*` و فایل‌های `scripts/runner/*` از پلن حذف شدند | ✅ approved (مالک) |
| D‑09 | افزودن `0010_exec.migration.ts` (۱۷ جدول) و **یک خط** به `schema-check.ts` (anchors) | `schema:check` بلوک §H را نمی‌شناسد | تنها تغییر کد خارج از قلمرو ماژول؛ در فاز PE‑0 | بی‌خطر |
| D‑10 | ارجاع `out_of_scope` در نسخهٔ ۱ فقط `open_item(type=out_of_scope)` است نه WorkItem جدا | جلوگیری از تورم موجودیت | گم‌شدن → همه در `req_coverage`/`ledger_status`/پنل دیده می‌شوند | بی‌خطر |
| D‑11 | `ledger-cli` = اسکریپت مخزن (`scripts/ledger-cli.ts` + `npm run ledger`)، نه باینری npm | «مطابق استانداردها» = استاندارد خودِ مخزن: همهٔ ابزارها `scripts/*.ts` با tsx (۱۴ مورد)، بدون `bin` | کشف‌پذیری برای تیم بیرونی ⇒ در `README` + `docs/RUNBOOK.md` مستند؛ در صورت نیاز بعداً به پکیج `@forgepm/ledger-cli` منتقل می‌شود (بدون تغییر API) | ✅ approved |
| D‑12 | **هر ۲۸ ابزار** ساخته و فعال می‌مانند؛ هیچ سطح «core/full» و هیچ ابزار مخفی | مالک: «ابزار کامل باشه» | هزینهٔ context با ۴ مکانیزم: توضیح ≤ ۲۰۰ کاراکتر، `readOnlyHint/destructiveHint`، سقف خروجی + `truncated`، و `session_start` به‌عنوان تنها «نقطهٔ شروع» | ✅ approved (ریسک ثبت → PE‑6 D.3) |
| D‑13 | **پنل کامل** (۲ صفحه + تب تسک + فرم‌های تأیید) به‌جای فقط‑خواندنی | پنل تنها مسیر مطمئن برای تأیید انسانی است؛ CLI نباید تنها راه باشد | هزینهٔ UI + i18n + a11y ⇒ PE‑1۲ جدا با تست‌های موجود (`i18n-check`, `chain.spec`, contrast) | ✅ approved |

**قانون (به‌روز):** همهٔ D‑ها **مؤیَد**اند و پیاده‌سازی می‌شوند؛ همچنان در PE‑۰ با
`req_add` + `ledger_record_decision` ثبت و (برای D‑01/02/07/08) با
`npm run ledger -- approve <D-id>` در Ledger تأیید رسمی می‌شوند — تا آن ثبت، Gate PE‑0 باز نمی‌ماند
(خود‑آزمایی: این سیستم باید روی ساختن خودش هم اجرا شود).

---

## ۳. معماری هدف

```
 agent (Claude Code / Cursor / Codex …)
   │  یک MCP واحد: `forgepm-mcp` (stdio) یا HTTP /mcp  —  [اختیاری] JSON snapshot فقط‌خواندنی
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
   └─ BullMQ jobs (exec.verify_facts, exec.review) از طریق outbox

   baseline هرگز با اجرای کد ساخته نمی‌شود: `exec_baseline_tests` فقط از **لاگ CI** همان
   `sha` پر می‌شود (fetch + parse). لاگ نبود ⇒ قاعدهٔ ۱۲ رد — fail closed (D‑08).

### ۳.۱ لایه‌بندی و مسیر فایل‌ها

| لایه | مسیر | محتوا |
|---|---|---|
| قرارداد | `packages/shared/src/schemas-exec.ts` | zod: `exitReportSchema`, `openItemSchema`, `policySchema`, `reqSchema`, `factSchema`, `journalSchema`, `toolOutputs` |
| enum‌ها | `packages/shared/src/enums.ts` | افزودن `EXEC_*` enum‌ها (بدون حذف مقدار قبلی) |
| خطاها | `packages/shared/src/error-codes.ts` | §۳.۳ |
| دامنه/کد قطعی | `packages/core/src/exec/` | ۱۶ فایل (زیر) |
| سرویس/REST | `apps/api/src/modules/exec/` | `module.ts`, `service.ts`, `mcp-tools.ts`, `routes.ts`, `approvals.ts` |
| worker | `apps/worker/src/handlers.ts` (ثبت) + `apps/worker/src/exec/` | handlerهای `exec.baseline`, `exec.verify_facts`, `exec.review` |
| CLI انسان | `scripts/ledger-cli.ts` (+ `npm run ledger`، `npm run policy:print/set`) | §۹.۵ — استاندارد مخزن: اسکریپت tsx، بدون پکیج npm جدا (D‑11) |
| پنل (کامل) | `pages/exec-tasks.ts`, `pages/exec-ledger.ts`, `pages/exec-policy.ts`, تب `exec` در `work-item-detail` | §۱۳ (PE‑12) — مشاهده + تمام قفل‌گشایی‌ها (fa/en، RTL) |
| مستند | `docs/EXECUTION_CONTROL.md`, `docs/LEDGER_RULES.md`, افزودن §H به `DATA_MODEL.md` | §۱۴ |

`packages/core/src/exec/`:
`codes.ts` (شناسه خوانا) · `open-items.ts` (ماشین وضعیت + قوانین بستن) · `evidence.ts`
(اعتبارسنجی ref) · `policy.ts` (طبقه‌بندی ریسک) · `exit-report.ts` (تبدیل به آیتم + validate) ·
`gate.ts` (۱۳ قاعده) · `requirements.ts` (پوشش، needs_revisit) · `plan.ts` (deps/چرخه/block/unblock) ·
`facts.ts` (hash/stale/supersede/promote) · `scope.ts` (glob + diff · test weakening) ·
`journal.ts` (started→unknown) · `session.ts` (بستهٔ اولویت‌دار با سقف) · `baseline.ts` (parse لاگ CI
+ fail‑closed) · `types.ts`. **`runner.ts` وجود ندارد**: در کل `packages/core/src/exec/**` هیچ
`child_process`/`spawn`/`exec` مجاز نیست — گارد J.7c: `tests/unit/exec-no-spawn.test.ts`.

### ۳.۲ اصول تغییرناپذیری (Invariant‌ها) — همان‌ها که تست می‌شوند

- **I‑1** تنها نقطهٔ نوشتن `status='done'` تابع `exec_gate_complete` است؛ هر مسیر دیگر
  (`work_item_transition` به `completed` وقتی تسک در ledger است) باید رد شود.
- **I‑2** هیچ رکورد ledger حذف نمی‌شود. `exec_events`، `exec_evidence`، `exec_action_journal`
  در DB با `BEFORE UPDATE OR DELETE` trigger + `REVOKE UPDATE, DELETE` محافظت می‌شوند.
- **I‑3** ایجنت نمی‌تواند وضعیت یک آیتم مسدودکننده را به `accepted|deferred|wont_fix` ببرد
  (نه ابزار، نه REST، نه CLI با کلید ایجنت — کلید `fpm_` با اسکوپ `ledger:decide` انسان است).
- **I‑4** سطح ریسک فقط از `touches + reversible` + جدول سیاست محاسبه می‌شود؛ فیلد ارسالی
  ایجنت به نام `risk_level` در schema **وجود ندارد** (ورودی ناشناخته = خطا).
- **I‑5** `verified` روی معیار پذیرش فقط با evidence معتبر + (برای تسک‌های با هارنس)
  نتیجهٔ اجرای قطعی تست set می‌شود؛ ایجنت هرگز `verified` نمی‌نویسد.
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
APPROVAL_PENDING 409 · SELF_APPROVAL_FORBIDDEN 403   (موجود: FORBIDDEN_SELF_APPROVAL)
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
| 10 | `exec_req_tasks` | `req_id, task_id, criterion_ids jsonb, created_at` | `UNIQUE(req_id, task_id)`؛ جای‌نمای `req_link_task` |
| 11 | `exec_task_deps` | `task_id, depends_on_task_id, created_at` | `CHECK task_id <> depends_on_task_id`؛ چرخه در کد (گراف) |
| 12 | `exec_facts` | `id, code 'F-###', key, value, kind('fact','assumption'), source('code','docs','human','tool_output','agent_guess'), source_ref, files jsonb, file_hashes jsonb, verified_at, status('active','stale','rejected','superseded'), superseded_by, created_at` | `kind='fact' ⇒ source<>'agent_guess'`؛ `(project_id, key)` unactive یکتای جزئی |
| 13 | `exec_fact_decisions` | `fact_id, decision_id, created_at` | پل stale → needs_revisit |
| 14 | `exec_baseline_tests` | `id, task_id, test_name, result_at_start('pass','fail','skip'), assertion_count, source('ci','human'), provenance jsonb, captured_at` | فقط writer = کد (parser لاگ CI)؛ `source='human'` **فقط** با approval انسانی و در گزارش نهایی برجسته؛ `provenance` = `{run_id, sha, job, started_at, exit_code, sha256_log}` |
| 15 | `exec_action_journal` | `id, task_id, code 'AJ-###', action, target, idempotent, expected_effect, pre_state_ref, status('started','done','failed','unknown'), started_at, finished_at, result_ref, note` | `started` بازنشانی خودکار به `unknown` در `session_start` |
| 16 | `exec_code_seq` | `project_id, prefix('T','C','OI','D','Q','F','REQ','AJ'), seq` | شمارندهٔ کد خوانا؛ `allocateLedgerCode` با `SELECT … FOR UPDATE` (تست همزمانی PE‑0.5) |
| 17 | `exec_gate_checks` | `id, task_id, report_id, ok, blocked_by jsonb, gate_version, tree_hash, run_source, created_at` | **مهرِ Gate**: هر ارزیابی (شامل رد) یک ردیف غیرقابل‌حذف؛ `done` فقط وقتی latest با `tree_hash = current` و `ok=true` باشد — حتی اگر کسی SQL مستقیم بزند |

**افزودنی‌های سازگار (additive) به جداول موجود** (هیچ ستون/جدول قبلی حذف یا ویرایش نمی‌شود):

- `work_items`: `exec_task_id uuid NULL REFERENCES exec_tasks(id)` (ستون add-only)
  + ایندکس جزئی `WHERE exec_task_id IS NOT NULL`.
- `settings`: بدون تغییر ساختار؛ کلیدهای جدید (§۳.۴).
- `approval_requests`: بدون تغییر ساختار؛ فقط مقدار جدید در `action` (متن آزاد است).

**DROP در مهاجرت بعدی (`0011_exec_tail`) فقط اگر لازم شد:** هیچ. همه چیز با add-only پیش می‌رود.

### ۴.۱ کلیدهای `SETTING_DEFINITIONS` (جدید)

```
modules.exec_control.enabled            bool  = false
exec.policy                    jsonb   = POLICY_DEFAULT (§۶)            (قابل override در پروژه)
exec.test_command              string  = ''   (فقط می‌گوید کدام کار CI این نتایج را تولید می‌کند؛ اجرا در CI خودِ مخزن)
exec.test_result_parser       jsonb   = { "pass":[…], "fail":[…], "skip":[…] } regex‌های نام TEST
exec.protected_test_globs     array   = ["**/*.test.ts","**/test/**/*.ts","**/e2e/**/*.spec.ts"]
exec.allowed_repo_roots        array   = []                              (prefix-safe، مثل github/config.ts)
exec.baseline_source           enum    = 'auto' | 'ci' | 'off'   (auto = تلاش برای خواندن لاگ CI همان sha)
exec.ci_log_endpoint           string  = ''       (مثلاً https://api.github.com/repos/{owner}/{repo}/actions/runs/{id}/logs)
exec.ci_log_secret_name        string  = ''       (نام کلید `secrets` برای توکن read-only لاگ CI)
exec.evidence_max_bytes        int     = 131072
exec.session_output_max_bytes  int     = 8192
exec.tool_output_max_bytes     int     = 16384
exec.max_review_rounds         int     = 2
exec.require_review_for_done   bool    = true
exec.block_transition_when_gate_fails bool = true
exec.stale_check_on_start      bool    = true
```

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
`session_start` تنها «نقطهٔ شروع» معرفی شده در قوانین است. اگر در تست رفتاری PE‑6 ابزاری
هرگز صدا زده نشد، **حذف نمی‌شود**؛ در گزارش نهایی با دلیل فهرست می‌شود (D‑12).

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
- [ ] PE‑0.8 `remote:` — سبز شدن CI روی PR. در PR #9 اجرا **شروع نشد** (صورتحساب Actions؛
      «recent account payments have failed») ⇒ `cannot-run`. تا این سبز نشود PE‑0 **بسته
      محسوب نمی‌شود** (طبق اصل ۱۲ پلن: fail closed، حتی علیه خودمان).

**راهنمای تکرار محلی (بدون docker):**
`node apps/web/scripts/dev-postgres.mjs` (پورت ۵۴۳۳) یا `@embedded-postgres/linux-x64` روی پورت دلخواه،
سپس `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/forgepm_test FORGEPM_TEST_NO_REDIS=1 npx vitest run --project integration tests/integration/exec-ledger-invariants.test.ts`.

---

## ۶. PE‑1 (بخش A) — Ledger: تسک، معیار، آیتم باز، رویداد، قوانین بستن

**کد قطعی:** `exec-open-items.ts` (ماشین وضعیت)، `exec-codes.ts`، قوانین `CHECK` DB.

**قوانین:** آیتم `blocks_completion=true` فقط با `resolved|not_applicable` و
`resolution_note ≥ 20 کاراکتر` بسته می‌شود؛ `accepted|deferred|wont_fix` فقط با
`resolved_by='human'` (مسیر انسانی = `approval_requests` یا CLI). تغییر وضعیت → `exec_events`.

**معیارهای پذیرش بخش A**

- [ ] A.1 مکالمه پاک و نشست تازه → `exec_ledger_status` تمام وضعیت (تسک‌ها، آیتم‌ها،
      سؤالات، تصمیم‌ها، معیارهای بدون evidence) را از DB برمی‌گرداند؛ تست: call بعد از `reset()` harness.
- [ ] A.2 هیچ مسیر حذفی نیست: لیست ابزارها، لیست routeها، و grep روی SQL مولد (تست واحد روی registry).
- [ ] A.3 `ledger_resolve_item(status:'deferred'|'accepted'|'wont_fix')` با actor=agent روی آیتم
      مسدودکننده → `LEDGER_TRANSITION_NOT_ALLOWED` (تست خودکار + تست actor=human سبز).
- [ ] A.4 هر تغییر وضعیت دقیقاً یک ردیف `exec_events` با `payload.before/after` (تست شمارش).
- [ ] A.5 ورودی نامعتبر (عنوان ۳ کاراکتر، enum غلط، UUID نامعتبر، فیلد اضافه) → خطای ساختارمند
      با `needed_action`، نه کرش، نه پذیرش (تست پارامتریک ۱۲ حالت).
- [ ] A.6 وضعیت تسک و `closed_at` با هم اتمیک؛ `done` بدون `closed_at` غیرقابل‌درج (CHECK).
- [ ] A.7 `blocks_completion=true` و `status='resolved'` با نوت خالی/کوتاه → رد (تست).
- [ ] A.8 آیتم بدون `task_id` مجاز نیست؛ FK ویرال → `NOT_FOUND` (نه orphan).
- [ ] A.9 ترجمه fa/en برچسب وضعیت‌ها در پنل با `i18n-check.mjs` سبز (parity).

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

- [ ] B.1 هر ابزار schema دقیق + `strict`؛ تست پارامتریک «فیلد ناقص/اضافه» برای ۵ ابزار (۲۰+ حالت).
- [ ] B.2 `exec_task_start` با معیار مبهم (`"the feature works well"`, `"امن باشد"`) رد؛
      با معیار قابل‌بررسی پذیرفته (جدول ۱۰ مثال مثبت/منفی در تست واحد، از جمله مثال فارسی).
- [ ] B.3 `ledger_add_open_item(type:'commitment'|'incomplete_requirement', blocks_completion:false)`
      بدون `why_not_blocking ≥ 40` کاراکتر → رد (تست).
- [ ] B.4 خروجی `task_start` شامل `task_id`, `code`, `criterion_ids` و `allowed_paths` است و
      `work_item_id` معتبر ساخته شده (تست integration).
- [ ] B.5 `ledger_status` با ۰ تسک، خروجی `{empty:true}` با هدایت به `exec_task_start` (تست).
- [ ] B.6 هر فراخوانی در `mcp_tool_calls` ثبت می‌شود (ورودی ماسک‌شده) — تست با dispatch واقعی.
- [ ] B.7 rate limit و scope check بدون تغییر رفتار: کلید `read`-only نمی‌تواند بنویسد (`FORBIDDEN_SCOPE`).
- [ ] B.8 idempotency: تکرار `exec_task_start` با `idempotency_key` یکسان = یک تسک (تست).

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
```

هر قاعده یک تابع خالص جدا (`rule01…rule13`) با `evalRule(ctx)` → `BlockedRef[]`.
**ترتیب و شمارهٔ قاعده ثابت است و در مستندات و تست‌ها قفل می‌شود** (`gate.rules.test.ts` یک
snapshot از شماره‌ها می‌گیرد تا افزودن/جابه‌جایی تصادفی ممکن نباشد).

| قاعده | شرط | منبع | پیاده‌سازی |
|---|---|---|---|
| 1 | گزارش کامل و معتبر | A/C | validate + ارجاع `report_id` |
| 2 | صفر آیتم `blocks_completion` در `open/blocked/awaiting_human` | A | `exec_open_items` |
| 3 | هر معیار ≥ ۱ evidence معتبر یا `waived` با approval | A/B | `exec_criteria/evidence` |
| 4 | صفر decision `pending/rejected` با تغییر اعمال‌شده | F | join `approval_requests` + journal `done` |
| 5 | صفر سؤال `blocking` بی‌پاسخ | B | `exec_questions` |
| 6 | صفر تست `fail`؛ `not_run` فقط با دلیل + آیتم متناظر | C | `tests_*` + open_item مطابقت |
| 7 | بازبینی نسخهٔ فعلی انجام‌شده و آیتم‌هایش بسته | E | `exec_reviews.tree_hash = worktree_hash` |
| 8 | پوشش ۱۰۰٪ REQهای وصل‌شده (معیار verified + evidence) | G | `exec_req_tasks` |
| 9 | فرزندان `done` (یا لغو با تأیید) + پیش‌نیازها `done` | H | `parent_id`, `exec_task_deps` |
| 10 | صفر فکت `stale/rejected` که تصمیم فعال به آن وابسته است | I | `exec_fact_decisions` |
| 11 | هیچ فایل خارج از `allowed_paths` بدون تأیید | J | `scope.ts` + `tree_hash` |
| 12 | اجرای **قطعی** `test_command`: صفر تست baseline شکسته/ناپدید/تضعیف | J | `baseline.ts` + job |
| 13 | صفر ردیف journal در `started/unknown` | K | `journal.ts` |

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

- [ ] C.1 یک آیتم مسدودکننده باز ⇒ همیشه `ok:false` (تست، ۳ ورودی متفاوت).
- [ ] C.2 معیار بدون evidence ⇒ تسک بسته نمی‌شود؛ با evidence سبز می‌شود.
- [ ] C.3 حذف `incomplete` از Exit Report → `UNPROCESSABLE`؛ `incomplete:[]` بدون
      `none_confirmed` → `UNPROCESSABLE`؛ با `none_confirmed.incomplete=true` → سبز.
- [ ] C.4 هر آیتم `incomplete`/`assumption`/`risks_found`/`tests_not_run`/`out_of_scope_findings`
      **توسط کد** در `exec_open_items` با `source='exit_report'` ظاهر می‌شود (تست شمارش + dedup با ref).
- [ ] C.5 هیچ مسیر دیگری `done` نمی‌کند (تست نفوذ: `work_item_transition`, REST, SQL مستقیم، CLI).
- [ ] C.6 `finalReport` دقیقاً با محتوای Ledger برابر است: تست با مقایسهٔ count/کدها (نه متن آزاد).
- [ ] C.7 قاعدهٔ ۴: decision `approval` با journal `done` ولی بدون approved → رد؛ بعد از approve → سبز.
- [ ] C.8 قاعدهٔ ۶: تست `fail` و `not_run` بدون آیتم متناظر → رد.
- [ ] C.9 قاعدهٔ ۱۳: journal `started` → رد؛ پس از `journal_done` → سبز.
- [ ] C.10 خروجی `blocked_by` برای هر ۱۳ قاعده با fixture جدا تست می‌شود (۱۳ تست unit).
- [ ] C.9b مهر Gate: درج دستی `status='done'` بدون مهر معتبر ⇒ `exec_ledger_status` و
      `exec_ledger_reconcile` آن را به‌عنوان `drift: gate stamp missing` گزارش می‌کنند (تست).
- [ ] C.11 `gate.ts` ≤ ۴۰۰ خط و هر قاعده ≤ ۶۰ خط (تست با خواندن فایل، مثل `tests/unit/eslint-boundaries.test.ts`).

---

## ۹. PE‑4 (بخش B ادامه) — Evidence، Decision، ask_human، policy_check، CLI و REST

### ۹.۱ `ledger_add_evidence` (ادعای بی‌مدرک ممنوع)

| kind | قواعد `ref` |
|---|---|
| `test_output` | `payload_inline` یا `ref = "ci:<run_id>:<job>"`؛ نرمال‌سازی ANSI؛ ≥ ۱ خط نتیجه از `exec.test_result_parser`؛ `pass/fail/skip` استخراج و در `meta` ذخیره؛ در دسترس نبودن ref → `EVIDENCE_UNAVAILABLE` |
| `diff` / `file` | `ref = "path:…"` یا `"commit:<7-40 hex>:path"`؛ `path` داخل `exec.allowed_repo_roots` (prefix-safe، الگو: `github/config.ts`)؛ hash فایل = `sha256(content)`؛ فایل ناموجود → `EVIDENCE_INVALID` |
| `command_output` | `ref="cmd:<journal id>"` یا inline با `summary ≥ 40` + خروجی ≥ ۲۰۰ کاراکتر |
| `manual_check` | `actor_type='human'` الزامی (ایجنت نمی‌تواند manual_check ثبت کند) |

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
+ تسک `awaiting_review` با `blocked_on_kind='question'`. سکوت ≠ تأیید: هیچ timeout تأییدی وجود ندارد
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

- [ ] B.9 `record_decision(touches:['public_api'])` **همیشه** `approval`؛ حتی اگر ایجنت
      `reversible:true` و متن «بدون ریسک» بفرستد (تست؛ ورودی `risk_level` هم reject می‌شود — I‑4).
- [ ] B.10 `add_evidence(ref:'src/does-not-exist.ts')` → `EVIDENCE_INVALID`؛ `test_output` ۳ خطی
      بدون خط نتیجه → `EVIDENCE_INVALID`؛ با خروجی واقعی → `verified_at` + معیار `verified`.
- [ ] B.11 `ask_human` بدون `recommendation` یا بدون `impact_per_option` هم‌طول → رد.
- [ ] B.12 `policy_check('run_destructive_command',{cmd:'git push --force'})` → `approval`؛
      `('write_secret',…)` → `deny`.
- [ ] B.13 `ledger_status` در نشست تازه بدون هیچ context دیگری کامل است (تست با harness reset + tools/call).
- [ ] B.14 `ledger-cli resolve OI-004 --status deferred --note "…"` (کاربر human) → موفق، با audit.
- [ ] B.15 همان دستور با کلید API یک **ایجنت** → `FORBIDDEN_SCOPE` (CLI از مسیر انسانی استفاده نمی‌کند).
- [ ] B.16 ثبت secret در `summary/ref/evidence` باعث `VALIDATION_ERROR`/mask می‌شود (تست ۶ الگو).
- [ ] B.17 OpenAPI و `schema.d.ts` بازتولید و commit شده‌اند: `npm run gen:api:check` سبز.
- [ ] B.18 پنل Approvals، `exec.decision|question|scope|waive|drop|promote` را با ترجمهٔ fa/en
      و ارجاع `task code` نمایش می‌دهد (تست e2e flagship: approve یک decision از پنل).

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

- [ ] F.1 `exec.policy` هر ۱۵+۵ ردیف جدول پرامپت/ضمیمه را دارد (تست snapshot روی `POLICY_DEFAULT`).
- [ ] F.2 تغییر `review→approval` برای `deps_add` فقط با `policy:set` و بدون تغییر کد،
      رفتار `policy_check` را عوض می‌کند (تست integration؛ cache ۵s → `invalidate`).
- [ ] F.3 `touches=['db_schema']` → `approval` + `approval_state='pending'` + رد Gate تا approve انسانی.
- [ ] F.4 تلاش ایجنت برای پایین‌آوردن سطح: (الف) فیلد `risk_level` در ورودی → خطای «ناشناخته»،
      (ب) ادعا در `rationale` → بی‌اثر؛ تست هر دو.
- [ ] F.5 دستهٔ ناشناخته → `review`؛ `touches=['none']` با `reversible=false` → `review` (حداقل).
- [ ] F.6 ترکیب چند دسته → بالاترین سطح؛ مثال `['public_api','deps_add']` → `approval`.
- [ ] F.7 `write_secret`/`delete_root_folder`/`rm -rf` → `deny` و نوشتن `exec_events` با `outcome:'blocked'`.
- [ ] F.8 تصمیم `approval` ردشده (`rejected`) + journal `done` ⇒ قاعدهٔ ۴ Gate رد می‌کند.
- [ ] F.9 hook: اسکریپت `scripts/claude-hook.mjs` با `PreToolUse` برای `Bash(git push*)`,
      `Bash(rm -rf*)`, `Edit` روی `package.json` → `permissionDecision:'ask'|'deny'`؛
      تست: اعتبارسنجی خروجی JSON hook با ورودی ساختگی (بدون وابستگی به Claude Code).

---

## ۱۱. PE‑6 (بخش D) — فایل قوانین رفتار ایجنت

- `docs/LEDGER_RULES.md`: متن پرامپت بخش D (بلوک‌های «چرا / شروع / محرک‌ها / کِی بپرسم / حین کار /
  پایان / ممنوع») + جدول محرک→ابزار + ۶ دستور `ledger-cli` + «اگر ابزار ledger در دسترس نبود،
  **توقف** و در متن گزارش کن؛ جایگزین نساز».
- `AGENTS.md`: افزودن بخش ۸ خطی `## Execution control (exec_control)` با ارجاع + ۴ «ممنوع» و
  ارجاع به `docs/LEDGER_RULES.md` (D‑04؛ بدون تغییر بقیهٔ فایل).
- `docs/MCP.md`: قطعهٔ پیکربندی `forgepm-mcp` (stdio) برای اتصال ایجنت + ساخت API key با
  اسکوپ‌های `ledger:*` (بدون بریج جدید).
- `.claude/settings.json` نمونه در `docs/examples/` (اختیاری، مستند، نه commit در ریشه).

**معیارهای پذیرش PE‑6**

- [ ] D.1 `docs/LEDGER_RULES.md` ≤ ۸۰ خط؛ هر بند یک «محرک ← ابزار» مشخص دارد (تست واحد با
      regex: هر خط `- ` داخل بخش محرک‌ها باید `→ ledger_*|exec_*` داشته باشد).
- [ ] D.2 فایل صریحاً «ممنوع»ها را با **دلیل** می‌گوید (تست وجود ۴ عبارت کلیدی).
- [ ] D.3 **تست رفتاری ۳ تسک واقعی** (خروجی در `docs/EXECUTION_CONTROL.md`): با یک کلید واقعی،
      سه تسک نمونه اجرا شود و برای هر «بعداً/فرضیه/تصمیم» فراخوانی ابزار ثبت گردد؛
      نرخ ثبت ≥ ۸ از ۱۰ محرک؛ موارد جاافتاده به‌عنوان `open_item(source='human', type='suggestion')`
      برای بهبود قوانین یادداشت شود.
- [ ] D.4 `npm run docs:check` سبز (لینک‌ها، فایل‌های الزامی)؛ `i18n-check` سبز.
- [ ] D.5 قوانین جدید `AGENTS.md` با `docs/EXECUTION_PLAN.md` تضاد ندارد: بازبینی دستی +
      ثبت در `docs/DECISIONS.md` (Context/Decision/Reason) برای هر تغییر رفتاری.

---

## ۱۲. PE‑7 (بخش E) — بازبین خصمانه

**ورودی ایزوله (قطعی، `exec/review-input.ts`):** (1) متن خام درخواست (از `exec_requirements.quote`)
(2) معیارها + وضعیت evidence (3) `git diff <start_ref>…HEAD` محدود به `allowed_repo_roots`
(4) `ledger_status` snapshot (5) Exit Report. **تاریخچهٔ مکالمه هرگز** — و این خود تست می‌شود:
ساخت ورودی در `exec_reviews` لاگ می‌شود (`payload.meta.input_sections = [...]`) و تست واحد
بررسی می‌کند هیچ‌کدام از `messages`, `conversation`, `agent_history`, `chat` نباشد + محدودیت
`prompt` بایت.

مراحل: `exec:requirements_coverage`, `exec:evidence_claims`, `exec:unrecorded_decisions`,
`exec:behavior_regression`, `exec:edge_cases`, `exec:out_of_scope`.
`verdict=fail` یا هر finding `blocks_completion=true` → قاعدهٔ ۷ Gate رد. هر finding →
`exec_open_items(source='reviewer')` با `evidence_ref` اجباری (فاقد ref → `REVIEW_OUTPUT_INVALID`
و **یک** تلاش مجدد با پیام اصلاحی؛ دوباره خراب → `review_failed` + ارجاع به انسان).
حداکثر `exec.max_review_rounds = 2` دور؛ پس از دور دوم، `open_item(type='risk', blocks_completion=true,
title='human arbitration required')` و Gate **هرگز** خودکار سبز نمی‌شود.

**ابطال:** `exec_reviews.tree_hash` با hash فعلی worktree مقایسه می‌شود؛ اختلاف ⇒
`REVIEW_STALE` (I‑6). تست: بعد از review، یک فایل را تغییر بده → قاعدهٔ ۷ رد.

**معیارهای پذیرش PE‑7**

- [ ] E.1 لاگ ورودی بازبین با ۵ بخش مورد انتظار؛ تست شامل «absence of conversation history».
- [ ] E.2 تسک عمداً ناقص (یک معیار بدون پیاده‌سازی): stub provider با پاسخ `fail` واقعی →
      finding `incomplete_requirement` در ledger و Gate رد (تست integration).
- [ ] E.3 `TODO: later` جاافتاده در diff → finding `commitment` با `blocks_completion=true`.
- [ ] E.4 خروجی غیر JSON یا یافتهٔ بدون `evidence_ref` → یک بازخواست، سپس `review_failed`.
- [ ] E.5 تغییر diff بعد از بازبین ⇒ اعتبار باطل (تست hash).
- [ ] E.6 سقف ۲ دور و ارجاع به انسان؛ بدون حلقهٔ بی‌پایان (تست شمارش `round`).
- [ ] E.7 بازبین توانایی نوشتن کد ندارد: `exec.review` فقط `review_runs/findings/open_items`
      را می‌نویسد (تست سطح دسترسی: ابزار ویرایش فایل/`work_item_update` در مسیر بازبین صدا زده نمی‌شود).
- [ ] E.8 هزینه: هر run در `ai_calls` ثبت و با `exec.max_cost_tokens` محدود (از `ai/budget.ts`).

---

## ۱۳. PE‑8 تا PE‑11 (ضمیمهٔ ۱)

### PE‑8 (بخش J) — Scope + Baseline

`scope.ts`: `changed_files = git diff --name-status <start_ref>` (یا manifest hash برای
بدون git)؛ هر فایل خارج از `allowed_paths` → `exec_open_items(out_of_scope, blocks=true,
source='hook')`. گسترش محدوده فقط با `approval_requests(action='exec.scope_expand')` و
`ledger-cli approve-scope`.
`baseline.ts` — baseline **هیچ‌وقت** از دهان ایجنت گرفته نمی‌شود و **هیچ‌وقت** توسط ForgePM اجرا
نمی‌شود (نه host، نه container). تنها منبع، لاگ CI است (`exec.baseline_source`):

| # | منبع | چگونه | `provenance` |
|---|---|---|---|
| 1 | **CI** (ترجیحی) | خواندن artifact/لاگ کارخانهٔ CI همان `sha` با `exec.ci_log_endpoint` + توکن **read-only از جدول `secrets`**؛ parse با `exec.test_result_parser` | `{provider:'github_actions', run_id, job, sha, sha256_log}` |
| 2 | **هیچ‌کدام** | `BASELINE_UNAVAILABLE` ⇒ **رد قاعدهٔ ۱۲ (fail closed)**. بدون اجرای host، بدون container، بدون `skipped` خودکار. تنها راه عبور: waive صریح انسانی با `approval_id` که در گزارش نهایی برجسته می‌شود | `{reason:'no_source'}` |

**استاندارد مرجع (چرا این شکل؟):** OWASP Top 10 CI/CD Security Risks — CICD‑SEC‑4 (Poisoned Pipeline
Execution: اجرای کد مخزن در context دارای secret) و CICD‑SEC‑5 (PBAC). نسخهٔ اول این پلن برای رعایت
همین استاندارد یک «runner ایزولهٔ ناپایدار» (container با cap‑drop/seccomp/no‑net) طراحی کرده بود؛
مالک آن را رد کرد و راه بهتری انتخاب شد: **کانال اجرا را نساز**. خواصی که runner قرار بود بدهد —
شاهدِ بی‌طرف بودن نتیجه، نبودِ دسترسی به secret در لحظهٔ اجرا، و fail closed — با خواندن لاگ CIِ
همان `sha` (به‌همراه `run_id`/`job` در `provenance`) حفظ می‌شوند، بدون سطح حملهٔ جدید و بدون وابستگی
استقرار. کلیدهای `exec.allow_host_test_command` و `exec.runner.*` به همین دلیل وجود ندارند: هیچ مسیر
اجرایی یعنی هیچ تنظیماتی برای آن.

سپس قاعدهٔ ۱۲ Gate: اجرای مجدد + سه تشخیص: `fail` جدید، **ناپدید شدن** تست، و تضعیف (کاهش تعداد
`it/test/assert` در `exec.protected_test_globs` یا افزودن `skip/only/xit/xdescribe`) →
`open_item(type='test_gap', blocks=true)`؛ رفع فقط با تأیید انسان. شمارش assertion از AST سبک
(شمارش `expect(`/`assert`) در همان سبک `review/analyzer.ts` انجام می‌شود — parser جدیدی اضافه نمی‌شود.

- [ ] J.1 تغییر فایل خارج از `allowed_paths` → آیتم مسدودکننده (تست).
- [ ] J.2 حذف یک تست baseline → Gate رد؛ برگرداندن تست → Gate سبز.
- [ ] J.3 افزودن `.skip` به تست baseline → رد؛ `.only` روی یک تست دیگر → رد (هر دو).
- [ ] J.4 نتیجهٔ baseline فقط توسط کد؛ فراخوانی `ledger_add_evidence(kind:'test_output')`
      برای قاعدهٔ ۱۲ کافی نیست (تست شمارش writer).
- [ ] J.5 `allowed_paths` بدون تأیید انسان قابل تغییر نیست (تست از هر ۳ مسیر: MCP، REST، CLI با کلید ایجنت).
۲ `skipped` + آیتم ریسک `blocks=false`؛ در گزارش نهایی برجسته.
- [ ] J.7 (بازبینی‌شده با D‑08) هیچ مسیر اجرایی در کد نیست: تست واحد `exec/ledger.test.ts` روی
      `baselineFromLog`/`compareBaseline` — parse لاگ CI، رد لاگ بدون خط نتیجه، و
      `baseline_source='off'` ⇒ قاعدهٔ ۱۲ **رد** (نه `skipped`؛ `exec/gate.test.ts`).
      ب. J.7b ماسک secret روی متن ذخیره‌شونده (`exec/evidence.ts::redactSecrets`، تست در
      `exec/evidence.test.ts`). ج. J.7c گارد ساختاری در `tests/unit/exec-no-spawn.test.ts` (جزئی از
      `npm run verify`) — با mutation check تأیید شد که الگو `spawn`/`execFile` را واقعاً می‌گیرد.
- [ ] J.8 پروژهٔ بدون git ⇒ manifest fallback و `start_ref=null`؛ Gate رد نمی‌کند ولی
      `scope:'manifest'` را در گزارش می‌آورد.

### PE‑9 (بخش‌های G + H) — الزامات و پلن

`requirements.ts`: `req_add` (quote عین متن، رد مبهم با همان `assertCheckable`)،
`req_link_task`، `req_change` (معیار/evidence/decision → `needs_revisit` + یک
`open_item(blocks=true)` برای هر تسک `done` مرتبط)، `req_coverage()`، drop فقط انسانی.
**قانون شروع:** اگر REQ فعال بدون تسک وجود داشته باشد، `exec_task_start` با
`REQUIREMENT_UNCOVERED` رد می‌شود (پیام: «اول REQ-00x را به یک تسک وصل کن یا از انسان بپرس»).
`plan.ts`: `task_split` (چرخه با `graph.ts` → `DEPENDENCY_CYCLE`)، `task_start` با
پیش‌نیاز `done`نبوده → رد با فهرست دقیق، `task_block` (۴ فیلد الزامی)، رفع خودکار مانع
با پاسخ سؤال/تأیید decision/`done` پیش‌نیاز + علامت `unblocked` در `session_start`،
`exec_plan_view` درختی.

- [ ] G.1 درخواست پنج‌جمله‌ای → ≥ ۵ REQ با `quote` بیتی‌به‌بیتی از متن کاربر (تست با فیکسچر
      متن؛ `quote` غیرمطابق → `UNPROCESSABLE`).
- [ ] G.2 REQ بدون تسک در `session_start`، `req_coverage` و `exec_plan_view`؛ `task_start` رد.
- [ ] G.3 Gate تسکی که REQ وصل‌شده‌اش معیار بدون evidence دارد → رد (تست).
- [ ] G.4 `req_change` → معیار/`decision` وابسته `needs_revisit` + آیتم مسدودکننده برای تسک done.
- [ ] G.5 ایجنت ابزار drop/waive الزام ندارد؛ `req drop` فقط CLI/پنل با `approval` (تست نبود ابزار + تست رد REST با کلید ایجنت).
- [ ] G.6 تعارض دو REQ (تست با هم‌پوشانی `kind`+`priority` + `contradicts` صریح) →
      `open_item(type='design_gap', blocks=true)` + `ask_human`.
- [ ] H.1 وابستگی چرخه‌ای رد (۳ حالت: خود، ۲‌تایی، ۳‌تایی).
- [ ] H.2 `task_start` با پیش‌نیاز ناتمام → رد با `pending_deps:[…]`.
- [ ] H.3 `task_block` بدون `unblock_condition` → رد؛ با شرط → `status='blocked'`.
- [ ] H.4 پاسخ سؤال مسدودکننده → تسک خودکار `in_progress` + `unblocked` در `session_start`.
- [ ] H.5 Gate والد با یک فرزند ناقص → `ok:false` (تست)؛ لغو زیرتسک با REQ وصل‌شده → نیازمند تأیید انسان.
- [ ] H.6 `exec_plan_view` درخت کامل را بدون context دیگری برمی‌گرداند؛ تفکیک `blocked` و `awaiting_human`.
- [ ] H.7 تسک `blocked` در هیچ فهرستی «in progress» نمایش داده نمی‌شود (تست serializer + تست UI string).

### PE‑10 (بخش K) — Resume + Journal

`journal.ts`: `journal_start` (کد `pre_state_ref = git rev-parse HEAD:.` + `git status --porcelain`)،
`journal_done/fail`، بازنشانی خودکار `started → unknown` در `session_start`.
**قفل نشست (کد قطعی، نه پرامپت):** تا وقتی ردیف `unknown` باز است، هر ابزار نوشتن به‌جز
`journal_done/fail`، `ledger_ask_human`، `exec_ledger_reconcile` و خواندنی‌ها → `JOURNAL_UNRESOLVED`.
`idempotent=false` + وضعیت نامعلوم ⇒ تکرار ممنوع، فقط `ask_human` یا `record_decision(approval)`.
`session_start()` → بستهٔ اولویت‌دار (۶ پلهٔ ضمیمه) با سقف بایت و شمارندهٔ «و N مورد دیگر → `ledger_list_open`».
`exec_ledger_reconcile()` → تسک done که فایل‌هایش عوض شده، فکت stale، journal معلق،
اختلاف diff با `changed_files`.

- [ ] K.1 کرش شبیه‌سازی‌شده در میانهٔ migration (ردیف `started`، بدون done) → در نشست
      تازه `unknown` و **اولین** مورد لیست (تست).
- [ ] K.2 ابزار نوشتن با `unknown` باز → `JOURNAL_UNRESOLVED`؛ پس از تعیین تکلیف → مجاز.
- [ ] K.3 تکرار اقدام غیرتکرارپذیر با `unknown` رد؛ با `idempotent=true` مجاز ولی `exec_events` می‌نویسد.
- [ ] K.4 `exec_ledger_reconcile` تغییر فایل پس از `closed_at` را گزارش می‌کند (تست hash).
- [ ] K.5 با ۲۰۰ آیتم باز، خروجی `session_start` ≤ `exec.session_output_max_bytes`،
      ۶ بخش با ترتیب ثابت و `truncated:true` + شمارنده (تست با seed).
- [ ] K.6 Gate تسک با journal `started/unknown` → رد (قاعده ۱۳) — تست.
- [ ] K.7 hook شروع نشست (اختیاری/اسکریپت): `session_start` را صدا می‌زند و خروجی را چاپ می‌کند؛
      تست: خروجی با اسکیمای `SessionSnapshot` سازگار است.

### PE‑11 (بخش I) — دانش پروژه

`facts.ts`: `fact_record` (hash فایل‌ها توسط کد؛ `kind='fact' + source='agent_guess'` → رد؛
`fact + code|tool_output` بدون `source_ref` → رد؛ کلید تکراری → `superseded` نه بازنویسی)،
`fact_query` (N نتیجه + برچسب هشدار برای stale)، `fact_verify` (بازسنجی hash)، `fact_promote`
(فقط با evidence غیر-حدس یا تأیید انسانی؛ `fact_promote_from_guess` در سیاست = `deny`).
stale خودکار در `session_start` + پیش از `task_complete` + job دوره‌ای؛ stale ⇒ تصمیم‌های
`active` وابسته `needs_revisit` + `open_item(blocks=true)`.

- [ ] I.1 `fact_record(kind:'fact', source:'agent_guess')` → رد با پیام «یا `kind:'assumption'` یا منبع واقعی».
- [ ] I.2 تغییر یک فایل مرجع ⇒ در اجرای بعدی (`session_start`) فکت `stale` (تست hash).
- [ ] I.3 stale ⇒ تصمیم وابسته `needs_revisit` + آیتم مسدودکننده + رد Gate (تست زنجیره‌ای).
- [ ] I.4 کلید تکراری ⇒ نسخهٔ قبلی `superseded` با `superseded_by` (هر دو ردیف باقی‌اند؛ تست شمارش).
- [ ] I.5 `fact_promote` بدون evidence → رد؛ با evidence معتبر → `active` + audit.
- [ ] I.6 `fact_query` فکت stale را با `status:'stale'` + `warning` برمی‌گرداند، نه به‌عنوان واقعیت.
- [ ] I.7 هیچ `fact` با `source_ref` غیرقابل‌بازدید باقی نمی‌ماند (`file:` موجود، `commit:` پارسable).

### PE‑12 — **پنل کامل**، README، سناریوی E2E، مستندات

**پنل کامل (D‑13)** — همه از REST انسانی/اداری، بدون هیچ مسیر نوشتن مستقیم به DB:

| صفحه/جزء | مسیر | محتوا |
|---|---|---|
| تسک‌های اجرا | `pages/exec-tasks.ts` + route `exec-tasks` | درخت `exec_plan_view`؛ ستون‌های `code/status/open items/blocked_on/unblock_condition/gate summary`؛ تفکیک رنگی `blocked` و `awaiting_human`؛ project picker و cursor pagination موجود |
| جزییات تسک | drawer همان صفحه (`exec-tasks/:code`) | معیارها + evidence با `provenance`، آیتم‌های باز، تصمیم‌ها، سؤالات، دورهای بازبینی، journal، REQهای وصل‌شده، دکمهٔ **Dry‑run Gate** با نمایش `blocked_by` |
| قفل‌گشایی انسانی | فرم‌های همان صفحه | `resolve`(note) · `answer Q` · `approve/reject D` · `waive C` · `drop REQ` · `approve-scope` · `fact promote` — هرکدام با `reason` الزامی و preview تأثیر |
| سیاست ریسک | `pages/exec-policy.ts` | جدول `exec.policy` قابل ویرایش (admin) + validation zod + diff قبل از ذخیره (معادل `policy:print/set`) |
| تب تسک در WorkItem | `pages/work-item-detail.ts` | بخش «Execution control» (وضعیت gate، `exec_events` اخیر)؛ دکمهٔ Done در `gate ok:false` **غیرفعال + tooltip دلیل** (سرور هم رد می‌کند) |
| افزوده روی Approvals | `pages/approvals.ts` | `exec.decision/question/scope/waive/drop/promote` با لینک به تسک (منطق approval بدون تغییر) |

*قراردادهای پنل:* کلیدهای i18n جدید با برابری `fa/en` (`i18n-check.mjs`)، `contrast-check.mjs`،
`raw-value-check.mjs`، کامپوننت‌های `ui/*` موجود، تست واحد کامپوننت + مسیر `apps/web/e2e/chain.spec.ts`.

**بدون بریج/پروکسی جدید (D‑02):** ایجنت همان `forgepm-mcp` (stdio) یا `/mcp` را استفاده می‌کند.
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

| # | صحنه | انتظار |
|---|---|---|
| 1 | درخواست ۱۲ جمله‌ای «افزودن ورود با توکن» | ۱۲ REQ با quote |
| 2 | یکی بدون تسک | `exec_task_start` رد (`REQUIREMENT_UNCOVERED`) |
| 3 | `task_split` با وابستگی | شروع زودهنگام رد |
| 4 | «بعداً refresh token را اضافه می‌کنم» | `OI-###` مسدودکننده |
| 5 | `touches=['public_api']` | `approval/pending`؛ اعمال بدون تأیید → `APPROVAL_PENDING` |
| 6 | `task_complete` زودهنگام | `ok:false` با `blocked_by` دقیق |
| 7 | فایل خارج از `allowed_paths` | آیتم مسدودکننده |
| 8 | حذف تست baseline (fixture از لاگ CI یک commit سبز + نسخهٔ تغییریافته برای حالت رد) | قاعدهٔ ۱۲ رد |
| 9 | تغییر فایل مرجع فکت | stale → needs_revisit → رد |
| 10 | کرش میانهٔ migration | `unknown` اول؛ تکرار مسدود |
| 11 | بازبینی (stub provider) | TODO جاافتاده → finding |
| 12 | تأییدهای انسانی از CLI **و** پنل | approve + answer + waive (دو مسیر، یک نتیجه در ledger) |
| 13 | `task_complete` نهایی | `done` + گزارش از Ledger (تطابق شمارش‌ها) |

اسکریپت exit code غیرصفر در هر انحراف؛ در CI به‌عنوان یک step مستقل اجرا می‌شود (با harness DB).

**معیارهای پذیرش PE‑12**

- [ ] L.1 `npm run exec:e2e` در CI سبز (۱۳ صحنه، ۰ خطای موردانتظار).
- [ ] L.2 یک MCP واحد: هر ۲۸ ابزار از `/mcp` و از `forgepm-mcp` stdio دیده/خوانده می‌شوند (تست SDK،
      الگو: `apps/api/test/integration/phase4-sdk.test.ts`) + «ماژول خاموش ⇒ صفر ابزار ledger».
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

| نوع | کجا | نمونه |
|---|---|---|
| واحد (کد قطعی، بدون DB) | `packages/core/src/exec/*.test.ts`, `packages/shared/src/schemas-exec.test.ts`, `tests/unit/*` | policy، ۱۳ قاعدهٔ gate، assertCheckable، scope glob، parser لاگ CI، journal، session pack، codes |
| Integration (Postgres+Redis واقعی) | `tests/integration/exec-*.test.ts` با `createHarness()` | ledger, gate روی تسک واقعی، approvals، stale/review، req coverage، resume |
| MCP contract | `apps/api/test/integration/exec-sdk.test.ts` (SDK + stdio) و `tests/integration/exec-mcp.test.ts` (JSON-RPC) | tools/list با/بدون enable، scope، rate limit، idempotency، envelope خطا |
| E2E پذیرش | `scripts/exec-e2e.ts` + `npm run exec:e2e` (CI) | ۱۳ صحنهٔ §۱۳ (PE‑12) |
| پنل | `apps/web/src/app/pages/{exec-tasks,exec-policy}.spec.ts` + `apps/web/e2e/chain.spec.ts` | درخت تسک، dry‑run gate، approve/waive از پنل، RTL/contrast/raw‑check |
| نبودِ هر مسیر اجرایی (D‑08) | `tests/unit/exec-no-spawn.test.ts` (هیچ `child_process`/`spawn`/`execFile` در `packages/core/src/exec/**` و `apps/api/src/modules/exec/**` + خودآزمایی الگو + نبودِ `docker-compose.runner.yml`) و `packages/core/src/exec/ledger.test.ts` (parse لاگ CI، قاعدهٔ `source`) | اگر روزی کانال اجرا اضافه شود `npm run verify` قرمز می‌شود — به‌جای اتکا به بازبینی انسانی |
| مهر گیت | `tests/integration/exec-gate-stamp.test.ts` | `done` بدون مهر معتبر = drift؛ `tree_hash` متفاوت = رد |
| دروازهٔ ساختاری | تست‌های موجود | `schema:check`, `docs:check`, `gen:api:check`, `check-migration-hashes`, `eslint-boundaries` |
| نفوذ/امنیت | `tests/integration/pou-exec-security.test.ts` | حذف رکورد، حذف مسیر، secret mask، path traversal، SQL injection در `ref` (کوتاه‌ترین مسیر: همه از Kysely parameterized) |
| عملکرد | `scripts/exec-perf.mjs` (تولید ۱۰۰۰ OI) | p95 `ledger_status < 150ms`, `session_start < 250ms`, gate dry-run < 120ms |

هر فاز با **تست قرمز اول** شروع می‌شود (الگوی `AGENTS.md`) و سبز شدن همان تست، معیار اتمام آن فاز است.
معیار پذیرشی که تست خودکار ندارد، در `docs/EXECUTION_CONTROL.md` با برچسب `manual:` و دستور اجرایش ثبت می‌شود.

---

## ۱۵. امنیت، ریسک‌ها و محدودیت‌ها

| ریسک | کاهش |
|---|---|
| اجرای `test_command` = RCE (CICD‑SEC‑4) | **ساخته نمی‌شود**: هیچ مسیر اجرایی در کد نیست (نه host، نه container، نه compose). نتیجه فقط از **لاگ CI** همان `commit_sha` خوانده/parse می‌شود؛ نبودش ⇒ `BASELINE_UNAVAILABLE` و **رد** قاعدهٔ ۱۲ (fail closed)؛ waive فقط انسانی و برجسته در گزارش نهایی؛ تست J.7 + گارد ساختاری J.7c |
| نشت secret به لاگ ذخیره‌شده | هر خروجیِ ذخیره‌شونده با `maskInput` ماسک و به `exec.evidence_max_bytes` سقف می‌شود؛ تست J.7b «نبود `FORGEPM_SECRET_KEY`/`fpm_` در متن ذخیره‌شده» |
| ابطال/جعل نتیجهٔ baseline | `provenance` (run_id/sha/sha256 log) در `exec_baseline_tests`؛ writer فقط کد؛ `run_source` در مهر `exec_gate_checks`؛ تست J.4 |
| **تورم ۲۸ ابزار MCP → context و فراموشی ثبت** (ریسک پذیرفته‌شدهٔ D‑12) | همه فعال؛ کنترل فقط با: توضیح ≤ ۲۰۰ کاراکتر (تست registry)، `exec.tool_output_max_bytes` + `truncated`، `session_start` به‌عنوان تنها نقطهٔ شروع، و **الزام رفتاری** D.3؛ ابزارهای استفاده‌نشده در گزارش نهایی فهرست می‌شوند (حذف خودسرانه ممنوع) |
| Ledger به‌عنوان منبع نشت secret | mask قبل از ذخیره (الگوی `maskInput`) + تست B.16 + رد الگوهای `fpm_`/PEM/AWS |
| Write amplification (هر فراخوانی = event) | batch در یک تراکنش؛ ایندکس `(task_id, ts)`؛ ریلین `exec_events` با retention موجود (`retention.ts`) |
| قفل شدن تسک‌ها در حلقهٔ بی‌پایان بازبینی | سقف ۲ دور + ارجاع انسانی (E.6) |
| هم‌زمانی ایجنت‌های متعدد روی یک تسک | `idempotency_key` الزامی برای نوشتن‌های idempotent؛ `SELECT … FOR UPDATE` روی شمارنده‌ها؛ تست همزمانی A.5/PE‑0.5 |
| انحراف `done` در UI توسط انسان | guard فقط برای تسک‌های دارای `exec_task_id`؛ اقدام انسان مجاز است ولی `exec_events` با `actor_type='human'` + `open_item(source='human')` ثبت می‌شود |
| نبود `start_ref` (ایجنت hook ندارد) | fallback manifest + علامت `scope:'unknown'` و **رد قاعدهٔ ۱۱** (fail closed) |
| هزینهٔ LLM بازبینی | `exec.max_cost_tokens` + `ai_calls` (E.8) + حداکثر ۲ دور |
| پنل کامل = سطح حملهٔ جدید (فرم‌های قفل‌گشایی) | همه از endpoint‌های انسانی با `exec:decide` + self‑approval ممنوع + audit + `reason` الزامی + preview تأثیر؛ UI هیچ قدرت اضافه‌ای نسبت به CLI ندارد (A‑8)؛ تست L.4b/L.4c |
| فشار برای «اجرای تست توسط خود پلتفرم» | این قابلیت ساخته نمی‌شود (D‑08 بازبینی‌شده): منبع فقط لاگ CI است؛ نبودش ⇒ قاعدهٔ ۱۲ رد + waive انسانی (بدون silent downgrade و بدون host/container) |

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

| فاز | محتوا | وابسته به | روز‌مهندس (کد+تست+مستند) |
|---|---|---|---|
| PE‑0 | داربست، مهاجرت ۱۷ جدول (+trigger/REVOKE)، codes، settings، schema:check | — | ۱٫۵–۲ |
| PE‑1 (A) | ledger + ماشین وضعیت + invariants | PE‑0 | ۱–۱٫۵ |
| PE‑2 (B هسته) | task_start/status/list_open/add_item/resolve | PE‑1 | ۲ |
| PE‑3 (C) | Exit Report + Gate ۱۳ قاعده + guard تسک | PE‑2 | ۲٫۵–۳ |
| PE‑4 (B ادامه) | evidence/decision/ask_human/policy_check + REST + CLI + approvals | PE‑3 | ۳ |
| PE‑5 (F) | policy engine + policy config + hook template | PE‑4 | ۱ |
| PE‑6 (D) | LEDGER_RULES.md + AGENTS.md + تست رفتاری ۳ تسک | PE‑2..PE‑5 | ۱ |
| PE‑7 (E) | بازبین خصمانه (`kind:'exec'`) + ابطال hash | PE‑3, PE‑4 | ۲–۲٫۵ |
| PE‑8 (J) | scope + baseline (فقط لاگ CI + fail closed) + test weakening | PE‑0, PE‑3 | ۱٫۵–۲ |
| PE‑9 (G+H) | requirements registry + plan/deps/blocked | PE‑1..PE‑3 | ۲ |
| PE‑10 (K) | journal + session_start + reconcile | PE‑3 | ۱٫۵ |
| PE‑11 (I) | facts + verify + links | PE‑10 (session hook) | ۲ |
| PE‑12 | **پنل کامل** (۶ جزء) + README/docs + e2e + CI step | همه | ۳–۳٫۵ |
| **جمع** | ۱۳ فاز، ~۵۰۰۰–۶۰۰۰ خط کد | | **۲۶–۳۰ روز‌مهندس** |

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

| ref | سؤال | پاسخ مالک | نتیجه در این پلن |
|---|---|---|---|
| OI‑1 | Postgres یا SQLite محلی؟ | **Postgres** («وقتی دیتابیس داریم، نیاز به دیتابیس دیگر نیست») | D‑01: بدون DB دوم؛ `.agent-ledger/` فقط JSON اختیاریِ فقط‑خواندنی (پیش‌فرض خاموش) |
| OI‑2 | ابزارها در `forgepm-mcp` یا MCP مستقل؟ | **یک MCP واحد** | D‑02: همان `ToolRegistry` + `/mcp`/`forgepm-mcp` stdio؛ بدون بریج و بدون پکیج جدید |
| OI‑3 | سقف ۸۰۰ خط یا تحقق کامل؟ | **تحقق کامل؛ تعداد خط مهم نیست** | D‑07: سقف خط لغو؛ هر ۱۳ فاز کامل؛ برآورد ۲۶–۳۰ روز؛ سقف کیفی فایل/تابع و «وابستگی غیرضروری ممنوع» پابرجا |
| OI‑4 | اجرای `test_command` روی سرور یا از CI؟ | **«مطابق استانداردها»**، سپس بازبینی مالک ۲۰۲۶‑۱۰‑۱۷: «وارد docker نشو» | D‑08: **هیچ‌کدام** — نتیجه فقط از لاگ CI خوانده می‌شود؛ OWASP CI/CD SEC‑4 با *نساختنِ* کانال اجرا رعایت می‌شود. کلیدهای `run_on_host`/`runner.*` وجود ندارند |
| OI‑5 | CLI باینری npm یا اسکریپت مخزن؟ | **«مطابق استانداردها»** | D‑11: `scripts/ledger-cli.ts` + `npm run ledger` (الگوی ۱۴ اسکریپت tsx موجود مخزن) |
| OI‑6 | ۲۸ ابزار یا فقط ۱۲ ابزار core؟ | **ابزار کامل** | D‑12: هر ۲۸ ابزار ثبت و visible؛ `exec.tools.level` حذف شد؛ کنترل هزینهٔ context با ۴ مکانیزم (§۴.۰) |
| OI‑7 | پنل کامل یا فقط‑خواندنی + درگاه تأیید؟ | **پنل کامل** | D‑13: ۶ جزء UI در PE‑12 (جدول + جزییات + فرم‌های قفل‌گشایی + سیاست + تب تسک + Approvals) با تست i18n/contrast/e2e |

**موارد باز جدید (کم‌اهمیت — شروع PE‑۰ را بلوکه نمی‌کنند):**

| ref | عنوان | نوع | نیازمند |
|---|---|---|---|
| OI‑8 | ~~پذیرش `not-run` برای تست وابسته به docker~~ | — | **بی‌موضوع شد** (۲۰۲۶‑۱۰‑۱۷): با حذف runner، هیچ تستی به docker وابسته نیست؛ همهٔ معیارهای PE‑8 با Postgres اجرا می‌شوند |
| OI‑9 | self‑host بدون GitHub ⇒ لاگ CI نیست ⇒ `BASELINE_UNAVAILABLE` ⇒ waive انسانی برای هر تسک؛ قابل‌تحمل؟ | design_gap | **پاسخ مالک: docker راه‌حل نیست.** گزینه‌های مجاز: (الف) هر CIای که لاگش از `exec.ci_log_endpoint` خوانده شود (GitLab/Jenkins/Azure یا pipeline محلی — سازگار با `provider='generic'`)، (ب) `baseline_source='off'` + پذیرش اینکه قاعدهٔ ۱۲ فقط با waive انسانی عبور می‌کند. اجرای خودکار در container ساخته نمی‌شود |
| OI‑10 | تأیید انسانی با `admin` موجود یا اسکوپ جدید `exec:decide`؟ | design_gap | تصمیم PE‑4 (پیشنهاد: `exec:decide` — اصل کمترین دسترسی) |

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
