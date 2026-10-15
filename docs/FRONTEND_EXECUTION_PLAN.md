# ForgePM Frontend — Unified Execution Plan

**Status:** DRAFT (unified from 6 source documents, 2026-10-15)
**Source documents (now superseded by this plan):**
1. `docs/FRONTEND_DESIGN_SYSTEM_REVIEW.md` — audit report (67 findings)
2. `docs/DESIGN_SYSTEM.md` — token & component contract
3. `docs/UI_DESIGN.md` — UI design spec per page
4. `docs/UX_FLOWS.md` — UX flows & IA
5. `docs/MINIMAL_DESIGN_ENHANCEMENTS.md` — minimal design enhancement checklist
6. `docs/PLATFORM_PARITY.md` — Trello/GitHub platform parity guide

**Scope:** `apps/web` (Angular 22 standalone + signals) presentation layer only.
**Out of scope:** backend (`apps/api`, `apps/worker`, `packages/*`).

---

## 0. Executive Summary

The panel compiles and its E2E passes, but the UI is a patchwork: tokens exist only
as 8 colour variables; spacing/radius/typography/motion/breakpoints/z-index are raw
values; there is one shared primitive (`ProjectPickerCmp`); tables are hand-rolled on
5 pages; states (loading/empty/error/disabled/focus) are inconsistently defined;
no responsive breakpoints exist despite the claim; `apps/web` is excluded from the
root lint/verify gate. This plan unifies the audit findings, the design-system
contract, the UI/UX specs, the minimal-enhancement checklist, and the platform-parity
guide into a single phased, prioritized, traceable execution plan.

---

## 1. Goals

1. Establish a single source of visual truth (tokens) for colour, spacing, typography,
   radius, shadow, motion, breakpoints, z-index, focus ring.
2. Build a shared component library (`ui/*`) so one concept = one component.
3. Adopt a finite set of page templates + a shared shell.
4. Define all states (loading, empty, error, disabled, hover, focus, active, success)
   once per component type.
5. Add accessibility baseline (focus-visible, ARIA, keyboard, contrast).
6. Add responsive behaviour via shared breakpoints.
7. Enforce mechanically (lint rules, style reference, visual regression).
8. Progressively reach Trello/GitHub-level UX parity without breaking minimalism.

---

## 2. Design Tokens (single source of truth)

All tokens live in `apps/web/src/styles.scss` `:root` (light) + `prefers-color-scheme: dark`.

### 2.1 Colour (semantic, theme-aware)

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
| `--color-on-accent` | `#fff` / `#16191d` | — | text on accent (replaces hardcoded `#fff`) |
| `--color-warning` | (new) | (new) | warnings (to add) |
| `--color-info` | (new) | (new) | info (to add) |

Rule: raw hex only inside this table. Status colours keep one meaning everywhere.
Accent is used only for primary CTA and active nav; everything else stays neutral.

### 2.2 Spacing (4-based scale)

`--space-1`=4px, `--space-2`=8px, `--space-3`=12px, `--space-4`=16px,
`--space-6`=24px, `--space-8`=32px, `--space-12`=48px, `--space-16`=64px.

### 2.3 Typography

`--font-size-h1`=1.4rem (page title, always `h1`),
`--font-size-h2`=1.05rem (section title, always `h2`),
`--font-size-body`=1rem, `--font-size-label`=0.85rem, `--font-size-caption`=0.9rem.
Weights: 400 (regular), 600 (semibold). Line-heights: tight 1.2, base 1.5.
Font family: `system-ui, 'Segoe UI', Tahoma, sans-serif`.

### 2.4 Radius

`--radius-sm`=6px, `--radius-md`=8px, `--radius-lg`=10px, `--radius-full`=9999px.

### 2.5 Shadow / elevation

