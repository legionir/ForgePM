/**
 * session_start packing (appendix §K.3): fixed priority order, hard byte cap,
 * and an overflow counter instead of a wall of text. Acceptance K.5.
 */

export interface SessionSection<T> {
  key: string;
  label: string;
  items: T[];
  /** How many items to print before "and N more". */
  limit?: number;
}

export interface PackedSection<T> {
  key: string;
  label: string;
  shown: T[];
  total: number;
  more: number;
  /** Read these with ledger_list_open / exec_ledger_status. */
  hint?: string;
}

export interface PackedSession<T> {
  /** Set when whole sections had to be dropped to fit the budget. */
  hint?: string;
  /** `bytes` is measured with the counter itself excluded (a JSON payload
   *  cannot contain its own exact length), and is always >= the real size. */
  meta: { bytes: number; truncated: boolean; within_budget: boolean };
  generated_at: string;
  sections: PackedSection<T>[];
  totals: Record<string, number>;
  max_bytes: number;
}

const DEFAULT_LIMIT = 10;

export function packSession<T>(sections: readonly SessionSection<T>[], opts: { maxBytes: number; at?: Date; limitPerSection?: number }): PackedSession<T> {
  const limit = opts.limitPerSection ?? DEFAULT_LIMIT;
  const out: PackedSession<T> = {
    generated_at: (opts.at ?? new Date()).toISOString(),
    sections: sections.map((s) => {
      const shown = s.items.slice(0, s.limit ?? limit);
      const packed: PackedSection<T> = { key: s.key, label: s.label, shown, total: s.items.length, more: Math.max(0, s.items.length - shown.length) };
      if (packed.more > 0) packed.hint = 'read the rest with ledger_list_open';
      return packed;
    }),
    totals: Object.fromEntries(sections.map((s) => [s.key, s.items.length])),
    max_bytes: opts.maxBytes,
    meta: { bytes: 0, truncated: false, within_budget: true },
  };
  // The budget is a hard limit: drop the LOWEST-priority rows first (the
  // sections arrive in SESSION_ORDER), so `human_pending` is always complete.
  if (byteLen(out) > opts.maxBytes) {
    out.meta.truncated = true;
    let guard = 0;
    while (byteLen(out) > opts.maxBytes && guard < 10_000) {
      guard += 1;
      if (!trimTowards(out)) break;
    }
    // Still too big even with every row dropped ⇒ cut whole sections, lowest first.
    while (byteLen(out) > opts.maxBytes && out.sections.length > 1) {
      out.sections = out.sections.slice(0, -1);
      out.hint = 'sections dropped to fit the byte budget — read them with ledger_list_open / exec_ledger_status';
    }
  }
  // Measure with the counter excluded so the number never changes the length it
  // reports: `bytes` is the size of the payload without that field.
  const measured = byteLen({ ...out, meta: { truncated: out.meta.truncated } });
  out.meta.bytes = measured;
  out.meta.within_budget = measured <= opts.maxBytes;
  return out;
}

function trimTowards<T>(out: PackedSession<T>): boolean {
  for (let i = out.sections.length - 1; i >= 0; i -= 1) {
    const s = out.sections[i];
    if (s.shown.length > 0) {
      s.shown = s.shown.slice(0, -1);
      s.more = s.total - s.shown.length;
      s.hint = 'payload capped — read the rest with ledger_list_open';
      return true;
    }
  }
  return false;
}

export function byteLen(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** Fixed priority order required by the appendix (§K.3). */
export const SESSION_ORDER = [
  'human_pending',
  'journal_unknown',
  'blocking_open_items',
  'stale_facts_and_revisits',
  'uncovered_requirements',
  'tasks',
] as const;
