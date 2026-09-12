import { Router } from 'express';
import { log, ApiError, getRedis } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { publicTenant } from '../middleware/tenant.js';
import { statusRateLimit } from '../middleware/rateLimit.js';
import { readStatus } from '../services/cache.js';

export const statusRouter = Router();

/**
 * The public status page payload.
 *
 * Unauthenticated, cached, and the single busiest endpoint in the
 * system: when something breaks, this is what thousands of people
 * refresh at once.
 */
statusRouter.get('/', statusRateLimit, publicTenant, async (req, res, next) => {
  try {
    /**
     * Answer a conditional request before doing anything else.
     *
     * A poller that checks every thirty seconds sends the ETag it
     * already has. When nothing has changed this costs one Redis GET and
     * returns no body at all - which is the difference between a page
     * that is cheap to watch and one that is expensive to watch, at
     * exactly the moment everybody is watching.
     */
    const currentEtag = await getRedis().get(keys.statusEtag(req.org.slug));
    if (currentEtag && req.get('if-none-match') === currentEtag) {
      res.set('ETag', currentEtag);
      res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
      return res.status(304).end();
    }

    const { payload, etag, result } = await readStatus(req.org);

    if (etag) res.set('ETag', etag);
    /**
     * max-age is deliberately shorter than the server's own TTL. A CDN
     * or browser holding this for longer than the server does would make
     * invalidation meaningless from the outside - an admin would clear
     * the cache and the page would still be wrong for everyone.
     */
    res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
    res.set('X-Cache', result);

    res.json(payload);
  } catch (err) {
    /**
     * Mongo is unreachable and there was no stale copy to fall back on.
     *
     * This is the one case the page genuinely cannot answer. It is a 503
     * with a machine-readable code rather than a 500, because it is not
     * a bug - it is the documented degraded state, and a monitoring
     * system reading this should know the difference.
     */
    log.error('status read failed', { org: req.org?.slug, err: err.message });
    next(ApiError.unavailable('status_unavailable', 'Status is temporarily unavailable.'));
  }
});
