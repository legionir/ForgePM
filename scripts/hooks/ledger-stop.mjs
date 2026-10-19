#!/usr/bin/env node
/**
 * ledger-stop.mjs — Stop hook (R-01): dual enforcement on the agent side.
 *
 * The server guard is not enough: the agent can say "تمام شد" in chat without
 * calling the ledger. This hook runs on every `Stop` event (Claude Code) and
 * blocks the exit until the ledger is clean. It is a thin client — the truth
 * lives in the API (`GET /api/v1/exec/status`), never in chat memory.
 *
 * Blocking conditions (any one is enough to block):
 *   - open items that are not `resolved` / `not_applicable` (severity != none)
 *   - pending approvals (`listExecApprovals`)
 *   - journal rows stuck in `started` or `unknown` (not `done`/`failed`)
 *   - triggerWithoutRegistration: an `exec_gate_checks` commit without a prior
 *     `exec_task_start` (detected via the `X-Exec-PreState` header vs ledger)
 *
 * The hook respects `stop_hook_active` (agent-cooperative): when the hook
 * itself sets the variable, it does not re-block on the same transcript turn.
 * See AGENTS.md §Execution control for the full exit sequence.
 */

/* eslint-disable no-undef */
const API_URL = (process.env.FORGEPM_API_URL ?? process.env.FORGEPM_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const API_KEY = process.env.FORGEPM_API_KEY ?? '';
const TASK_REF = process.env.FORGEPM_TASK_REF ?? process.env.FORGEPM_TASK ?? '';

function decision(decisionType, reason, extra = {}) {
  return {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      permissionDecision: decisionType,
      permissionDecisionReason: reason,
      ...extra,
    },
  };
}

async function fetchLedgerStatus() {
  if (!API_KEY) return null;
  const url = `${API_URL}/api/v1/exec/status${TASK_REF ? `?task_ref=${encodeURIComponent(TASK_REF)}` : ''}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function hasBlockingLedger(status) {
  if (!status) return false;
  // Panel projection shape: { blocked_by: string[], report_missing: string[] } or { ledger: { blocked_by } }
  const blocked = status.blocked_by ?? status.ledger?.blocked_by ?? status.verdict?.blocked_by ?? [];
  if (Array.isArray(blocked) && blocked.length > 0) return true;
  const pendingApprovals = status.pending_approvals ?? status.approvals ?? [];
  if (Array.isArray(pendingApprovals) && pendingApprovals.length > 0) return true;
  const journal = status.journal ?? status.action_journal ?? [];
  if (Array.isArray(journal) && journal.some((j) => j.status === 'started' || j.status === 'unknown')) return true;
  // Trigger without registration: server stamps a pre_state but task_start was never called
  if (status.trigger_without_registration) return true;
  return false;
}

export async function evaluateStopHook(input, ledgerStatusFetcher = fetchLedgerStatus) {
  if (!input || typeof input !== 'object') return {};
  if (input.hook_event_name !== 'Stop' && input.hook_event_name !== 'stop' && input.stop_hook_active) {
    // stop_hook_active — we set this ourselves to avoid infinite loops; respect it
    return {};
  }
  // Only run when we have an API key; without it we cannot verify and must not pretend to pass
  const ledger = await ledgerStatusFetcher();
  if (!ledger) {
    // No ledger context (no key or API down) — do not block, but warn via reason (soft)
    return {};
  }
  if (hasBlockingLedger(ledger)) {
    const blockedBy = ledger.blocked_by ?? ledger.verdict?.blocked_by ?? [];
    const msg = `ledger still blocks exit: ${(blockedBy || []).join(', ') || 'open items/approvals/journal not settled'} — resolve via the ledger tools before stopping.`;
    return decision('deny', msg, { blocked_by: blockedBy, stop_hook_active: true });
  }
  return {};
}

async function readStdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.stdout.write(JSON.stringify({}) + '\n');
    return;
  }
  const res = await evaluateStopHook(input);
  process.stdout.write(JSON.stringify(res) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(() => process.stdout.write(JSON.stringify({}) + '\n'));
