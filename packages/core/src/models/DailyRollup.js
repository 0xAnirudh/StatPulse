import mongoose from 'mongoose';

/**
 * One day of checks for one component.
 *
 * A separate collection rather than another granularity inside
 * UptimeRollup, and that is a deliberate choice about the index. The
 * hourly bucket for midnight and the daily bucket for that same day are
 * both `2026-09-16T00:00:00Z`, so they would collide on the unique
 * (orgId, componentId, bucket) index - and the fix, adding a
 * `granularity` discriminator, means migrating an index that the flusher
 * writes through on its hot path. A second collection costs nothing and
 * cannot collide.
 *
 * Kept for thirteen months, against ninety days for the hourly buckets.
 * A ninety-day uptime figure is then 90 documents rather than 2,160, and
 * a year-over-year question is answerable at all.
 */

const dailyRollupSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    componentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Component', required: true },

    /** Midnight UTC of the day being summarised. */
    day: { type: Date, required: true },

    total: { type: Number, default: 0 },
    ok: { type: Number, default: 0 },
    degraded: { type: Number, default: 0 },
    down: { type: Number, default: 0 },
    sumMs: { type: Number, default: 0 },
    maxMs: { type: Number, default: 0 },

    /**
     * How many of the day's 24 hours had any samples at all.
     *
     * A day assembled from three hours of data is not a day, and an
     * uptime figure computed from it should be read with that in mind.
     * Recording it means the distinction survives into the chart instead
     * of being quietly averaged away.
     */
    hoursCovered: { type: Number, default: 0 },
  },
  { timestamps: true },
);

dailyRollupSchema.index({ orgId: 1, componentId: 1, day: -1 }, { unique: true });

/**
 * Thirteen months. Long enough to answer "how were we doing this time
 * last year", short enough that nobody has to think about it.
 */
dailyRollupSchema.index({ day: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

export const DailyRollup = mongoose.model('DailyRollup', dailyRollupSchema);
