import { Transaction, type Kysely } from 'kysely';
import { newId } from '../id';
import { toJsonb } from '../jsonb';
import type { DB } from './types';

export type Db = Kysely<DB>;
export type Tx = Transaction<DB>;

/** Something that is either the pool-backed db or an open transaction. */
export type DbLike = Db | Tx;

export interface OutboxMessage {
  topic: string;
  payload: unknown;
  organization_id?: string | null;
}

/**
 * Insert an outbox row within the current transaction/connection.
 * Services never touch BullMQ directly — only outbox rows (plan §3b-3).
 */
export async function appendOutbox(db: DbLike, msg: OutboxMessage): Promise<string> {
  const id = newId();
  await db
    .insertInto('outbox')
    .values({
      id,
      organization_id: msg.organization_id ?? null,
      topic: msg.topic,
      // kysely serialises plain objects to jsonb; scalars go through toJsonb
      payload: toJsonb(msg.payload) as never,
    })
    .execute();
  return id;
}

export interface UnitOfWorkContext {
  tx: Tx;
  /** Append an outbox message inside this unit of work's transaction. */
  enqueue(topic: string, payload: unknown, organizationId?: string | null): Promise<string>;
}

/**
 * unitOfWork: domain change + audit_event + outbox row in ONE transaction
 * (plan §3b-3). Phase 0 wires the transaction + outbox; audit_event is added
 * by the domain services in Phase 1 through the same callback.
 */
export async function unitOfWork(db: Db, fn: (ctx: UnitOfWorkContext) => Promise<void>): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await fn({
      tx,
      enqueue: (topic, payload, organizationId) =>
        appendOutbox(tx, { topic, payload, organization_id: organizationId ?? null }),
    });
  });
}
