import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance J.7c (plan §PE-8) — the structural half of D-041.
 *
 * The draft solved "the gate must not trust the agent about test results" by
 * executing the tests in an ephemeral container. The owner cancelled that
 * ("وارد docker نشو — docker چرا لازم است؟") and the plan took the stronger
 * shape instead: there is no execution path to abuse. This test is what keeps
 * it that way. It does not care *why* someone reaches for `child_process`, only
 * that the exec surfaces (gate, baseline, ledger services, API module) never
 * gain the ability to run repo code — if it goes red, the fix is to read a CI
 * log, not to widen an allowlist.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SURFACES = ['packages/core/src/exec', 'apps/api/src/modules/exec'];

/** Anything that could turn "run the project's tests" into remote code execution. */
const BANNED =
  /node:child_process|['"]child_process['"]|\bexecFile\s*\(|\bspawnSync\s*\(|\bexecSync\s*\(|\bspawn\s*\(|\bprocess\.binding\s*\(/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(join(ROOT, dir, entry.name));
    }
  }
  return out;
}

describe('exec surfaces cannot spawn processes (D-041 / J.7c)', () => {
  it('scans the real module, not an empty list', () => {
    expect(sources(SURFACES[0]!).length).toBeGreaterThan(10);
    expect(sources(SURFACES[1]!).length).toBeGreaterThan(0);
  });

  it('no exec source file imports child_process or spawns anything', () => {
    const checked: string[] = [];
    for (const dir of SURFACES) {
      for (const file of sources(dir)) {
        checked.push(file);
        const src = readFileSync(file, 'utf8');
        expect(BANNED.test(src), `${basename(file)} must not spawn processes (D-041)`).toBe(false);
      }
    }
    expect(checked.length).toBeGreaterThan(10);
  });

  it('the cancelled runner artefacts did not come back', () => {
    const repoPkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
    expect(repoPkg).not.toMatch(/docker/);
    expect(readdirSync(join(ROOT, 'scripts'))).not.toContain('runner');
    expect(readdirSync(ROOT)).not.toContain('docker-compose.runner.yml');
  });

  it('the BANNED pattern itself works (a guard that matches nothing is worse than none)', () => {
    expect(BANNED.test("import { execSync } from 'node:child_process';")).toBe(true);
    expect(BANNED.test('execFile("npm", ["test"]);')).toBe(true);
    expect(BANNED.test('spawn("sh", ["-c", cmd]);')).toBe(true);
    expect(BANNED.test('export function compareBaseline() { return 1; }')).toBe(false);
  });
});