`--shadow-flat`=none, `--shadow-sm`=0 1px 2px rgba(0,0,0,0.06),
`--shadow-md`=0 4px 12px rgba(0,0,0,0.10), `--shadow-modal`=0 12px 32px rgba(0,0,0,0.18).
Used only for modal, dropdown, toast, card hover — not decoration.

### 2.6 Motion

`--motion-fast`=120ms, `--motion-base`=200ms, `--motion-slow`=320ms,
`--ease-standard`=cubic-bezier(0.2, 0, 0, 1). Respect `prefers-reduced-motion`.

### 2.7 Breakpoints

`--bp-sm`=640px, `--bp-md`=768px, `--bp-lg`=1024px, `--bp-xl`=1280px.

### 2.8 Z-index

`--z-base`=0, `--z-dropdown`=10, `--z-sticky`=20, `--z-overlay`=30,
`--z-modal`=40, `--z-toast`=50.

### 2.9 Focus ring

`--focus-ring`=2px solid var(--color-accent), `--focus-ring-offset`=2px.

---

## 3. Component Library (`apps/web/src/app/ui/*`)

One component per file, `ChangeDetectionStrategy.OnPush`, must cover listed states.

| Component | Props | States | Notes |
|---|---|---|---|
| `ui/button` | variant (primary/secondary/destructive/ghost), size (sm/md), disabled, loading, type | default, hover, focus-visible, active, disabled, loading | replaces CSS selector styling |
| `ui/input` (+select/textarea) | label, placeholder (hint only), error, helper, required, disabled, readOnly | default, focus-visible, error, disabled, readOnly | shared height/padding/border/radius/focus |
| `ui/card` | title, subtitle, actions slot | default, hover (if interactive) | |
| `ui/data-table` | columns, rows, empty, loading, error | empty, loading, error, default | pagination, sort indicator, row hover, selection, row actions |
| `ui/empty-state` | icon, message, action (optional) | — | used by every list/table/search |
| `ui/loading` (skeleton/spinner) | type (table/card/button) | — | one canonical treatment per component type |
| `ui/tabs` | items, active, aria-label | default, active, focus-visible, disabled | |
| `ui/modal`, `ui/drawer`, `ui/tooltip`, `ui/popover` | — | focus ring, overlay z-index, motion tokens | defined when first needed |
| `ui/toast` | message, type, duration | — | single shared confirmation mechanism |
| `ui/avatar` | name, size (sm/md/lg), image? | — | initials fallback; used in nav/comments/assignee |
| `ui/badge` | variant (default/success/warning/error/info), size (sm/md) | — | state, priority, labels, risk level |
| `ui/breadcrumbs` | items | — | detail pages |
| `ui/project-picker` | (existing) + loading/empty states | — | fix CMP-006 |
| `ui/shell` | — | — | owns header/nav/footer; pages supply inner content |

Validation timing policy: on submit (default); on blur for async-validated fields (documented per field).

---

## 4. Shell & Page Templates

- One shell component (`ui/shell`) owning header/nav/footer; pages supply inner content only.
- Page templates: list, detail, form, dashboard. Spacing between shell and content
  governed by `--space-4`/`--space-6`.
- Page title is always `h1`; section titles `h2` (fix SHL-001/TYG-001).
- Primary action placement: top-right of page header; back navigation top-left.
- Nav collapses to drawer below `--bp-md`; overflow menu for 13+ links.
- Breadcrumbs on detail pages: Projects / Work Items / KEY.

---

## 5. State Coverage (per component type, defined once)

- **Loading**: skeleton matching eventual layout (table skeleton, card skeleton, button spinner).
- **Empty**: `ui/empty-state` (icon + message + optional CTA).
- **Error**: `role="alert"` / `aria-live="polite"` banner using `--color-error`.
- **Disabled**: reduced opacity + `cursor: not-allowed`, no pointer events.
- **Hover/focus/active/pressed**: defined per interactive component type; focus ring identical everywhere.
- **Success/confirmation**: `ui/toast` (shonaor, bottom-right, auto-dismiss).

