import { createHash } from 'node:crypto';

/**
 * Repository Analyzer (plan §10.6.2) — deterministic, AI-free. Runs on the
 * worker for Refactor Review and writes `code_structure_index` (keyed by
 * commit_sha). Detects: long functions, high cyclomatic complexity, many
 * parameters, duplicated blocks (rolling hash, ≥ 6 lines / ≥ 50 tokens) and
 * import cycles with fan-in/fan-out. Language-agnostic fallback metrics for
 * non-TS/JS files.
 */

export interface AnalyzerFile {
  path: string;
  content: string;
}

export interface FunctionMetric {
  name: string;
  file: string;
  line_start: number;
  line_end: number;
  lines: number;
  complexity: number;
  params: number;
}

export interface DupBlock {
  files: [string, string];
  start_a: number;
  start_b: number;
  lines: number;
  tokens: number;
  hash: string;
}

export interface ImportGraph {
  edges: { from: string; to: string }[];
  fan_in: Record<string, number>;
  fan_out: Record<string, number>;
  cycles: string[][];
}

export interface StructureIndex {
  files: number;
  languages: Record<string, number>;
  loc: number;
  functions: FunctionMetric[];
  duplicates: DupBlock[];
  imports: ImportGraph;
  per_file: Record<string, { loc: number; functions: number }>;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php', cs: 'csharp', md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
};

function ext(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return m ? m[1].toLowerCase() : '';
}

export function isCodeFile(path: string): boolean {
  const l = LANG_BY_EXT[ext(path)];
  return !!l && l !== 'markdown' && l !== 'json' && l !== 'yaml';
}

/** Strip line noise that would defeat structural comparison. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Very small brace-matching function extractor (heuristic; TS/JS only). */
export function extractFunctions(path: string, content: string): FunctionMetric[] {
  const lines = stripComments(content).split('\n');
  const out: FunctionMetric[] = [];
  const head = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>|^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{\s*$/;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3] ?? 'anonymous';
    // find the matching closing brace from the first '{' at/after this line.
    let depth = 0;
    let started = false;
    let end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--;
      }
      if (started && depth === 0) { end = j; break; }
    }
    if (!started) continue;
    const body = lines.slice(i, end + 1).join('\n');
    const params = paramsCount(lines[i]);
    out.push({
      name,
      file: path,
      line_start: i + 1,
      line_end: end + 1,
      lines: end - i + 1,
      complexity: cyclomatic(body),
      params,
    });
    i = end;
  }
  return out;
}

function paramsCount(headLine: string): number {
  const m = /\(([^)]*)\)/.exec(headLine);
  if (!m || !m[1].trim()) return 0;
  return m[1].split(',').filter((p) => p.trim().length > 0).length;
}

function cyclomatic(body: string): number {
  const decisions =
    (body.match(/\bif\b/g)?.length ?? 0) +
    (body.match(/\bfor\b/g)?.length ?? 0) +
    (body.match(/\bwhile\b/g)?.length ?? 0) +
    (body.match(/\bcase\b/g)?.length ?? 0) +
    (body.match(/\bcatch\b/g)?.length ?? 0) +
    (body.match(/&&/g)?.length ?? 0) +
    (body.match(/\|\|/g)?.length ?? 0) +
    (body.match(/\?\s?[^:]*:/g)?.length ?? 0);
  return 1 + decisions;
}

