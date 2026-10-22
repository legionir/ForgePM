/**
 * Pure UI logic (plan §10 P7-3): the testable core of the component
 * library, extracted so unit tests can hit it without Angular's injection
 * context — this file deliberately imports nothing and exports nothing
 * framework-specific. Components in ui/* delegate to these functions;
 * `npm run test:web` measures this file (kept at 100%).
 */

// ---------- avatar ----------

/** Initials fallback: first letters of the first two words, uppercased. */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

// ---------- tabs ----------

/** Roving-tabindex math for tab lists (Arrow/Home/End, wraps). */
export function nextTabIndex(len: number, index: number, key: string): number | null {
  if (!len) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % len;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + len) % len;
  if (key === 'Home') return 0;
  if (key === 'End') return len - 1;
  return null;
}

// ---------- data table ----------

/** Structural column shape needed for sorting (ui/data-table extends it). */
export interface SortCol<T> {
  key: string;
  value?: (row: T) => string | number;
  sortValue?: (row: T) => string | number;
}

/** Copy-on-sort with column-aware keys (custom sortValue wins). */
export function sortRows<T>(rows: T[], columns: SortCol<T>[], sortKey: string, asc: boolean): T[] {
  const list = [...rows];
  if (!sortKey) return list;
  const col = columns.find((c) => c.key === sortKey);
  const get = (r: T): string | number =>
    col?.sortValue ? col.sortValue(r) : col?.value ? col.value(r) : String((r as Record<string, unknown>)[sortKey] ?? '');
  return list.sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return asc ? cmp : -cmp;
  });
}

/** Pagination slice; page index clamps into range, 0 = no pagination. */
export function pageSlice<T>(rows: T[], page: number, pageSize: number): T[] {
  if (!pageSize) return rows;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(0, page), pages - 1);
  return rows.slice(p * pageSize, p * pageSize + pageSize);
}

// ---------- command palette ----------

