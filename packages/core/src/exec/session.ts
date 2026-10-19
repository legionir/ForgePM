import type { ExecSessionSectionKey } from '@forgepm/shared';

/**
 * session_start packing (appendix §K.3): fixed priority order, a hard byte
 * budget, and per-section overflow counts instead of a wall of text.
 */
export interface SessionSection<T> {
  key: ExecSessionSectionKey;
  label: string;
  items: T[];
  /** How many items to print before the section reports its remaining count. */
  limit?: number;
  /** Read-tool hint specific to this section. */
  hint?: string;
}

export interface PackedSection<T> {
  key: ExecSessionSectionKey;
  label: string;
  shown: T[];
  total: number;
  more: number;
  /** Read these with the tool named by the section's hint. */
  hint?: string;
}

export type PackedSession<T, C extends Record<string, unknown> = Record<string, unknown>> = C & {
  /** Set when any row or section content was omitted to fit the budget. */
  hint?: string;
  meta: { bytes: number; truncated: boolean; within_budget: boolean };
  generated_at: string;
  sections: PackedSection<T>[];
  totals: Record<string, number>;
  max_bytes: number;
};

const DEFAULT_LIMIT = 10;

export function packSession<T, C extends Record<string, unknown> = Record<string, unknown>>(
  sections: readonly SessionSection<T>[],
  opts: { maxBytes: number; at?: Date; limitPerSection?: number; context?: C },
): PackedSession<T, C> {
  const limit = opts.limitPerSection ?? DEFAULT_LIMIT;
  const packedSections = sections.map((section): PackedSection<T> => {
    const shown = section.items.slice(0, section.limit ?? limit);
    const packed: PackedSection<T> = {
      key: section.key,
      label: section.label,
      shown,
      total: section.items.length,
      more: Math.max(0, section.items.length - shown.length),
    };
    if (packed.more > 0) packed.hint = section.hint ?? 'read the rest with ledger_list_open';
    return packed;
  });
  const out = {
    ...(opts.context ?? ({} as C)),
    generated_at: (opts.at ?? new Date()).toISOString(),
    sections: packedSections,
    totals: Object.fromEntries(sections.map((section) => [section.key, section.items.length])),
    max_bytes: opts.maxBytes,
    meta: {
      bytes: 0,
      // Rows omitted by the per-section cap are truncation too, even when the
      // byte budget itself did not force a trim.
      truncated: packedSections.some((section) => section.more > 0),
      within_budget: true,
    },
  } as PackedSession<T, C>;

  // Keep all six priority sections. Under pressure, remove rows from the
  // lowest-priority section first; totals and `more` remain truthful.
  let guard = 0;
  while (true) {
    refreshMeta(out, opts.maxBytes);
    if (byteLen(out) <= opts.maxBytes || guard++ >= 20_000) break;
    out.meta.truncated = true;
    if (trimLowestPriorityRow(out)) continue;
    if (trimContextArray(out)) continue;
    if (removeHintsAndShortenLabels(out)) continue;
    break;
  }
  refreshMeta(out, opts.maxBytes);
  return out;
}

function trimLowestPriorityRow<T>(out: PackedSession<T>): boolean {
  for (let index = out.sections.length - 1; index >= 0; index -= 1) {
    const section = out.sections[index];
    if (!section || section.shown.length === 0) continue;
    section.shown = section.shown.slice(0, -1);
    section.more = Math.max(0, section.total - section.shown.length);
    if (section.more > 0) section.hint ??= 'read the rest with ledger_list_open';
    else delete section.hint;
    return true;
  }
  return false;
}

/** Compatibility summaries are also bounded; the section totals remain exact. */
function trimContextArray<T>(out: PackedSession<T>): boolean {
  for (const key of ['recently_unblocked', 'uncovered_requirements']) {
    const value = (out as Record<string, unknown>)[key];
    if (Array.isArray(value) && value.length > 0) {
      value.pop();
      out.meta.truncated = true;
      return true;
    }
  }
  return false;
}

function removeHintsAndShortenLabels<T>(out: PackedSession<T>): boolean {
  if (out.hint) {
    delete out.hint;
    return true;
  }
  const sectionWithHint = [...out.sections].reverse().find((section) => section.hint);
  if (sectionWithHint) {
    delete sectionWithHint.hint;
    return true;
  }
  const verboseLabel = [...out.sections].reverse().find((section) => section.label !== section.key);
  if (verboseLabel) {
    verboseLabel.label = verboseLabel.key;
    return true;
  }
  return false;
}

function refreshMeta<T>(out: PackedSession<T>, maxBytes: number): void {
  // The byte counter affects its own width. Iterate to a fixed point so `bytes`
  // describes the actual UTF-8 JSON payload, including itself.
  for (let index = 0; index < 8; index += 1) {
    const size = byteLen(out);
    if (out.meta.bytes === size) break;
    out.meta.bytes = size;
  }
  out.meta.within_budget = byteLen(out) <= maxBytes;
  // Updating the boolean does not change JSON byte length; re-sync defensively.
  out.meta.bytes = byteLen(out);
}

export function byteLen(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** Fixed priority order required by the appendix (§K.3). */
export const SESSION_ORDER: readonly ExecSessionSectionKey[] = [
  'human_pending',
  'journal_unknown',
  'blocking_open_items',
  'stale_facts_and_revisits',
  'uncovered_requirements',
  'tasks',
];
