import mongoose from 'mongoose';
import { INCIDENT_STATUS, INCIDENT_IMPACT } from '@statpulse/shared';

/**
 * A declared incident.
 *
 * The human half of the status page. Automated checks know that
 * something stopped answering; they do not know that payments are up but
 * settling to the wrong ledger, and they cannot write the sentence that
 * stops support drowning. An incident is where that goes.
 */

const updateSchema = new mongoose.Schema(
  {
    message: { type: String, required: true, trim: true, maxlength: 4_000 },
    status: { type: String, enum: Object.values(INCIDENT_STATUS), required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: true },
);

const incidentSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, lowercase: true, trim: true },

    status: {
      type: String,
      enum: Object.values(INCIDENT_STATUS),
      default: INCIDENT_STATUS.INVESTIGATING,
    },
    impact: {
      type: String,
      enum: Object.values(INCIDENT_IMPACT),
      default: INCIDENT_IMPACT.MINOR,
    },

    affectedComponents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Component' }],

    /**
     * The timeline, embedded rather than referenced.
     *
     * An unbounded array in a document is usually a mistake; here it is
     * not, because an incident has tens of updates and is read in its
     * entirety every time it is read at all. The cap exists anyway - a
     * single incident accumulating 200 updates is one that should have
     * been closed and reopened as a second incident, and the cap is what
     * makes someone do that rather than growing one document forever.
     */
    updates: {
      type: [updateSchema],
      validate: {
        validator: (v) => v.length <= 200,
        message: 'An incident may hold at most 200 updates. Open a follow-up incident instead.',
      },
    },

    startedAt: { type: Date, default: Date.now },

    /**
     * Null is the definition of "active", and it is the first field of
     * the index the public page hits on every cache miss.
     */
    resolvedAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// "Active incidents, newest first" - the hottest incident query there is.
incidentSchema.index({ orgId: 1, resolvedAt: 1, startedAt: -1 });
incidentSchema.index({ orgId: 1, slug: 1 }, { unique: true });
// History pagination.
incidentSchema.index({ orgId: 1, createdAt: -1 });

export const Incident = mongoose.model('Incident', incidentSchema);
