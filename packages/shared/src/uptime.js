/**
 * Uptime arithmetic over pre-aggregated buckets.
 *
 * Each bucket is one hour for one component and satisfies
 * `ok + degraded + down === total`, where "degraded" means the check
 * succeeded but was slower than the component's threshold.
 */

/**
 * Sum a set of buckets into a percentage.
 *
 * Returns null rather than 100 when there is nothing to measure. A
 * component that has never been checked has unknown uptime, and printing
 * "100%" for it is a lie of exactly the kind a status page cannot afford
 * - it is the number a customer quotes back during a renewal.
 *
 * Empty buckets contribute nothing to either side of the fraction. A
 * window in which the checker itself was down is a gap in our
 * observation, not downtime on the customer's part, and counting it as
 * an outage would make this a measure of our reliability rather than
 * theirs.
 */
export function uptimePercent(buckets, { degradedCountsAsUp = true } = {}) {
  let total = 0;
  let up = 0;

  for (const b of buckets) {
    total += b.total ?? 0;
    up += (b.ok ?? 0) + (degradedCountsAsUp ? (b.degraded ?? 0) : 0);
  }

  if (total === 0) return null;
  // Two decimals: the difference between 99.98% and 99.9812% is noise,
  // but the difference between 99.9% and 100% is a conversation.
  return Number(((up / total) * 100).toFixed(2));
}

/** Mean response time across buckets, or null when nothing was measured. */
export function meanResponseMs(buckets) {
  let total = 0;
  let sum = 0;
  for (const b of buckets) {
    total += b.total ?? 0;
    sum += b.sumMs ?? 0;
  }
  return total === 0 ? null : Math.round(sum / total);
}

/** The UTC hour a timestamp belongs to. The bucket key everywhere. */
export function hourBucket(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}
