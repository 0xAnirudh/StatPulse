import mongoose from 'mongoose';
import { COMPONENT_STATUS, COMPONENT_TYPES } from '@statpulse/shared';

/**
 * A monitored service.
 *
 * The status field here is the authoritative one, and it is written only
 * when a component actually transitions - a few times a month, not the
 * 1,440 times a day it is checked. Everything that changes on every
 * check (latency, last-checked time, failure counters) lives in Redis.
 * See the ping worker for why.
 */

const componentSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },

    name: { type: String, required: true, trim: true },

    /**
     * The public identifier.
     *
     * Not the ObjectId. Exposing those leaks insertion order and rough
     * creation times to anyone reading the status page, and it welds the
     * public API to the current database - re-seeding or migrating would
     * break every bookmark and every subscriber's saved reference.
     */
    slug: { type: String, required: true, lowercase: true, trim: true },

    description: { type: String, trim: true, maxlength: 500 },

    /** Display grouping: "Core", "Dashboard", "Third-party". */
    group: { type: String, trim: true },

    type: { type: String, enum: COMPONENT_TYPES, required: true },

    /**
     * What gets fetched.
     *
     * Admin-supplied, and therefore the most dangerous field in the
     * schema: this server fetches it from inside the production network
     * on a timer. It is validated against the SSRF rules on write and
     * again at request time, because DNS can change in between.
     */
    targetUrl: { type: String, required: true },

    method: { type: String, enum: ['GET', 'HEAD'], default: 'GET' },

    /**
     * Per-component thresholds.
     *
     * A 200ms database and a 3s report builder cannot share one
     * definition of "slow", and a component that legitimately answers
     * 401 to an unauthenticated probe is not down.
     */
    expectedStatusCodes: { type: [Number], default: [200, 201, 204] },
    timeoutMs: { type: Number, default: 5_000, min: 1_000, max: 15_000 },
    degradedAboveMs: { type: Number, default: 1_000, min: 1 },
    checkIntervalSec: { type: Number, default: 60, min: 30, max: 3_600 },

    status: {
      type: String,
      enum: Object.values(COMPONENT_STATUS),
      default: COMPONENT_STATUS.OPERATIONAL,
    },
    statusChangedAt: Date,

    /**
     * Snapshots, written by the flusher every ten minutes rather than by
     * the checker every minute. Accurate to within one flush interval,
     * which is all anything reads them for.
     */
    lastCheckedAt: Date,
    responseTimeMs: Number,

    /** Paused: excluded from checks, history kept. */
    isActive: { type: Boolean, default: true },

    /** You monitor things you do not advertise. */
    isPublic: { type: Boolean, default: true },

    displayOrder: { type: Number, default: 0 },

    /**
     * Soft delete.
     *
     * A hard delete would orphan ninety days of uptime history, and
     * uptime history is the thing customers quote back at you in a
     * renewal conversation.
     */
    deletedAt: Date,
  },
  { timestamps: true },
);

componentSchema.index({ orgId: 1, slug: 1 }, { unique: true });
// The ping sweep's query: every active component, once a minute.
componentSchema.index({ orgId: 1, isActive: 1, deletedAt: 1 });
// The public page's query, already in display order.
componentSchema.index({ orgId: 1, isPublic: 1, displayOrder: 1 });

export const Component = mongoose.model('Component', componentSchema);
