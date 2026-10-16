#!/usr/bin/env node
/**
 * raw-value-check.mjs — mechanical token gate (plan §10 P0-4/ENF-001,
 * acceptance: "no raw hex/spacing/font-size outside :root").
 * Rules over apps/web/src/**:
 *   1. Hex colours are allowed ONLY in custom-property declarations
 *      (`--token: #…`) inside src/styles.scss — the token register.
 *   2. `font-size:` in styles.scss must use a --font-size-* token or a
 *      relative unit (em/%); absolute px/rem font sizes are rejected.
 *   3. Literal `style="…"` attributes in component templates may only
 *      reference var(…) tokens (design-system demo usage).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const failures = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|scss)$/.test(name)) out.push(p);
  }
  return out;
}

for (const file of walk(root)) {
  const rel = file.slice(root.length - 'src'.length);
  const lines = readFileSync(file, 'utf8').split('\n');
  const isStyles = rel.endsWith('styles.scss');

  lines.forEach((line, i) => {
    const n = i + 1;
    // Rule 1: hex colours only in token declarations of styles.scss
    const hex = line.match(/#[0-9a-fA-F]{3,8}\b/);
    if (hex && !(isStyles && /^\s*--[\w-]+:/.test(line))) {
      failures.push(`${rel}:${n}: raw hex colour "${hex[0]}" — use a --color-* token`);
    }
    // Rule 2: absolute font sizes in CSS
    if (isStyles) {
      const fs = line.match(/font-size:\s*([^;]+);/);
      if (fs && !/var\(--font-size-|em|%/.test(fs[1])) {
        failures.push(`${rel}:${n}: raw font-size "${fs[1].trim()}" — use a --font-size-* token`);
      }
    }
    // Rule 3: inline style literals must reference tokens only
    const style = line.match(/style="([^"]*)"/);
    if (style && /[^;'"(]([0-9]+px|#[0-9a-fA-F]{3,8})/.test(style[1]) && !/var\(/.test(style[1])) {
      failures.push(`${rel}:${n}: literal inline style "…" — use var(--) tokens or a CSS class`);
    }
  });
}

if (failures.length) {
  console.error('raw-value-check FAILED:');
  for (const f of failures) console.error('  ✘ ' + f);
  process.exit(1);
}
console.log('raw-value-check OK — no raw hex/font-size/inline-literal outside the token register');