/** Case-insensitive substring filter on resolved labels, order preserved. */
export function filterCommands<T>(cmds: T[], query: string, label: (c: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return cmds;
  return cmds.filter((c) => label(c).toLowerCase().includes(q));
}

// ---------- theming ----------

export type ThemeChoice = 'system' | 'light' | 'dark';

/** Explicit choice wins; `system` follows the media query. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): 'light' | 'dark' {
  if (choice === 'dark') return 'dark';
  if (choice === 'light') return 'light';
  return systemDark ? 'dark' : 'light';
}

// ---------- markdown ----------

export type MdSegment =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: string }
  | { t: 'italic'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; href: string };

/**
 * Minimal inline-markdown tokenizer: **bold**, *italic*, `code`,
 * [label](https://…). Emits TYPED SEGMENTS, never HTML — the renderer binds
 * them in the template, so there is no innerHTML and no XSS surface.
 * Links are restricted to http(s). Paragraphs split on blank lines.
 */
export function parseMarkdown(src: string): MdSegment[][] {
  const paragraphs = (src ?? '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
  return paragraphs.map((p) => {
    const segments: MdSegment[] = [];
    // order matters: code first (no formatting inside), then links, bold, italic
    const re = /(`[^`]+`)|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p))) {
      if (m.index > last) segments.push({ t: 'text', v: p.slice(last, m.index) });
      const tok = m[0];
      if (tok.startsWith('`')) segments.push({ t: 'code', v: tok.slice(1, -1) });
      else if (tok.startsWith('[')) {
        const label = tok.slice(1, tok.indexOf(']'));
        const href = tok.slice(tok.indexOf('](') + 2, -1);
        segments.push({ t: 'link', v: label, href });
      } else if (tok.startsWith('**')) segments.push({ t: 'bold', v: tok.slice(2, -2) });
      else segments.push({ t: 'italic', v: tok.slice(1, -1) });
      last = m.index + tok.length;
    }
    if (last < p.length) segments.push({ t: 'text', v: p.slice(last) });
    return segments;
  });
}

// ---------- workflow colours ----------

/** Badge variant for a workflow state category (GitHub open/closed feel). */
export function stateVariant(category: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  switch (category) {
    case 'completed':
      return 'success';
    case 'started':
      return 'info';
    case 'in_review':
      return 'warning';
    default:
      return 'default';
  }
}

// ---------- board drag session (issue #11, D-046) ----------
//
// One gesture, two delivery paths. A real browser starts an HTML5 drag from the
// `draggable` card and `dragstart` stands this session down (dragToNative), so the
// two never both act on a drop. Headless Chromium does not enter a drag session for
// Playwright's `dragTo` at all, so the pointer stream (press → move → release) has
// to carry the same gesture. The phase rules live here, pure, because they are the
// part that can be wrong silently.

/** Pointer travel that turns a press into a drag; below it, it stays a click. */
export const DRAG_THRESHOLD_PX = 4;

/** Elements that keep their own press behaviour — the card is dragged around them. */
const NO_DRAG_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL']);

export interface DragSession {
  /** Increments per press; a drop may be applied once per token, by either path. */
  token: number;
  phase: 'idle' | 'pending' | 'dragging';
  key: string;
  fromStateId: string;
  x: number;
  y: number;
}

export const DRAG_IDLE: DragSession = { token: 0, phase: 'idle', key: '', fromStateId: '', x: 0, y: 0 };

/** Whether a press on this element may begin a board drag. */
export function canDragFrom(tagName: string | undefined): boolean {
  return !!tagName && !NO_DRAG_TAGS.has(tagName.toUpperCase());
}

/** Press: remembered, but not yet a drag — and a newer gesture than anything before it. */
export function dragDown(prev: DragSession, key: string, fromStateId: string, x: number, y: number): DragSession {
  return { token: prev.token + 1, phase: 'pending', key, fromStateId, x, y };
}

/** Move: the threshold is measured from the press point, once, so the origin stays put. */
export function dragMove(prev: DragSession, x: number, y: number): DragSession {
  if (prev.phase === 'idle') return prev;
  if (prev.phase === 'dragging') return prev;
  if (Math.max(Math.abs(x - prev.x), Math.abs(y - prev.y)) < DRAG_THRESHOLD_PX) return prev;
  return { ...prev, phase: 'dragging' };
}

/** Destination of the current gesture: a foreign column, and only once it is a drag. */
export function dragTarget(prev: DragSession, zoneStateId: string | null): string | null {
  if (prev.phase !== 'dragging') return null;
  if (!zoneStateId || zoneStateId === prev.fromStateId) return null;
  return zoneStateId;
}

/** Gesture over (either way): idle, but the token survives so it cannot re-apply. */
export function dragEnd(prev: DragSession): DragSession {
  return { ...DRAG_IDLE, token: prev.token };
}

/** The native HTML5 drag took the gesture; the pointer path must not act on it. */
export function dragToNative(prev: DragSession): DragSession {
  return { ...DRAG_IDLE, token: prev.token };
}

// ---------- display text: CamelCase + status meta ----------

/**
 * CamelCase display text for Latin labels and enum values: `in_progress`, `In Progress` and
 * `IN PROGRESS` all become `InProgress`. Text with no Latin letters (Persian) is returned
 * unchanged, because joining its words would only damage it.
 */
export function camelCase(text: string | null | undefined): string {
  const raw = (text ?? '').trim();
  if (!raw || !/[A-Za-z]/.test(raw)) return raw;
  return raw
    .split(/[\s_/-]+/)
    .filter(Boolean)
    .map((w) => {
      const uniform = w === w.toLowerCase() || w === w.toUpperCase();
      return w.charAt(0).toUpperCase() + (uniform ? w.slice(1).toLowerCase() : w.slice(1));
    })
    .join('');
}

export type BadgeTone = 'default' | 'success' | 'warning' | 'error' | 'info';
export interface StatusMeta {
  variant: BadgeTone;
  icon: string;
}

const STATUS_META: Record<string, StatusMeta> = {
  // workflow state categories
  backlog: { variant: 'default', icon: 'inbox' },
  unstarted: { variant: 'default', icon: 'circle' },
  started: { variant: 'info', icon: 'play' },
  in_review: { variant: 'warning', icon: 'eye' },
  completed: { variant: 'success', icon: 'check-circle' },
  canceled: { variant: 'error', icon: 'x-circle' },
  // feature lifecycle
  proposed: { variant: 'default', icon: 'inbox' },
  planned: { variant: 'info', icon: 'flag' },
  in_progress: { variant: 'info', icon: 'play' },
  in_validation: { variant: 'warning', icon: 'eye' },
  released: { variant: 'success', icon: 'rocket' },
  deprecated: { variant: 'default', icon: 'archive' },
  // milestones, projects
  open: { variant: 'info', icon: 'clock' },
  closed: { variant: 'success', icon: 'check-circle' },
  active: { variant: 'success', icon: 'check-circle' },
  archived: { variant: 'default', icon: 'archive' },
  disabled: { variant: 'default', icon: 'x-circle' },
  // jobs, approvals, reviews, plans
  queued: { variant: 'default', icon: 'clock' },
  pending: { variant: 'warning', icon: 'clock' },
  running: { variant: 'info', icon: 'play' },
  processing: { variant: 'info', icon: 'play' },
  succeeded: { variant: 'success', icon: 'check-circle' },
  done: { variant: 'success', icon: 'check-circle' },
  approved: { variant: 'success', icon: 'check-circle' },
  applied: { variant: 'success', icon: 'check-circle' },
  failed: { variant: 'error', icon: 'x-circle' },
  rejected: { variant: 'error', icon: 'x-circle' },
  dead: { variant: 'error', icon: 'alert' },
  draft: { variant: 'default', icon: 'file-text' },
  ready: { variant: 'info', icon: 'check' },
  // priorities
  none: { variant: 'default', icon: 'circle' },
  low: { variant: 'default', icon: 'caret-down' },
  medium: { variant: 'info', icon: 'chevrons-up-down' },
  high: { variant: 'warning', icon: 'caret-up' },
  urgent: { variant: 'error', icon: 'alert' },
};

/** Variant and icon for a status/priority value (unknown values stay neutral). */
export function statusMeta(status: string | null | undefined): StatusMeta {
  const key = (status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_META[key] ?? { variant: 'default', icon: 'circle' };
}
