import type { PlanContent, ValidationReport } from '@forgepm/shared';

/**
 * Deterministic plan validation (plan §7.4): no dependency cycle, unique
 * temp_ids, >=1 AC per Feature, item count <= cap, no duplicate titles within
 * a Feature. Similarity warnings against existing items are added by the
 * caller via `similarWarning`.
 */
export function validatePlan(content: PlanContent, maxItems = 200): ValidationReport {
  const allItems: { temp_id: string; title: string; depends_on: string[]; feature?: string }[] = [];
  const features = collectFeatures(content);
  const cycles: string[][] = [];
  const dupTempIds: string[] = [];
  const dupTitles: string[] = [];
  const warnings: string[] = [];

  const seen = new Set<string>();
  for (const f of features) {
    if (f.acceptance_criteria.length < 1) warnings.push(`feature '${f.key}' has no acceptance criteria`);
    const titles = new Map<string, number>();
    for (const wi of f.work_items) {
      if (seen.has(wi.temp_id)) dupTempIds.push(wi.temp_id);
      seen.add(wi.temp_id);
      titles.set(wi.title, (titles.get(wi.title) ?? 0) + 1);
      allItems.push({ temp_id: wi.temp_id, title: wi.title, depends_on: wi.depends_on, feature: f.key });
    }
    for (const [t, n] of titles) if (n > 1) dupTitles.push(t);
  }
  for (const wi of content.work_items) {
    if (seen.has(wi.temp_id)) dupTempIds.push(wi.temp_id);
    seen.add(wi.temp_id);
    allItems.push({ temp_id: wi.temp_id, title: wi.title, depends_on: wi.depends_on });
  }

  const cyc = detectCycle(allItems);
  cycles.push(...cyc);

  if (allItems.length > maxItems) warnings.push(`item count ${allItems.length} exceeds cap ${maxItems}`);

  const ok = cycles.length === 0 && dupTempIds.length === 0 && allItems.length <= maxItems;
  return {
    ok,
    cycles,
    duplicate_temp_ids: [...new Set(dupTempIds)],
    duplicate_titles: [...new Set(dupTitles)],
    warnings,
    item_count: allItems.length,
  };
}

function collectFeatures(content: PlanContent): PlanContent['features'] {
  return [...content.features, ...content.milestones.flatMap((m) => m.features)];
}

function detectCycle(items: { temp_id: string; depends_on: string[] }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const it of items) adj.set(it.temp_id, it.depends_on);
  const cycles: string[][] = [];
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string): void => {
    const c = color.get(node);
    if (c === 2) return;
    if (c === 1) {
      const idx = stack.indexOf(node);
      if (idx >= 0) cycles.push([...stack.slice(idx), node]);
      return;
    }
    color.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (adj.has(next)) visit(next);
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const it of items) visit(it.temp_id);
  return cycles;
}

/** Trigram-based similarity used for near-duplicate warnings (>=0.85). */
export function similarity(a: string, b: string): number {
  const A = trigrams(a.toLowerCase());
  const B = trigrams(b.toLowerCase());
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  const padded = `  ${s}  `;
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}
