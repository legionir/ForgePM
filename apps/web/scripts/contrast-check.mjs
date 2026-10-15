#!/usr/bin/env node
/**
 * contrast-check.mjs — mechanical WCAG 2.1 gate for the design tokens
 * (plan §10 P5-3 / RSP-004). Parses the token registers from src/styles.scss
 * (light `:root` + dark blocks), then asserts contrast ratios for every
 * text colour on both backgrounds in BOTH themes:
 *   ≥ 4.5:1  normal-size text tokens (fg, muted, accent, error, ok,
 *            warning, info) and on-accent vs accent
 *   ≥ 3.0:1  focus ring (accent) vs page background
 * The repo's Playwright axe run (e2e/chain.spec.ts §11) covers rendered
 * pages in CI; this script additionally pins the token values themselves so
 * a bad palette can never be committed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scss = readFileSync(join(root, 'src/styles.scss'), 'utf8');

const expand = (h) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h);
const hexRe = /--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g;
const darkSplit = scss.indexOf('@media (prefers-color-scheme: dark)');

const light = {};
for (const m of scss.slice(0, darkSplit).matchAll(hexRe)) light[m[1]] = expand(m[2]);

const darkSection = scss.slice(darkSplit);
const darkOverrides = {};
for (const m of darkSection.matchAll(hexRe)) darkOverrides[m[1]] = expand(m[2]);
const dark = { ...light, ...darkOverrides };

function parseHex(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}
function channel(c) {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const textTokens = ['color-fg', 'color-muted', 'color-accent', 'color-error', 'color-ok', 'color-warning', 'color-info'];
const failures = [];
const report = [];

for (const theme of ['light', 'dark']) {
  const t = theme === 'light' ? light : dark;
  for (const bgName of ['color-bg', 'color-surface']) {
    for (const tk of textTokens) {
      const r = ratio(t[tk], t[bgName]);
      report.push(`${theme}/${tk} on ${bgName}: ${r.toFixed(2)}`);
      if (r < 4.5) failures.push(`${theme}: ${tk} (${t[tk]}) on ${bgName} (${t[bgName]}) = ${r.toFixed(2)} < 4.5`);
    }
  }
  const onAccent = ratio(t['color-on-accent'], t['color-accent']);
  report.push(`${theme}/on-accent on accent: ${onAccent.toFixed(2)}`);
  if (onAccent < 4.5) failures.push(`${theme}: on-accent (${t['color-on-accent']}) on accent (${t['color-accent']}) = ${onAccent.toFixed(2)} < 4.5`);
  const focus = ratio(t['color-accent'], t['color-bg']);
  report.push(`${theme}/focus ring: ${focus.toFixed(2)}`);
  if (focus < 3) failures.push(`${theme}: focus ring accent (${t['color-accent']}) vs bg (${t['color-bg']}) = ${focus.toFixed(2)} < 3`);
}

if (failures.length) {
  console.error('contrast-check FAILED:');
  for (const f of failures) console.error('  ✘ ' + f);
  process.exit(1);
}
console.log(`contrast-check OK — ${report.length} pairs ≥ threshold in light + dark`);
