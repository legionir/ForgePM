import type { PlanStatus } from '@forgepm/shared';

/**
 * Plan lifecycle (plan §7). Only the transitions in this table are legal; any
 * other transition is rejected (409) by the service. Content changes always
 * create an immutable new revision; `approve` never implies `apply`.
 */
const TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  generating: ['ready', 'needs_clarification', 'generation_failed', 'canceled'],
  generation_failed: ['generating', 'canceled'],
  needs_clarification: ['generating', 'canceled'],
  // content revisions re-validate (ready or needs_clarification); an approval
  // revoked by a new revision returns the plan to generating.
  ready: ['approved', 'ready', 'needs_clarification', 'generating', 'canceled'],
  approved: ['applying', 'ready', 'generating', 'superseded', 'canceled'],
  applying: ['applied', 'apply_failed', 'canceled'],
  apply_failed: ['applying', 'canceled'],
  applied: [],
  canceled: [],
  superseded: [],
};

export function canTransition(from: PlanStatus, to: PlanStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Events that map a (from, event) pair to a target status (plan table). */
export type PlanEvent =
  | 'generate_ok'
  | 'generate_needs_clarification'
  | 'generate_invalid'
  | 'retry_generation'
  | 'answer_clarification'
  | 'revise'
  | 'approve'
  | 'apply'
  | 'apply_ok'
  | 'apply_failed'
  | 'cancel'
  | 'supersede';

const EVENT_TARGET: Partial<Record<PlanEvent, PlanStatus>> = {
  generate_ok: 'ready',
  generate_needs_clarification: 'needs_clarification',
  generate_invalid: 'generation_failed',
  retry_generation: 'generating',
  answer_clarification: 'generating',
  revise: 'ready', // service re-validates and may move to needs_clarification
  approve: 'approved',
  apply: 'applying',
  apply_ok: 'applied',
  apply_failed: 'apply_failed',
  cancel: 'canceled',
  supersede: 'superseded',
};

/** Resolve an event to a target status or throw a state-machine error. */
export function nextStatus(from: PlanStatus, event: PlanEvent): PlanStatus {
  const to = EVENT_TARGET[event];
  if (!to) throw new Error(`unknown plan event '${event}'`);
  if (event === 'revise') {
    // A revision is content-validatable; it may land in ready or needs_clarification.
    return to;
  }
  return to;
}

export const isTerminal = (s: PlanStatus): boolean => (TRANSITIONS[s] ?? []).length === 0;
