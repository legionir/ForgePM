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
2. **Ledger در PostgreSQL همان `forgepm` میزبان است** (نه SQLite محلی)، چون Gate باید
   سمت سرور اجرا شود و تاریخچهٔ مکالمه منبع حقیقت نیست. `.agent-ledger/` فقط **کیش
   فقط‌خواندنی + حالت advisory آفلاین** است (§۲، D‑01).
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
8. **۱۳ فاز (PE‑۰ … PE‑۱۲)** با تست خودکار در پایان هر فاز؛ `npm run verify` + `schema:check` +
   `gen:api:check` + `docs:check` + `migration-hash` باید در هر فاز سبز بمانند.
9. **سناریوی پذیرش نهایی به اسکریپت اجراشدنی تبدیل می‌شود:** `npm run exec:e2e`
   (بخش ۵ پرامپت اصلی + ۶ مورد ضمیمه) که در CI اجرا می‌شود.
10. **بازهٔ تقریبی:** ۲۲ تا ۲۵ روز‌مهندس (۱۳ فاز PE‑0…PE‑12، §۱۶) و حدود ۴۲۰۰ تا ۵۲۰۰ خط کد
    (بدون تست/مهاجرت/مستند) — یعنی **انحراف آشکار از «۴۰۰ تا ۸۰۰ خط» پرامپت اصلی**،
    که در §۲ (D‑07) به‌صورت یک الزام باز ثبت و با مالک نهایی می‌شود.

---

## ۱. ممیزی مخزن و تطبیق پرامپت با استک واقعی

پرامپت با عبارت «اگر پروژهٔ من استک دیگری دارد، سازگار با آن بساز و در یک خط گزارش بده»
راهنمایی کرده است. جدول زیر نشان می‌دهد چه چیزی **بازاستفاده** می‌شود و چه چیزی **نو** است.

| نیاز پرامپت | وضعیت در ForgePM | تصمیم اجرایی |
|---|---|---|
| زبان TS، Node ≥ ۲۰ | ✅ Node 22 (`engines: >=22 <23`) | بدون تغییر؛ هدف Node 22 |
| ذخیره‌سازی SQLite + `.agent-ledger/ledger.db` | ❌ Postgres تنها منبع حقیقت پایدار (§`README`/`ARCHITECTURE`) | Ledger در Postgres؛ `.agent-ledger/` = کیش فقط‑خواندنی (§۲ D‑01) |
| MCP server | ✅ `/mcp` استریمبل HTTP + `forgepm-mcp` (stdio proxy) | ابزارهای جدید در `ToolRegistry` + اسکوپ‌های `ledger:read/write/decide`؛ stdio از طریق بریج §۱۰ |
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
| CLI انسانی | ❌ فقط `scripts/*.ts` با tsx | `scripts/ledger-cli.ts` → `npm run ledger -- …` (REST + API key admin، بدون SQL مستقیم) |
| `test_command` اجراشده توسط کد | ⚠️ `REPO_MOUNT_ROOT` برای منابع محلی | اجرای قطعی در **worker** با sandbox (§۹) |
| Hookها (PreToolUse) | ❌ | اسکریپت تولید + تست اسکیمای `.claude/settings.json`؛ تعهد = «مسدودسازی سمت سرور» (§۱۰) |

**نتیجه:** ~۶۵٪ زیرساخت لازم وجود دارد. کار اصلی، **قلمرو جدید داده + دروازهٔ قطعی +
جدول سیاست + ایزولاسیون بازبینی + journal/resume** است، نه ساخت اپلیکیشن جدید.

---

## ۲. انحراف‌های آگاهانه از پرامپت (هر کدام = یک `open_item` در Ledger)