No page may silently skip a state.

---

## 6. UX Flows & Information Architecture

### 6.1 Navigation groups
Work: Projects, Work Items, Features, Planner.
Integrations: GitHub, MCP, AI Providers, Approvals, Reviews.
Admin: Settings, System, API Keys, Admin (audit/users).

### 6.2 Core journeys
- J1 First-run: Setup → Projects → create project → (optional) API key.
- J2 Plan & execute: select project → create work items (or generate via Planner) →
  move across states (list/board) → detail → comments/acceptance → transition to done.
- J3 Plan generation: create plan (goal) → generate → review → approve → apply →
  inspect report.
- J4 Review & integrate: enable modules → GitHub config → link repo → run review →
  decide findings → create work items.
- J5 Administer: health → toggle modules → retry jobs → backup; settings override/inherit;
  admin users/roles/audit.

### 6.3 Feedback/error/undo policies
- Every mutating action shows inline success confirmation (toast) within 1s.
- Errors surface as `role="alert"` banners with the API message; never silent.
- Destructive actions (archive, revoke, reject) require confirmation dialog before execution.
- Undo where API supports it; otherwise confirmation is mandatory.
- Loading: skeleton in place of content; never blank screen.
- Empty: helpful message + primary CTA.
- Module disabled: show activation guidance, not an error wall.

### 6.4 Navigation & entry points
- Deep links resolve (`/work-items/:key`).
- Project selection persists in localStorage and is shared across pages.
- Language toggle persists and sets `dir` (RTL for fa).
- Unauthenticated → `/login`; first-run → `/setup`.

### 6.5 Error recovery
- Network failure: error banner with retry.
- 409 BLOCKED_BY_OPEN_ITEMS: surface server message on the item.
- 503 module disabled: guidance mode.
- Session expiry: redirect to login on next navigation.

### 6.6 Terminology (glossary, consistent app-wide)
Work item (not issue/ticket), Feature, Milestone, Plan, Project, State, Transition.
Actions: Create, Archive, Revoke, Approve, Reject, Generate, Apply.
Status words: enabled/disabled, on/off, ok/failed.

### 6.7 Accessibility & task completion
- Keyboard-only completion of all primary tasks.
- Screen-reader announcements for errors and success.
- Task completion measured by E2E flagship + chain specs.

---

## 7. Minimal Design Enhancements (keep minimal, not empty)

1. **Colour**: accent only for primary CTA + active nav; status colours only for
   feedback; surface elevation for cards/panels; add `--color-warning`/`--color-info`.
2. **Graphics/icons**: one icon library (Lucide/Heroicons SVG); replace emoji ☑/☐;
   icons only functional (buttons, empty state, nav); simple line-art SVG for empty
   states; logo/brand mark in shell.
3. **Motion**: micro-interactions only (hover/focus 120ms, toast fade-in 200ms,
   drawer collapse 320ms); no decorative animation; respect `prefers-reduced-motion`.
4. **Effects/depth**: shadow tokens only for modal/dropdown/toast/card-hover; border
   for separators; focus ring (currently missing — STT-008).
5. **Typography**: weights 400+600 only; spacing via `--space-*`; monospace for
   codes/keys (`.raw`).
6. **Grid/spacing**: spacing scale 4/8/12/16/24/32/48/64; max-width 1280px.

**Do NOT do**: gradients, glassmorphism, neumorphism, stock images, animation on
every interaction, multiple accent colours.

**Quick wins (low cost, high impact):**
1. Focus ring — 1h.
2. Icon library + replace emoji — 2-4h.
3. Spacing + radius tokens — 2h.
4. Shadow on card/modal/toast — 1h.
5. Micro-transition on hover/focus — 1h.
6. Simple empty-state SVG — 1-2h.

---

## 8. Platform Parity (Trello & GitHub)

