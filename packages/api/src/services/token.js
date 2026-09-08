import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config, log, getRedis } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';

/**
 * Tokens.
 *
 * Two of them, with deliberately different natures:
 *
 *   access  - a signed JWT, fifteen minutes, never checked against a
 *             store. Stateless is the point: the request path does no
 *             Redis round trip to authenticate.
 *
 *   refresh - thirty opaque random bytes, thirty days, checked against
 *             Redis on every use and rotated each time.
 *
 * The refresh token is deliberately NOT a JWT. A signed refresh token
 * still has to be looked up in Redis to know whether it has been
 * revoked, so the signature buys nothing - while its decodable payload
 * hands anyone who reads the cookie the user id and the org id for free.
 * Random bytes plus a server-side lookup is both simpler and tighter.
 */

const REFRESH_BYTES = 32;

/**
 * How long a rotated token stays recognisable.
 *
 * Long enough to absorb a client that retried a refresh whose response
 * it never received; short enough that a token replayed by anyone else
 * is caught. Sixty seconds is comfortably outside a retry window and
 * comfortably inside an attacker's.
 */
const USED_GRACE_SEC = 60;

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export function issueAccessToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      org: user.orgId.toString(),
      role: user.role,
      // The escape hatch for "disable this account now". Compared on
      // every request; a bump invalidates every token already issued.
      tv: user.tokenVersion ?? 0,
      jti: randomUUID(),
    },
    config.JWT_SECRET,
    { expiresIn: config.JWT_ACCESS_TTL },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.JWT_SECRET);
}

/**
 * Mint a refresh token and put it on the whitelist.
 *
 * Two structures, because two questions get asked. "Is this token
 * live?" is a lookup by hash. "What sessions does this user have, and
 * kill them all" is a lookup by user. Neither is derivable from the
 * other cheaply, so both are stored.
 */
export async function issueRefreshToken(user, { ip, userAgent, sessionId } = {}) {
  const token = randomBytes(REFRESH_BYTES).toString('base64url');
  const hash = hashToken(token);
  const ttlSec = config.REFRESH_TTL_DAYS * 24 * 60 * 60;
  const id = sessionId ?? randomUUID();

  const redis = getRedis();
  await redis
    .multi()
    .sadd(keys.sessionSet(user._id.toString()), hash)
    .expire(keys.sessionSet(user._id.toString()), ttlSec)
    .hset(keys.sessionToken(hash), {
      userId: user._id.toString(),
      orgId: user.orgId.toString(),
      sessionId: id,
      ip: ip ?? '',
      userAgent: (userAgent ?? '').slice(0, 200),
      createdAt: new Date().toISOString(),
    })
    .expire(keys.sessionToken(hash), ttlSec)
    .exec();

  return { token, hash, sessionId: id, expiresInSec: ttlSec };
}

export const REFRESH_OUTCOME = Object.freeze({
  OK: 'ok',
  UNKNOWN: 'unknown',
  REPLAYED: 'replayed',
});

/**
 * Look up a presented refresh token and consume it.
 *
 * Three outcomes, and the third is the one worth the machinery:
 *
 *   ok       - live token, now retired; the caller issues a new pair.
 *   unknown  - never existed, or expired. Ordinary 401.
 *   replayed - not live, but recently retired. Someone is using a token
 *              that was already exchanged, which means two parties hold
 *              it, which means one of them stole it. Every session for
 *              that user is destroyed and they log in again.
 *
 * Rotation is what makes replay detectable at all. Without it a stolen
 * refresh token is indistinguishable from the real one forever.
 */
export async function consumeRefreshToken(token) {
  const hash = hashToken(token);
  const redis = getRedis();

  const session = await redis.hgetall(keys.sessionToken(hash));
  if (!session || !session.userId) {
    const wasUsed = await redis.get(keys.sessionUsed(hash));
    if (wasUsed) {
      log.warn('refresh token replayed', { userId: wasUsed });
      await revokeAllSessions(wasUsed);
      return { outcome: REFRESH_OUTCOME.REPLAYED, userId: wasUsed };
    }
    return { outcome: REFRESH_OUTCOME.UNKNOWN };
  }

  await redis
    .multi()
    .srem(keys.sessionSet(session.userId), hash)
    .del(keys.sessionToken(hash))
    .set(keys.sessionUsed(hash), session.userId, 'EX', USED_GRACE_SEC)
    .exec();

  return { outcome: REFRESH_OUTCOME.OK, session };
}

/** Log out one session. An SREM and a DEL - no expiry to wait for. */
export async function revokeRefreshToken(token) {
  const hash = hashToken(token);
  const redis = getRedis();
  const session = await redis.hgetall(keys.sessionToken(hash));
  if (!session?.userId) return false;

  await redis
    .multi()
    .srem(keys.sessionSet(session.userId), hash)
    .del(keys.sessionToken(hash))
    .exec();
  return true;
}

/** Log out everywhere. Also the response to a detected replay. */
export async function revokeAllSessions(userId) {
  const redis = getRedis();
  const hashes = await redis.smembers(keys.sessionSet(userId));
  if (hashes.length === 0) return 0;

  const pipeline = redis.multi();
  for (const hash of hashes) pipeline.del(keys.sessionToken(hash));
  pipeline.del(keys.sessionSet(userId));
  await pipeline.exec();

  return hashes.length;
}

/** Everything currently live for one user, for the sessions screen. */
export async function listSessions(userId) {
  const redis = getRedis();
  const hashes = await redis.smembers(keys.sessionSet(userId));

  const sessions = await Promise.all(
    hashes.map(async (hash) => {
      const s = await redis.hgetall(keys.sessionToken(hash));
      if (!s?.sessionId) return null;
      return {
        id: s.sessionId,
        ip: s.ip || null,
        userAgent: s.userAgent || null,
        createdAt: s.createdAt,
      };
    }),
  );

  return sessions.filter(Boolean);
}

/** Revoke one session by its public id rather than by its secret. */
export async function revokeSessionById(userId, sessionId) {
  const redis = getRedis();
  const hashes = await redis.smembers(keys.sessionSet(userId));

  for (const hash of hashes) {
    const s = await redis.hgetall(keys.sessionToken(hash));
    if (s?.sessionId === sessionId) {
      await redis.multi().srem(keys.sessionSet(userId), hash).del(keys.sessionToken(hash)).exec();
      return true;
    }
  }
  return false;
}
