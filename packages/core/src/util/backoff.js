/**
 * Exponential backoff with full jitter.
 *
 * The jitter is not decoration. Several processes start at once on a
 * deploy, and if a store is briefly down they all fail at the same
 * moment. Without jitter they then retry in lockstep forever, arriving
 * as a synchronised thundering herd exactly when the store is trying to
 * recover. Randomising each delay spreads them out.
 *
 * `random` is injectable so the spread can actually be tested rather
 * than assumed.
 */
export function backoffDelay(attempt, { base = 250, max = 30_000, random = Math.random } = {}) {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
  }
  // Cap the exponent before the shift, so a long outage cannot overflow
  // into a negative or absurd delay.
  const ceiling = Math.min(max, base * 2 ** Math.min(attempt, 31));
  return Math.floor(random() * ceiling);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