### 8.1 Trello patterns (Kanban/Board)
- Rich card: title + label chips + assignee avatar + checklist indicator + due date.
- Drag & drop with transition animation.
- Column header: name + count + overflow menu (add card, rename, archive).
- Quick-add card button at bottom of each column → inline input.
- Board themes (optional, post-MVP).
- Filter by label/assignee/priority (currently only state filter).

### 8.2 GitHub patterns (Issues/PR/Repo)
- Rich list row: checkbox + title + labels + priority badge + state badge +
  assignee avatar + comment count.
- Detail sidebar: Assignees, Labels, Projects, Milestone, Linked PRs (editable).
- Tabs in detail: Conversation, Activity, Acceptance, Links.
- Markdown rendering for description/comments (check bundle budget).
- Status badges (Open/Closed/Merged) with colour.
- Keyboard shortcuts (`/` search, `?` help, `c` new).
- Command palette (Cmd+K).
- Reactions on comments (post-MVP).
- Timeline/activity with icons + actor + timestamp.

### 8.3 Shared patterns (both platforms)
- Avatar (initials fallback) in nav/comments/assignee.
- Badge/label chips with variants.
- Tooltip for icon-only buttons.
- Popover/dropdown menu for row actions (replace direct buttons).
- Global search in shell.
- Empty states with CTA + illustration.
- Loading skeletons.
- Toast notifications (replace inline msg).
- Breadcrumbs on detail pages.
- Responsive sidebar (fixed desktop, drawer mobile).

### 8.4 Phased parity roadmap
**Phase 1 (MVP parity — low cost, high impact):**
1. Badge component (state, priority, risk).
2. Avatar component (initials) in comments + nav.
3. Empty state with CTA + illustration.
4. Loading skeleton for tables/lists.
5. Toast replacing inline msg.
6. Breadcrumbs on detail pages.
7. Basic keyboard shortcuts (`/`, `?`).

**Phase 2 (Polish):**
8. Sidebar in work-item-detail (assignees, labels, milestone).
9. Tabs in detail (conversation/activity/acceptance).
10. Command palette (Cmd+K).
11. Overflow menu («...») for row actions.
12. Markdown rendering (bundle budget check).

**Phase 3 (Nice-to-have):**
13. Reactions on comments.
14. Board themes (Trello-style).
15. Drag animation.

---

## 9. Audit Findings (traceable)

All findings from `docs/FRONTEND_DESIGN_SYSTEM_REVIEW.md` with IDs. Severity:
CRITICAL/HIGH/MEDIUM/LOW/INFO/POTENTIAL/UNVERIFIED.

### Token pass (TKN-)
- TKN-001 (HIGH) No token scale beyond 8 colour vars; spacing/radius/shadow/typography/motion/breakpoints/z-index are raw.
- TKN-002 (LOW) Raw hex `#fff` in button rule instead of token.
- TKN-003 (LOW) Ad-hoc radius 6/8/10px.
- TKN-004 (LOW) Ad-hoc font sizes 1.4/1.05/0.9/0.85rem.
- TKN-005 (LOW) Ad-hoc spacing 0.2–1.2rem.

### Component duplication (CMP-)
- CMP-001 (HIGH) No shared component library beyond ProjectPickerCmp; tables hand-rolled on 5 pages.
- CMP-002 (MEDIUM) Empty-state pattern duplicated per list.
- CMP-003 (MEDIUM) Loading state on exactly one page (literal ellipsis).
- CMP-004 (MEDIUM) No shared Button; emphasis via fragile CSS selectors.
- CMP-005 (LOW) Template CSS class names with no matching rules (dead/unstyled).
- CMP-006 (LOW) ProjectPickerCmp.ready unused; no loading/empty state.

### Prop API (API-)
- API-001 (INFO) No shared component prop API exists.
- API-002 (LOW) Event naming inconsistency: (ngSubmit) vs (click).

