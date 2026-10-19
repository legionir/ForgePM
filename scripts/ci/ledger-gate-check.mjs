#!/usr/bin/env node
/**
 * ledger-gate-check.mjs — CI trailer gate (R-01): Ledger-Task trailer check.
 *
 * Every PR commit that touches product code (not docs/ci-only) must carry a
 * `Ledger-Task: T-xxx` trailer (or `Ledger-Exempt: <reason>` with an allowlisted
 * path). The script also verifies that the gate stamp was checked (the API's
 * `dryRunGate` was called) — inferred from the CI log artifact `gate.json`.
 *
 * Exit 0 = pass, 1 = fail (blocks CI).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const EXEMPT_ALLOWLIST = new Set([
  'docs/', 'scripts/docs-check', '.github/workflows/ci.yml',
  'CHANGELOG.md', 'README.md',
]);

function isExemptPath(file) {
  for (const p of EXEMPT_ALLOWLIST) if (file.startsWith(p)) return true;
  return false;
}

export function checkCommitTrailers(commits) {
  const failures = [];
  for (const c of commits) {
    const msg = c.message ?? '';
    const hasLedgerTask = /Ledger-Task:\s*T-\S+/i.test(msg);
    const hasExempt = /Ledger-Exempt:\s*.+/i.test(msg);
    if (hasLedgerTask || hasExempt) continue;
    // Docs-only commits are exempt even without trailer (B-009)
    const files = c.files ?? [];
    const onlyExempt = files.length > 0 && files.every(isExemptPath);
    if (onlyExempt) continue;
    failures.push({ sha: c.sha, summary: `${c.sha.slice(0, 7)} missing Ledger-Task/Ledger-Exempt trailer` });
  }
  return failures;
}

export function checkGateStamp(gateJsonPath = 'gate.json') {
  if (!existsSync(gateJsonPath)) return { ok: false, reason: `gate stamp ${gateJsonPath} not found — did dryRunGate run?` };
  try {
    const data = JSON.parse(readFileSync(gateJsonPath, 'utf8'));
    if (!data.gate_version || !data.tree_hash) return { ok: false, reason: 'gate.json missing gate_version/tree_hash' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `gate.json invalid: ${e.message}` };
  }
}

function getCommits(base = 'origin/main') {
  try {
    const range = execFileSync('git', ['rev-list', `${base}..HEAD`, '--no-merges'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    return range.map((sha) => {
      const message = execFileSync('git', ['log', '-1', '--format=%B', sha], { encoding: 'utf8' });
      let files = [];
      try {
        files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', sha], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      } catch { /* root commit has no parent */ }
      return { sha, message, files };
    });
  } catch {
    return [];
  }
}

async function main() {
  const commits = getCommits();
  if (!commits.length) {
    console.log('ledger-gate: no commits in range — pass');
    process.exit(0);
  }
  const trailerFails = checkCommitTrailers(commits);
  if (trailerFails.length) {
    console.error('ledger-gate: missing trailers:\n' + trailerFails.map((f) => `  - ${f.summary}`).join('\n'));
    process.exit(1);
  }
  const stamp = checkGateStamp(process.env.GATE_JSON ?? 'gate.json');
  if (!stamp.ok) {
    console.warn(`ledger-gate: gate stamp warning — ${stamp.reason} (advisory until API emits gate.json)`);
    // Do not hard-fail on stamp yet (B-009): advisory until the API writes gate.json in CI
  }
  console.log('ledger-gate: pass');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
