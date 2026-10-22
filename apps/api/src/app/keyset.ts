import { sql } from 'kysely';

/**
 * Keyset pagination cursors carry a timestamp. A JS Date only holds milliseconds while PostgreSQL stores
 * microseconds (and rows written in one transaction share one timestamp), so a cursor built from a Date
 * excludes the remaining rows of the cursor's own millisecond from the next page. These helpers keep full
 * precision end to end without changing the ORDER BY, so the created_at index is still used.
 */

/** Select expression: the row's timestamp column as text at full precision, aliased `cursor_ts`. */
export const cursorTs = (column = 'created_at') => sql<string>`${sql.ref(column)}::text`.as('cursor_ts');

/** A cursor timestamp (full-precision text, or an ISO string from an older cursor) bound as timestamptz. */
export const tsParam = (ts: string) => sql<Date>`${ts}::timestamptz`;

/** The cursor timestamp of a row that was selected with {@link cursorTs}. */
export const rowCursorTs = (row: unknown): string => (row as { cursor_ts: string }).cursor_ts;
