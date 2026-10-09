import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * pnpm report:phase <N> — writes docs/PHASE<N>_REPORT.md carrying the two
 * mandatory separate lines (plan §2 step 6):
 *   local:  pass|fail   — did `pnpm verify` actually run & succeed here?
 *   remote: pass|fail|not-configured|pending — Remote CI via `gh` (never faked).
 *
 * It runs NOTHING itself; it reads the evidence markers, so a phase can never
 * be declared green unless that gate actually ran:
 *   - local pass requires a `.verify-local` marker containing "pass" (written
 *     by a real `pnpm verify`, or by CI).
 *   - remote reflects GitHub check-run conclusions for HEAD; with no remote or
 *     no gh auth it is `not-configured`, never assumed pass.
 *
 * Flags: `--stdout` (print, don't write) and `--marker <path>` (override the
 * local-marker location — used by the hermetic selftest).
 */
function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const args = process.argv.slice(2);
const phase = Number(args[0] ?? 0);
const stdout = args.includes('--stdout');
const markerIdx = args.indexOf('--marker');
const markerFile = markerIdx >= 0 ? args[markerIdx + 1] : resolve('.verify-local');

const local = existsSync(markerFile) && readFileSync(markerFile, 'utf8').trim() === 'pass' ? 'pass' : 'fail';

let remote = 'not-configured';
const hasRemote = run('git remote get-url origin');
if (hasRemote && run('gh auth status').includes('Logged in')) {
  const sha = run('git rev-parse HEAD');
  const concl = run(`gh api repos/:owner/:repo/commits/${sha}/check-runs --jq '.check_runs[].conclusion'`);
  const lines = concl.split('\n').filter(Boolean);
  if (lines.length === 0) remote = 'not-configured';
  else if (lines.some((l) => l === 'FAILURE' || l === 'CANCELLED' || l === 'TIMED_OUT')) remote = 'fail';
  else if (lines.every((l) => l === 'SUCCESS')) remote = 'pass';
  else remote = 'pending';
}

const report = `# Phase ${phase} report

- local: ${local}
- remote: ${remote}

Generated at ${new Date().toISOString()}. Neither status is claimed unless its
gate actually ran (local: \`.verify-local\` marker from a real \`pnpm verify\`;
remote: GitHub check-runs for the pushed commit).
`;

if (stdout) {
  console.log(report);
} else {
  mkdirSync(resolve('docs'), { recursive: true });
  writeFileSync(resolve(dirname('docs'), `PHASE${phase}_REPORT.md`), report, 'utf8');
  console.log(report);
}
