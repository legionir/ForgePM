import { describe, it, expect } from 'vitest';
import {
  analyzeRepoFiles,
  structureIndexJson,
  partitionFiles,
  selectFiles,
  buildImportGraph,
  isCodeFile,
} from '../index';

const longFn = `export function big(a: number, b: number, c: number, d: number, e: number, f: number): number {
  if (a) { if (b) { for (let i = 0; i < a; i++) { if (i % 2) { while (i > c) { i--; } } } } }
  if (d) { for (let j = 0; j < d; j++) { if (j) { for (let k = 0; k < j; k++) { if (k) { while (k > e) { k--; } } } } } }
  if (f) { for (let m = 0; m < f; m++) { if (m) { for (let n = 0; n < m; n++) { if (n) { while (n > a) { n--; } } } } } }
  if (a && b && c) { for (let p = 0; p < a; p++) { if (p) { for (let q = 0; q < p; q++) { if (q) { while (q > b) { q--; } } } } } }
  if (c && d && e) { for (let r = 0; r < c; r++) { if (r) { for (let s = 0; s < r; s++) { if (s) { while (s > d) { s--; } } } } } }
  return a + b + c + d + e + f;
}`;

const dupBody = `function sharedHelper(alpha: number, beta: number): number {
  const gamma = alpha * 2 + beta * 3 - 7;
  const delta = gamma / 3 - beta + alpha * 4;
  const epsilon = delta + alpha * beta - gamma * 2 + 11;
  const zeta = epsilon - gamma + delta * 2 - beta + 13;
  const eta = zeta * alpha / 2 + beta - epsilon + delta * 3;
  const theta = eta + epsilon - zeta + gamma * beta / 4 - 17;
  const iota = theta * 2 + eta - epsilon + zeta / 3 + delta;
  return iota + theta - eta + epsilon - zeta + delta - gamma + beta;
}`;

const files = [
  { path: 'src/long.ts', content: longFn },
  { path: 'src/dupA.ts', content: `import { x } from './cycle';\n${dupBody}` },
  { path: 'src/dupB.ts', content: `${dupBody}` },
  { path: 'src/cycle.ts', content: `import { y } from './cycle2';\nexport const x = 1;\nfunction y2(a: number) { return a; }` },
  { path: 'src/cycle2.ts', content: `import { x } from './cycle';\nexport const y = 2;` },
  { path: 'README.md', content: '# not code\n' },
];

describe('repository analyzer (plan §10.6.2, deterministic AI-free)', () => {
  const idx = analyzeRepoFiles(files);
  const json = structureIndexJson(idx);

  it('detects the 120-line-equivalent long / complex / many-param function', () => {
    const fn = idx.functions.find((f) => f.name === 'big');
    expect(fn).toBeDefined();
    expect(fn!.params).toBe(6);
    expect(fn!.complexity).toBeGreaterThan(10);
    const listed = (json.functions as { name: string }[]).find((f) => f.name === 'big');
    expect(listed).toBeTruthy();
  });

  it('detects the duplicated block via rolling hash (≥6 lines)', () => {
    expect(idx.duplicates.length).toBeGreaterThan(0);
    const pair = idx.duplicates.find((d) => d.files.includes('src/dupA.ts') && d.files.includes('src/dupB.ts'));
    expect(pair).toBeDefined();
    expect(pair!.lines).toBeGreaterThanOrEqual(6);
  });

  it('detects the import cycle + fan counts', () => {
    expect(idx.imports.cycles.length).toBeGreaterThan(0);
    const flat = idx.imports.cycles.flat();
    expect(flat).toContain('src/cycle.ts');
    expect(flat).toContain('src/cycle2.ts');
    expect(idx.imports.fan_out['src/dupA.ts']).toBeGreaterThanOrEqual(1);
  });

  it('counts files/languages and skips non-code from function analysis', () => {
    expect(idx.files).toBe(6);
    expect(idx.languages.markdown).toBe(1);
    expect(isCodeFile('README.md')).toBe(false);
    expect(isCodeFile('src/a.ts')).toBe(true);
    expect(idx.per_file['README.md'].functions).toBe(0);
  });
});

describe('partitioning + incremental selection (plan §10.6.4/5)', () => {
  it('partitions a 12000-file repo into 3 runs at max 5000', () => {
    const many = Array.from({ length: 12000 }, (_, i) => ({ path: `pkg${i % 9}/f${i}.ts`, content: `export const v = ${i};` }));
    const { groups } = partitionFiles(many, 5000);
    expect(groups.length).toBe(3);
    expect(groups.reduce((n, g) => n + g.length, 0)).toBe(12000);
    expect(groups.every((g) => g.length <= 5000)).toBe(true);
    // deterministic: same input -> same partitioning (cursor advances reliably)
    expect(partitionFiles(many, 5000).groups.map((g) => g.length)).toEqual(groups.map((g) => g.length));
  });

  it('selectFiles filters to the requested paths', () => {
    const sel = selectFiles(files, ['src/long.ts', 'src/nope.ts']);
    expect(sel.map((f) => f.path)).toEqual(['src/long.ts']);
  });

  it('buildImportGraph ignores external packages', () => {
    const g = buildImportGraph([{ path: 'a.ts', content: `import fs from 'node:fs';\nimport { b } from './b';` }, { path: 'b.ts', content: 'export const b = 1;' }]);
    expect(g.edges).toEqual([{ from: 'a.ts', to: 'b.ts' }]);
  });
});
