import { sql } from 'kysely';
import { z } from 'zod';
import {
  activeCipher,
  appendEvent,
  baselineFromLog,
  getEffective,
  getSecret,
  isProtectedTest,
  newId,
  resolveExecReviewSource,
  toJsonb,
  unitOfWork,
  type Db,
  type ParserCfg,
} from '@forgepm/core';
import { AppError, DEFAULT_TEST_PARSER, detectWeakening, idOrCodeSchema } from '@forgepm/shared';
import type { Actor } from '../../app/auth-context';
import { projectForTask, projectRefSchema, auditIn } from './context';
import { readCiLog } from './ci-log-source';

const MAX_PROTECTED_FILES = 250;
const MAX_CAPTURED_TESTS = 5_000;

export const baselineCaptureInputSchema = z.strictObject({
  task_ref: idOrCodeSchema,
  project_ref: projectRefSchema.optional(),
});

interface TaskRow {
  id: string;
  code: string;
  status: string;
  start_ref: string | null;
}

interface CapturedTest {
  name: string;
  result: 'pass' | 'fail' | 'skip';
}

interface CapturedCiRun {
  provider: string;
  run_id: string;
  job: string;
  sha: string;
  sha256_log: string;
  tests: CapturedTest[];
  totals: { pass: number; fail: number; skip: number };
  complete: true;
  captured_at: string;
  weakening: { path: string; assertions_before: number; assertions_after: number; count_delta: number; modifiers: string[] }[];
}

/**
 * Capture CI evidence by looking up only SHAs measured by the server. The
 * caller cannot submit a SHA, a log, a test name or a result. ForgePM never
 * executes the repository; the endpoint is configured by an administrator.
 */
