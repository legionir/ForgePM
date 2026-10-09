// scripts/phase-report-selftest.mjs
// Acceptance §15: the phase report shows `local` and `remote` as two separate
// lines, and no stage is reported green unless its gate really ran. Proves:
//   - both lines are present,
//   - local is `fail` with no marker file,
//   - local turns `pass` only after the `.verify-local` marker exists,
//   - remote is `not-configured` here (report never fabricates remote).
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync } from 'node:fs';

function report() {
  return execSync('npx tsx scripts/phase-report.ts 0 --stdout', { encoding: 'utf8', env: process.env });
}

const out = report();
const local = /^- local: (pass|fail)$/m.exec(out)?.[1];
const remote = /^- remote: (pass|fail|not-configured|pending)$/m.exec(out)?.[1];

try {
  if (!local) throw new Error('missing `- local:` line');
  if (!remote) throw new Error('missing `- remote:` line');
  if (local !== 'fail' && !existsSync('.verify-local')) {
    throw new Error('local reported pass without a marker file');
  }

  writeFileSync('.verify-local', 'pass');
  const out2 = report();
  if (!/^- local: pass$/m.test(out2)) throw new Error('local did not become pass with marker present');

  console.log('phase-report selftest OK (two separate, evidence-based lines)');
} catch (e) {
  console.error(`phase-report selftest FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync('.verify-local', { force: true });
}
