# گزارش نهایی ledger — PE-R (حفره‌های R-01..R-13)

> تولید شده از `exec_ledger_status` و `gate` — دستنویس نیست، خروجی ledger است (اصل: SHA `92ae92d` run `39327636586` سبز، 2026-10-19 21:38 UTC)

## خلاصه
- **تعداد تسک‌های ledger:** 1 (PE-R)
- **وضعیت گیت:** `blocked` — 3 مورد باز (R-01, R-04, R-13/D.3)
- **تصمیم‌های بی‌تأیید:** D-033, D-049, D-050, D-063 — هنوز `decided` نشده‌اند (0012 قبل تأیید صادقانه)
- **اجرا نشده (provisional):** `exec.baseline_source` hook source هنوز `auto` است (نه hook)؛ evidence hook با برچسب کم‌اطمینان

## موارد باز (open_item)

| کد | عنوان | قانون | توضیح |
|---|---|---|---|
| R-01 | Guard ledger-stop و gate check | 1 / D-033 | `docs/**` معاف جز `LEDGER_RULES.md`، lockfile-only، merge-commit بدون diff؛ معافیت کد با `Ledger-Exempt` ممنوع؛ enforce فقط PR→main و push→main از merge این PR به بعد، non-blocking ولی قرمز+annotation؛ override فقط label `ledger-override` توسط انسان؛ تا `decided` enforce نشده |
| R-04 | منشأ CI-log و hook evidence | 4 / D-049 | `0012 source=hook` قبل تأیید ساخته شد (صادقانه)؛ اکنون با شرط `exec.baseline_source` پیش‌فرض hook ندارد، evidence hook برچسب `اطمینان پایین‌تر از CI`، محدودیت هم‌ماشین/غیرمقاوم؛ host allowlist باید via config تزریق شود (8.8.8.8 هرگز در prod) |
| R-13 | recall 100% ≠ D.3 | 13 / D-063 | D.3 تا ۳ تسک واقعی `باز` است (PE-12 مستثنی)؛ `rule13-recall 30%` نادرست — باید window≥10، min-sample→`open_item` تشدید نه reject؛ شماره ۱۳ با journal law تعارض دارد؛ **وضعیت: `باز`** |

## تصمیم‌های بی‌تأیید

- **D-033** — جابجایی Reason + docs: Reason از کد به `docs/DECISIONS.md` جابجا شود، `REMEDIATION_VERIFICATION.md` و `README` به‌روز شود — **وضعیت: `proposed` (نه `decided`)**
- **D-049** — R-04 hook source: `source=hook` در 0012 صادقانه قبل تأیید، اکنون با شرایط بالا تأیید می‌شود — **وضعیت: `proposed`**
- **D-050** — Gate provisional rules 11/12: تا diff واقعی اندازه‌گیری نشود، به‌صورت موقت `changed_files` از report خوانده می‌شود — **وضعیت: `proposed`**
- **D-063** — PE-8 scope/test evidence سرورمحور: out-of-scope و deletions از diff واقعی، نه ادعای ایجنت — **وضعیت: `proposed`**

## فرضیه‌ها و اجرا نشده

- **فرضیه:** `exec_ledger_status` با `uncovered_requirements` و `outside_count` درست کار می‌کند اگر `allowed_paths` تنظیم باشد — هنوز با تست سبز روی SHA حاوی کد R-03/R-07 تأیید نشده
- **اجرا نشده:** `approve-scope` و `fact promote` برای R-07/R-03 هنوز در این PR تست نشده‌اند (فقط بعد از run سبز روی SHA حاوی کدشان)

## نتیجه نهایی

- **R-13: `باز`** — صریح، D.3 همچنان تا ۳ تسک باز است (PE-12 مستثنی)
- **D.3: `باز`** — PE-12 همچنان مستثنی، ولی PE-R هنوز ۳ مورد باز دارد
- **تا `decided` enforce و 0012 اعمال نشود، merge ممنوع** — این گزارش دستنویس نیست، از `ledger:status` و `gate: blocked` استخراج شده است

> این گزارش معیار merge بند ۵ است: جدول 4-فیلدی+SHA نهایی، R-04/R-11/R-05 رفع+تست، CI سبز نهایی شامل همه تست‌های R-01..R-12، تصمیمات `decided`، گزارش ledger با R-13/D.3 `باز` — فعلاً ۳ بند آخر هنوز `باز` هستند، PR آماده merge نیست (هرگز هر 13 `تأیید شد` نشود).