### Shell & template (SHL-)
- SHL-001 (MEDIUM) Multiple h1 on several pages.
- SHL-002 (MEDIUM) No shared page template; free-form sections.
- SHL-003 (LOW) Nav has 13 links with no grouping/overflow.

### State coverage (STT-)
- STT-001 (MEDIUM) Disabled state never represented.
- STT-002 (LOW) Success/confirmation feedback ad hoc.
- STT-003 (MEDIUM) ProjectContext no loading/error state.
- STT-004 (MEDIUM) ai-providers create/test unguarded.
- STT-005 (MEDIUM) approvals/system/admin unguarded async.
- STT-006 (MEDIUM) reviews.load treats any error as module disabled.
- STT-007 (LOW) github.load unguarded.
- STT-008 (HIGH) Focus-visible treatment not defined anywhere.
- STT-009 (MEDIUM) Keyboard accessibility gaps (drag-and-drop).

### Form consistency (FRM-)
- FRM-001 (LOW) Validation timing inconsistent.
- FRM-002 (LOW) Labels wrap inputs without explicit for/id.
- FRM-003 (MEDIUM) Primary/secondary/destructive variants/ordering differ.
- FRM-004 (LOW) features.createMilestone unguarded.
- FRM-005 (LOW) ai-providers API key label hardcoded English (not i18n).
- FRM-006 (MEDIUM) settings mutates row.input directly on signal-held objects.

### Collection consistency (TBL-)
- TBL-001 (MEDIUM) Hand-rolled tables inconsistent columns, no sort/pagination/selection.
- TBL-002 (LOW) mcp table minor (part of TBL-001).
- TBL-003 (LOW, POTENTIAL) settings pagination unknown registry size.

### Typography/colour/icon/motion (TYG-)
- TYG-001 (MEDIUM) Heading levels don't match semantic role.
- TYG-002 (LOW, POTENTIAL) Status colours potential dual meaning.
- TYG-003 (LOW) Mixed iconography (emoji).
- TYG-004 (INFO) No motion tokens.

### Responsive/a11y/theming (RSP-)
- RSP-001 (HIGH) No responsive breakpoints.
- RSP-002 (MEDIUM) Same concept collapses differently.
- RSP-003 (MEDIUM) ARIA roles/labels inconsistent.
- RSP-004 (LOW) Theming: hardcoded #fff in button rule.
- RSP-005 (INFO) RTL holds (positive).

### Naming & structure (NAM-)
- NAM-001 (LOW) Component class naming inconsistent.
- NAM-002 (INFO) Shared primitives under app/ui/.
- NAM-003 (INFO) No page-named components (positive).

### Enforcement (ENF-)
- ENF-001 (HIGH) Web excluded from root lint/verify; no raw-value lint rules.
- ENF-002 (MEDIUM) No living style reference.
- ENF-003 (MEDIUM) No visual regression testing.
- ENF-004 (MEDIUM) No component-level unit tests.

### Drift (DRF-)
- DRF-001 (MEDIUM) Stylesheet header claims not fully true.
- DRF-002 (INFO) Hand-rolled i18n documented (D-034).
- DRF-003 (LOW) E2E coupling to label text.

---

## 10. Unified Execution Plan (phased)

### Phase 0 — Foundation (tokens + lint gate)
**Goal:** Establish token source of truth and mechanical enforcement.
**Tasks:**
- P0-1: Add full token scale to `styles.scss` `:root` (spacing, radius, typography, shadow, motion, breakpoints, z-index, focus ring, colour-on-accent, warning/info). [TKN-001]
- P0-2: Replace raw `#fff` in button rule with `--color-on-accent`. [TKN-002, RSP-004]
- P0-3: Replace raw radii/font-sizes/spacing with tokens. [TKN-003, TKN-004, TKN-005]
- P0-4: Add web eslint config + raw-value lint rules; add web to root verify. [ENF-001]
- P0-5: Add global `:focus-visible` ring. [STT-008]
- P0-6: Correct stylesheet header comment (responsive claim). [DRF-001]
**Acceptance:** lint passes; no raw hex/spacing/font-size outside `:root`; focus ring visible.
**Dependencies:** none.

