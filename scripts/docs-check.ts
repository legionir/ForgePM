/**
 * pnpm docs:check — every required doc exists, is non-empty, and its
 * relative markdown links resolve (§15). Also fails if EXECUTION_PLAN.md
 * differs from the committed plan source-of-truth is NOT checked (that file
 * is a copy); only structure/links are verified here.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const REQUIRED = [
  'README.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'docs/PRODUCT.md',
  'docs/ARCHITECTURE.md',
  'docs/DATA_MODEL.md',
  'docs/SECURITY.md',
  'docs/API_CONTRACTS.md',
  'docs/MCP_CONTRACTS.md',
  'docs/EXECUTION_PLAN.md',
  'docs/ACCEPTANCE_CRITERIA.md',
  'docs/PERFORMANCE_BUDGET.md',
  'docs/DECISIONS.md',
  'docs/BLOCKERS.md',
  'docs/GITHUB.md',
  'docs/REVIEWS.md',
  'docs/RUNBOOK.md',
  'docs/SCALING.md',
  'docs/MCP.md',
];

const problems: string[] = [];

for (const rel of REQUIRED) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    problems.push(`missing: ${rel}`);
    continue;
  }
  if (statSync(abs).size === 0) problems.push(`empty: ${rel}`);
}

// broken relative links inside docs/*.md and root markdown files
const linkRe = /\[[^\]]*\]\((?!https?:|#|mailto:)([^)\s]+)\)/g;
for (const rel of REQUIRED) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) continue;
  const md = readFileSync(abs, 'utf8');
  for (const m of md.matchAll(linkRe)) {
    const target = m[1].replace(/^.\//, '').split('#')[0];
    if (!target) continue;
    const absTarget = resolve(dirname(abs), target);
    if (!existsSync(absTarget)) problems.push(`broken link in ${rel}: ${m[1]}`);
  }
}

if (problems.length) {
  process.stderr.write(`docs:check FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`docs:check OK — ${REQUIRED.length} required docs present, links resolve`);
void relative;
