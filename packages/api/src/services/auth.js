import bcrypt from 'bcrypt';
import { config, ApiError } from '@statpulse/core';
import { User, Organization } from '@statpulse/core/models';

/**
 * A hash of nothing in particular, compared against when a login names
 * an account that does not exist.
 *
 * Without it a missing email returns in under a millisecond while a real
 * one takes as long as bcrypt does, and that difference is a reliable
 * oracle for enumerating which addresses have accounts. Doing the work
 * anyway makes both paths cost the same.
 */
let decoyHash = null;
async function getDecoyHash() {
  decoyHash ??= await bcrypt.hash('decoy-password-never-matches', config.BCRYPT_ROUNDS);
  return decoyHash;
}

/**
 * Registration, open exactly once.
 *
 * The brief had this endpoint public. On an admin panel that means the
 * first stranger to find the URL becomes an administrator of someone
 * else's status page - and a status page is a publishing tool, so the
 * damage is telling that company's customers whatever you like.
 *
 * So it works while the organization has no users and refuses
 * afterwards. Further administrators arrive by invitation.
 */
export async function register({ email, password }, org) {
  const existing = await User.countDocuments({ orgId: org._id });
  if (existing > 0) {
    throw ApiError.forbidden(
      'registration_closed',
      'This organization already has an administrator. New accounts are created by invitation.',
    );
  }

  const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);

  try {
    // The first account owns the organization. There is nobody else to
    // grant it, and an org with no owner cannot invite anyone.
    return await User.create({
      orgId: org._id,
      email,
      passwordHash,
      role: 'owner',
      status: 'active',
    });
  } catch (err) {
    // Counting first and inserting second is a race: two simultaneous
    // registrations both see zero users and both proceed. The unique
    // index is the only thing that actually decides it.
    if (err.code === 11000) {
      throw ApiError.conflict('email_taken', 'That email address already has an account');
    }
    throw err;
  }
}

export async function authenticate({ email, password }, org) {
  const user = await User.findOne({ orgId: org._id, email }).select('+passwordHash');

  // Compare regardless of whether the account exists, so both paths take
  // the same time. The result of the decoy comparison is discarded.
  const hash = user ? user.passwordHash : await getDecoyHash();
  const matches = await bcrypt.compare(password, hash);

  if (!user || !matches) {
    // One message for both cases. Saying "no such account" versus "wrong
    // password" hands out a free enumeration oracle.
    throw ApiError.unauthorized('invalid_credentials', 'Email or password is incorrect');
  }

  if (user.status === 'disabled') {
    throw ApiError.forbidden('account_disabled', 'This account has been disabled');
  }

  user.lastLoginAt = new Date();
  await user.save();

  return user;
}

/** The single-tenant default, created on first use. */
export async function defaultOrganization() {
  return Organization.findOneAndUpdate(
    { slug: 'default' },
    { $setOnInsert: { name: 'StatPulse', slug: 'default', hosts: [] } },
    { upsert: true, returnDocument: 'after' },
  );
}
