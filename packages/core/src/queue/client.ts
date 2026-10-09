import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { QUEUES, type QueueName } from './queues';

export { QUEUES, OUTBOX_DISPATCH_JOB, type QueueName } from './queues';

/**
 * Redis connection for BullMQ. maxRetriesPerRequest MUST be null for BullMQ.
 * Redis holds only queue/lock data — no durable state (plan §3).
 */
export function createRedis(url: string): Redis {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

/** One Queue handle per logical queue name. */
export function createQueues(connection: Redis): Record<keyof typeof QUEUES, Queue> {
  const mk = (name: QueueName) => new Queue(name, { connection });
  return { default: mk(QUEUES.default), review: mk(QUEUES.review) };
}
