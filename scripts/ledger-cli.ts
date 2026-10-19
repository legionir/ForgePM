#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * `forgepm-ledger` — the human's command line for the execution ledger
 * (docs/EXECUTION_CONTROL_PLAN.md §9.5, acceptance B.14/B.15, D-11).
 *
 * The CLI is a THIN client: it speaks to the same REST routes the panel uses
 * (`/api/v1/exec/*`) with `FORGEPM_URL` + `FORGEPM_API_KEY`, and it never
 * touches the database. That is deliberate — a tool that connects to the
 * database directly can do things the human's key is not allowed to do, and
 * then the ledger records a decision nobody was allowed to make.
 *
 *   list                        what the ledger is waiting for
 *   show <T-code>               one task, its blockers and the gate's verdict
 *   resolve <OI-code> --status <status> --note "<note>"
 *   answer <Q-code> "<answer>"
 *   approve <D-code> [--reason "<reason>"]
 *   reject <D-code> --reason "<reason>"
 *   waive <C-code> --reason "<reason>"
 *   req drop <REQ-code> --note "<note>"
 *   approve-scope <T-code> --paths "a,b" --reason "<reason>"
 *   fact promote <F-code> [--source human|code|docs|tool_output] [--source-ref "<ref>"] --reason "<reason>"
 *   policy print | policy set --from policy.json | --value '<json>'
 *
 * `--json` prints the raw answer; without it the output is at most 40 lines
 * (a page), because a terminal is not a database dump.
 */

const URL_BASE = (process.env.FORGEPM_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const API_KEY = process.env.FORGEPM_API_KEY ?? '';
const MAX_LINES = 40;

/** The flags that take a value. Anything else with `--` is a mistake. */
const VALUE_FLAGS = new Set([
  'status',
  'note',
  'reason',
  'paths',
  'source',
  'source-ref',
  'value',
  'from',
  'scope',
  'scope-id',
  'out',
]);

interface Flags {
  json: boolean;
  values: Record<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { json: false, values: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--json') {
      flags.json = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = argv[i + 1] ?? '';
      if (!VALUE_FLAGS.has(name)) fail(`unknown flag --${name}`);
      if (!value || value.startsWith('--')) fail(`--${name} needs a value`);
      i += 1;
      flags.values[name] = value;
      continue;
    }
    flags.positionals.push(arg);
  }
  return flags;
}

function fail(message: string): never {
  process.stderr.write(`ledger: ${message}\n`);
  process.exit(2);
}

/** The request itself: it throws, so a caller may decide what a failure means. */
async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  if (!API_KEY) throw new Error('FORGEPM_API_KEY is not set (the CLI needs a HUMAN key: ledger:decide)');
  const res = await fetch(`${URL_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* a non-JSON body is printed as it came */
  }
  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } };
    throw new Error(`${res.status} ${err?.error?.code ?? 'ERROR'}: ${err?.error?.message ?? text}`);
  }
  return body;
}

/** R-13 recall metrics — `ledger-cli stats` */
async function stats(): Promise<void> {
  // Local file fallback when API has no behavior endpoint: read BEHAVIOR_OBSERVATIONS.md
  try {
    const text = await readFile(resolve('docs/BEHAVIOR_OBSERVATIONS.md'), 'utf8');
    const rows = text.split('\n').filter((l) => l.startsWith('| ') && !l.includes('رفتار مشاهده')).length;
    const covered = text.split('\n').filter((l) => l.includes('✅')).length;
    const recall = rows ? covered / rows : 1;
    console.log(`behavior recall: ${covered}/${rows} = ${(recall * 100).toFixed(1)}% (threshold 30% ${recall >= 0.3 ? '✅' : '❌'})`);
    if (recall < 0.3) process.exit(1);
  } catch {
    console.log('behavior recall: no BEHAVIOR_OBSERVATIONS.md — 100% (no data)');
  }
}

/** A failed call ends the command with the server's own words. */
async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  try {
    return await request(path, init);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * A call that may fail without killing the command: the gate's dry run needs
 * the `ledger:read` scope, and a human whose key only decides must still see
 * the ledger.
 */
async function softApi(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; body: unknown }> {
  try {
    return { ok: true, body: await request(path, init) };
  } catch {
    return { ok: false, body: null };
  }
}

/** At most one page: a terminal shows forty lines, not a thousand. */
function page(lines: string[]): string {
  if (lines.length <= MAX_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_LINES - 1), `… ${lines.length - MAX_LINES + 1} more lines (use --json)`].join('\n');
}

function print(body: unknown, lines: string[], flags: Flags): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${page(lines)}\n`);
}

