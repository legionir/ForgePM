import { describe, expect, it } from 'vitest';
import { SESSION_ORDER, packSession, type SessionSection } from './session';

type Row = { code: string; text: string };
function rows(prefix: string, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    code: `${prefix}-${i}`,
    text: `${prefix} item ${i} with a moderately long description to eat bytes`,
  }));
}

describe('session pack (appendix §K.3, acceptance K.4)', () => {
  it('K.3a the order is fixed: human_pending first, tasks last', () => {
    expect(SESSION_ORDER).toEqual([
      'human_pending',
      'journal_unknown',
      'blocking_open_items',
      'stale_facts_and_revisits',
      'uncovered_requirements',
      'tasks',
    ]);
    const secs: SessionSection<Row>[] = SESSION_ORDER.map((k) => ({ key: k, label: k, items: rows(k, 2) }));
    expect(
      packSession(secs, { maxBytes: 100_000, at: new Date('2026-01-01T00:00:00Z') }).sections.map((s) => s.key),
    ).toEqual([...SESSION_ORDER]);
  });

  it('K.3b over-long sections are capped and point at the read tool instead of truncating mid-json', () => {
    const secs: SessionSection<Row>[] = [{ key: 'tasks', label: 'tasks', items: rows('T', 40) }];
    const packed = packSession(secs, { maxBytes: 100_000, limitPerSection: 5 });
    expect(packed.sections[0].shown).toHaveLength(5);
    expect(packed.sections[0].more).toBe(35);
    expect(packed.sections[0].hint).toContain('ledger_list_open');
    expect(packed.totals.tasks).toBe(40);
    expect(packed.meta.truncated).toBe(true);
  });

  it('K.4 the byte budget is honoured and the payload is always valid JSON', () => {
    const secs: SessionSection<Row>[] = SESSION_ORDER.map((k) => ({ key: k, label: k, items: rows(k, 60) }));
    const packed = packSession(secs, { maxBytes: 2048 });
    expect(packed.meta.within_budget).toBe(true);
    expect(packed.meta.bytes).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(packed).length).toBeLessThanOrEqual(2048);
    expect(() => JSON.parse(JSON.stringify(packed))).not.toThrow();
    expect(packed.meta.bytes).toBeGreaterThan(1500);
    // highest priority survives: the first section keeps rows, the last one is emptied
    expect(packed.sections[0].shown.length).toBeGreaterThan(0);
    expect(packed.sections[packed.sections.length - 1].shown).toHaveLength(0);
    // totals still tell the truth about the ledger
    expect(packed.sections.reduce((a, s) => a + s.total, 0)).toBe(360);
  });

  it('K.5 keeps all six sections and signals counts when hundreds of rows exceed the budget', () => {
    const secs: SessionSection<Row>[] = SESSION_ORDER.map((key) => ({
      key,
      label: key,
      items: rows(key, key === 'blocking_open_items' ? 200 : 0),
    }));
    const packed = packSession(secs, { maxBytes: 2048 });
    expect(packed.sections.map((section) => section.key)).toEqual([...SESSION_ORDER]);
    expect(packed.sections[2]?.total).toBe(200);
    expect(packed.sections[2]?.more).toBeGreaterThan(0);
    expect(packed.meta.truncated).toBe(true);
    expect(packed.meta.within_budget).toBe(true);
    expect(packed.meta.bytes).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify(packed), 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('a generated_at timestamp is present so a stale session can be detected', () => {
    const packed = packSession([], { maxBytes: 100, at: new Date('2026-01-01T00:00:00Z') });
    expect(packed.generated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(packed.sections).toEqual([]);
  });
});
