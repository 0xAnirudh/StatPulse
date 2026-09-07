import mongoose from 'mongoose';

/**
 * One hour of checks for one component, pre-aggregated.
 *
 * Ninety days of raw samples is 130,000 documents per component. Asking
 * "what is the 90-day uptime" of that on every cache miss is a full scan
 * behind a page that promises a 50ms p99. These buckets make the same
 * question 2,160 tiny documents, and the daily rollups make it 90.
 */

const uptimeRollupSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
    componentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Component', required: true },

    /** Hour-truncated UTC. */
    bucket: { type: Date, required: true },

    total: { type: Number, default: 0 },
    ok: { type: Number, default: 0 },
    degraded: { type: Number, default: 0 },
    down: { type: Number, default: 0 },

    sumMs: { type: Number, default: 0 },
    maxMs: { type: Number, default: 0 },

    /**
     * The highest stream id folded into this bucket so far.
     *
     * The increments above are not idempotent - applying a redelivered
     * batch twice would inflate the totals, and uptime figures end up in
     * contracts. Every increment is conditional on the incoming batch
     * being newer than this watermark, so a replay matches no document
     * and changes nothing.
     *
     * Redis stream ids are monotonic and lexicographically ordered, so a
     * string comparison is a valid ordering.
     */
    lastStreamId: { type: String, default: '0-0' },
  },
  { timestamps: true },
);

uptimeRollupSchema.index({ orgId: 1, componentId: 1, bucket: -1 }, { unique: true });

export const UptimeRollup = mongoose.model('UptimeRollup', uptimeRollupSchema);