### Phase 1 — Core components (button, input, badge, avatar, empty-state, loading, toast)
**Goal:** Build the shared component library foundation.
**Tasks:**
- P1-1: `ui/button` with variants/sizes/states. [CMP-004, FRM-003]
- P1-2: `ui/input` (+select/textarea) with label/error/helper/disabled/readOnly. [FRM-001, FRM-002]
- P1-3: `ui/badge` with variants. [PLATFORM_PARITY 3.2]
- P1-4: `ui/avatar` with initials fallback. [PLATFORM_PARITY 3.1]
- P1-5: `ui/empty-state` (icon + message + CTA). [CMP-002]
- P1-6: `ui/loading` (skeleton/spinner per type). [CMP-003]
- P1-7: `ui/toast` (service + component). [STT-002]
- P1-8: `ui/breadcrumbs`. [PLATFORM_PARITY 3.9]
**Acceptance:** components render in all states; unit tests pass.
**Dependencies:** Phase 0.

### Phase 2 — Shell & templates
**Goal:** Shared shell and page templates.
**Tasks:**
- P2-1: `ui/shell` (header/nav/footer) with responsive drawer. [SHL-002, SHL-003, RSP-001]
- P2-2: Page templates (list/detail/form/dashboard) with standard spacing. [SHL-002]
- P2-3: Fix multiple h1 → h2 for section titles. [SHL-001, TYG-001]
- P2-4: `ui/tabs` component. [PLATFORM_PARITY]
- P2-5: `ui/project-picker` loading/empty states. [CMP-006]
**Acceptance:** all pages use shell + template; heading hierarchy consistent.
**Dependencies:** Phase 1.

### Phase 3 — State hardening & accessibility
**Goal:** Fix unguarded async, focus, keyboard, ARIA.
**Tasks:**
- P3-1: Add disabled state binding to buttons during async actions. [STT-001]
- P3-2: Guard unguarded async (ai-providers, approvals, system, admin, features, github, reviews). [STT-004, STT-005, STT-007, FRM-004]
- P3-3: Fix reviews catch-all (check MODULE_DISABLED specifically). [STT-006]
- P3-4: Fix settings mutable signal (use update). [FRM-006]
- P3-5: Add `role="alert"`/`aria-live` to error containers. [RSP-003]
- P3-6: Keyboard alternative for drag-and-drop. [STT-009]
- P3-7: Fix hardcoded "API key" label → i18n. [FRM-005]
- P3-8: Fix E2E coupling to label text (add testids). [DRF-003]
**Acceptance:** no unhandled rejections; all errors announced; keyboard-only task completion.
**Dependencies:** Phase 1.

### Phase 4 — Collection consistency (data-table)
**Goal:** Shared table/data-list component.
**Tasks:**
- P4-1: `ui/data-table` with columns, rows, empty/loading/error, sort, pagination, selection, row actions. [CMP-001, TBL-001]
- P4-2: Migrate work-items, mcp, settings, system (jobs), admin (users, audit) to data-table. [TBL-001]
- P4-3: Overflow menu («...») for row actions. [PLATFORM_PARITY 3.4]
**Acceptance:** all tables use shared component; consistent headers/sort/empty/loading/error.
**Dependencies:** Phase 1, 2.

### Phase 5 — Responsive & theming
**Goal:** Shared breakpoints and responsive collapse.
**Tasks:**
- P5-1: Add media queries for nav (drawer), tables (horizontal scroll), forms (stack). [RSP-001, RSP-002]
- P5-2: Ensure RTL holds (verify no physical left/right). [RSP-005]
- P5-3: Verify dark-mode contrast (axe run). [RSP-004]
**Acceptance:** usable on 360px width; no horizontal overflow except tables.
**Dependencies:** Phase 2.