| id | انحراف | چرا | ریسک / راه‌حل | وضعیت تأیید |
|---|---|---|---|---|
| D‑01 | Ledger در Postgres، SQLite فقط کش | Gate باید مستقل از ماشین ایجنت باشد؛ چند‌مستأجیری؛ بکاپ/ریالتن موجود | اگر سرور پایین باشد ایجنت قفل می‌شود → «fail closed» + حالت advisory (§۱۰) | تأیید مالک لازم |
| D‑02 | `agent-ledger` به‌جای MCP server مستقل، داخل `ToolRegistry` | جلوگیری از دو منبع حقیقت؛ استفاده از auth/scope/audit/rate-limit موجود | حجم ابزارها در `tools/list` → `exec.tools.level` (§۱۳) | تأیید مالک لازم |
| D‑03 | تسک‌ها روی `work_items` نگاشت می‌شوند | بدون دوگانگی وضعیت؛ پنل رایگان | همگام‌سازی دوطرفه → **تک‌نویس:** فقط `exec` وضعیت ledger را تغییر می‌دهد، UI فقط نمایش | تأیید لازم |
| D‑04 | `AGENTS.md` مخزن «منبع حقیقت پلن فاز» است؛ قوانین جدید در `docs/LEDGER_RULES.md` | `docs:check` + `EXECUTION_PLAN` منبع حقیقت‌اند؛ جلوگیری از تضاد | دو فایل → `AGENTS.md` فقط ۱ بخش ارجاع + «ممنوعه‌ها» (≤ ۲۰ خط اضافه) | بی‌خطر |
| D‑05 | `policy.json` → تنظیم `exec.policy` (JSONB، zod، override در سطح پروژه) | منبع حقیقت واحد + بدون restart + قابل audit | ویرایش فایل ساده‌تر است → `npm run policy:print/set` همان سهولت | تأیید لازم |
| D‑06 | `start_ref` سمت **runner** (hook/بریج) نوشته می‌شود | سرور به clone ایجنت دسترسی ندارد | اگر runner نباشد → manifest از hash فایل‌ها (§J) یا `scope: unknown` و Gate رد | بی‌خطر |
| D‑07 | حجم ~۴۲۰۰–۵۲۰۰ خط، نه ۴۰۰–۸۰۰ | ضمیمه دامنه را به ۱۱ بخش + پنل + CLI گسترش داد | سقف فایل ≤ ۴۰۰ خط؛ هر فایل > ۳۰۰ خط = بازنگری | تأیید لازم |
| D‑08 | `baseline` فقط در پروژه‌های با `exec.harness.enabled` | اجرای `test_command` روی host سرور خطرناک است | بدون هارنس → قاعدهٔ ۱۲ `skipped` با `open_item(blocks=false, type=risk)` | تأیید لازم |
| D‑09 | افزودن `0010_exec.migration.ts` و **یک خط** به `schema-check.ts` (anchors) | `schema:check` بلوک‌های §H را نمی‌شناسد | تنها تغییر کد خارج از قلمرو ماژول؛ در فاز PE‑0 | بی‌خطر |
| D‑10 | ارجاع `out_of_scope` در نسخهٔ ۱ فقط `open_item(type=out_of_scope)` است نه WorkItem جدا | جلوگیری از تورم موجودیت | گم‌شدن → همه در `req_coverage`/`ledger_status` دیده می‌شوند | بی‌خطر |

**قانون:** هیچ‌کدام از D‑01…D‑08 بدون «تأیید مالک» پیاده‌سازی نشود؛ در PE‑0 با
`req_add` + `ledger_record_decision` ثبت و با `ledger-cli approve` تأیید می‌شوند.

---

## ۳. معماری هدف

```
 agent (Claude Code / Cursor / Codex)
   │  stdio: forgepm-ledger-mcp (بریج، §۱۰)     ── کش محلی فقط‌خواندنی: .agent-ledger/ledger.db
   ▼                                            (snapshot + advisory-only mode)
 POST /mcp  (dispatch.ts: scope, rate, module gate, idempotency, mcp_tool_calls)
   ▼
 apps/api/src/modules/exec/{mcp-tools.ts, routes.ts, service.ts}
   ▼
 packages/core/src/exec/*            ← تمام منطق قطعی: gate, policy, evidence, scope,
   │                                   baseline, journal, facts, requirements, codes
   ├─ Postgres  exec_* (15 جدول)     ← منبع حقیقت؛ triggerها + REVOKE append‑only
   ├─ approval_requests (human)      ← تأیید/رد/answer/waive/drop/promote
   ├─ review engine (kind 'exec')   ← بازبین خصمانه، ورودی ایزوله، tree_hash
   ├─ work-items guard              ← transition به 'completed' بدون Gate = FORBIDDEN
   └─ BullMQ jobs (exec.baseline, exec.verify_facts) از طریق outbox
```

### ۳.۱ لایه‌بندی و مسیر فایل‌ها

