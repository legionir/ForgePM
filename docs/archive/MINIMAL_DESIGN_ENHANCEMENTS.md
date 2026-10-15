# Minimal Design Enhancements — ForgePM Panel

برای اینکه طراحی مینیمال فعلی «خالی/یکنواخت» نباشد ولی همچنان مینیمال بماند،
باید **لایه‌های کوچک و هدفمند** اضافه کنید، نه دکور. بر اساس
`docs/DESIGN_SYSTEM.md` و یافته‌های audit.

## ۱. رنگ (فعلاً همه چیز آبی/خاکستری)
- **Accent را فقط برای CTA اصلی** استفاده کنید (دکمهٔ primary، لینک active). بقیهٔ عناصر خنثی بمانند.
- **Status colors** (`--color-ok`, `--color-error`) فقط برای بازخورد (موفقیت/خطا) — نه برای دکور.
- **Surface elevation**: `--color-surface` برای کارت‌ها/پنل‌ها تا عمق بصری ایجاد شود (فعلاً border تخت است).
- یک **رنگ semantic سوم** (مثلاً `--color-warning` یا `--color-info`) برای هشدارها اضافه کنید — الان فقط ok/error هست.

## ۲. گرافیک/آیکون (فعلاً emoji ☑/☐)
- یک **کتابخانهٔ آیکون واحد** انتخاب کنید (مثلاً Lucide/Heroicons — SVG سبک) و emoji را جایگزین کنید (TYG-003).
- آیکون‌ها فقط **کاربردی**: کنار دکمه‌ها، در empty state، در nav. بدون آیکون تزئینی.
- **Empty state illustration**: یک SVG سادهٔ یک‌رنگ (line-art) برای «خالی بودن» — نه تصویر رنگی.
- **Logo/brand mark** در shell (فعلاً فقط متن "Panel").

## ۳. انیمیشن (فعلاً هیچ)
- فقط **micro-interactions** با توکن‌های motion (`--motion-fast/base/slow`):
  - hover/focus transition روی دکمه‌ها و لینک‌ها (120ms).
  - fade-in برای toast/empty state (200ms).
  - collapse/expand برای drawer nav (320ms).
- **هیچ animation تزئینی** (parallax، floating، gradient animation) — با مینیمال بودن منافات دارد.
- `prefers-reduced-motion` را رعایت کنید (motion را غیرفعال کنید).

## ۴. افکت/عمق (فعلاً همه تخت)
- **Shadow tokens** (`--shadow-sm/md`) فقط برای: modal، dropdown، toast، card hover.
- **Border** به‌جای shadow برای جداکننده‌ها (فعلاً همین‌طور است — خوب).
- **Focus ring** (`--focus-ring`) برای دسترسی — الان اصلاً نیست (STT-008).

## ۵. تایپوگرافی (فعلاً ۴ اندازهٔ خام)
- **وزن فونت**: فقط regular (400) + semibold (600) — الان همین‌طور.
- **Spacing بین متن‌ها** با توکن‌های `--space-*` (فعلاً خام).
- **Monospace** برای کدها/کلیدها (`.raw` الان دارد — خوب، فقط توکن‌سازی).

## ۶. Grid/فاصله (فعلاً ad-hoc)
- **Spacing scale** (4/8/12/16/24/32/48/64) به‌جای 0.2–1.2rem خام.
- **Max-width** محتوا 1280px (فعلاً 1200px — نزدیک، استاندارد کنید).

## ۷. کارهایی که نباید انجام دهید (برای حفظ مینیمال)
- گرادیان، glassmorphism، neumorphism.
- تصاویر stock/illustration رنگی.
- animation روی هر تعامل.
- چند رنگ accent.

## خلاصهٔ اولویت (کم‌هزینه، تأثیر بالا)
1. Focus ring (دسترسی) — ۱ ساعت.
2. Icon library + جایگزین emoji — ۲-۴ ساعت.
3. Spacing tokens + radius tokens — ۲ ساعت.
4. Shadow روی card/modal/toast — ۱ ساعت.
5. Micro-transition روی hover/focus — ۱ ساعت.
6. Empty-state SVG ساده — ۱-۲ ساعت.
