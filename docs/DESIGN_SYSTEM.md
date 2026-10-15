# ForgePM Design System — v0.1 (draft)

Status: DRAFT (design-system designer pass, 2026-10-15). Derived from the
frontend audit `docs/FRONTEND_DESIGN_SYSTEM_REVIEW.md`. This document defines
the token set and component contracts the panel (`apps/web`) must converge on.
Code-level implementation is tracked separately (frontend developer scope).

## 1. Principles

1. One concept, one component (§13.3 of the Frontend Design System contract).
2. Every visual property derives from a named token (§13.2).
3. States (loading, empty, error, disabled, hover, focus, active, success) are
   defined once per component type and inherited (§13.5).
4. Theming is token-swap only; no per-component dark-mode conditionals (§13.11).
5. Deviations must be documented here before use (drift pass).

## 2. Tokens

### 2.1 Colour (semantic, theme-aware)

Light (`:root`) / Dark (`prefers-color-scheme: dark`), as currently defined in
`apps/web/src/styles.scss:4-22`:

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--color-bg` | `#fff` | `#16191d` | page background |
| `--color-fg` | `#1c2025` | `#e8eaed` | primary text |
| `--color-muted` | `#5f6771` | `#9aa2ab` | secondary text / labels |
| `--color-line` | `#d6dade` | `#3a4046` | borders/dividers |
| `--color-accent` | `#2457c5` | `#8ab4f8` | primary action, active nav |
| `--color-error` | `#b3261e` | `#ff6b61` | error text/borders |
| `--color-ok` | `#1a7f37` | `#6fdc8c` | success/confirmation |
| `--color-surface` | `#f5f7f9` | `#1f2429` | elevated surface |
| `--color-on-accent` | `#fff` (light) / `#16191d` (dark) | — | text on accent (replaces hardcoded `#fff`, TKN-002/RSP-004) |

Rule: raw hex only inside this table. Status colours keep one meaning everywhere.

### 2.2 Spacing (4-based scale)

| Token | Value |
|---|---|
| `--space-1` | 4px (0.25rem) |
| `--space-2` | 8px (0.5rem) |
| `--space-3` | 12px (0.75rem) |
| `--space-4` | 16px (1rem) |
| `--space-6` | 24px (1.5rem) |
| `--space-8` | 32px (2rem) |
| `--space-12` | 48px (3rem) |
| `--space-16` | 64px (4rem) |

Derived from the raw values currently in `styles.scss` (0.2–1.2rem); collapse to
nearest scale step during migration.

### 2.3 Typography

| Token | Value | Role |
|---|---|---|
| `--font-size-h1` | 1.4rem | page title (always `h1`) |
| `--font-size-h2` | 1.05rem | section title (always `h2`) |
| `--font-size-body` | 1rem | body text |
| `--font-size-label` | 0.85rem | form labels |
| `--font-size-caption` | 0.9rem | captions / board column headers |
| `--font-weight-regular` | 400 | body |
| `--font-weight-semibold` | 600 | active nav, emphasis |
| `--line-height-tight` | 1.2 | headings |
| `--line-height-base` | 1.5 | body |

Font family: `system-ui, 'Segoe UI', Tahoma, sans-serif` (unchanged).

### 2.4 Radius

| Token | Value |
|---|---|
| `--radius-sm` | 6px |
| `--radius-md` | 8px |
| `--radius-lg` | 10px |
| `--radius-full` | 9999px |

### 2.5 Shadow / elevation

| Token | Value |
|---|---|
| `--shadow-flat` | none |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.06)` |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.10)` |
| `--shadow-modal` | `0 12px 32px rgba(0,0,0,0.18)` |

(No shadows currently used; defined for future components.)

### 2.6 Motion

| Token | Value |
|---|---|
| `--motion-fast` | 120ms |
| `--motion-base` | 200ms |
| `--motion-slow` | 320ms |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |

### 2.7 Breakpoints

| Token | Value |
|---|---|
| `--bp-sm` | 640px |
| `--bp-md` | 768px |
| `--bp-lg` | 1024px |
| `--bp-xl` | 1280px |

### 2.8 Z-index

| Token | Value |
|---|---|
| `--z-base` | 0 |
| `--z-dropdown` | 10 |
| `--z-sticky` | 20 |
| `--z-overlay` | 30 |
| `--z-modal` | 40 |
| `--z-toast` | 50 |

### 2.9 Focus ring

| Token | Value |
|---|---|
| `--focus-ring` | `2px solid var(--color-accent)` |
| `--focus-ring-offset` | `2px` |

## 3. Component library (contracts)