| لایه | مسیر | محتوا |
|---|---|---|
| قرارداد | `packages/shared/src/schemas-exec.ts` | zod: `exitReportSchema`, `openItemSchema`, `policySchema`, `reqSchema`, `factSchema`, `journalSchema`, `toolOutputs` |
| enum‌ها | `packages/shared/src/enums.ts` | افزودن `EXEC_*` enum‌ها (بدون حذف مقدار قبلی) |
| خطاها | `packages/shared/src/error-codes.ts` | §۳.۳ |
| دامنه/کد قطعی | `packages/core/src/exec/` | ۱۴ فایل (زیر) |
| سرویس/REST | `apps/api/src/modules/exec/` | `module.ts`, `service.ts`, `mcp-tools.ts`, `routes.ts`, `approvals.ts` |
| worker | `apps/worker/src/handlers.ts` (ثبت) + `apps/worker/src/exec/` | handlerهای `exec.baseline`, `exec.verify_facts`, `exec.review` |
| CLI انسان | `scripts/ledger-cli.ts` | §۸ |
| بریج stdio | `apps/ledger-mcp/` (پکیج جدید، اختیاری در انتهای فاز) | §۱۰ |
| پنل | `apps/web/src/app/pages/exec-ledger.ts` | فهرست + باز کردن قفل‌ها (fa/en) |
| مستند | `docs/EXECUTION_CONTROL.md`, `docs/LEDGER_RULES.md`, افزودن §H به `DATA_MODEL.md` | §۱۴ |

`packages/core/src/exec/`:
`codes.ts` (شناسه خوانا) · `open-items.ts` (ماشین وضعیت + قوانین بستن) · `evidence.ts`
(اعتبارسنجی ref) · `policy.ts` (طبقه‌بندی ریسک) · `exit-report.ts` (تبدیل به آیتم + validate) ·
`gate.ts` (۱۳ قاعده) · `requirements.ts` (پوشش، needs_revisit) · `plan.ts` (deps/چرخه/block/unblock) ·
`facts.ts` (hash/stale/supersede/promote) · `scope.ts` (glob + diff) · `baseline.ts` (parse نتایج + تضعیف) ·
`journal.ts` (started→unknown) · `session.ts` (بستهٔ اولویت‌دار با سقف) · `types.ts`.

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
- **I‑8** هر نوشتن = یک `exec_events` + یک `audit_event` در **همان تراکنش** (شکست = rollback).

### ۳.۳ قرارداد خطا (اضافه‌شدنی به `error-codes.ts`)

```
LEDGER_NOT_FOUND 404 · LEDGER_STATE_INVALID 409 · LEDGER_TRANSITION_NOT_ALLOWED 409
GATE_FAILED 409 · CRITERION_NOT_CHECKABLE 422 · EVIDENCE_INVALID 422
SCOPE_VIOLATION 422 · JOURNAL_UNRESOLVED 409 · FACT_STALE 409
REQUIREMENT_UNCOVERED 409 · REVIEW_STALE 409 · REVIEW_OUTPUT_INVALID 422
APPROVAL_PENDING 409 · SELF_APPROVAL_FORBIDDEN 403   (موجود: FORBIDDEN_SELF_APPROVAL)
```

پیام هر خطا **قابل‌اقدام** است (قاعدهٔ ضمیمه §۴): `code` + `what_is_wrong` + `needed_action` +
`tool_to_call` + `refs`. مثال:
`{ code:'GATE_FAILED', blocked_by:[{rule:2, ref:'OI-004', needed:'resolve with note or ask_human', tool_to_call:'ledger_resolve_item'}] }`.

---

