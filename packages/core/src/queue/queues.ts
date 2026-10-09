/** BullMQ queue names (plan §3b-3). Heavy review queues get their own entry in Phase 6. */
export const QUEUES = {
  default: 'forgepm.default',
  review: 'forgepm.review',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const OUTBOX_DISPATCH_JOB = 'outbox.dispatch';
