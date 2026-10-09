import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsRegistry } from './metrics';

/**
 * Plan §14 observability: Prometheus text exposition, dependency-free.
 * A test registry instance here — the process-wide default is wired by the api.
 */
let m: MetricsRegistry;
beforeEach(() => {
  m = new MetricsRegistry();
});

describe('MetricsRegistry (plan §14)', () => {
  it('increments named counters with sorted, escaped labels', () => {
    m.inc('http_requests_total', { route: '/a', method: 'GET' }, 1);
    m.inc('http_requests_total', { method: 'GET', route: '/a' }, 2); // order-insensitive
    m.inc('http_requests_total', { route: '/b', method: 'POST' }, 1);
    const out = m.prometheus();
    expect(out).toContain('http_requests_total{method="GET",route="/a"} 3');
    expect(out).toContain('http_requests_total{method="POST",route="/b"} 1');
  });

  it('escapes quotes and backslashes in label values', () => {
    m.inc('x_total', { weird: 'a"b\\c' }, 1);
    expect(m.prometheus()).toContain('x_total{weird="a\\"b\\\\c"} 1');
  });

  it('rejects invalid metric names', () => {
    expect(() => m.inc('not a name', {}, 1)).toThrow(/invalid metric name/);
  });

  it('help + type lines are emitted once per family', () => {
    m.counter('api_jobs_failed', 'Failed jobs', {});
    m.inc('api_jobs_failed', {}, 1);
    const out = m.prometheus();
    expect(out.match(/# HELP api_jobs_failed/g)).toHaveLength(1);
    expect(out).toContain('# TYPE api_jobs_failed counter');
  });

  it('gauges are set (not accumulated) and appear without labels map when empty', () => {
    m.gauge('queue_length', 17);
    m.gauge('queue_length', 3);
    const out = m.prometheus();
    expect(out).toContain('# TYPE queue_length gauge');
    expect(out).toContain('queue_length 3');
    expect(out).not.toContain('queue_length 17');
  });

  it('observes histograms into buckets with _sum and _count', () => {
    m.setBuckets('http_request_duration_seconds', [0.1, 0.5, 1]);
    m.observe('http_request_duration_seconds', 0.05);
    m.observe('http_request_duration_seconds', 0.6);
    const out = m.prometheus();
    expect(out).toContain('# TYPE http_request_duration_seconds histogram');
    expect(out).toContain('http_request_duration_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('http_request_duration_seconds_bucket{le="0.5"} 1');
    expect(out).toContain('http_request_duration_seconds_bucket{le="1"} 2');
    expect(out).toContain('http_request_duration_seconds_bucket{le="+Inf"} 2');
    expect(out).toContain('http_request_duration_seconds_count 2');
    expect(out).toMatch(/http_request_duration_seconds_sum 0\.65/);
  });

  it('resets all series (test isolation helper)', () => {
    m.inc('a_total', {}, 1);
    m.gauge('b', 2);
    m.reset();
    expect(m.prometheus()).toBe('');
  });
});
