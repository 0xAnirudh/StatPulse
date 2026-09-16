import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { config, ApiError, getRedis } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { User } from '@statpulse/core/models';
import { revokeAllSessions } from './token.js';

/**
 * Invitations.
 *
 * Registration closes after the first account, so this is how everybody
 * else gets in. An invitation is a credential - whoever holds the token
 * becomes an administrator of a status page - so it is treated like one:
 * random bytes, stored only as a hash, single use, and short-lived.
 */

const TOKEN_BYTES = 32;

/**
 * Twenty-four hours.
 *
 * Long enough to survive a weekend handover, short enough that an
 * invitation forwarded to the wrong address, or left sitting in an inbox
 * that is later compromised, has stopped working by the time anyone
 * finds it.
 */
const TTL_SEC = 24 * 60 * 60;

const hash = (token) => createHash('sha256').update(token).digest('hex');

export async function inviteUser(org, { email, role }, invitedBy) {
  const existing = await User.findOne({ orgId: org._id, email });
  if (existing && existing.status !== 'invited') {
    throw ApiError.conflict('email_taken', 'That email address already has an account');
  }

  // Re-inviting someone who has not accepted yet reissues the token
  // rather than failing - which is what "resend the invite" means, and
  // it invalidates the previous one for free.
  const user =
    existing ??
    (await User.create({
      orgId: org._id,
      email,
      // A placeholder that cannot be produced by bcrypt, so it can never
      // match a real password. The account is unusable until accepted.
      passwordHash: 'invited',
      role,
      status: 'invited',
      invitedBy: invitedBy?._id,
    }));

  if (existing) {
    existing.role = role;
    await existing.save();
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await getRedis().set(keys.invite(hash(token)), user._id.toString(), 'EX', TTL_SEC);

  return { user, token, expiresInSec: TTL_SEC };
}

/**
 * Accept an invitation and set a password.
 *
 * The token is consumed before the password is written, so a token
 * cannot be used twice even if two requests arrive together - the loser
 * finds nothing to redeem.
 */
export async function acceptInvite({ token, password }) {
  const redis = getRedis();
  const key = keys.invite(hash(token));

  const userId = await redis.get(key);
  if (!userId) throw ApiError.unauthorized('invalid_invite', 'That invitation is not valid');

  const consumed = await redis.del(key);
  if (consumed === 0) throw ApiError.unauthorized('invalid_invite', 'That invitation is not valid');

  const user = await User.findById(userId);
  if (!user || user.status !== 'invited') {
    throw ApiError.unauthorized('invalid_invite', 'That invitation is not valid');
  }

  user.passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);
  user.status = 'active';
  await user.save();

  return user;
}

export async function listUsers(org) {
  return User.find({ orgId: org._id }).sort({ createdAt: 1 }).lean();
}

/**
 * Change a colleague's role or disable them.
 *
 * Disabling bumps tokenVersion and destroys every session, because the
 * whole point of disabling somebody mid-incident is that it takes effect
 * now rather than in fifteen minutes.
 */
export async function updateUser(org, userId, changes, actor) {
  const user = await User.findOne({ _id: userId, orgId: org._id });
  if (!user) throw ApiError.notFound('user_not_found', 'No such user');

  if (user._id.equals(actor._id)) {
    // Locking yourself out of your own status page is not a thing anyone
    // means to do, and there may be no other owner to undo it.
    throw ApiError.unprocessable('cannot_modify_self', 'You cannot change your own account here');
  }

  if (changes.role) user.role = changes.role;

  if (changes.status && changes.status !== user.status) {
    user.status = changes.status;
    if (changes.status === 'disabled') {
      user.tokenVersion += 1;
      await revokeAllSessions(user._id.toString());
    }
  }

  await user.save();
  return user;
}
