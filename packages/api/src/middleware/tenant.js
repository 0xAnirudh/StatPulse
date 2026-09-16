import { ApiError, log, getRedis } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { Organization } from '@statpulse/core/models';
import { defaultOrganization } from '../services/auth.js';

/**
 * Work out whose status page this request is for.
 *
 * Public routes resolve the tenant from the Host header, because a
 * visitor to status.acme.com has no token to carry an org id in. Admin
 * routes take it from the verified JWT claim, which cannot be spoofed by
 * setting a header.
 *
 * The caching here is not an optimisation. A load test against a warm
 * payload cache found every request hanging for ten seconds and then
 * failing: the payload was sitting in Redis, but this middleware ran
 * first and went to Mongo, so the "served entirely from Redis" read path
 * was nothing of the sort. With Mongo unreachable - the exact case the
 * whole design is for - the status page could not answer at all.
 *
 * So the resolved organization is cached in Redis alongside the payload
 * it belongs to. A cache hit now touches Mongo zero times.
 */

const MEMORY_TTL_MS = 60_000;
const REDIS_TTL_SEC = 3_600;

/** Two layers: process memory in front of Redis in front of Mongo. */
const memory = new Map();

const hostKey = (host) => (host ? host.split(':')[0].toLowerCase() : '_default');

function remember(key, org) {
  memory.set(key, { org, at: Date.now() });
  return org;
}

/**
 * The org, as the public payload needs it.
 *
 * Only the fields anything actually reads, so a cached copy does not go
 * stale in ways that matter. Settings live on the document and are read
 * by admin paths, which resolve through the token and go to Mongo.
 */
const portable = (org) => ({ _id: org._id.toString(), slug: org.slug, name: org.name });

async function fromMongo(host) {
  if (host !== '_default') {
    const byHost = await Organization.findOne({ hosts: host }).lean();
    if (byHost) return byHost;
  }
  // No host match: the single-tenant deployment, where every request
  // belongs to the only organization there is.
  return defaultOrganization();
}

export async function resolveTenant(rawHost) {
  const key = hostKey(rawHost);

  const held = memory.get(key);
  if (held && Date.now() - held.at < MEMORY_TTL_MS) return held.org;

  const redis = getRedis();

  // Redis before Mongo. An organization changes about never, so an
  // hour-old copy is a perfectly good answer.
  try {
    const cached = await redis.get(keys.orgCache(key));
    if (cached) return remember(key, JSON.parse(cached));
  } catch {
    // Redis unavailable; fall through to Mongo.
  }

  try {
    const org = await fromMongo(key);
    const value = portable(org);
    await redis.set(keys.orgCache(key), JSON.stringify(value), 'EX', REDIS_TTL_SEC).catch(() => {});
    return remember(key, value);
  } catch (err) {
    /**
     * Mongo is unreachable and nothing is cached anywhere.
     *
     * An expired in-memory entry is still used in preference to failing:
     * organizations change about never, and letting one expire into a
     * hard error would throw away the only thing that still works.
     */
    if (held) {
      log.warn('tenant lookup failed, serving an expired copy', { err: err.message });
      return held.org;
    }
    throw err;
  }
}

export async function publicTenant(req, res, next) {
  try {
    req.org = await resolveTenant(req.get('host'));
    return next();
  } catch (err) {
    // Logged, not swallowed. A page running on a stale org record is
    // fine; one doing it without anyone knowing why is not.
    log.warn('tenant unresolvable', { err: err.message });
    return next(ApiError.unavailable('tenant_unavailable', 'Status is temporarily unavailable.'));
  }
}

/** For authenticated routes: the org comes from the token, not the host. */
export async function tokenTenant(req, res, next) {
  try {
    const org = await Organization.findById(req.auth.orgId);
    if (!org) return next(ApiError.unauthorized('org_missing', 'Organization no longer exists'));
    req.org = org;
    next();
  } catch (err) {
    next(err);
  }
}

/** Tests and the seed script reach for this directly. */
export function clearTenantCache() {
  memory.clear();
}
