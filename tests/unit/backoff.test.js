import { describe, it, expect } from 'vitest';
import { backoffDelay } from '../../packages/core/src/util/backoff.js';

describe('backoffDelay', () => {
  it('grows the ceiling exponentially', () => {
    // random() pinned at its maximum, so the result is the ceiling
    // itself rather than a sample from under it.
    const atMax = (attempt) => backoffDelay(attempt, { random: () => 0.999999 });

    expect(atMax(0)).toBe(249);
    expect(atMax(1)).toBe(499);
    expect(atMax(2)).toBe(999);
    expect(atMax(3)).toBe(1_999);
  });

  it('never exceeds the cap however long the outage runs', () => {
    for (const attempt of [10, 20, 31, 40, 1_000]) {
      expect(backoffDelay(attempt, { random: () => 0.999999 })).toBeLessThan(30_000);
    }
  });

  it('spreads callers out rather than retrying in lockstep', () => {
    // The point of the jitter: a hundred processes retrying the same
    // attempt number must not all pick the same delay.
    const delays = new Set(Array.from({ length: 100 }, () => backoffDelay(5)));
    expect(delays.size).toBeGreaterThan(50);
  });

  it('refuses a nonsensical attempt rather than returning a nonsense delay', () => {
    expect(() => backoffDelay(-1)).toThrow(RangeError);
    expect(() => backoffDelay(1.5)).toThrow(RangeError);
  });
});
