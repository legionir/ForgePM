import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance A.2 (docs/EXECUTION_CONTROL_PLAN.md §6): the ledger has no delete
 * path. Not "we did not add one yet" — a mechanical refusal to let one appear,
 * in any of the three places one could hide: a tool name, a REST route, or raw
 * SQL in the service layer. 0010 backs this with append-only triggers and
 * REVOKE, but those protect the rows; this test protects the code from growing
 * a way around them (and from the softer failure mode: a `deleteOpenItem` that
 * "cleans up" a mistake and erases the reason a gate said no).
 *
 * Closing an item is `resolveOpenItem(status: 'wont_fix'|…, note ≥ 20 chars)` —
 * history with a reason. If this test goes red, the answer is to write a note,
 * not to widen a pattern.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SURFACES = ['packages/core/src/exec', 'apps/api/src/modules/exec'];

/** Anything that removes ledger state, in the two SQL styles the code base uses. */
const DELETES = /DELETE\s+FROM\s+exec_|\.deleteFrom\(\s*['"]exec_/;
/** Rewriting or clearing an append-only table (the journal's settle UPDATE is not this). */
const REWRITES =
  /UPDATE\s+exec_(events|evidence|gate_checks)\b|\.updateTable\(\s*['"]exec_(events|evidence|gate_checks)['"]\s*\)[\s\S]{0,200}?set\(\s*['"]?/;
/** A DELETE verb on a ledger route, however the router spells it. */
const DELETE_ROUTES = /\.(delete|del)\s*\(\s*['"][^'"]*exec/;

function sources(dir: string): { file: string; text: string }[] {
  const root = join(ROOT, dir);
  const walk = (current: string): { file: string; text: string }[] => {
    const out: { file: string; text: string }[] = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(file));
      } else if (entry.isFile() && file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        out.push({ file: file.slice(ROOT.length + 1), text: readFileSync(file, 'utf8') });
      }
    }
    return out;
  };
  return walk(root);
}

describe('the ledger has no delete path (A.2)', () => {
  const files = SURFACES.flatMap(sources);

  it('scans the real ledger sources, not an empty list', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.file.endsWith('open-items-service.ts'))).toBe(true);
    expect(files.some((f) => f.file.includes('exec'))).toBe(true);
    expect(files.some((f) => f.file.endsWith('gate-rules/rule01-exit-report.ts'))).toBe(true);
  });

  it('no exec source deletes a ledger row in any SQL style', () => {
    const hits = files.filter((f) => DELETES.test(f.text)).map((f) => f.file);
    expect(hits).toEqual([]);
  });

  it('no exec source rewrites an append-only table', () => {
    const hits = files.filter((f) => REWRITES.test(f.text)).map((f) => f.file);
    expect(hits).toEqual([]);
  });

  it('no exec route is registered with DELETE', () => {
    const hits = files.filter((f) => DELETE_ROUTES.test(f.text)).map((f) => f.file);
    expect(hits).toEqual([]);
  });

  it('the patterns themselves bite — a guard that matches nothing is worse than none', () => {
    expect(DELETES.test('await sql`DELETE FROM exec_open_items WHERE task_id = ${id}`')).toBe(true);
    expect(DELETES.test("db.deleteFrom('exec_events')")).toBe(true);
    expect(REWRITES.test("sql`UPDATE exec_events SET payload = '{}'`")).toBe(true);
    expect(DELETE_ROUTES.test("app.delete('/api/v1/exec/open-items/:id')")).toBe(true);
    // and the legitimate shapes stay legitimate: settling a journal row is not a rewrite
    expect(REWRITES.test("sql`UPDATE exec_action_journal SET status = 'done' WHERE code = ${code}`")).toBe(false);
  });

  it('the write path is the only entry point, and it appends an event per mutation', () => {
    const svc = files.find((f) => f.file.endsWith('open-items-service.ts'))!;
    expect(svc.text).toContain('appendEvent(db');
    // exactly two appendEvent calls today: created + closed/reopened
    expect(svc.text.match(/appendEvent\(db,/g)?.length).toBe(2);
    // and no raw UPDATE/INSERT outside those two statements
    expect(svc.text.match(/INSERT INTO exec_\w+|UPDATE exec_\w+/g)).toEqual([
      'INSERT INTO exec_open_items',
      'UPDATE exec_open_items',
    ]);
  });
});
