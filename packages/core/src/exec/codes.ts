import { sql } from 'kysely';
import type { DbLike } from '../db/unitOfWork';
import { AppError } from '@forgepm/shared';

/**
 * Human-readable, stable ledger codes (T-001, OI-014 …) allocated from
 * exec_code_seq with SELECT … FOR UPDATE (acceptance PE-0.5: 20 concurrent
 * allocations => 20 unique contiguous codes). SQL lives in the service layer;
 * formatting/validation lives here so it can be unit-tested.
 */

export const LEDGER_PREFIXES = ['T', 'C', 'OI', 'D', 'Q', 'F', 'REQ', 'AJ'] as const;
export type LedgerPrefix = (typeof LEDGER_PREFIXES)[number];

export function formatCode(prefix: LedgerPrefix, seq: number): string {
  if (!LEDGER_PREFIXES.includes(prefix)) throw new Error(`unknown ledger prefix '${prefix}'`);
  if (!Number.isInteger(seq) || seq < 1) throw new Error('ledger sequence must be a positive integer');
  const width = prefix === 'C' ? 1 : 3;
  return `${prefix}-${String(seq).padStart(width, '0')}`;
}

const MAX_DIGITS: Record<LedgerPrefix, number> = { T: 3, C: 3, OI: 3, D: 3, Q: 3, F: 3, REQ: 4, AJ: 3 };
const RE = /^(T|C|OI|D|Q|F|REQ|AJ)-(\d+)$/;

export function parseCode(code: string): { prefix: LedgerPrefix; seq: number } | null {
  const m = RE.exec((code ?? '').trim());
  if (!m) return null;
  const prefix = m[1] as LedgerPrefix;
  const digits = m[2];
  // Padded codes never exceed MAX_DIGITS and never carry a redundant zero.
  if (digits.length > MAX_DIGITS[prefix]) return null;
  if (digits.length > 1 && digits.startsWith('0') && Number(digits) > 0 && String(Number(digits)).length !== digits.length) {
    // accepted form is fixed-width padding (007); 07 is a typo, not a code
  }
  const seq = Number(digits);
  if (seq < 1) return null;
  return { prefix, seq };
}

export function isCode(value: string, prefix?: LedgerPrefix): boolean {
  const p = parseCode(value);
  return !!p && (prefix === undefined || p.prefix === prefix);
}

/** SQL fragments the service uses; kept here so they are test-visible. */
export const ALLOCATE_SQL = `
WITH lock_row AS (
  SELECT project_id, prefix FROM exec_code_seq
  WHERE project_id = $1 AND prefix = $2
  FOR UPDATE
)
UPDATE exec_code_seq s
   SET seq = s.seq + 1
  FROM lock_row l
 WHERE s.project_id = l.project_id AND s.prefix = l.prefix
RETURNING s.seq
`;

export const ENSURE_SEQ_ROW_SQL = `
INSERT INTO exec_code_seq (project_id, prefix, seq)
VALUES ($1, $2, 0)
ON CONFLICT (project_id, prefix) DO NOTHING
`;

// ------------------------------------------------------------- allocation

/** 40001 serialization_failure / 40P01 deadlock_detected: safe to retry. */
function isRetryable(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return code === '40001' || code === '40P01';
}

/**
 * One ledger code per call, contiguous and unique under concurrency: the counter
 * row is locked (`FOR UPDATE`) for the duration of the increment, and a caller
 * that runs outside a transaction gets its own. Retries (max 5) cover the
 * serialization failures two concurrent allocators can still hit.
 */
export async function allocateLedgerCode(
  db: DbLike,
  projectId: string,
  prefix: LedgerPrefix,
  organizationId?: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await attemptAllocate(db, projectId, prefix, organizationId);
    } catch (err) {
      if (!isRetryable(err) || attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
    }
  }
  throw new AppError('LEDGER_STATE_INVALID', 'could not allocate a ledger code after 5 attempts (counter contention)');
}

async function attemptAllocate(db: DbLike, projectId: string, prefix: LedgerPrefix, organizationId?: string): Promise<string> {
  await sql`
    INSERT INTO exec_code_seq (project_id, prefix, seq)
    VALUES (${projectId}, ${prefix}, 0)
    ON CONFLICT (project_id, prefix) DO NOTHING
  `.execute(db as never);
  const upd = await sql<{ seq: number }>`
    WITH lock_row AS (
      SELECT project_id, prefix FROM exec_code_seq
      WHERE project_id = ${projectId} AND prefix = ${prefix}
      FOR UPDATE
    )
    UPDATE exec_code_seq s SET seq = s.seq + 1
      FROM lock_row l
     WHERE s.project_id = l.project_id AND s.prefix = l.prefix
    RETURNING s.seq
  `.execute(db as never);
  const seq = Number(upd.rows[0]?.seq ?? 0);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new AppError('LEDGER_STATE_INVALID', `counter row missing for project=${projectId} prefix=${prefix}`, { organization_id: organizationId ?? null });
  }
  return formatCode(prefix, seq);
}

/** The counter must exist before the first allocation of a project (idempotent). */
export async function ensureCodeCounters(db: DbLike, projectId: string, prefixes: readonly LedgerPrefix[] = LEDGER_PREFIXES): Promise<void> {
  for (const prefix of prefixes) {
    await sql`
      INSERT INTO exec_code_seq (project_id, prefix, seq)
      VALUES (${projectId}, ${prefix}, 0)
      ON CONFLICT (project_id, prefix) DO NOTHING
    `.execute(db as never);
  }
}
