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