### Phase 6 — Platform parity (MVP)
**Goal:** Trello/GitHub-level UX essentials.
**Tasks:**
- P6-1: Rich card in board (labels, avatar, checklist indicator, due date). [PLATFORM_PARITY 8.1]
- P6-2: Column header with count + overflow menu + quick-add. [PLATFORM_PARITY 8.1]
- P6-3: Rich list row (checkbox, labels, badges, avatar, comment count). [PLATFORM_PARITY 8.2]
- P6-4: Detail sidebar (assignees, labels, milestone, linked PRs). [PLATFORM_PARITY 8.2]
- P6-5: Tabs in detail (conversation, activity, acceptance, links). [PLATFORM_PARITY 8.2]
- P6-6: Breadcrumbs. [PLATFORM_PARITY 3.9]
- P6-7: Keyboard shortcuts (`/`, `?`, `c`). [PLATFORM_PARITY 8.2]
- P6-8: Empty states with CTA + illustration. [PLATFORM_PARITY 3.6]
**Acceptance:** E2E flagship + chain still pass; new interactions keyboard-accessible.
**Dependencies:** Phase 1-4.

### Phase 7 — Polish & enforcement
**Goal:** Mechanical enforcement and living style reference.
**Tasks:**
- P7-1: Add `/design-system` route or Storybook. [ENF-002]
- P7-2: Add visual regression (Playwright screenshots) for shell + key pages. [ENF-003]
- P7-3: Add component-level unit tests. [ENF-004]
- P7-4: Command palette (Cmd+K). [PLATFORM_PARITY 8.2]
- P7-5: Markdown rendering (bundle budget check). [PLATFORM_PARITY 8.2]
- P7-6: Icon library adoption (replace emoji). [TYG-003, MINIMAL 2]
**Acceptance:** style reference current; visual regression green; unit tests ≥80% coverage.
**Dependencies:** Phase 6.

### Phase 8 — Nice-to-have (post-MVP)
- Reactions on comments.
- Board themes (Trello-style).
- Drag animation.
- Undo for destructive actions (API support check).

---

## 11. Traceability matrix (finding → phase → task)

| Finding | Phase | Task |
|---|---|---|
| TKN-001 | 0 | P0-1 |
| TKN-002 | 0 | P0-2 |
| TKN-003 | 0 | P0-3 |
| TKN-004 | 0 | P0-3 |
| TKN-005 | 0 | P0-3 |
| CMP-001 | 4 | P4-1, P4-2 |
| CMP-002 | 1 | P1-5 |
| CMP-003 | 1 | P1-6 |
| CMP-004 | 1 | P1-1 |
| CMP-005 | 0/1 | cleanup during migration |
| CMP-006 | 2 | P2-5 |
| API-001 | 1 | component prop APIs |
| API-002 | 3 | P3-2 (standardise ngSubmit) |
| SHL-001 | 2 | P2-3 |
| SHL-002 | 2 | P2-1, P2-2 |
| SHL-003 | 2 | P2-1 |
| STT-001 | 3 | P3-1 |
| STT-002 | 1 | P1-7 |
| STT-003 | 3 | P3-2 |
| STT-004 | 3 | P3-2 |
| STT-005 | 3 | P3-2 |
| STT-006 | 3 | P3-3 |
| STT-007 | 3 | P3-2 |
| STT-008 | 0 | P0-5 |
| STT-009 | 3 | P3-6 |
| FRM-001 | 1 | P1-2 |
| FRM-002 | 1 | P1-2 |
| FRM-003 | 1 | P1-1 |
| FRM-004 | 3 | P3-2 |
| FRM-005 | 3 | P3-7 |
| FRM-006 | 3 | P3-4 |
| TBL-001 | 4 | P4-1, P4-2 |
| TBL-002 | 4 | P4-2 |
| TBL-003 | 4 | P4-1 (pagination) |
| TYG-001 | 2 | P2-3 |
| TYG-002 | 0 | P0-1 (add warning/info) |
| TYG-003 | 7 | P7-6 |
| TYG-004 | 0 | P0-1 (motion tokens) |
| RSP-001 | 5 | P5-1 |
| RSP-002 | 5 | P5-1 |
| RSP-003 | 3 | P3-5 |
| RSP-004 | 0 | P0-2 |
| RSP-005 | 5 | P5-2 |
| NAM-001 | 1 | naming convention doc |
| NAM-002 | 2 | promote to src/ui/ |
| NAM-003 | — | positive (no action) |
| ENF-001 | 0 | P0-4 |
| ENF-002 | 7 | P7-1 |
| ENF-003 | 7 | P7-2 |
| ENF-004 | 7 | P7-3 |
| DRF-001 | 0 | P0-6 |
| DRF-002 | — | documented (D-034) |
| DRF-003 | 3 | P3-8 |

