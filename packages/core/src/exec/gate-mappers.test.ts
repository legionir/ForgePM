import { describe, expect, it } from 'vitest';
import { toBaseline, toScope } from './gate-mappers';

const startSha = 'a'.repeat(40);
const currentSha = 'b'.repeat(40);
const startLogHash = 'd'.repeat(64);
const startProvenance = {
  provider: 'fixture',
  run_id: 'run-1',
  job: 'unit',
  sha: startSha,
  sha256_log: startLogHash,
};
const startEvent = (sha = startSha) => ({
  id: '01-start-event',
  action: 'baseline.start_captured',
  actor_type: 'system',
  actor_id: 'ci-baseline-reader',
  tool: 'baseline_capture',
  created_at: new Date('2026-10-19T11:00:00.000Z'),
  payload: { start: { ...startProvenance, sha } },
});
const runEvent = (sha = currentSha) => ({
  id: '02-current-event',
  action: 'baseline.captured',
  actor_type: 'system',
  actor_id: 'ci-baseline-reader',
  tool: 'baseline_capture',
  created_at: new Date('2026-10-19T12:00:00.000Z'),
  payload: {
    after: {
      sha,
      run_id: 'run-2',
      job: 'unit',
      sha256_log: 'c'.repeat(64),
      complete: true,
      tests: [{ name: 'auth > logs in', result: 'pass' }],
      weakening: [],
    },
  },
});

describe('gate baseline mapping (PE-8)', () => {
  it('labels a server-measured no-Git diff as a manifest scope basis', () => {
    const scope = toScope([{ path: 'src/app.ts', status: 'M' }], ['src/**'], null, null, false, 'manifest');
    expect(scope.available).toBe(true);
    expect(scope.basis).toBe('manifest');
    expect(scope.files[0]?.in_allowed_paths).toBe(true);
  });

  it('accepts only CI-origin start rows and a system capture for the current SHA', () => {
    const result = toBaseline(
      [
        {
          test_name: 'auth > logs in',
          result_at_start: 'pass',
          source: 'ci',
          provenance: startProvenance,
        },
        {
          test_name: 'agent-claimed test',
          result_at_start: 'pass',
          source: 'human',
          provenance: startProvenance,
        },
      ],
      [startEvent(), runEvent()],
      startSha,
      currentSha,
      false,
    );
    expect(result.ran).toBe(true);
    expect(result.start_sha).toBe(startSha);
    expect(result.current_sha).toBe(currentSha);
    expect(result.tests.map((test) => test.name)).toEqual(['auth > logs in']);
    expect(result.after?.sha).toBe(currentSha);
    expect(result.after?.results).toEqual({ 'auth > logs in': 'pass' });
  });

  it('fails closed when either the current SHA or the CI event provenance mismatches', () => {
    const wrongCurrent = toBaseline(
      [{ test_name: 'auth > logs in', result_at_start: 'pass', source: 'ci', provenance: startProvenance }],
      [startEvent(), runEvent()],
      startSha,
      'd'.repeat(40),
      false,
    );
    expect(wrongCurrent.ran).toBe(false);
    expect(wrongCurrent.unavailable_reason).toContain('no CI log captured');

    const wrongStart = toBaseline(
      [{ test_name: 'auth > logs in', result_at_start: 'pass', source: 'ci', provenance: { sha: 'd'.repeat(40) } }],
      [startEvent(), runEvent()],
      startSha,
      currentSha,
      false,
    );
    expect(wrongStart.ran).toBe(false);
    expect(wrongStart.unavailable_reason).toContain('no CI baseline captured');
  });

  it('requires a system-authored start capture event matching every baseline row', () => {
    const result = toBaseline(
      [{ test_name: 'auth > logs in', result_at_start: 'pass', source: 'ci', provenance: startProvenance }],
      [runEvent()],
      startSha,
      currentSha,
      false,
    );
    expect(result.ran).toBe(false);
    expect(result.tests).toEqual([]);
  });

  it('does not treat an agent-authored waiver marker as an approval', () => {
    const result = toBaseline(
      [{ test_name: 'auth > logs in', result_at_start: 'pass', source: 'ci', provenance: startProvenance }],
      [
        startEvent(),
        {
          ...runEvent(),
          actor_type: 'agent',
          payload: { waiver: 'baseline:T-001', approval_id: 'not-human' },
        },
      ],
      startSha,
      currentSha,
      false,
    );
    expect(result.ran).toBe(false);

    const wrongSystemActor = toBaseline(
      [{ test_name: 'auth > logs in', result_at_start: 'pass', source: 'ci', provenance: startProvenance }],
      [startEvent(), { ...runEvent(), actor_id: 'untrusted-writer' }],
      startSha,
      currentSha,
      false,
    );
    expect(wrongSystemActor.ran).toBe(false);
  });
});