## ۴. مدل داده (مهاجرت `0010_exec` — ۱۶ جدول)

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
| 14 | `exec_baseline_tests` | `id, task_id, test_name, result_at_start('pass','fail','skip'), source_snapshot('ci','local'), assertion_count, captured_at` | فقط writer = کد (`exec.baseline` job) |
| 15 | `exec_action_journal` | `id, task_id, code 'AJ-###', action, target, idempotent, expected_effect, pre_state_ref, status('started','done','failed','unknown'), started_at, finished_at, result_ref, note` | `started` بازنشانی خودکار به `unknown` در `session_start` |
| 16 | `exec_code_seq` | `project_id, prefix('T','C','OI','D','Q','F','REQ','AJ'), seq` | شمارندهٔ کد خوانا؛ `allocateLedgerCode` با `SELECT … FOR UPDATE` (تست همزمانی PE‑0.5) |

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
exec.test_command              string  = ''                              (اجرا فقط اگر allow_host_test_command)
exec.test_result_parser       jsonb   = { "pass":[…], "fail":[…], "skip":[…] } regex‌های نام TEST
exec.protected_test_globs     array   = ["**/*.test.ts","**/test/**/*.ts","**/e2e/**/*.spec.ts"]
exec.allowed_repo_roots        array   = []                              (prefix-safe، مثل github/config.ts)
exec.harness.enabled           bool    = false
exec.allow_host_test_command   bool    = false                           (پیش‌فرض خاموش؛ ریسک RCE)
exec.evidence_max_bytes        int     = 131072
exec.session_output_max_bytes  int     = 8192
exec.tool_output_max_bytes     int     = 16384
exec.max_review_rounds         int     = 2
exec.tools.level               enum    = 'core' | 'full'  (پیش‌فرض core — §۱۳)
exec.require_review_for_done   bool    = true
exec.block_transition_when_gate_fails bool = true
exec.stale_check_on_start      bool    = true
```

هر ۱۶ کلید در تست واحد با `z` خودِ registry اعتبارسنجی می‌شود (الگوی `env.test.ts`).

---

### ۴.۰ فهرست کامل ابزارهای MCP (۲۸ ابزار؛ ۱۲ «core»)

| ابزار | اسکوپ | نوشتن | فاز | core |
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

شمارش ۲۸ ابزار در ۱۲ «core» خلاصه می‌شود؛ سطح با `exec.tools.level` کنترل می‌شود تا
هزینهٔ context و احتمال فراموش‌کردن ثبت کنترل شود (ضمیمه §۴). ابزارهای غیرcore وقتی
ساختارشان در دادهٔ واقعی (۲ تا ۳ تسک) تثبیت شد، فعال می‌شوند.

**هیچ ابزار حذف/ویرایش مستقیمی برای ایجنت وجود ندارد:** نه `*_delete`، نه `*_set_risk`،
نه `criterion_waive`، نه `req_drop`، نه `policy_set`. تنها مسیر انسانی اسکوپ `ledger:decide`
(REST/پنل/`ledger-cli`) است.

---

## ۵. PE‑0 — پایه‌ریزی ماژول (بدون منطق Gate)

**هدف:** داربست کامل، بدون رفتار: ماژول ثبت، مهاجرت، تنظیمات، envelope ابزارها.

**محدودهٔ تغییر:**
1. `packages/core/src/db/migrations/0010_exec.migration.ts` (۱۶ جدول: ۱۵ جدول `exec_*` + `exec_code_seq` برای شمارندهٔ کد + trigger
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

**معیارهای پذیرش PE‑0**

- [ ] PE‑0.1 `npm run migrate` روی DB خالی سبز؛ اجرای دوم **idempotent** (بدون خطا).
- [ ] PE‑0.2 `npm run schema:check` سبز: ۱۶ جدول §H با ستون/نوع/NOT NULL/ایندکس مطابق `DATA_MODEL.md`.
- [ ] PE‑0.3 تست واحد: `UPDATE`/`DELETE` روی `exec_events|exec_evidence|exec_action_journal`
      با نقش اپ `FORBIDDEN`/trigger خطا (تست `tests/integration/exec-ledger-invariants.test.ts`).
- [ ] PE‑0.4 حذف رکورد از هر مسیر عمومی ledger با `CONFLICT LEDGER_STATE_INVALID`/خطای دسترسی رد می‌شود (تست لیست ابزارها: هیچ `*_delete` وجود ندارد).
- [ ] PE‑0.5 ۲۰ فراخوانی همزمان `allocateLedgerCode` → ۲۰ کد یکتای پیوسته (تست همزمانی).
- [ ] PE‑0.6 `GET /health/ready` بدون تغییر؛ ماژول پیش‌فرض خاموش و `tools/list` ایجنت بدون
      ابزار جدید است؛ با enable، ابزارها ظاهر می‌شوند (تست integration).
- [ ] PE‑0.7 `npm run verify` سبز (lint, typecheck, unit+integration, coverage ≥ 80, build)
      و `docs:check` بدون لینک شکسته.

---

## ۶. PE‑1 (بخش A) — Ledger: تسک، معیار، آیتم باز، رویداد، قوانین بستن

**کد قطعی:** `exec-open-items.ts` (ماشین وضعیت)، `exec-codes.ts`، قوانین `CHECK` DB.

**قوانین:** آیتم `blocks_completion=true` فقط با `resolved|not_applicable` و
`resolution_note ≥ 20 کاراکتر` بسته می‌شود؛ `accepted|deferred|wont_fix` فقط با
`resolved_by='human'` (مسیر انسانی = `approval_requests` یا CLI). تغییر وضعیت → `exec_events`.

**معیارهای پذیرش بخش A**

- [ ] A.1 مکالمه پاک و نشست تازه → `exec_ledger_status` تمام وضعیت (تسک‌ها، آیتم‌ها،
      سؤالات، دisions، معیارهای بدون evidence) را از DB برمی‌گرداند؛ تست: call بعد از `reset()` harness.
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
`deriveStatus` خالص و تست‌شده). در قبول: `status='done'`, `closed_at=now()`, آیتم‌های
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
- `docs/MCP.md`: قطعهٔ پیکربندی بریج stdio + کلید API با اسکوپ‌های `ledger:*`.
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
`baseline.ts`: job `exec.baseline` → اجرای `exec.test_command` → parse با regex →
`exec_baseline_tests` (writer = کد؛ ابزار «ثبت دستی نتیجه» وجود ندارد). قاعدهٔ ۱۲ Gate:
اجرای مجدد + سه تشخیص: `fail` جدید، **ناپدید شدن** تست، و تضعیف (کاهش تعداد
`it/test/assert` در `exec.protected_test_globs` یا افزودن `skip/only/xit/xdescribe`) →
`open_item(type='test_gap', blocks=true)`؛ رفع فقط با تأیید انسان.

- [ ] J.1 تغییر فایل خارج از `allowed_paths` → آیتم مسدودکننده (تست).
- [ ] J.2 حذف یک تست baseline → Gate رد؛ برگرداندن تست → Gate سبز.
- [ ] J.3 افزودن `.skip` به تست baseline → رد؛ `.only` روی یک تست دیگر → رد (هر دو).
- [ ] J.4 نتیجهٔ baseline فقط توسط کد؛ فراخوانی `ledger_add_evidence(kind:'test_output')`
      برای قاعدهٔ ۱۲ کافی نیست (تست شمارش writer).
- [ ] J.5 `allowed_paths` بدون تأیید انسان قابل تغییر نیست (تست از هر ۳ مسیر: MCP، REST، CLI با کلید ایجنت).
- [ ] J.6 `test_command` خاموش ⇒ قاعدهٔ ۱۲ `skipped` + آیتم ریسک `blocks=false`؛ در گزارش نهایی برجسته.
- [ ] J.7 اجرای تست در sandbox: تست واحد روی `exec/test-runner.ts` — reject خارج از
      `allowed_repo_roots`، reject symlink escape، timeout، cap خروجی ۱MB، بدون env والد.
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

### PE‑12 — پنل، بریج stdio، README، سناریوی E2E، پاکسازی

- `apps/web/src/app/pages/exec-ledger.ts`: جدول تسک‌ها با ستون‌های `code/status/open items/blocked_on/
  gate summary` + درگاه «بازکردن قفل‌ها» (resolve/answer/approve/waive/drop/promote) → فقط
  endpoint‌های انسانی؛ کلیدهای i18n جدید؛ تست واحد کامپوننت + یک مسیر در `e2e/chain.spec.ts`.
- بریج `apps/ledger-mcp/` (`forgepm-ledger-mcp`, stdio → `/mcp`، `FORGEPM_URL`/`FORGEPM_API_KEY`):
  ۱) retry با backoff، ۲) کش فقط‑خواندنی از `ledger_status` در `.agent-ledger/ledger.db`
  (SQLite فقط برای **نمایش آفلاین**)، ۳) `--local` advisory: ledger محلی جدا، همهٔ خروجی‌ها با
  `"advisory": true, "enforced": false` و بدون قدرت بستن تسک (پرس از سرور همیشه لازم).
- `README.md`: بخش «Execution control» (نصب، enable، پیکربندی MCP، `npm run ledger -- --help`,
  `policy:print/set`, `config.json` جایگزین = settings).
- `docs/EXECUTION_CONTROL.md`: جدول وضعیت معیارهای پذیرش A–K با خط‌های `local:`/`remote:` (الگوی
  `npm run report:phase`).

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
| 8 | حذف تست baseline | قاعدهٔ ۱۲ رد |
| 9 | تغییر فایل مرجع فکت | stale → needs_revisit → رد |
| 10 | کرش میانهٔ migration | `unknown` اول؛ تکرار مسدود |
| 11 | بازبینی (stub provider) | TODO جاافتاده → finding |
| 12 | تأییدهای انسانی از CLI | approve + answer + waive |
| 13 | `task_complete` نهایی | `done` + گزارش از Ledger (تطابق شمارش‌ها) |

اسکریپت exit code غیرصفر در هر انحراف؛ در CI به‌عنوان یک step مستقل اجرا می‌شود (با harness DB).

**معیارهای پذیرش PE‑12**

- [ ] L.1 `npm run exec:e2e` در CI سبز (۱۳ صحنه، ۰ خطای موردانتظار).
- [ ] L.2 بریج stdio: handshake + `tools/list` + `tools/call` با SDK موجود (`@modelcontextprotocol/sdk`،
      الگو: `apps/api/test/integration/phase4-sdk.test.ts`).
- [ ] L.3 حالت offline: سرور down ⇒ ابزار نوشتن خطای صریح «fail closed»؛ `--local` با برچسب advisory.
- [ ] L.4 کش محلی فقط `readonly` (تست: هیچ statement نوشتاری در مسیر local cache برای `advisory:false`).
- [ ] L.5 i18n parity + RTL: `node scripts/i18n-check.mjs` سبز؛ صفحهٔ جدید بدون سرریز در ۳۶۰/۱۲۸۰.
- [ ] L.6 `npm run verify`، `schema:check`، `gen:api:check`، `docs:check`، `migration-hash`، `perf`
      (P‑02 بدون رگرسیون > ۱۰٪ برای `exec_ledger_status` با ۱۰۰۰ آیتم) سبز.
- [ ] L.7 پوشهٔ تست واحد `exec.*` ≥ ۸۰٪ خطوط/توابع (thresholds موجود).

---

## ۱۴. استراتژی تست (نگاشت معیار → تست)

| نوع | کجا | نمونه |
|---|---|---|
| واحد (کد قطعی، بدون DB) | `packages/core/src/exec/*.test.ts`, `packages/shared/src/schemas-exec.test.ts`, `tests/unit/*` | policy, gate rules, assertCheckable, scope glob, baseline parse, journal, session pack, codes |
| Integration (Postgres+Redis واقعی) | `tests/integration/exec-*.test.ts` با `createHarness()` | ledger, gate روی تسک واقعی، approvals، stale/review، req coverage، resume |
| MCP contract | `apps/api/test/integration/exec-sdk.test.ts` (SDK + stdio) و `tests/integration/exec-mcp.test.ts` (JSON-RPC) | tools/list با/بدون enable، scope، rate limit، idempotency، envelope خطا |
| E2E پذیرش | `scripts/exec-e2e.ts` + `npm run exec:e2e` (CI) | ۱۳ صحنهٔ §۱۳ (PE‑12) |
| پنل | `apps/web/src/app/pages/exec-ledger.spec.ts` + `apps/web/e2e/chain.spec.ts` | approve از پنل، جدول، RTL |
| دروازهٔ ساختاری | تست‌های موجود | `schema:check`, `docs:check`, `gen:api:check`, `check-migration-hashes`, `eslint-boundaries` |
| نفوذ/امنیت | `tests/integration/pou-exec-security.test.ts` | حذف رکورد، حذف مسیر، secret mask، path traversal، SQL injection در `ref` (کوتاه‌ترین مسیر: همه از Kysely parameterized) |
| عملکرد | `scripts/exec-perf.mjs` (تولید ۱۰۰۰ OI) | p95 `ledger_status < 150ms`, `session_start < 250ms`, gate dry-run < 120ms |

هر فاز با **تست قرمز اول** شروع می‌شود (الگوی `AGENTS.md`) و سبز شدن همان تست، معیار اتمام آن فاز است.
معیار پذیرشی که تست خودکار ندارد، در `docs/EXECUTION_CONTROL.md` با برچسب `manual:` و دستور اجرایش ثبت می‌شود.

---

## ۱۵. امنیت، ریسک‌ها و محدودیت‌ها

| ریسک | کاهش |
|---|---|
| اجرای `test_command` روی سرور = RCE | پیش‌فرض `exec.harness.enabled=false` + `allow_host_test_command=false`؛ اجرای worker در container با mount read-only + env بدون secret + timeout + cap خروجی؛ path allowlist prefix-safe؛ تست J.7 |
| تورم ۲۷ ابزار MCP → context و فراموشی ثبت | `exec.tools.level='core'` (۱۲ ابزار اجباری)؛ بقیه با enable سطح `full`؛ توضیح یک‌خطی هر ابزار ≤ ۲۰۰ کاراکتر؛ `exec.tool_output_max_bytes` |
| Ledger به‌عنوان منبع نشت secret | mask قبل از ذخیره (الگوی `maskInput`) + تست B.16 + رد الگوهای `fpm_`/PEM/AWS |
| Write amplification (هر فراخوانی = event) | batch در یک تراکنش؛ ایندکس `(task_id, ts)`؛ ریلین `exec_events` با retention موجود (`retention.ts`) |
| قفل شدن تسک‌ها در حلقهٔ بی‌پایان بازبینی | سقف ۲ دور + ارجاع انسانی (E.6) |
| هم‌زمانی ایجنت‌های متعدد روی یک تسک | `idempotency_key` الزامی برای نوشتن‌های idempotent؛ `SELECT … FOR UPDATE` روی شمارنده‌ها؛ تست همزمانی A.5/PE‑0.5 |
| انحراف `done` در UI توسط انسان | guard فقط برای تسک‌های دارای `exec_task_id`؛ اقدام انسان مجاز است ولی `exec_events` با `actor_type='human'` + `open_item(source='human')` ثبت می‌شود |
| نبود `start_ref` (ایجنت hook ندارد) | fallback manifest + علامت `scope:'unknown'` و **رد قاعدهٔ ۱۱** (fail closed) |
| هزینهٔ LLM بازبینی | `exec.max_cost_tokens` + `ai_calls` (E.8) + حداکثر ۲ دور |

`docs/SECURITY.md` به‌روزرسانی: § جدید «exec_control» (تهدیدها/کاهش‌ها)، و `docs/RUNBOOK.md`:
«قفل شدن تسک → dry-run گیت از CLI»، «پاکسازی journal معلّق»، «restore از بکاپ + verify».

---

## ۱۶. ترتیب اجرا، وابستگی‌ها و برآورد

| فاز | محتوا | وابسته به | روز‌مهندس (کد+تست+مستند) |
|---|---|---|---|
| PE‑0 | داربست، مهاجرت ۱۵ جدول، codes، settings، schema:check | — | ۱٫۵–۲ |
| PE‑1 (A) | ledger + ماشین وضعیت + invariants | PE‑0 | ۱–۱٫۵ |
| PE‑2 (B هسته) | task_start/status/list_open/add_item/resolve | PE‑1 | ۲ |
| PE‑3 (C) | Exit Report + Gate ۱۳ قاعده + guard تسک | PE‑2 | ۲٫۵–۳ |
| PE‑4 (B ادامه) | evidence/decision/ask_human/policy_check + REST + CLI + approvals | PE‑3 | ۲٫۵ |
| PE‑5 (F) | policy engine + policy config + hook template | PE‑4 | ۱ |
| PE‑6 (D) | LEDGER_RULES.md + AGENTS.md + تست رفتاری ۳ تسک | PE‑2..PE‑5 | ۱ |
| PE‑7 (E) | بازبین خصمانه (`kind:'exec'`) + ابطال hash | PE‑3, PE‑4 | ۲–۲٫۵ |
| PE‑8 (J) | scope + baseline + test weakening | PE‑0, PE‑3 | ۲ |
| PE‑9 (G+H) | requirements registry + plan/deps/blocked | PE‑1..PE‑3 | ۲ |
| PE‑10 (K) | journal + session_start + reconcile | PE‑3 | ۱٫۵ |
| PE‑11 (I) | facts + verify + links | PE‑10 (session hook) | ۲ |
| PE‑12 | پنل + بریج + README + e2e + CI step | همه | ۲–۲٫۵ |
| **جمع** | ۱۳ فاز | | **۲۲–۲۵ روز‌مهندس** |

**قاعدهٔ ترتیب:** هر فاز فقط با تست‌های خودش بسته می‌شود؛ هیچ فازی با `skip`/`TODO` تحویل
نمی‌شود؛ اگر چیزی لازم شد و در این پلن نبود → `open_item` و توقف (نه ساخت بی‌اجازه).
اگر PE‑8 تا PE‑۱۰ زمان‌بر شد، **این ترتیب قابل تحویل است**: PE‑0…PE‑7 (۸۰٪ ارزش) →
PE‑8 → PE‑9 → PE‑10 → PE‑11 → PE‑12. پنل می‌تواند به یک نسخهٔ خواندنی کاهش یابد
(ثبت به‌عنوان `open_item(type='out_of_scope')` در صورت تصمیم به حذف).

**نقشهٔ شاخه/تگ:** هر فاز = `phase/exec-<N>-<slug>` از `main`، squash‑merge،
تگ `v1.<N>.0-rc.<m>` پس از سبز شدن remote CI (قرارداد `AGENTS.md`).

---

## ۱۷. تعریف «تمام» (Definition of Done) برای این پروژه

1. **۱۰۹ معیار پذیرش A–K + PE‑0/PE‑12 (§۵ تا §۱۳)** تیک‌خورده؛ هرکدام با برچسب
   `auto:` به فایل تست یا `manual:` به دستور اجرایی مشخص (قاعدهٔ `AGENTS.md`: بدون اجرای
   واقعی دروازه، سبز اعلام نمی‌شود).
2. `npm run verify` سبز (lint, typecheck, unit, integration, coverage ≥ 80, build) +
   `schema:check` + `docs:check` + `gen:api:check` + `migration-hash` + `i18n-check`.
3. `npm run exec:e2e` سبز در CI (۱۳ صحنه) — **سناریوی بخش ۵ + ۶ مورد ضمیمه**.
4. `docs/LEDGER_RULES.md` + `AGENTS.md` + `docs/EXECUTION_CONTROL.md` + `docs/MCP.md` +
   `docs/API_CONTRACTS.md` + `docs/MCP_CONTRACTS.md` + `docs/DATA_MODEL.md` (§H) +
   `docs/SECURITY.md` + `docs/RUNBOOK.md` + `README.md` + `CHANGELOG.md` به‌روز.
5. گزارش نهایی **توسط همین سیستم** تولید می‌شود: `exec_ledger_status` + `buildFinalReport`
   (موارد باز، فرض‌ها، تصمیم‌های بدون تأیید، `waived`ها، `skipped`های قاعدهٔ ۱۲، ابزارهای
   هرگز‌استفاده‌نشده در §۱۷).
6. خط‌های `local: pass|fail` و `remote: pass|fail|not-configured` در گزارش هر فاز (قاعدهٔ مخزن:
   بدون اجرای واقعی دروازه، سبز اعلام نمی‌شود).

---

## ۱۸. موارد باز، فرض‌ها و تصمیم‌هایی که همین حالا باید در Ledger ثبت شوند

**موارد باز مسدودکننده (قبل از PE‑0 باید تعیین تکلیف شوند):**

| ref | عنوان | نوع | نیازمند |
|---|---|---|---|
| OI‑1 | تأیید D‑01: Postgres به‌جای SQLite (Ledger سمت سرور) | assumption/design_gap | پاسخ مالک |
| OI‑2 | تأیید D‑02: ابزارها داخل `ToolRegistry` یا MCP server مستقل | design_gap | پاسخ مالک |
| OI‑3 | تأیید D‑07: حجم ۴۲۰۰–۵۲۰۰ خط در برابر سقف ۸۰۰ خط پرامپت | risk | پاسخ مالک |
| OI‑4 | تأیید D‑08/J.6: آیا اجرای `test_command` روی سرور مجاز است یا baseline از CI خوانده شود؟ | risk | پاسخ مالک |
| OI‑5 | آیا `ledger-cli` باید باینری مستقل npm باشد یا اسکریپت مخزن کافی است؟ | scope | پاسخ مالک |
| OI‑6 | ۲۸ ابزار (پیشنهادهای §۴.۰) یا فقط ۱۲ ابزار core؟ سطح پیش‌فرض کدام باشد؟ | design_gap | پاسخ مالک |
| OI‑7 | پنل کامل یا فقط‌خواندنی + درگاه تأیید؟ | scope | پاسخ مالک |

**فرض‌های من (بدون تأیید، اگر اشتباه بودند هزینهٔ بازگشت دارند):**

- A‑1: `exec.*` ابزارها فقط برای actor نوع `agent` و `user` با اسکوپ `ledger:*` فعال‌اند؛
  انسان‌ها عموماً از REST/پنل استفاده می‌کنند.
- A‑2: یک `exec_task` به یک `work_item` نگاشت می‌شود (۱:۱)، نه برعکس چندتایی.
- A‑3: `exec_events` جای `mcp_tool_calls` را نمی‌گیرد؛ لاگ خام همان‌جا می‌ماند (تکرار داده ممنوع).
- A‑4: واژه‌نامهٔ «معیار مبهم» برای انگلیسی و فارسی؛ برای زبان‌های دیگر `CRITERION_NOT_CHECKABLE`
  محافظه‌کارانه رد می‌کند تا انسان بازبینی کند.
- A‑5: در نسخهٔ ۱، `waive` معیار فقط با `approval_requests` (نه صرفاً `ledger:decide` کلید).
- A‑6: `exec_review` روی همان `review_runs` نوشته می‌شود تا پنل Reviews رایگان کار کند.

**تصمیم‌های فنی این سند (هر کدام در PE‑0 با `ledger_record_decision` ثبت می‌شود):**
`Postgres-backed ledger`، `gate single entry + transition guard`، `settings-based policy`،
`code-allocated readable ids`، `approval_requests as human channel`، `review engine reuse for adversarial`،
`core/full tool levels`، `fail-closed offline behavior`.

---

## ۱۹. چک‌لیست شروع اجرا (اولین ۳۰ دقیقه پس از تأیید این سند)

```
1) ledger-cli / REST: exec module enable (system) → modules.exec_control.enabled=true
2) req_add برای ۲۱ بند الزام این سند (هر § معیار = یک REQ با quote از همین فایل)
3) record_decision برای D‑01…D‑10 (approval برای D‑01, D‑02, D‑07, D‑08)
4) ask_human برای OI‑1…OI‑7 (blocking=true)  ← تا پاسخ، PE‑1 شروع نشود
5) task_split: PE‑0…PE‑12 با depends_on طبق §۱۶ و allowed_paths هر فاز
6) baseline_capture برای مخزن (PE‑8 فعال شود) و fact_record از DATA_MODEL/ARCHITECTURE
```
