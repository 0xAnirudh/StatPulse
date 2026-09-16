import mongoose from 'mongoose';

/**
 * An administrator.
 *
 * Only staff have accounts. Visitors to a status page never sign in -
 * the entire public surface is unauthenticated, which is what lets it be
 * cached so aggressively.
 */

const userSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    email: { type: String, required: true, lowercase: true, trim: true },

    /**
     * Never selected by default.
     *
     * A route that does `res.json(user)` is a mistake someone will make
     * eventually. Two independent guards stop it from mattering: the
     * field is not loaded unless asked for, and the toJSON transform
     * below strips it if it ever is.
     */
    passwordHash: { type: String, required: true, select: false },

    role: { type: String, enum: ['owner', 'admin'], default: 'admin' },
    status: { type: String, enum: ['active', 'invited', 'disabled'], default: 'active' },

    /**
     * Bumped to invalidate every access token this user holds.
     *
     * Access tokens are not checked against a store on the request path,
     * so there is otherwise no way to disable an account faster than the
     * fifteen-minute expiry. The version is carried as a claim and
     * compared on each request; a mismatch rejects immediately.
     */
    tokenVersion: { type: Number, default: 0 },

    lastLoginAt: Date,

    /** Who let them in. Useful the day somebody asks how an account exists. */
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Unique per organization, not globally: two tenants may legitimately
// have an administrator with the same address.
userSchema.index({ orgId: 1, email: 1 }, { unique: true });

/** What the account holder sees about themselves. */
userSchema.methods.toPrivate = function toPrivate() {
  return {
    id: this._id.toString(),
    email: this.email,
    role: this.role,
    status: this.status,
    memberSince: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