export async function baselineCaptureTool(db: Db, actor: Actor, raw: unknown): Promise<Record<string, unknown>> {
  const args = baselineCaptureInputSchema.parse(raw ?? {});
  const projectId = await projectForTask(db, actor, args.task_ref, args.project_ref);
  const task = await findTask(db, actor.organizationId, projectId, args.task_ref);
  if (!task) throw new AppError('NOT_FOUND', `no task '${args.task_ref}' in this project`, { ref: args.task_ref });
  if (task.status === 'done') {
    throw new AppError('LEDGER_STATE_INVALID', `task ${task.code} is already closed`, {
      needed_action: 'a closed task keeps its captured baseline; open a new task for new work',
    });
  }
  const startSha = task.start_ref;
  if (!startSha || !/^[0-9a-f]{40,64}$/i.test(startSha)) {
    return unavailable(task, 'task has no code-captured start commit SHA');
  }

  const [sourceSetting, endpointSetting, secretNameSetting, parserSetting, protectedSetting, privateSetting] = await Promise.all([
    getEffective(db, 'exec.baseline_source', actor.organizationId, projectId),
    getEffective(db, 'exec.ci_log_endpoint', actor.organizationId, projectId),
    getEffective(db, 'exec.ci_log_secret_name', actor.organizationId, projectId),
    getEffective(db, 'exec.test_result_parser', actor.organizationId, projectId),
    getEffective(db, 'exec.protected_test_globs', actor.organizationId, projectId),
    getEffective(db, 'network.allow_private_targets', actor.organizationId, projectId),
  ]);
  if (sourceSetting?.value === 'off') return unavailable(task, 'exec.baseline_source is off');
  const endpoint = typeof endpointSetting?.value === 'string' ? endpointSetting.value : '';
  const secretName = typeof secretNameSetting?.value === 'string' ? secretNameSetting.value.trim() : '';
  if (!endpoint) return unavailable(task, 'exec.ci_log_endpoint is not configured');
  if (!secretName) return unavailable(task, 'exec.ci_log_secret_name is not configured');
  let secret: string | null = null;
  try {
    secret = await getSecret(db, activeCipher(), actor.organizationId, secretName, 'system');
  } catch {
    return unavailable(task, 'read-only CI secret could not be read from the encrypted secrets store');
  }
  if (!secret) return unavailable(task, `read-only CI secret '${secretName}' is not present in the encrypted secrets store`);

  const source = resolveExecReviewSource();
  if (!source?.headSha || !source.isWorktreeClean || !source.changedFiles || !source.readFilePair) {
    return unavailable(task, 'read-only Git source cannot verify the current commit and protected test files');
  }
  let currentSha: string;
  let clean: boolean;
  try {
    [currentSha, clean] = await Promise.all([source.headSha(), source.isWorktreeClean()]);
  } catch {
    return unavailable(task, 'current commit could not be measured');
  }
  currentSha = currentSha.toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(currentSha)) return unavailable(task, 'current commit SHA is invalid');

  const parser = parseParser(parserSetting?.value);
  if (!parser) return unavailable(task, 'exec.test_result_parser is invalid or exceeds safe limits');
  const protectedGlobs = Array.isArray(protectedSetting?.value)
    ? protectedSetting.value.filter((value): value is string => typeof value === 'string')
    : [];
  if (!protectedGlobs.length) return unavailable(task, 'exec.protected_test_globs is empty');
  const allowPrivateTargets = privateSetting?.value === true;

  const startRead = await readCiLog({
    endpoint,
    sha: startSha,
    secret,
    allowPrivateTargets,
  });
  if (!startRead.ok) return unavailable(task, startRead.reason);
  const startParsed = baselineFromLog(startRead.snapshot.log, parser, 'ci');
  if (!validParsedRun(startParsed)) return unavailable(task, 'start CI log did not contain complete, named per-test results');
  if (startParsed.rows.length > MAX_CAPTURED_TESTS) return unavailable(task, 'start CI log contains too many tests to capture safely');

  const afterRead = clean
    ? currentSha === startSha.toLowerCase()
      ? startRead
      : await readCiLog({ endpoint, sha: currentSha, secret, allowPrivateTargets })
    : { ok: false as const, reason: 'current worktree is dirty; commit the changes before matching a CI log' };
  let afterRun: CapturedCiRun | null = null;
  let afterFailure: string | null = null;
  if (afterRead.ok) {
    const afterParsed = baselineFromLog(afterRead.snapshot.log, parser, 'ci');
    if (!validParsedRun(afterParsed)) {
      afterFailure = 'current CI log did not contain complete, named per-test results';
    } else if (afterParsed.rows.length > MAX_CAPTURED_TESTS) {
      afterFailure = 'current CI log contains too many tests to capture safely';
    } else {
      try {
        const changes = await source.changedFiles({ start_ref: startSha });
        const protectedChanges = changes.filter((file) => isProtectedTest(file.path, protectedGlobs));
        if (protectedChanges.length > MAX_PROTECTED_FILES) throw new Error('too many protected test files changed');
        const weakening: CapturedCiRun['weakening'] = [];
        for (const file of protectedChanges) {
          const pair = await source.readFilePair({ start_ref: startSha, path: file.path, status: file.status });
          const measured = detectWeakening(pair.before ?? '', pair.after ?? '', file.path);
          if (measured) {
            weakening.push({
              path: measured.path,
              assertions_before: measured.assertionsBefore,
              assertions_after: measured.assertionsAfter,
              count_delta: measured.countDelta,
              modifiers: measured.addedModifiers,
            });
          }
        }
        const [confirmedSha, stillClean] = await Promise.all([source.headSha(), source.isWorktreeClean()]);
        if (!stillClean || confirmedSha.toLowerCase() !== currentSha) {
          throw new Error('worktree changed while CI results were being captured');
        }
        afterRun = {
          provider: afterRead.snapshot.provider,
          run_id: afterRead.snapshot.run_id,
          job: afterRead.snapshot.job,
          sha: afterRead.snapshot.sha,
          sha256_log: afterRead.snapshot.sha256_log,
          tests: afterParsed.rows.map((row) => ({ name: row.name, result: row.result })),
          totals: afterParsed.totals,
          complete: true,
          captured_at: new Date().toISOString(),
          weakening,
        };
      } catch (error) {
        afterFailure = error instanceof Error ? error.message : 'protected test files could not be measured safely';
      }
    }
  } else {
    afterFailure = afterRead.reason;
  }

  const startRun = {
    provider: startRead.snapshot.provider,
    run_id: startRead.snapshot.run_id,
    job: startRead.snapshot.job,
    sha: startRead.snapshot.sha,
    sha256_log: startRead.snapshot.sha256_log,
    captured_at: new Date().toISOString(),
    test_count: startParsed.rows.length,
    totals: startParsed.totals,
  };
  let startCaptured = false;
  let storedStartProvenance: { run_id: string; job: string; sha: string; sha256_log: string } | null = null;
  await unitOfWork(db, async ({ tx }) => {
    const existing = await tx
      .selectFrom('exec_baseline_tests')
      .select(['test_name', 'result_at_start', 'source', 'provenance'])
      .where('task_id', '=', task.id)
      .execute();
    if (!existing.length) {
      const provenance = {
        provider: startRun.provider,
        run_id: startRun.run_id,
        job: startRun.job,
        sha: startRun.sha,
        sha256_log: startRun.sha256_log,
        captured_at: startRun.captured_at,
      };
      await tx
        .insertInto('exec_baseline_tests')
        .values(
          startParsed.rows.map((row) => ({
            id: newId(),
            task_id: task.id,
            test_name: row.name,
            result_at_start: row.result,
            assertion_count: row.assertions ?? null,
            source: 'ci' as const,
            approval_id: null,
            provenance: toJsonb(provenance) as never,
          })),
        )
        .execute();
      await appendEvent(tx, {
        organization_id: actor.organizationId,
        task_id: task.id,
        entity: 'baseline',
        entity_id: task.id,
        entity_code: task.code,
        action: 'baseline.start_captured',
        actor_type: 'system',
        actor_id: 'ci-baseline-reader',
        tool: 'baseline_capture',
        payload: { start: startRun },
      });
      startCaptured = true;
      storedStartProvenance = {
        run_id: startRun.run_id,
        job: startRun.job,
        sha: startRun.sha,
        sha256_log: startRun.sha256_log,
      };
    } else {
      if (!sameBaseline(existing, startParsed.rows, startSha)) {
        throw new AppError('LEDGER_STATE_INVALID', 'stored baseline provenance does not match the task start SHA', {
          needed_action: 'do not replace a baseline silently; ask a human to waive it or create a new task',
        });
      }
      const provenance = objectValue(existing[0]?.provenance);
      if (
        !provenance || typeof provenance.run_id !== 'string' || typeof provenance.job !== 'string' ||
        typeof provenance.sha !== 'string' || typeof provenance.sha256_log !== 'string'
      ) {
        throw new AppError('LEDGER_STATE_INVALID', 'stored CI baseline provenance is incomplete', {
          needed_action: 'do not replace a baseline silently; ask a human to waive it or create a new task',
        });
      }
      storedStartProvenance = {
        run_id: provenance.run_id,
        job: provenance.job,
        sha: provenance.sha,
        sha256_log: provenance.sha256_log,
      };
    }

    if (afterRun) {
      await appendEvent(tx, {
        organization_id: actor.organizationId,
        task_id: task.id,
        entity: 'baseline',
        entity_id: task.id,
        entity_code: task.code,
        action: 'baseline.captured',
        actor_type: 'system',
        actor_id: 'ci-baseline-reader',
        tool: 'baseline_capture',
        payload: { after: afterRun },
      });
    }
    await auditIn(tx, actor, 'exec.baseline.capture', 'exec_task', task.id, {
      task: task.code,
      start_sha: startSha,
      current_sha: currentSha,
      start_test_count: startParsed.rows.length,
      after_test_count: afterRun?.tests.length ?? 0,
      weakening_count: afterRun?.weakening.length ?? 0,
      start_captured: startCaptured,
      ready: afterRun !== null,
    });
  });

  if (!afterRun) {
    return {
      ok: false,
      code: 'BASELINE_UNAVAILABLE',
      task_id: task.id,
      task_code: task.code,
      start_sha: startSha,
      current_sha: currentSha,
      baseline_tests: startParsed.rows.length,
      needed_action: afterFailure ?? 'capture both CI logs for the exact start and current commit SHAs',
      human_waive_route: `/api/v1/exec/tasks/${task.id}/baseline/waive`,
    };
  }
  return {
    ok: true,
    task_id: task.id,
    task_code: task.code,
    start_sha: startSha,
    current_sha: currentSha,
    start_test_count: startParsed.rows.length,
    current_test_count: afterRun.tests.length,
    weakening_count: afterRun.weakening.length,
    start_captured: startCaptured,
    provenance: {
      start: storedStartProvenance ?? {
        run_id: startRun.run_id,
        job: startRun.job,
        sha: startRun.sha,
        sha256_log: startRun.sha256_log,
      },
      current: { run_id: afterRun.run_id, job: afterRun.job, sha: afterRun.sha, sha256_log: afterRun.sha256_log },
    },
  };
}

