import { getRedis } from './redis/client.js';
import * as keys from './redis/keys.js';
import { Organization } from './models/Organization.js';

/**
 * Cache invalidation, in core rather than in the API.
 *
 * Both processes invalidate: an admin write does it from the API, and a
 * status transition does it from the ping worker. Putting it here is
 * what stops the worker importing from the HTTP package to get at it.
 *
 * Reading the cache stays in the API, because rebuilding it needs the
 * payload composer and the worker has no business owning that.
 */

/**
 * Org slugs, memoised.
 *
 * The worker knows a component's orgId and the cache is keyed by slug.
 * Looking that up on every transition would be a database read on the
 * one path that is already doing three; organizations change about
 * never, so a small map is enough.
 */
const slugCache = new Map();
const SLUG_TTL_MS = 300_000;

export async function orgSlugById(orgId) {
  const id = orgId.toString();
  const hit = slugCache.get(id);
  if (hit && Date.now() - hit.at < SLUG_TTL_MS) return hit.slug;

  const org = await Organization.findById(id).select('slug').lean();
  if (!org) return null;

  slugCache.set(id, { slug: org.slug, at: Date.now() });
  return org.slug;
}

export function clearSlugCache() {
  slugCache.clear();
}

/**
 * Drop the cached payload after a write.
 *
 * Two rules, both non-obvious, both the source of the classic bug.
 *
 * DELETE, never SET. Writing the new payload from inside a write means
 * two concurrent writers can land theirs out of order and the loser's
 * stale view sticks for a full TTL. Deleting is idempotent and
 * order-independent: the next reader rebuilds from what is committed.
 *
 * AFTER the Mongo write commits, never before. Deleting first opens a
 * window in which a concurrent reader repopulates the cache from
 * pre-write data - and the TTL then keeps that wrong answer alive for a
 * full minute.
 *
 * The stale copy is deliberately left alone. It is the Mongo-is-down
 * fallback, and a slightly old fallback is the entire point of one.
 */
export async function invalidateStatus(org) {
  const slug = typeof org === 'string' ? org : org?.slug;
  if (!slug) return;
  await getRedis().del(keys.statusCache(slug), keys.statusEtag(slug));
}

/** Invalidate when all you have is the org's id, as the worker does. */
export async function invalidateStatusByOrgId(orgId) {
  const slug = await orgSlugById(orgId);
  if (slug) await invalidateStatus(slug);
}
