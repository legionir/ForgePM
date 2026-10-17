import { EXEC_HUMAN_ONLY_CLOSURES, EXEC_OPEN_ITEM_ACTIVE, type ExecOpenItemStatus } from '@forgepm/shared';

/**
 * Open-item state machine (docs/EXECUTION_CONTROL_PLAN.md §6 / plan §A rules).
 * Pure so the "no silent close" law can be tested without a database — and the
 * same function is reused by the service layer and the DB CHECK constraints.
 */

export interface ResolveSubject {
  code: string;
  type: string;
  blocks_completion: boolean;
  status: ExecOpenItemStatus;
}

export interface ResolveInput {
  requested: ExecOpenItemStatus;
  note: string;
  actorType: 'agent' | 'human' | 'system';
}

export interface NewOpenItemInput {
  type: string;
  title: string;
  detail?: string;
  blocks_completion: boolean;
  /** Required when a REQUIRED item is filed as non-blocking (plan §B). */
  why_not_blocking?: string;
  actorType: 'agent' | 'human' | 'system';
}

export type ResolveOutcome = { ok: true } | { ok: false; code: 'LEDGER_TRANSITION_NOT_ALLOWED' | 'VALIDATION_ERROR'; message: string; needed_action: string };

const MIN_NOTE = 20;
/** Statuses that END the item. 'blocked'/'awaiting_human'/'open' are active states. */
export const CLOSURE_STATUSES = ['resolved', 'accepted', 'deferred', 'wont_fix', 'not_applicable'] as const;
export const isOpenItemClosure = (status: ExecOpenItemStatus): boolean => (CLOSURE_STATUSES as readonly string[]).includes(status);

export function validateResolution(subject: ResolveSubject, input: ResolveInput): ResolveOutcome {
  const note = (input.note ?? '').trim();
  if (input.requested === 'open') {
    if (input.actorType !== 'human') {
      return fail('LEDGER_TRANSITION_NOT_ALLOWED', 'an agent may not reopen a closed item — only a human may', 'ask the human (ledger_ask_human) to reopen it, or add a fresh open item');
    }
    return { ok: true };
  }
  if (note.length < MIN_NOTE) {
    return fail('VALIDATION_ERROR', `closing an open item needs a resolution note of at least ${MIN_NOTE} characters (got ${note.length})`, 'explain what was done, or where the proof lives, then retry');
  }
  if (subject.blocks_completion && isOpenItemClosure(input.requested)) {
    if (input.requested === 'accepted' || input.requested === 'deferred' || input.requested === 'wont_fix') {
      if (input.actorType !== 'human' && input.actorType !== 'system') {
        return fail(
          'LEDGER_TRANSITION_NOT_ALLOWED',
          `'${input.requested}' is not allowed for a blocking item by an agent — an agent may not delete a required item from the definition of done`,
          `either fix it and resolve with status 'resolved' + evidence, or call ledger_ask_human so a human can decide`,
        );
      }
    }
    if (input.actorType === 'agent' && input.requested !== 'resolved' && input.requested !== 'not_applicable') {
      return fail(
        'LEDGER_TRANSITION_NOT_ALLOWED',
        `a blocking item may only be closed as 'resolved' or 'not_applicable' (got '${input.requested}')`,
        'resolve it with proof, or ask the human to accept/defer it',
      );
    }
  }
  if (input.requested === 'not_applicable' && subject.type !== 'suggestion' && subject.type !== 'out_of_scope' && note.length < 60) {
    return fail('VALIDATION_ERROR', "'not_applicable' on a non-optional item needs a longer justification (>= 60 chars)", 'state which requirement makes it not applicable, quoting the requirement code');
  }
  return { ok: true };
}

/**
 * Filing rules. The important one: an agent may not file "the requirement is not
 * met" as a non-blocking note — that would let it shrink the definition of done
 * by wording. Mirrors the DB CHECK on `exec_open_items`, so a direct SQL write
 * is held to the same bar.
 */
export function validateNewOpenItem(input: NewOpenItemInput): ResolveOutcome {
  const title = (input.title ?? '').trim();
  if (title.length < 10) {
    return fail('VALIDATION_ERROR', `title needs >= 10 characters (got ${title.length})`, 'state the observable problem, not a label ("gate blocks on missing test")');
  }
  const requiredish = input.type === 'incomplete_requirement' || input.type === 'commitment';
  if (requiredish && !input.blocks_completion) {
    const why = (input.why_not_blocking ?? '').trim();
    const min = input.actorType === 'agent' ? 40 : 1;
    if (why.length < min) {
      return fail(
        'VALIDATION_ERROR',
        `an ${input.type} filed as non-blocking needs why_not_blocking of >= ${min} characters (got ${why.length})`,
        "either file it with blocks_completion=true, or explain which requirement makes it optional (quoting its code)",
      );
    }
  }
  return { ok: true };
}

export function isHumanOnlyClosure(status: ExecOpenItemStatus): boolean {
  return (EXEC_HUMAN_ONLY_CLOSURES as readonly string[]).includes(status);
}

export function isActiveOpenItem(status: ExecOpenItemStatus): boolean {
  return (EXEC_OPEN_ITEM_ACTIVE as readonly string[]).includes(status);
}

/** Blocking items that keep the gate shut. */
export function blockingOpen<T extends { blocks_completion: boolean; status: ExecOpenItemStatus }>(items: readonly T[]): T[] {
  return items.filter((i) => i.blocks_completion && isActiveOpenItem(i.status));
}

/**
 * Dedup key for auto-promotion of exit-report entries into open items: the same
 * sentence must not create two items across resubmissions (acceptance C.4).
 */
export function dedupKey(kind: string, title: string): string {
  const norm = title
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();
  return `${kind}|${norm.slice(0, 200)}`;
}

function fail(code: 'LEDGER_TRANSITION_NOT_ALLOWED' | 'VALIDATION_ERROR', message: string, needed_action: string): { ok: false; code: typeof code; message: string; needed_action: string } {
  return { ok: false, code, message, needed_action };
}
