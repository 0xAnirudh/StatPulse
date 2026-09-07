import { describe, it, expect } from 'vitest';
import { uptimePercent, meanResponseMs, hourBucket } from '../../packages/shared/src/index.js';

const bucket = (ok, degraded, down, sumMs = 0) => ({
  total: ok + degraded + down,
  ok,
  degraded,
  down,
  sumMs,
});

describe('uptimePercent', () => {
  it('is null when nothing has been measured', () => {
    // Not 100. A component nobody has checked has unknown uptime, and
    // printing a perfect score for it is the exact lie a status page
    // cannot afford - that number ends up in a renewal conversation.
    expect(uptimePercent([])).toBeNull();
    expect(uptimePercent([bucket(0, 0, 0)])).toBeNull();
  });

  it('counts a slow-but-answering check as up by default', () => {
    expect(uptimePercent([bucket(50, 50, 0)])).toBe(100);
    expect(uptimePercent([bucket(50, 50, 0)], { degradedCountsAsUp: false })).toBe(50);
  });

  it('sums across buckets rather than averaging their percentages', () => {
    // An hour with one sample and an hour with a thousand must not count
    // equally. Averaging percentages is the classic way to get this
    // wrong: it would report 50%, when 1 of 1001 checks failed.
    expect(uptimePercent([bucket(0, 0, 1), bucket(1000, 0, 0)])).toBe(99.9);
  });

  it('ignores hours in which nothing was recorded', () => {
    // The checker being down is a gap in our observation, not downtime
    // on the customer's side.
    const withGap = [bucket(60, 0, 0), bucket(0, 0, 0), bucket(60, 0, 0)];
    expect(uptimePercent(withGap)).toBe(100);
  });

  it('rounds to two decimals', () => {
    expect(uptimePercent([bucket(9998, 0, 2)])).toBe(99.98);
  });
});

describe('meanResponseMs', () => {
  it('weights by sample count, not by bucket', () => {
    expect(
      meanResponseMs([
        { total: 1, sumMs: 1000 },
        { total: 9, sumMs: 900 },
      ]),
    ).toBe(190);
  });

  it('is null with nothing to average', () => {
    expect(meanResponseMs([])).toBeNull();
  });
});

describe('hourBucket', () => {
  it('truncates to the UTC hour', () => {
    expect(hourBucket('2026-09-07T13:47:31.482Z').toISOString()).toBe('2026-09-07T13:00:00.000Z');
  });

  it('does not mutate its argument', () => {
    const original = new Date('2026-09-07T13:47:31.482Z');
    hourBucket(original);
    expect(original.toISOString()).toBe('2026-09-07T13:47:31.482Z');
  });
});
