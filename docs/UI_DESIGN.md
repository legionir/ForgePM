# ForgePM Panel — UI Design Spec (draft)

Companion to `docs/DESIGN_SYSTEM.md`. Describes the intended visual/interaction
design for each page using the token set. No code changes; implementation is
frontend-developer scope.

## 1. Global chrome

- Shell: top bar (`header.shell`) with nav links (left) and who/lang/logout
  (right). Nav collapses to a drawer below `--bp-md`.
- Content area: `main` max-width 1280px (`--bp-xl`), padding `--space-4`.
- Page header: `h1` title + optional primary action (top-right) + back link
  (top-left on detail pages).
- Section spacing: `--space-6` between sections, `--space-3` within.

## 2. States (every data-driven view)

Loading: skeleton rows/cards matching the eventual layout (table skeleton for
tables, card skeleton for lists). Empty: `ui/empty-state` (icon + message +
optional action). Error: `role="alert"` banner using `--color-error` surface.
Disabled: reduced opacity + `cursor: not-allowed`, no pointer events.

## 3. Pages

### 3.1 Login / Setup
- Centered card (`.auth`): max-width 360px, radius `--radius-lg`, padding
  `--space-6`, surface background.
- Stacked fields with labels above inputs; primary submit button full-width.
- Error message below form, `role="alert"`.

### 3.2 Projects
- Page header + "New project" form (inline, `--space-3` gap).
- List: cards or table rows showing key · name · status; archive action
  (secondary/destructive) on active rows.
- Empty state: "No projects yet" + create CTA.

### 3.3 Work items (list + board)
- Project picker + view tabs (list/board) + state filter select.
- List view: table with columns key, title, type, priority, state; row links
  to detail.
- Board view: columns per state (min 240px), cards draggable; keyboard move
  controls on each card.
- Create form below (title, type, state).
- Empty state per view.

### 3.4 Work item detail
- Back link, title (key — title), meta line (type · priority · state).
- Description, acceptance checklist (checkbox icon from icon set).
- Transition form (select + save), comments list + add form, activity list.
- Loading: skeleton; empty comments: "No comments yet".

### 3.5 Features / Milestones
- Two sections, each with list + create form. Section titles `h2`.
- Feature row shows key · title · lifecycle · work_progress % · readiness %.
- Progress shown as text + optional progress bar (token colours).

### 3.6 Planner
- Goal + constraints form; plan card with status badge, action buttons
  (generate/approve/apply) by status; apply report in monospace block.

### 3.7 AI providers
- Create form (name, kind, api key); list rows with name · kind · on/off ·
  last4; test button; result message.

### 3.8 Approvals
- List rows: action · risk · status; approve/reject buttons (success/destructive
  variants).

### 3.9 Reviews
- Module-disabled hint when 503; otherwise repo select + PR number form, runs
  list, findings list with dismiss/accept/create-issue actions.

### 3.10 GitHub
- Config form (app id, private key textarea, webhook secret); status line;
  when enabled: project picker + repo list with link action; else disabled hint.

### 3.11 MCP
- Outcome filter select; calls table (tool, outcome, duration).

### 3.12 Settings
- Scope tabs (system/project); project picker when project scope.
- Table: key, source badge, value input, override/inherit actions.

### 3.13 System
- Health (db, redis), module toggles list, jobs table with retry on
  failed/dead, backup button + result.

### 3.14 Admin
- Users table (email, role), audit table (action, actor, resource).

## 4. Responsiveness

- Below `--bp-md`: nav drawer, forms stack, tables horizontal-scroll, board
  columns min 200px with horizontal scroll.
- Touch targets ≥ 44px on mobile.

## 5. Accessibility

- Focus ring visible on all interactive elements.
- Error messages announced (`role="alert"`).
- Drag-and-drop has keyboard alternative.
- Contrast verified against WCAG AA (UNVERIFIED pending axe run).

## 6. Open design questions

1. Icon library choice (TBD).
2. Progress bar component (new or reuse?).
3. Dark-mode accent button text colour (use `--color-on-accent`).
