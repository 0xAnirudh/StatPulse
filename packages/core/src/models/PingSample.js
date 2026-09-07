import mongoose from 'mongoose';
import { ERROR_CLASS } from '@statpulse/shared';

/**
 * One health check, as recorded.
 *
 * These arrive in batches from the flusher, never one at a time from the
 * checker - 50 components on a one-minute interval is 72,000 of these a
 * day, and writing them individually is the disk I/O the write-behind
 * buffer exists to eliminate.
 *
 * A regular collection, not a time-series one, and that is a deliberate
 * trade. Time-series would compress this shape better and is the obvious
 * fit - but time-series collections do not support unique indexes, and
 * the _id trick below is what makes the flusher safe to retry. Storage
 * is cheap at 7MB a day; a uptime figure that is quietly wrong after a
 * crash is not.
 */

const pingSampleSchema = new mongoose.Schema(
  {
    /**
     * The Redis stream entry id this sample came from.
     *
     * Consumer groups are at-least-once: a flusher that dies between
     * writing and acknowledging will be handed the same entries again.
     * Keying on the stream id means the retry re-inserts the same
     * documents and collides, and an unordered bulk insert simply skips
     * the duplicates. Exactly-once effect, no coordination.
     */
    _id: { type: String },

    ts: { type: Date, required: true },
    componentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Component', required: true },
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },

    ok: { type: Boolean, required: true },
    statusCode: Number,
    responseMs: Number,
    errorClass: { type: String, enum: [...Object.values(ERROR_CLASS), null], default: null },
  },
  { versionKey: false },
);

// Per-component history, newest first.
pingSampleSchema.index({ componentId: 1, ts: -1 });

/**
 * Ninety days, enforced by Mongo rather than by a cron job nobody
 * remembers to run. Anything older is served from the rollups, which are
 * three orders of magnitude smaller.
 */
pingSampleSchema.index({ ts: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const PingSample = mongoose.model('PingSample', pingSampleSchema);
