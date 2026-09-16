import { log } from '@statpulse/core';
import { UptimeRollup, DailyRollup } from '@statpulse/core/models';

/**
 * Fold hourly buckets into daily ones.
 *
 * Runs nightly. The hourly buckets expire after ninety days; these keep
 * thirteen months, so a ninety-day uptime figure is 90 documents instead
 * of 2,160 and a year-over-year question is answerable at all.
 *
 * Recomputed from source rather than incremented, which makes it
 * idempotent by construction: running it twice, or re-running it after a
 * late flush has added samples to a day, produces the right answer both
 * times. An $inc-based version would have needed the same watermark
 * machinery as the flusher, for a job that has all the source data
 * sitting in front of it.
 */

const DAY_MS = 24 * 3_600_000;

export function startOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * @param days  how many complete days back to recompute
 *
 * Two by default, not one. A flush landing at 00:03 carries samples
 * belonging to yesterday, so a job that only ever recomputed the day
 * just ended would miss them - permanently, since it never looks back.
 */
export async function rollupDaily({ days = 2, now = Date.now() } = {}) {
  const today = startOfDay(now);
  const from = new Date(today.getTime() - days * DAY_MS);

  const hourly = await UptimeRollup.find({
    bucket: { $gte: from, $lt: today },
  }).lean();

  if (hourly.length === 0) {
    log.debug('nothing to roll up', { from: from.toISOString() });
    return { days: 0, components: 0 };
  }

  const byDay = new Map();

  for (const h of hourly) {
    const day = startOfDay(h.bucket);
    const key = `${h.componentId}:${day.getTime()}`;

    if (!byDay.has(key)) {
      byDay.set(key, {
        orgId: h.orgId,
        componentId: h.componentId,
        day,
        total: 0,
        ok: 0,
        degraded: 0,
        down: 0,
        sumMs: 0,
        maxMs: 0,
        hoursCovered: 0,
      });
    }

    const d = byDay.get(key);
    d.total += h.total;
    d.ok += h.ok;
    d.degraded += h.degraded;
    d.down += h.down;
    d.sumMs += h.sumMs;
    d.maxMs = Math.max(d.maxMs, h.maxMs);
    if (h.total > 0) d.hoursCovered += 1;
  }

  const rows = [...byDay.values()];

  await DailyRollup.bulkWrite(
    rows.map((d) => ({
      updateOne: {
        filter: { orgId: d.orgId, componentId: d.componentId, day: d.day },
        // $set, not $inc. The totals are the whole day recomputed from
        // the hourly buckets, so writing them twice writes the same
        // answer twice.
        update: { $set: d },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  log.info('rolled up daily uptime', { rows: rows.length, from: from.toISOString() });
  return { days, rows: rows.length };
}