async function findTask(db: Db, organizationId: string, projectId: string, ref: string): Promise<TaskRow | null> {
  const result = await sql<TaskRow>`
    SELECT id::text AS id, code, status, start_ref
    FROM exec_tasks
    WHERE organization_id = ${organizationId} AND project_id = ${projectId}
      AND (code = ${ref} OR id::text = ${ref})
    LIMIT 1
  `.execute(db as never);
  return result.rows[0] ?? null;
}

function parseParser(value: unknown): ParserCfg | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      pass: [...DEFAULT_TEST_PARSER.pass],
      fail: [...DEFAULT_TEST_PARSER.fail],
      skip: [...DEFAULT_TEST_PARSER.skip],
      test_line: DEFAULT_TEST_PARSER.test_line,
    };
  }
  const raw = value as Record<string, unknown>;
  const groups = ['pass', 'fail', 'skip'] as const;
  const parsed: ParserCfg = { pass: [], fail: [], skip: [], test_line: '' };
  for (const group of groups) {
    const values = raw[group];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > 20 || values.some((item) => typeof item !== 'string' || item.length > 200)) return null;
    try {
      for (const pattern of values as string[]) new RegExp(pattern, 'i');
    } catch {
      return null;
    }
    parsed[group] = values as string[];
  }
  if (raw.test_line !== undefined) {
    if (typeof raw.test_line !== 'string' || raw.test_line.length > 200) return null;
    parsed.test_line = raw.test_line;
  }
  return parsed;
}

