# ForgePM Panel — UX Flows & Information Architecture (draft)

Companion to `docs/UI_DESIGN.md` and `docs/DESIGN_SYSTEM.md`. Defines user
journeys, IA, navigation, feedback/error/undo policies, and terminology.

## 1. Information architecture

Top-level navigation (shell nav), grouped:
- Work: Projects, Work Items, Features, Planner
- Integrations: GitHub, MCP, AI Providers, Approvals, Reviews
- Admin: Settings, System, API Keys, Admin (audit/users)

Terminology (glossary, consistent app-wide):
- "Work item" (not "issue"/"ticket"), "Feature", "Milestone", "Plan",
  "Project", "State" (workflow state), "Transition".
- Actions: Create, Archive, Revoke, Approve, Reject, Generate, Apply.
- Status words: enabled/disabled, on/off, ok/failed.

## 2. Core user journeys

### J1 — First-run setup → first project
Setup (org + admin) → Projects → create project → (optional) API key.
Exit: user lands on Projects with one project selected.

### J2 — Plan and execute work
Select project → create work items (or generate via Planner) → move items
across states (list or board) → open detail → add comments / check
acceptance criteria → transition to done.

### J3 — Plan generation
Select project → Planner → create plan (goal) → generate → review → approve
→ apply → inspect apply report → verify created milestones/features/items.

### J4 — Review & integrate
Settings → enable modules → GitHub config → link repo → Reviews run on PR →
decide findings → create work items from findings.

### J5 — Administer
System health → toggle modules → retry failed jobs → backup.
Settings → override/inherit keys per scope.
Admin → users/roles/audit.

## 3. Feedback, error, and undo policies

- Every mutating action shows inline success confirmation (toast) within 1s.
- Errors surface as `role="alert"` banners with the API message; never silent.
- Destructive actions (archive project, revoke key, reject approval) require
  confirmation dialog before execution.
- Undo: archive/revoke are reversible via a follow-up action where the API
  supports it; otherwise confirmation is mandatory (no undo).
- Loading: skeleton in place of content; never blank screen.
- Empty: helpful message + primary CTA to create first item.
- Module disabled: show activation guidance, not an error wall (reviews/github).

## 4. Navigation & entry points

- Deep links resolve (`/work-items/:key`).
- Project selection persists in localStorage and is shared across pages.
- Language toggle persists and sets `dir` (RTL for fa).
- Unauthenticated users redirect to `/login`; first-run to `/setup`.

## 5. Error recovery

- Network failure: show error banner with retry affordance.
- 409 BLOCKED_BY_OPEN_ITEMS: surface server message on the item.
- Module disabled (503): guidance mode.
- Session expiry: redirect to login on next navigation.

## 6. Accessibility & task completion

- Keyboard-only completion of all primary tasks (create item, transition,
  comment, approve/reject, settings override).
- Screen-reader announcements for errors and success.
- Task completion measured by E2E flagship + chain specs.

## 7. Open UX questions

1. Confirmation dialog component (new shared component).
2. Undo for destructive actions (API support?).
3. Onboarding tour for first-run (not in scope v1).
