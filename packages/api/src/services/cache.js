import { randomUUID } from 'node:crypto';
import {
  config,
  log,
  getRedis,
  sleep,
  invalidateStatus,
  increment,
  observe,
} from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { composeStatusPayload, etagFor } from './status.js';

/**
 * Cache-aside for the public status page.
 *
 * Plain cache-aside has a hole, and it is the specific hole this product
 * cannot afford: the TTL expires at the exact moment two thousand people
 * are refreshing, every one of those requests misses, and every one of
 * them queries Mongo. The database dies - and it dies *because* you
 * cached. Caching turned a steady read load into a synchronised spike.
 *
 * So a miss does not mean "go and rebuild". It means "try to become the
 * one request that rebuilds; if someone else already is, serve the stale
 * copy".
 */

/** How long a rebuilder may hold the lock before it is presumed dead. */
const LOCK_TTL_MS = 5_000;

/** A loser waits this long, this many times, before giving up and rebuilding. */
const RETRY_DELAY_MS = 50;
const MAX_RETRIES = 3;

export const CACHE_RESULT = Object.freeze({
  HIT: 'hit',
  MISS: 'miss',
  STALE: 'stale',
});

async function writePayload(org, payload) {
  const json = JSON.stringify(payload);
  const etag = etagFor(payload);

  await getRedis()
    .multi()
    .set(keys.statusCache(org.slug), json, 'EX', config.STATUS_CACHE_TTL_SEC)
    // The stale copy lives far longer and is only read when Mongo cannot
    // be reached. It is the difference between a status page that
    // degrades and one that 503s during the outage it exists to report.
    .set(keys.statusStale(org.slug), json, 'EX', config.STATUS_STALE_TTL_SEC)
    .set(keys.statusEtag(org.slug), etag, 'EX', config.STATUS_CACHE_TTL_SEC)
    .exec();

  return etag;
}

async function readStale(org) {
  const json = await getRedis().get(keys.statusStale(org.slug));
  if (!json) return null;
  const payload = JSON.parse(json);
  // Marked, always. A status page quietly serving old data is worse than
  // one that admits it is struggling - the page renders this as "last
  // updated 8 minutes ago", and the reader decides what to trust.
  payload.stale = true;
  return payload;
}

/**
 * Read the payload, rebuilding at most once however many callers miss.
 */
export async function readStatus(org) {
  const redis = getRedis();
  const cacheKey = keys.statusCache(org.slug);

  const cached = await redis.get(cacheKey);
  if (cached) {
    increment('cache_requests_total', { result: CACHE_RESULT.HIT });
    return {
      payload: JSON.parse(cached),
      etag: await redis.get(keys.statusEtag(org.slug)),
      result: CACHE_RESULT.HIT,
    };
  }

  const token = randomUUID();
  const lockKey = keys.statusLock(org.slug);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const won = await redis.set(lockKey, token, 'NX', 'PX', LOCK_TTL_MS);

    if (won === 'OK') {
      try {
        const rebuildStarted = process.hrtime.bigint();
        const payload = await composeStatusPayload(org);
        const etag = await writePayload(org, payload);
        observe(
          'cache_rebuild_duration_seconds',
          Number(process.hrtime.bigint() - rebuildStarted) / 1e9,
        );
        increment('cache_requests_total', { result: CACHE_RESULT.MISS });
        return { payload, etag, result: CACHE_RESULT.MISS };
      } finally {
        // Released with a compare-and-delete, never a bare DEL: a slow
        // rebuild can outlive its own lock, and deleting unconditionally
        // would delete the *next* holder's lock. See lua/unlock.lua.
        await redis.unlock(lockKey, token).catch(() => {});
      }
    }

    // Someone else is rebuilding. Serving them a copy that is at most ten
    // minutes old, right now, beats making them queue for a fresh one.
    const stale = await readStale(org);
    if (stale) {
      increment('cache_requests_total', { result: CACHE_RESULT.STALE });
      return { payload: stale, etag: null, result: CACHE_RESULT.STALE };
    }

    // No stale copy - a cold start. Wait briefly for the winner to
    // finish rather than piling on.
    await sleep(RETRY_DELAY_MS);
    const filled = await redis.get(cacheKey);
    if (filled) {
      return {
        payload: JSON.parse(filled),
        etag: await redis.get(keys.statusEtag(org.slug)),
        result: CACHE_RESULT.HIT,
      };
    }
  }

  // The holder died mid-rebuild and left nothing behind. Rebuild without
  // the lock rather than answering an error.
  log.warn('cache lock contended past retries, rebuilding unlocked', { org: org.slug });
  const payload = await composeStatusPayload(org);
  const etag = await writePayload(org, payload);
  return { payload, etag, result: CACHE_RESULT.MISS };
}

/**
 * Re-exported so callers on the read side have one import for the whole
 * cache, while the invalidation itself lives in core where the worker
 * can reach it too.
 */
export { invalidateStatus };
