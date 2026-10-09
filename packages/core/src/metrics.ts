/**
 * Dependency-free Prometheus text-exposition registry (plan §14 observability).
 * Supports counters, gauges and histograms. Deliberately minimal: it covers the
 * request/latency/queue/failed-job/AI/MCP counters the plan names, with no new
 * runtime dependency (keeps the production tree lean and auditable).
 */
export type Labels = Record<string, string | number>;

type Family =
  | { kind: 'counter'; help: string; series: Map<string, { labels: Labels; value: number }> }
  | { kind: 'gauge'; help: string; value: number; labels: Labels }
  | { kind: 'histogram'; help: string; buckets: number[]; counts: number[]; sum: number; count: number };

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function fmtLabels(labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

function num(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Number.POSITIVE_INFINITY) return '+Inf';
  return String(v);
}

export class MetricsRegistry {
  private families = new Map<string, Family>();

  counter(name: string, help = name, labels: Labels = {}): void {
    this.assertName(name);
    let f = this.families.get(name);
    if (!f) {
      f = { kind: 'counter', help, series: new Map() };
      this.families.set(name, f);
    }
    if (f.kind !== 'counter') throw new Error(`metric ${name} already registered as ${f.kind}`);
    const key = labelKey(labels);
    if (!f.series.has(key)) f.series.set(key, { labels, value: 0 });
  }

  inc(name: string, labels: Labels = {}, value = 1): void {
    if (!this.families.has(name)) this.counter(name, name, labels);
    const f = this.families.get(name)!;
    if (f.kind !== 'counter') throw new Error(`metric ${name} is not a counter`);
    const key = labelKey(labels);
    const s = f.series.get(key) ?? { labels, value: 0 };
    s.value += value;
    f.series.set(key, s);
  }

  gauge(name: string, value: number, labels: Labels = {}): void {
    this.assertName(name);
    this.families.set(name, { kind: 'gauge', help: name, value, labels });
  }

  setBuckets(name: string, buckets: number[]): void {
    this.assertName(name);
    const sorted = [...buckets].sort((a, b) => a - b);
    if (!this.families.has(name)) {
      this.families.set(name, { kind: 'histogram', help: name, buckets: sorted, counts: sorted.map(() => 0), sum: 0, count: 0 });
    }
  }

  observe(name: string, value: number): void {
    let f = this.families.get(name);
    if (!f) {
      // default buckets if observe happens before setBuckets
      this.setBuckets(name, [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
      f = this.families.get(name)!;
    }
    if (f.kind !== 'histogram') throw new Error(`metric ${name} is not a histogram`);
    for (let i = 0; i < f.buckets.length; i++) {
      if (value <= f.buckets[i]) f.counts[i]++;
    }
    f.sum += value;
    f.count++;
  }

  reset(): void {
    this.families.clear();
  }

  prometheus(): string {
    const lines: string[] = [];
    for (const [name, f] of this.families) {
      lines.push(`# HELP ${name} ${f.help}`);
      if (f.kind === 'counter') {
        lines.push(`# TYPE ${name} counter`);
        for (const s of f.series.values()) lines.push(`${name}${fmtLabels(s.labels)} ${num(s.value)}`);
      } else if (f.kind === 'gauge') {
        lines.push(`# TYPE ${name} gauge`);
        lines.push(`${name}${fmtLabels(f.labels)} ${num(f.value)}`);
      } else {
        lines.push(`# TYPE ${name} histogram`);
        let cumulative = 0;
        for (let i = 0; i < f.buckets.length; i++) {
          cumulative = f.counts[i];
          lines.push(`${name}_bucket{le="${num(f.buckets[i])}"} ${cumulative}`);
        }
        lines.push(`${name}_bucket{le="+Inf"} ${f.count}`);
        lines.push(`${name}_sum ${num(f.sum)}`);
        lines.push(`${name}_count ${f.count}`);
      }
    }
    return lines.join('\n');
  }

  private assertName(name: string): void {
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
  }
}

/** Process-wide registry; the api installs its hooks against this instance. */
export const defaultRegistry = new MetricsRegistry();
