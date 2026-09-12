import { describe, it, expect } from 'vitest';
import { aggregate, parseEntry } from '../../packages/jobs/src/flush.worker.js';

const entry = (id, { component = 'c1', org = 'o1', ts, outcome = 'ok', ms = 100 }) => [
  id,
  [
    'c',
    component,
    'o',
    org,
    't',
    String(ts),
    'ok',
    outcome === 'fail' ? '0' : '1',
    'ms',
    String(ms),
    'sc',
    '200',
    'e',
    '',
    'out',
    outcome,
  ],
];

const AT = (iso) => new Date(iso).getTime();

describe('parseEntry', () => {
  it('reads the flat field array a stream hands back', () => {
    const parsed = parseEntry(entry('1757000000000-0', { ts: AT('2026-09-12T10:15:00Z') }));

    expect(parsed.id).toBe('1757000000000-0');
    expect(parsed.componentId).toBe('c1');
    expect(parsed.ok).toBe(true);
    expect(parsed.responseMs).toBe(100);
    expect(parsed.ts.toISOString()).toBe('2026-09-12T10:15:00.000Z');
  });
});

describe('aggregate', () => {
  it('folds a batch into one bucket per component per hour', () => {
    const buckets = aggregate(
      [
        entry('1-0', { ts: AT('2026-09-12T10:05:00Z') }),
        entry('2-0', { ts: AT('2026-09-12T10:45:00Z') }),
        entry('3-0', { ts: AT('2026-09-12T11:05:00Z') }),
      ].map(parseEntry),
    );

    expect(buckets).toHaveLength(2);
    expect(buckets[0].total).toBe(2);
    expect(buckets[1].total).toBe(1);
  });

  it('separates components that share an hour', () => {
    const buckets = aggregate(
      [
        entry('1-0', { component: 'a', ts: AT('2026-09-12T10:05:00Z') }),
        entry('2-0', { component: 'b', ts: AT('2026-09-12T10:06:00Z') }),
      ].map(parseEntry),
    );
    expect(buckets).toHaveLength(2);
  });

  it('keeps ok, degraded and down summing to total', () => {
    // The invariant every uptime percentage depends on.
    const buckets = aggregate(
      [
        entry('1-0', { ts: AT('2026-09-12T10:00:00Z'), outcome: 'ok' }),
        entry('2-0', { ts: AT('2026-09-12T10:01:00Z'), outcome: 'slow' }),
        entry('3-0', { ts: AT('2026-09-12T10:02:00Z'), outcome: 'fail' }),
        entry('4-0', { ts: AT('2026-09-12T10:03:00Z'), outcome: 'fail' }),
      ].map(parseEntry),
    );

    const [b] = buckets;
    expect(b.total).toBe(4);
    expect(b.ok).toBe(1);
    expect(b.degraded).toBe(1);
    expect(b.down).toBe(2);
    expect(b.ok + b.degraded + b.down).toBe(b.total);
  });

  it('carries the highest stream id as the watermark', () => {
    // What makes a redelivered batch a no-op rather than a double count.
    const buckets = aggregate(
      [
        entry('1757000000000-0', { ts: AT('2026-09-12T10:00:00Z') }),
        entry('1757000000000-5', { ts: AT('2026-09-12T10:01:00Z') }),
        entry('1757000000000-2', { ts: AT('2026-09-12T10:02:00Z') }),
      ].map(parseEntry),
    );

    expect(buckets[0].maxId).toBe('1757000000000-5');
  });

  it('accumulates latency for the mean and keeps the peak', () => {
    const buckets = aggregate(
      [
        entry('1-0', { ts: AT('2026-09-12T10:00:00Z'), ms: 100 }),
        entry('2-0', { ts: AT('2026-09-12T10:01:00Z'), ms: 300 }),
      ].map(parseEntry),
    );

    expect(buckets[0].sumMs).toBe(400);
    expect(buckets[0].maxMs).toBe(300);
  });

  it('handles an empty batch', () => {
    expect(aggregate([])).toEqual([]);
  });
});
