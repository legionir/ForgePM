# Platform Parity — Trello & GitHub patterns for ForgePM Panel

برای اینکه ForgePM شبیه به Trello/GitHub شود، باید **الگوهای تعاملی و بصری**
آن پلتفرم‌ها را به‌صورت هدفمند وارد کنید — نه کپی ظاهری. بر اساس کد فعلی و
`docs/DESIGN_SYSTEM.md`.

## ۱. الگوهای Trello (Kanban / Board)

| الگوی Trello | وضعیت فعلی ForgePM | کار لازم |
|---|---|---|
| کارت با عنوان + برچسب رنگی + آواتار + چک‌لیست | `.card` فقط عنوان + کلید | کارت غنی: برچسب (label chips)، آواتار مسئول، نشانگر چک‌لیست، تاریخ سررسید |
| Drag & Drop با انیمیشن جابجایی | DnD native بدون انیمیشن | اضافه کردن transition روی جابجایی کارت (motion token) |
| ستون‌ها با عنوان + شمارنده + منوی «...» | ستون ساده با `h2` | header ستون: نام + count + overflow menu (افزودن کارت، تغییر نام، آرشیو) |
| Quick-add کارت در پایین ستون | فرم جداگانه در پایین صفحه | دکمهٔ «+ Add card» در هر ستون → inline input |
| رنگ پس‌زمینهٔ برد / تم | فقط light/dark | تم‌های برد (رنگ پس‌زمینهٔ ستون‌ها) — اختیاری، بعد از MVP |
| فیلتر/جستجو روی برد | فقط فیلتر state | فیلتر بر اساس label، assignee، priority |

فایل‌های متأثر: `pages/work-items.ts` (board view), `styles.scss` (`.board`, `.card`).

## ۲. الگوهای GitHub (Issues / PR / Repo)

| الگوی GitHub | وضعیت فعلی ForgePM | کار لازم |
|---|---|---|
| لیست با checkbox + عنوان + metadata (labels, milestone, assignee, comments count) | جدول ساده ۵ ستون | ردیف غنی: checkbox، عنوان، labels (chips)، priority badge، state badge، assignee avatar، comment count |
| Sidebar در detail (Assignees, Labels, Projects, Milestone, Linked PRs) | فقط meta line متنی | sidebar سمت راست در work-item-detail با فیلدهای قابل ویرایش |
| Tabs (Conversation / Commits / Checks / Files changed) | فقط یک view | tabs برای detail: Comments, Activity, Acceptance, Links |
| Markdown rendering برای description/comments | متن خام | رندر Markdown (نیاز به lib — بررسی bundle budget) |
| Status badges (Open/Closed/Merged) با رنگ | متن ساده | badge component با variant (success/warning/error/neutral) |
| Keyboard shortcuts (`c` new issue، `/` search، `g`+`i` issues) | هیچ | shortcut handler + help modal (`?`) |
| Command palette (Cmd+K) | هیچ | palette برای جستجو/ناوبری سریع |
| Reactions (👍 ❤️) روی comments | هیچ | اختیاری — بعد از MVP |
| Timeline/activity با آیکون | لیست متنی | timeline با آیکون + actor + timestamp |

فایل‌های متأثر: `pages/work-items.ts`, `pages/work-item-detail.ts`, `pages/features.ts`.

## ۳. الگوهای مشترک (هر دو پلتفرم)

### ۳.۱ Avatar / User identity
- الان فقط نام متنی. اضافه کردن avatar (حروف اول یا تصویر) در nav، comments، assignee.
- کامپوننت `ui/avatar` با size scale.

### ۳.۲ Badge / Label chips
- کامپوننت `ui/badge` با variant (default, success, warning, error, info) و size (sm/md).
- استفاده: state, priority, labels, risk level.

### ۳.۳ Tooltip
- hover tooltip برای آیکون‌های بدون متن (overflow menu، actions).

### ۳.۴ Popover / Dropdown menu
- منوی «...» برای row actions (فعلاً دکمهٔ مستقیم archive/revoke).

### ۳.۵ Search
- جستجوی global در shell (Cmd+K یا input در nav).
- فیلتر در صفحات list.

### ۳.۶ Empty states با CTA
- الان متن ساده. اضافه کردن illustration + CTA (مطابق UI design spec).

### ۳.۷ Loading skeletons
- الان فقط `…`. skeleton rows/cards.

### ۳.۸ Toast notifications
- الان inline `msg()`. toast شناور (bottom-right) با auto-dismiss.

### ۳.۹ Breadcrumbs
- در detail pages: Projects / Work Items / KEY.

### ۳.۱۰ Responsive sidebar
- GitHub-style: sidebar ثابت در desktop، drawer در mobile.

## ۴. اولویت‌بندی پیشنهادی (MVP → Polish)

**فاز ۱ (MVP parity — کم‌هزینه، تأثیر بالا):**
1. Badge component (state, priority, risk) — جایگزین متن ساده.
2. Avatar component (حروف اول) در comments و nav.
3. Empty state با CTA (illustration ساده).
4. Loading skeleton برای tables/lists.
5. Toast به‌جای inline msg.
6. Breadcrumbs در detail pages.
7. Keyboard shortcuts پایه (`/` search، `?` help).

**فاز ۲ (Polish):**
8. Sidebar در work-item-detail (assignees, labels, milestone).
9. Tabs در detail (conversation/activity/acceptance).
10. Command palette (Cmd+K).
11. Overflow menu («...») برای row actions.
12. Markdown rendering (با بررسی bundle budget).

**فاز ۳ (Nice-to-have):**
13. Reactions روی comments.
14. تم‌های برد (Trello-style).
15. Drag animation.

## ۵. نکات مهم (بر اساس audit)
- همهٔ این‌ها باید از **توکن‌های design system** استفاده کنند (نه مقادیر خام) — وگرنه drift تکرار می‌شود (TKN-001, ENF-001).
- هر کامپوننت جدید باید **states** (loading/empty/error/disabled/hover/focus) داشته باشد (STT-*).
- **یک concept = یک component** — نسازید `PrimaryButton` و `SubmitButton` جداگانه (CMP-*).
- **Bundle budget**: ۵۰۰ KB gzip — هر dependency جدید (markdown lib، icon lib) باید توجیه شود.