Each component lives in `apps/web/src/app/ui/<name>.ts` (one component per file),
with `ChangeDetectionStrategy.OnPush`, and must cover the listed states.

### 3.1 Button
- Props: `variant: 'primary' | 'secondary' | 'destructive' | 'ghost'`, `size: 'sm' | 'md'`, `disabled`, `loading`, `type`.
- States: default, hover, focus-visible, active, disabled, loading.
- Events: `(clicked)` (or native submit when `type="submit"`).
- Rules: primary = accent bg + on-accent text; destructive = error colour; never
  style by CSS selector on `button[type=...]`.

### 3.2 Input / Select / Textarea
- Shared height, padding, border, radius, focus treatment driven by tokens.
- Props: `label`, `placeholder` (hint only), `error`, `helper`, `required`,
  `disabled`, `readOnly`.
- States: default, focus-visible, error, disabled, readOnly.
- Validation timing policy: on submit (default); on blur for fields with async
  validation (documented per field).

### 3.3 Card
- Props: `title`, `subtitle`, `actions` slot.
- States: default, hover (if interactive).

### 3.4 Table / Data list
- Props: `columns`, `rows`, `empty` template, `loading`, `error`.
- Shared: header styling, sort indicator icon, pagination, row hover, row
  selection checkbox, row action menu, empty/loading/error states.

### 3.5 Empty state
- Props: `icon`, `message`, `action` (optional button).
- Used by every list/table/search.

### 3.6 Loading (skeleton/spinner)
- One canonical treatment per component type (table skeleton, card skeleton,
  spinner for buttons).

### 3.7 Tabs
- Props: `items`, `active`, `aria-label`.
- States: default, active, focus-visible, disabled.

### 3.8 Modal / Drawer / Tooltip / Popover
- Defined when first needed; must reuse focus ring, overlay z-index, motion tokens.

### 3.9 Toast / confirmation
- Single shared mechanism (service + component) for success/error/info.

### 3.10 Project picker
- Existing `ui/project-picker.ts`; add loading/empty states (CMP-006).

## 4. Shell & templates

- One shell component (`ui/shell`) owning header/nav/footer; pages supply inner
  content only (SHL-002).
- Page templates: list, detail, form, dashboard. Spacing between shell and
  content governed by `--space-4`/`--space-6`.
- Page title is always `h1`; section titles `h2` (TYG-001/SHL-001).
- Primary action placement: top-right of page header; back navigation top-left.

## 5. Accessibility baseline

- Focus-visible ring on every interactive element (`--focus-ring`).
- Error containers use `role="alert"` / `aria-live="polite"`.
- Forms: label association via `for`/`id` in shared input.
- Drag-and-drop has a keyboard alternative (move controls).
- Contrast: verify with axe in CI (ENF-003).

## 6. Iconography

- Adopt one icon library (TBD by frontend lead); until then, replace emoji
  (☑/☐ in work-item-detail) with inline SVG from the chosen set.
- Icon sizes from spacing scale; icon-to-text spacing `--space-2`.

## 7. Motion

- Durations/easings from §2.6 only. No page-specific flourishes.

## 8. Responsive

- Breakpoints from §2.7. Tables get a horizontal-scroll container below `--bp-md`
  (or a card-list fallback, applied globally).
- Nav collapses to a drawer below `--bp-md`.

## 9. Theming

- Light/dark via `prefers-color-scheme` swapping token values only. No
  per-component `if dark mode` logic.

## 10. Governance

- New tokens/components require a PR updating this document + the living style
  reference (ENF-002).
- Lint rules forbid raw hex/spacing/font-size outside token definitions (ENF-001).
- Visual regression covers shared primitives/templates (ENF-003).
- Versioning: semver on this document; breaking token/component changes bump
  major.

## 11. Migration notes (from audit)

- Replace `#fff` literal in button rule with `--color-on-accent` (TKN-002).
- Replace 6/8/10px radii with `--radius-*` (TKN-003).
- Replace 1.4/1.05/0.9/0.85rem font sizes with `--font-size-*` (TKN-004).
- Replace ad-hoc spacing with `--space-*` (TKN-005).
- Create `ui/button`, `ui/empty-state`, `ui/loading`, `ui/data-table`,
  `ui/shell`, `ui/toast` (CMP-001..004).
- Fix unguarded async actions (STT-004, STT-005, FRM-004).
- Fix reviews catch-all (STT-006).
- Fix multiple h1 (SHL-001/TYG-001).
- Fix hardcoded "API key" label (FRM-005).
- Fix settings mutable signal (FRM-006).
- Add web to root verify gate (ENF-001).
