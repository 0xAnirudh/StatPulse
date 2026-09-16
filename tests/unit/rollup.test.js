import { describe, it, expect } from 'vitest';
import { startOfDay } from '../../packages/jobs/src/rollup-daily.js';

describe('startOfDay', () => {
  it('truncates to midnight UTC', () => {
    expect(startOfDay('2026-09-16T13:47:31.482Z').toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });

  it('does not mutate its argument', () => {
    const original = new Date('2026-09-16T13:47:31.482Z');
    startOfDay(original);
    expect(original.toISOString()).toBe('2026-09-16T13:47:31.482Z');
  });

  it('keeps a late-evening timestamp on its own day', () => {
    // The boundary that matters: a check at 23:59 UTC belongs to the day
    // ending, not the one starting. Local-time truncation would move it
    // for anyone east of Greenwich.
    expect(startOfDay('2026-09-16T23:59:59.999Z').toISOString()).toBe('2026-09-16T00:00:00.000Z');
    expect(startOfDay('2026-09-17T00:00:00.000Z').toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });
});
