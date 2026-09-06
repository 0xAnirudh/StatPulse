import mongoose from 'mongoose';

/**
 * A tenant.
 *
 * There is exactly one of these in v1, seeded at bootstrap, and it would
 * be fair to ask why it exists at all. The answer is that "status.acme.com"
 * is in the product description: the moment a second customer appears,
 * every query, every index and every cache key has to become
 * tenant-scoped. Retrofitting that is a migration plus an audit of every
 * find() in the codebase for the one that forgot its filter, and the
 * failure mode of forgetting is showing one customer another customer's
 * outage.
 *
 * Carrying orgId from the first commit costs one field and one index
 * column. That is the whole cost, paid once, up front.
 */

const organizationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    /** Public identifier, and the org half of every cache key. */
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]+$/, 'Slug may contain only lowercase letters, numbers and hyphens'],
    },

    /**
     * The hostnames this org's public status page answers on.
     *
     * Public routes resolve the tenant from the Host header, because a
     * visitor to status.acme.com has no token to carry an org id in.
     */
    hosts: { type: [String], default: [] },

    timezone: { type: String, default: 'UTC' },

    settings: {
      defaultCheckIntervalSec: { type: Number, default: 60 },
      publicUptimeWindowDays: { type: Number, default: 90 },
    },
  },
  { timestamps: true },
);

organizationSchema.index({ hosts: 1 });

export const Organization = mongoose.model('Organization', organizationSchema);
