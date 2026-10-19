import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance J.7c (plan §PE-8) — the structural half of D-041.
 *
 * The draft solved "the gate must not trust the agent about test results" by
 * executing the tests in an ephemeral container. The owner cancelled that
 * ("وارد docker نشو — docker چرا لازم است؟"). PE-7 adds one tightly audited
 * exception: the API's Git input adapter may use `execFile` for fixed,
 * read-only `git diff`/`ls-files`/`rev-parse`/`status`/`show` commands. It may
 * not run project code or write to the repository. Every other exec surface remains spawn-free.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SURFACES = ['packages/core/src/exec', 'apps/api/src/modules/exec'];
const READ_ONLY_GIT_SOURCE = join(ROOT, 'apps/api/src/modules/exec/review-source.ts');

/** Anything that could turn "run the project's tests" into remote code execution. */
const BANNED =
  /node:child_process|['"]child_process['"]|\bexecFile\s*\(|\bspawnSync\s*\(|\bexecSync\s*\(|\bspawn\s*\(|\bprocess\.binding\s*\(/;

function sources(dir: string): string[] {
  const walk = (current: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(file));
      } else if (entry.isFile() && file.endsWith('.ts') && !file.endsWith('.test.ts')) {
        out.push(file);
      }
    }
    return out;
  };
  return walk(join(ROOT, dir));
}

describe('exec surfaces cannot spawn processes (D-041 / J.7c)', () => {
  it('scans the real module, including nested gate rules', () => {
    const coreSources = sources(SURFACES[0]!);
    expect(coreSources.length).toBeGreaterThan(10);
    expect(coreSources.some((file) => file.endsWith(join('gate-rules', 'rule01-exit-report.ts')))).toBe(true);
    expect(sources(SURFACES[1]!).length).toBeGreaterThan(0);
  });

  it('only the audited read-only Git adapter may call child_process', () => {
    const checked: string[] = [];
    for (const dir of SURFACES) {
      for (const file of sources(dir)) {
        checked.push(file);
        const src = readFileSync(file, 'utf8');
        if (file === READ_ONLY_GIT_SOURCE) {
          expect(src).toContain("import { execFile } from 'node:child_process'");
          expect(src).toContain("core.fsmonitor=false");
          expect(src).toContain("core.hooksPath=/dev/null");
          expect(src).toContain("diff.external=false");
          expect(src).toContain("['rev-parse'");
          expect(src).toContain("['ls-files'");
          expect(src).toContain("'diff'");
          expect(src).toContain("['status'");
          expect(src).toContain("'show'");
          expect(src).toContain("GIT_CONFIG_NOSYSTEM");
          expect(src).toContain("GIT_OPTIONAL_LOCKS = '0'");
          expect(src).not.toMatch(/\bshell\s*:\s*true|\b(execSync|spawnSync|execFileSync|spawn)\s*\(/);
          expect(src).not.toMatch(/\[['"](?:add|commit|checkout|reset|clean|restore|rm|push|fetch|pull|merge|rebase|switch|stash)['"]/);
          expect(src).not.toMatch(/\b(writeFile|appendFile|mkdir|unlink|truncate)\s*\(/);
          continue;
        }
        expect(BANNED.test(src), `${basename(file)} must not spawn processes (D-041)`).toBe(false);
      }
    }
    expect(checked).toContain(READ_ONLY_GIT_SOURCE);
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