function statusLines(body: unknown): string[] {
  const view = body as {
    empty?: boolean;
    tasks?: {
      code: string;
      status: string;
      drift?: string | null;
      blockers?: { code: string; title: string }[];
      reasons_not_ready?: string[];
    }[];
  };
  if (view?.empty) return ['the project has no ledger task yet'];
  const lines: string[] = [];
  for (const task of view?.tasks ?? []) {
    lines.push(`${task.code}  ${task.status}${task.drift ? `  DRIFT: ${task.drift}` : ''}`);
    for (const blocker of task.blockers ?? []) lines.push(`  blocker ${blocker.code}: ${blocker.title}`);
    for (const reason of task.reasons_not_ready ?? []) lines.push(`  not ready: ${reason}`);
  }
  return lines.length ? lines : ['nothing is waiting'];
}

/** The reason a human has to give: `--reason`, or `--note` (the same thing). */
function reasonOf(flags: Flags, what: string): string {
  const reason = (flags.values.reason ?? flags.values.note ?? '').trim();
  if (reason.length < 10) fail(`--reason is required for ${what} (at least 10 characters — a decision without a reason is not a decision)`);
  return reason;
}

async function showTask(code: string, flags: Flags): Promise<void> {
  const body = await api(`/api/v1/exec/status?task_ref=${encodeURIComponent(code)}`);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }
  const lines = statusLines(body);
  // The dry run asks the gate "may this close?" without closing anything.
  const answer = await softApi(`/api/v1/exec/gate/${encodeURIComponent(code)}`, { method: 'POST', body: {} });
  if (!answer.ok) {
    lines.push('gate: the dry run is not available for this key (it needs ledger:read)');
  } else {
    const verdict = answer.body as {
      ok?: boolean;
      status?: string;
      blocked_by?: { rule: number; ref: string; title: string; needed?: string }[];
    };
    lines.push(verdict.ok ? 'gate: ok — the task may close' : `gate: blocked (${verdict.status})`);
    for (const blocked of verdict.blocked_by ?? []) {
      lines.push(`  rule ${blocked.rule} ${blocked.ref}: ${blocked.title}`);
    }
  }
  process.stdout.write(`${page(lines)}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  const [command, ...rest] = flags.positionals;
  if (!command) {
    fail(
      'usage: ledger <list|show|resolve|answer|approve|reject|waive|req|approve-scope|fact|policy|stats> …',
    );
  }

  switch (command) {
    case 'list': {
      const body = await api('/api/v1/exec/status');
      print(body, statusLines(body), flags);
      return;
    }
    case 'show': {
      const code = rest[0];
      if (!code) fail('usage: ledger show <T-code>');
      await showTask(code, flags);
      return;
    }
    case 'resolve': {
      const code = rest[0];
      if (!code) fail('usage: ledger resolve <OI-code> --status <status> --note "<note>"');
      if (!flags.values.status)
        fail('--status is required (resolved | accepted | deferred | wont_fix | not_applicable | open)');
      if (!flags.values.note)
        fail('--note is required (at least 20 characters — a closure without a reason is not a closure)');
      const body = await api(`/api/v1/exec/items/${encodeURIComponent(code)}/resolve`, {
        method: 'POST',
        body: { status: flags.values.status, note: flags.values.note },
      });
      print(
        body,
        [`${(body as { code?: string; status?: string }).code ?? code} → ${(body as { status?: string }).status ?? 'ok'}`],
        flags,
      );
      return;
    }
    case 'answer': {
      const code = rest[0];
      const answer = rest.slice(1).join(' ').trim();
      if (!code || !answer) fail('usage: ledger answer <Q-code> "<answer>"');
      const body = await api(`/api/v1/exec/questions/${encodeURIComponent(code)}/answer`, {
        method: 'POST',
        body: { answer },
      });
      print(body, [`${(body as { code?: string }).code ?? code} answered`], flags);
      return;
    }
    case 'approve':
    case 'reject': {
      const code = rest[0];
      if (!code) fail(`usage: ledger ${command} <D-code> [--reason "<reason>"]`);
      if (command === 'reject' && !flags.values.reason) fail('--reason is required when rejecting');
      const body = await api(`/api/v1/exec/decisions/${encodeURIComponent(code)}/decide`, {
        method: 'POST',
        body: { decision: command === 'approve' ? 'approved' : 'rejected', reason: flags.values.reason },
      });
      print(body, [`${code} ${command === 'approve' ? 'approved' : 'rejected'}`], flags);
      return;
    }
    case 'waive': {
      const code = rest[0];
      if (!code) fail('usage: ledger waive <C-code> --reason "<reason>"');
      const body = await api(`/api/v1/exec/criteria/${encodeURIComponent(code)}/waive`, {
        method: 'POST',
        body: { reason: reasonOf(flags, 'a waiver') },
      });
      print(body, [`${(body as { code?: string }).code ?? code} waived`], flags);
      return;
    }
    case 'req': {
      const verb = rest[0];
      const code = rest[1];
      if (verb !== 'drop' || !code) fail('usage: ledger req drop <REQ-code> --note "<note>"');
      const body = await api(`/api/v1/exec/requirements/${encodeURIComponent(code)}/drop`, {
        method: 'POST',
        body: { reason: reasonOf(flags, 'a dropped requirement') },
      });
      print(body, [`${(body as { code?: string }).code ?? code} dropped`], flags);
      return;
    }
    case 'approve-scope': {
      const code = rest[0];
      if (!code) fail('usage: ledger approve-scope <T-code> --paths "a,b" --reason "<reason>"');
      const paths = (flags.values.paths ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (!paths.length) fail('--paths is required (the paths the task may now touch, comma separated)');
      const body = await api(`/api/v1/exec/scope/${encodeURIComponent(code)}/expand`, {
        method: 'POST',
        body: { paths, reason: reasonOf(flags, 'a scope expansion') },
      });
      print(
        body,
        [
          `${(body as { task_code?: string }).task_code ?? code} scope +${(body as { added_paths?: string[] }).added_paths?.length ?? 0} path(s)`,
        ],
        flags,
      );
      return;
    }
    case 'fact': {
      const verb = rest[0];
      const code = rest[1];
      if (verb !== 'promote' || !code) {
        fail('usage: ledger fact promote <F-code> [--source human|code|docs|tool_output] --reason "<reason>"');
      }
      const body = await api(`/api/v1/exec/facts/${encodeURIComponent(code)}/promote`, {
        method: 'POST',
        body: {
          source: flags.values.source,
          source_ref: flags.values['source-ref'],
          reason: reasonOf(flags, 'a promoted fact'),
        },
      });
      print(body, [`${(body as { code?: string }).code ?? code} promoted to a fact`], flags);
      return;
    }
    case 'policy': {
      const verb = rest[0];
      const scope = flags.values.scope ?? 'organization';
      const scopeId = flags.values['scope-id'] ?? 'me';
      if (verb === 'print') {
        const body = await api(
          `/api/v1/settings/effective?key=exec.policy&scope=${encodeURIComponent(scope)}&scope_id=${encodeURIComponent(scopeId)}`,
        );
        const value = (body as { value?: unknown }).value;
        print(
          body,
          [`exec.policy (${(body as { source?: string }).source ?? 'default'}):`, ...JSON.stringify(value ?? {}, null, 2).split('\n')],
          flags,
        );
        return;
      }
      if (verb === 'set') {
        const inline = flags.values.value;
        const sourceFile = flags.values.from;
        if (Boolean(inline) === Boolean(sourceFile)) fail('provide exactly one of --from <file> or --value <json>');
        let value: unknown;
        try {
          const raw = sourceFile ? await readFile(resolve(sourceFile), 'utf8') : (inline as string);
          value = JSON.parse(raw);
        } catch {
          fail(sourceFile ? `--from could not be read as JSON: ${sourceFile}` : '--value must be JSON');
        }
        const body = await api(`/api/v1/settings/${encodeURIComponent(scope)}/${encodeURIComponent(scopeId)}/exec.policy`, {
          method: 'PUT',
          body: { value },
        });
        print(body, [`exec.policy set (${scope})`], flags);
        return;
      }
      fail("usage: ledger policy print | ledger policy set --from <file> | --value '<json>'");
      return;
    }
    case 'snapshot': {
      const out = flags.values.out ?? '.agent-ledger/status.json';
      const body = await api('/api/v1/exec/status');
      const snapshot = {
        advisory_only: true,
        generated_at: new Date().toISOString(),
        ttl_seconds: 300,
        data: body,
      };
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
      print(snapshot, [`snapshot written to ${out} (advisory_only:true, ttl 300s)`], flags);
      return;
    }
    case 'stats': {
      await stats();
      return;
    }
    default:
      fail(
        `unknown command '${command}' (list | show | resolve | answer | approve | reject | waive | req drop | approve-scope | fact promote | policy)`,
      );
  }
}

main().catch((err) => {
  process.stderr.write(`ledger: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
