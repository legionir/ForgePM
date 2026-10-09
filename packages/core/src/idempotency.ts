import { createHash } from 'node:crypto';
import { AppError } from '@forgepm/shared';
import { newId } from './id';
import { toJsonb } from './jsonb';
import type { Db, DbLike } from './db/unitOfWork';

/**
 * Idempotency (plan §3b-3): unique (actor_id, operation, key). A caller that
 * wants to run a guarded write calls `beginIdempotency` (its own tiny tx):
 *   - fresh key  -> a `in_progress` claim row is inserted, returns {kind:'run'}
 *   - same hash, stored -> {kind:'replay', response, status}
 *   - different hash -> 422 UNPROCESSABLE
 *   - still in flight -> 409 IN_PROGRESS
 * On success the caller stores the result *in its own transaction* via
 * `storeIdempotencyResult`. On failure it calls `abandonIdempotency` so the
 * key is free again.
 */
export function requestHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

const TTL_MS = 24 * 60 * 60 * 1000;

export type IdempotencyOutcome =
  | { kind: 'replay'; response: unknown; status: number | null }
  | { kind: 'run' };

export async function beginIdempotency(
  db: Db,
  actorId: string,
  operation: string,
  key: string,
  body: unknown,
): Promise<IdempotencyOutcome> {
  const hash = requestHash(body);
  try {
    await db
      .insertInto('idempotency_keys')
      .values({
        id: newId(),
        actor_id: actorId,
        operation,
        key,
        request_hash: hash,
        status: 'in_progress',
        expires_at: new Date(Date.now() + TTL_MS),
      })
      .execute();
    return { kind: 'run' };
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
  }

  const existing = await db
    .selectFrom('idempotency_keys')
    .select(['status', 'response', 'response_status', 'request_hash'])
    .where('actor_id', '=', actorId)
    .where('operation', '=', operation)
    .where('key', '=', key)
    .executeTakeFirst();
  if (!existing) throw new AppError('INTERNAL', 'idempotency row vanished');
  if (existing.request_hash !== hash) throw new AppError('UNPROCESSABLE', 'idempotency key reused with a different body');
  if (existing.status === 'in_progress') throw new AppError('IN_PROGRESS', 'an identical operation is in progress');
  return { kind: 'replay', response: existing.response, status: existing.response_status ?? 200 };
}

/** Persist the result of a completed idempotent operation (same tx as writes). */
export async function storeIdempotencyResult(
  db: DbLike,
  actorId: string,
  operation: string,
  key: string,
  response: unknown,
  status: number,
): Promise<void> {
  await db
    .updateTable('idempotency_keys')
    .set({ status: 'stored', response: toJsonb(response) as never, response_status: status })
    .where('actor_id', '=', actorId)
    .where('operation', '=', operation)
    .where('key', '=', key)
    .execute();
}

/** Release a claim after a failed run so the operation may be retried. */
export async function abandonIdempotency(db: Db, actorId: string, operation: string, key: string): Promise<void> {
  await db
    .deleteFrom('idempotency_keys')
    .where('actor_id', '=', actorId)
    .where('operation', '=', operation)
    .where('key', '=', key)
    .where('status', '=', 'in_progress')
    .execute();
}