/** Tokenise a line for duplicate detection (identifiers/operators kept). */
function tokenize(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Rolling-hash duplicate blocks (plan §10.6.2): normalised windows of
 * `minLines` lines qualify when they have at least `minLines` lines OR at
 * least `minTokens` tokens ("≥ 6 lines or 50 tokens"), keyed by sha256.
 */
export function findDuplicates(files: AnalyzerFile[], minLines = 6, minTokens = 50): DupBlock[] {
  const seen = new Map<string, { path: string; line: number; tokens: number }>();
  const blocks: DupBlock[] = [];
  // A window is a real duplicate only if it is substantial: >= minLines lines
  // (the fixed window) OR >= minTokens tokens (dense short blocks). The fixed
  // minLines window always meets the line floor, so we still require a small
  // token floor to avoid matching brace-only structure.
  const tokenFloor = Math.max(8, Math.min(minTokens, 12));
  for (const f of files) {
    if (!isCodeFile(f.path)) continue;
    const lines = stripComments(f.content).split('\n').map(tokenize).filter((l) => l.length > 0);
    if (lines.length < minLines) continue;
    for (let i = 0; i + minLines <= lines.length; i++) {
      const window = lines.slice(i, i + minLines);
      const tokens = window.join(' ').split(/\W+/).filter(Boolean).length;
      if (tokens < tokenFloor) continue; // skip trivially empty structure
      const key = createHash('sha256').update(window.join('\n')).digest('hex').slice(0, 32);
      const prev = seen.get(key);
      if (prev && prev.path !== f.path) {
        blocks.push({ files: [prev.path, f.path], start_a: prev.line, start_b: i + 1, lines: minLines, tokens, hash: key });
        seen.delete(key); // report a pair once, not N times
      } else if (!prev) {
        seen.set(key, { path: f.path, line: i + 1, tokens });
      }
    }
  }
  return blocks;
}

/** Resolve relative import specifiers between known files (best effort). */
export function buildImportGraph(files: AnalyzerFile[]): ImportGraph {
  const byPath = new Set(files.map((f) => f.path));
  const edges: { from: string; to: string }[] = [];
  for (const f of files) {
    if (!isCodeFile(f.path)) continue;
    const specs = [...f.content.matchAll(/(?:import\s+(?:[\w*\s{},$]*\s+from\s+)?|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const s of specs) {
      if (!s.startsWith('.')) continue;
      const target = resolveImport(f.path, s, byPath);
      if (target) edges.push({ from: f.path, to: target });
    }
  }
  const fan_in: Record<string, number> = {};
  const fan_out: Record<string, number> = {};
  for (const e of edges) {
    fan_in[e.to] = (fan_in[e.to] ?? 0) + 1;
    fan_out[e.from] = (fan_out[e.from] ?? 0) + 1;
  }
  return { edges, fan_in, fan_out, cycles: findImportCycles(files.map((f) => f.path), edges) };
}

function normalisePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Resolve `./util` -> util.ts / util/index.ts style candidates. */
function resolveImport(fromPath: string, spec: string, byPath: Set<string>): string | null {
  const base = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/') + 1) : '';
  const clean = normalisePath(base + spec);
  if (byPath.has(clean)) return clean;
  for (const extName of ['.ts', '.tsx', '.js', '/index.ts', '/index.js']) {
    if (byPath.has(clean + extName)) return clean + extName;
  }
  return null;
}

/** DFS cycle detection over the import graph (dedup by sorted member set). */
export function findImportCycles(nodes: string[], edges: { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const cycles: string[][] = [];
  const seenKeys = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): void => {
    state.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) {
        const idx = stack.indexOf(m);
        const cyc = stack.slice(idx);
        const key = [...cyc].sort().join('|');
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cycles.push(cyc);
        }
      } else if (!state.get(m)) {
        visit(m);
      }
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of nodes) if (!state.get(n)) visit(n);
  return cycles;
}

/** Full analysis pass; deterministic so tests need no provider. */
export function analyzeRepoFiles(files: AnalyzerFile[]): StructureIndex {
  const languages: Record<string, number> = {};
  const per_file: Record<string, { loc: number; functions: number }> = {};
  const functions: FunctionMetric[] = [];
  let loc = 0;
  for (const f of files) {
    const lang = LANG_BY_EXT[ext(f.path)] ?? 'other';
    languages[lang] = (languages[lang] ?? 0) + 1;
    const fLoc = f.content.split('\n').filter((l) => l.trim().length > 0).length;
    loc += fLoc;
    const fns = isCodeFile(f.path) && (lang === 'typescript' || lang === 'javascript') ? extractFunctions(f.path, f.content) : [];
    functions.push(...fns);
    per_file[f.path] = { loc: fLoc, functions: fns.length };
  }
  return { files: files.length, languages, loc, functions, duplicates: findDuplicates(files), imports: buildImportGraph(files), per_file };
}

/** Compact JSON for the jsonb column (top offenders only, capped). */
export function structureIndexJson(idx: StructureIndex): Record<string, unknown> {
  const longFns = idx.functions.filter((f) => f.lines > 50 || f.complexity > 10 || f.params > 5).slice(0, 500);
  return {
    files: idx.files,
    languages: idx.languages,
    loc: idx.loc,
    functions: longFns,
    function_count: idx.functions.length,
    duplicates: idx.duplicates.slice(0, 500),
    imports: {
      edges: idx.imports.edges.length,
      cycles: idx.imports.cycles.slice(0, 100),
      high_fan_in: Object.entries(idx.imports.fan_in).filter(([, v]) => v >= 3).slice(0, 200),
      high_fan_out: Object.entries(idx.imports.fan_out).filter(([, v]) => v >= 3).slice(0, 200),
    },
  };
}

/**
 * Partition a file list for staged analysis (plan §10.6.4): deterministic
 * order (top-level directory, then path) filled into batches of at most
 * `maxFilesPerRun`; a large directory is split across batches. The run cursor
 * advances batch by batch until the whole repo is covered.
 */
export function partitionFiles(files: AnalyzerFile[], maxFilesPerRun: number): { groups: string[][]; order: string[] } {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '(root)';
    groups.set(top, [...(groups.get(top) ?? []), f.path]);
  }
  const order = [...groups.keys()].sort();
  const orderedPaths = order.flatMap((g) => (groups.get(g) ?? []).sort());
  const batches: string[][] = [];
  for (let i = 0; i < orderedPaths.length; i += maxFilesPerRun) {
    batches.push(orderedPaths.slice(i, i + maxFilesPerRun));
  }
  return { groups: batches, order };
}

export function selectFiles(files: AnalyzerFile[], paths: string[]): AnalyzerFile[] {
  const set = new Set(paths);
  return files.filter((f) => set.has(f.path));
}