function validParsedRun(parsed: ReturnType<typeof baselineFromLog>): boolean {
  const reported = parsed.totals.pass + parsed.totals.fail + parsed.totals.skip;
  const named = {
    pass: parsed.rows.filter((row) => row.result === 'pass').length,
    fail: parsed.rows.filter((row) => row.result === 'fail').length,
    skip: parsed.rows.filter((row) => row.result === 'skip').length,
  };
  return (
    parsed.complete &&
    parsed.rows.length > 0 &&
    parsed.rows.length >= reported &&
    named.pass >= parsed.totals.pass &&
    named.fail >= parsed.totals.fail &&
    named.skip >= parsed.totals.skip &&
    parsed.rows.every((row) => row.name.length > 0)
  );
}

function sameBaseline(
  existing: { test_name: string; result_at_start: string; source: string; provenance: unknown }[],
  parsed: { name: string; result: string }[],
  expectedSha: string,
): boolean {
  if (existing.length !== parsed.length) return false;
  const expected = new Map(parsed.map((row) => [row.name, row.result]));
  return existing.every((row) => {
    if (row.source !== 'ci' || row.result_at_start !== expected.get(row.test_name)) return false;
    const provenance = objectValue(row.provenance);
    return typeof provenance?.sha === 'string' && provenance.sha.toLowerCase() === expectedSha.toLowerCase();
  });
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function unavailable(task: TaskRow, reason: string): Record<string, unknown> {
  return {
    ok: false,
    code: 'BASELINE_UNAVAILABLE',
    task_id: task.id,
    task_code: task.code,
    needed_action: reason,
    human_waive_route: `/api/v1/exec/tasks/${task.id}/baseline/waive`,
  };
}
