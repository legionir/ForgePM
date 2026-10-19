import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Acceptance C.11 (plan §8.2): "`gate.ts` ≤ 400 lines and each rule ≤ 60
 * lines (a test that reads the files, like `tests/unit/eslint-boundaries.test.ts`)".
 *
 * The size limit is not style: the gate is the one place an agent's "I am
 * done" is turned into a decision, and a decision nobody can read is a
 * decision nobody can argue with. Splitting the rules into one file each
 * keeps each answer short enough to be checked by eye — and this test is
 * what stops the next person from putting it all back in one file.
 */

const GATE_DIR = fileURLToPath(new URL('../../packages/core/src/exec', import.meta.url));
const RULES_DIR = fileURLToPath(new URL('../../packages/core/src/exec/gate-rules', import.meta.url));

const lineCount = (file: string): number => readFileSync(file, 'utf8').split('\n').length;

/**
 * The line span of the arrow function a rule file exports.
 *
 * A rule may be written with a block body (`=> { … }`) or as an expression
 * (`=> ctx.criteria.filter(…)`). Both are the same rule, so the measurement
 * has to understand both — a size test that only understands one style is a
 * test that fails for a reason nobody cares about.
 */
function functionLineCount(file: string): number {
  const src = readFileSync(file, 'utf8');
  const m = /=>\s*/.exec(src);
  if (!m) throw new Error(`no rule function in ${file}`);
  const afterArrow = m.index + m[0].length;
  const first = src.slice(0, m.index).split('\n').length;
  if (src.startsWith('{', afterArrow)) {
    // A block body: the span between its braces.
    let depth = 0;
    for (let i = afterArrow; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          const last = src.slice(0, i).split('\n').length;
          return last - first + 1;
        }
      }
    }
    throw new Error(`unbalanced braces in ${file}`);
  }
  // An expression body: from the arrow to the end of the statement, which is
  // everything up to the export.
  const end = src.search(/\n\nexport default/);
  const tail = (end === -1 ? src : src.slice(0, end)).replace(/\s+$/, '');
  const last = tail.split('\n').length;
  return last - first + 1;
}

describe('C.11 — the finalization gate stays readable', () => {
  it('gate.ts is at most 400 lines', () => {
    expect(lineCount(`${GATE_DIR}/gate.ts`)).toBeLessThanOrEqual(400);
  });

  it('every rule file is at most 400 lines', () => {
    for (const file of readdirSync(RULES_DIR)) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      expect(lineCount(`${RULES_DIR}/${file}`), file).toBeLessThanOrEqual(400);
    }
  });

  it('every rule function is at most 60 lines', () => {
    for (const file of readdirSync(RULES_DIR)) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      expect(functionLineCount(`${RULES_DIR}/${file}`), file).toBeLessThanOrEqual(60);
    }
  });

  it('there is one file per rule, numbered 1..13', () => {
    const files = readdirSync(RULES_DIR)
      .filter((f) => f.startsWith('rule'))
      .sort();
    expect(files.length).toBe(13);
    files.forEach((file, i) => {
      expect(file, `rule ${i + 1} is not in the right file`).toMatch(
        new RegExp(`^rule${String(i + 1).padStart(2, '0')}-`),
      );
    });
  });
});