---

## 12. Open Questions (from audit Appendix C)

1. Contrast ratios — needs rendered axe audit (UNVERIFIED).
2. Bundle size — needs build (UNVERIFIED).
3. Settings registry size — determines pagination (UNVERIFIED).
4. Whether `apps/web` joins root workspace (UNVERIFIED).
5. Icon library choice (UNVERIFIED — frontend lead decision).
6. Confirmation dialog component (new shared component) — UX open question.
7. Undo for destructive actions (API support?) — UX open question.
8. Onboarding tour for first-run (post-MVP).

---

## 13. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Token migration breaks existing E2E selectors | POSSIBLE | MEDIUM | Keep data-testid stable; run flagship/chain after each phase |
| Bundle budget exceeded by new deps (icon lib, markdown) | POSSIBLE | HIGH | Justify each dep; measure with `ng build` |
| Dark-mode contrast failure on accent buttons | LIKELY | MEDIUM | Use `--color-on-accent`; verify with axe |
| Scope creep from platform parity | LIKELY | MEDIUM | Strict phase gating; Phase 8 post-MVP |
| No test infra for web (no node_modules in CI sandbox) | CERTAIN | HIGH | Install deps in CI; add unit tests in Phase 7 |

---

## 14. Definition of Done (per phase)

- Code: lint + typecheck clean.
- Tests: ≥80% module line coverage + acceptance tests green.
- Docs: OpenAPI/MCP/tool doc updated; design system doc updated.
- Audit: every mutation emits audit_event (backend, not frontend scope).
- Security: schema validation at boundaries, no concatenated SQL.
- Reproducibility: `docker compose up` works on clean machine.
- Change Manifest complete + Evidence recorded.

---

## 15. Handoff

- **Primary recipients:** Frontend Developer, UI Designer, UX Designer, Design System Designer.
- **Decision owner:** Technical Lead / Design Manager.
- **Required artifacts:** this plan + `docs/DESIGN_SYSTEM.md` + `docs/UI_DESIGN.md` + `docs/UX_FLOWS.md`.
- **Acceptance criteria:** Consistency/Accessibility (design system), Usability (UX), Design Criteria (UI).

---

## 16. Source document status

After this plan is approved, the following source documents are **superseded** and should
be archived (not deleted) under `docs/archive/`:
- `docs/FRONTEND_DESIGN_SYSTEM_REVIEW.md`
- `docs/DESIGN_SYSTEM.md`
- `docs/UI_DESIGN.md`
- `docs/UX_FLOWS.md`
- `docs/MINIMAL_DESIGN_ENHANCEMENTS.md`
- `docs/PLATFORM_PARITY.md`

This plan (`docs/FRONTEND_EXECUTION_PLAN.md`) is the single source of truth for
frontend execution going forward.
