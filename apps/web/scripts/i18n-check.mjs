#!/usr/bin/env node
// npm run i18n:check — plan §11 gate "اسکریپت بررسی کلیدهای i18n": the fa key set
// must equal the en key set exactly (no untranslated UI in either locale) and
// every i18n.instant('key') literal used in sources must exist in both.
// Pure-node (no TS loader): the dictionaries are flat `export const X = {...}`
// object literals, parsed with a key regex — drift in shape fails loudly.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');

const dictKeys = (path) => {
  const src = readFileSync(path, 'utf8');
  const keys = [...src.matchAll(/^\s{2}'([^']+)':\s/gm)].map((m) => m[1]);
  if (keys.length === 0) throw new Error(`i18n:check: no keys parsed from ${path} — dictionary shape changed`);
  return keys;
};

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

const en = dictKeys(join(SRC, 'app', 'i18n', 'en.ts'));
const fa = dictKeys(join(SRC, 'app', 'i18n', 'fa.ts'));
const enSet = new Set(en);
const faSet = new Set(fa);
const problems = [];

for (const k of enSet) if (!faSet.has(k)) problems.push(`fa missing key: ${k}`);
for (const k of faSet) if (!enSet.has(k)) problems.push(`fa has unknown key: ${k}`);

const usedRe = /i18n\.instant\('([^']+)'/g;
for (const file of walk(SRC)) {
  if (file.includes(join('i18n')) || file.endsWith('i18n.ts')) continue;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(usedRe)) {
    if (!enSet.has(m[1])) problems.push(`${file}: key '${m[1]}' not in en`);
    if (!faSet.has(m[1])) problems.push(`${file}: key '${m[1]}' not in fa`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`i18n:check FAILED\n${problems.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`i18n:check OK — ${enSet.size} keys in parity, all usages defined\n`);
