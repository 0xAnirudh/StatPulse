import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import { config, log, getRedis, ApiError, increment } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';

/**
 * Rate limits.
 *
 * Each bucket names what it is protecting and who it counts. The two
 * things worth reading closely are the identity function below and the
 * failure policy at the bottom - the algorithm itself is in
 * lua/ratelimit.lua.
 */

export const BUCKETS = Object.freeze({
  /** Cheap because it is cached; generous so an outage does not throttle readers. */
  PUBLIC_STATUS: {
    name: 'public:status',
    limit: config.STATUS_RATE_LIMIT,
    windowMs: 60_000,
    failOpen: true,
  },

  /** Feeds a notification queue. The one endpoint a bot actually wants. */
  PUBLIC_SUBSCRIBE: { name: 'public:subscribe', limit: 5, windowMs: 60_000, failOpen: true },
  PUBLIC_SUBSCRIBE_DAY: {
    name: 'public:subscribe:day',
    limit: 20,
    windowMs: 86_400_000,
    failOpen: true,
  },

  /**
   * Two limiters on login, and both are necessary.
   *
   * Per-IP alone is defeated by a botnet spreading attempts across
   * thousands of addresses. Per-account alone is a denial-of-service
   * vector: anyone who knows an admin's email can lock them out by
   * failing to log in as them. Together they cover each other.
   */
  AUTH_IP: { name: 'auth:login:ip', limit: 10, windowMs: 900_000, failOpen: true },
  AUTH_ACCOUNT: { name: 'auth:login:acct', limit: 5, windowMs: 900_000, failOpen: true },

  /** Authenticated and small. Fails closed - see below. */
  ADMIN_WRITE: { name: 'admin:write', limit: 60, windowMs: 60_000, failOpen: false },
});

/**
 * Who a request is counted against.
 *
 * IPv6 is bucketed by /64, not by address. A single residential customer
 * is routinely handed more individual v6 addresses than this process has
 * memory for keys, so per-address counting is no limit at all.
 */
export function clientIdentity(ip) {
  if (!ip) return 'unknown';
  if (net.isIPv6(ip)) {
    const expanded = ip.split('%')[0];
    // First four hextets is the /64 that was delegated.
    const parts = expanded.split(':');
    return parts.slice(0, 4).join(':') || expanded;
  }
  return ip;
}

/** Emails are hashed: a rate-limit key should not be a list of customers. */
export const accountIdentity = (email) =>
  createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 32);

export async function consume(bucket, identifier) {
  const [allowed, remaining, resetMs] = await getRedis().ratelimit(
    keys.rateLimit(bucket.name, identifier),
    bucket.windowMs,
    bucket.limit,
    // Unique per request. Without it two requests landing in the same
    // millisecond collapse into one sorted-set member and one of them
    // is free.
    `${Date.now()}-${randomUUID()}`,
  );
  return { allowed: allowed === 1, remaining: Number(remaining), resetMs: Number(resetMs) };
}

function setHeaders(res, bucket, remaining, resetMs) {
  res.set('RateLimit-Limit', String(bucket.limit));
  res.set('RateLimit-Remaining', String(Math.max(0, remaining)));
  res.set('RateLimit-Reset', String(Math.ceil(resetMs / 1000)));
}

/**
 * @param identify  how to name the caller for this bucket
 */
export function rateLimit(bucket, identify = (req) => clientIdentity(req.ip)) {
  return async (req, res, next) => {
    let result;
    try {
      result = await consume(bucket, identify(req));
    } catch (err) {
      /**
       * Redis is unreachable.
       *
       * Public buckets fail OPEN. Rate limiting protects against abuse;
       * refusing all traffic because the abuse-protection layer is down
       * converts a degradation into an outage - and on a status page
       * that means going dark during someone else's incident, which is
       * the one thing this product must not do.
       *
       * Admin writes fail CLOSED. Different risk: a handful of requests
       * refused is an inconvenience to one operator, while an unlimited
       * write endpoint during a Redis outage is not.
       */
      log.warn('rate limiter unavailable', { bucket: bucket.name, err: err.message });
      if (bucket.failOpen) return next();
      return next(ApiError.unavailable('rate_limit_unavailable', 'Try again shortly.'));
    }

    setHeaders(res, bucket, result.remaining, result.resetMs);

    if (result.allowed) return next();

    // Seconds, rounded up, per the HTTP spec. A sub-second wait still
    // has to be reported as 1 - a client that trusts a 0 retries
    // immediately and is refused again.
    increment('ratelimit_rejections_total', { bucket: bucket.name });
    res.set('Retry-After', String(Math.max(1, Math.ceil(result.resetMs / 1000))));
    next(ApiError.tooManyRequests('rate_limited', 'Too many requests. Please slow down.'));
  };
}

/** The pair that guards login. Both must pass. */
export const loginRateLimit = [
  rateLimit(BUCKETS.AUTH_IP),
  rateLimit(BUCKETS.AUTH_ACCOUNT, (req) => accountIdentity(req.body?.email ?? 'unknown')),
];

export const statusRateLimit = rateLimit(BUCKETS.PUBLIC_STATUS);
export const adminWriteRateLimit = rateLimit(
  BUCKETS.ADMIN_WRITE,
  (req) => req.auth?.userId ?? clientIdentity(req.ip),
);
