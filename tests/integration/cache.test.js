import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { connectRedis, disconnectRedis, getRedis } from '../../packages/core/src/redis/client.js';
import * as keys from '../../packages/core/src/redis/keys.js';

/**
 * The rebuild is stubbed rather than driven through Mongo.
 *
 * What is under test is how many times a rebuild happens for N
 * concurrent misses - which is a property of the lock, not of the
 * query. A counting stub measures it exactly; a real Mongo round trip
 * would only add noise and a network dependency.
 */
const rebuilds = { count: 0, delayMs: 0 };

vi.mock('../../packages/api/src/services/status.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    composeStatusPayload: async () => {
      rebuilds.count += 1;
      if (rebuilds.delayMs) await new Promise((r) => setTimeout(r, rebuilds.delayMs));
      return {
        status: 'OPERATIONAL',
        updatedAt: new Date().toISOString(),
        stale: false,
        groups: [],
        activeIncidents: [],
      };
    },
  };
});

const { readStatus, invalidateStatus, CACHE_RESULT } =
  await import('../../packages/api/src/services/cache.js');

const org = { _id: new mongoose.Types.ObjectId(), slug: 'testorg' };

beforeAll(connectRedis);
afterAll(disconnectRedis);
beforeEach(async () => {
  await getRedis().flushdb();
  rebuilds.count = 0;
  rebuilds.delayMs = 0;
});

describe('cache-aside', () => {
  it('rebuilds on a miss and serves the cached copy afterwards', async () => {
    const first = await readStatus(org);
    expect(first.result).toBe(CACHE_RESULT.MISS);
    expect(rebuilds.count).toBe(1);

    const second = await readStatus(org);
    expect(second.result).toBe(CACHE_RESULT.HIT);
    // The whole point: the second read did not go near the database.
    expect(rebuilds.count).toBe(1);
  });

  it('gives the same ETag for unchanged content', async () => {
    const a = await readStatus(org);
    await invalidateStatus(org);
    // A real gap, so the two rebuilds cannot land in the same
    // millisecond and give updatedAt the same value by accident.
    await new Promise((r) => setTimeout(r, 5));
    const b = await readStatus(org);

    // Rebuilt, so updatedAt differs - but nothing a reader cares about
    // changed, so a poller holding the old ETag still gets a 304.
    expect(b.payload.updatedAt).not.toBe(a.payload.updatedAt);
    expect(b.etag).toBe(a.etag);
  });
});

describe('the stampede', () => {
  it('collapses two hundred concurrent misses into one rebuild', async () => {
    // NFR-3, and the reason the lock exists. This is the shape of a real
    // outage: the TTL expires while thousands of people are refreshing.
    // Without single-flight every one of them queries Mongo, and the
    // database dies *because* the cache expired.
    rebuilds.delayMs = 40;

    const results = await Promise.all(Array.from({ length: 200 }, () => readStatus(org)));

    expect(rebuilds.count).toBe(1);
    expect(results).toHaveLength(200);
    for (const r of results) expect(r.payload.status).toBe('OPERATIONAL');
  });

  it('serves the stale copy to whoever loses the race', async () => {
    // Warm the stale copy, then expire only the live key.
    await readStatus(org);
    await getRedis().del(keys.statusCache(org.slug));
    // The warm-up was a rebuild too; only the ones after it are the
    // measurement.
    rebuilds.count = 0;
    rebuilds.delayMs = 120;

    const [winner, ...losers] = await Promise.all(
      Array.from({ length: 20 }, () => readStatus(org)),
    );

    expect(rebuilds.count).toBe(1);
    const served = [winner, ...losers];
    expect(served.some((r) => r.result === CACHE_RESULT.STALE)).toBe(true);
    // Anyone served a stale copy is told so, and the page renders it as
    // "last updated N minutes ago" rather than passing it off as fresh.
    for (const r of served) {
      if (r.result === CACHE_RESULT.STALE) expect(r.payload.stale).toBe(true);
    }
  });
});

describe('invalidation', () => {
  it('forces the next read to rebuild', async () => {
    await readStatus(org);
    await invalidateStatus(org);

    const after = await readStatus(org);
    expect(after.result).toBe(CACHE_RESULT.MISS);
    expect(rebuilds.count).toBe(2);
  });

  it('leaves the stale copy intact', async () => {
    // The stale copy is the Mongo-is-down fallback. Clearing it on every
    // admin write would remove the safety net at the exact moment an
    // admin is making changes during an incident.
    await readStatus(org);
    await invalidateStatus(org);

    expect(await getRedis().get(keys.statusStale(org.slug))).toBeTruthy();
  });

  it('is idempotent', async () => {
    await readStatus(org);
    await invalidateStatus(org);
    await expect(invalidateStatus(org)).resolves.not.toThrow();
  });
});

describe('the rebuild lock', () => {
  it('is released as soon as the rebuild finishes', async () => {
    await readStatus(org);
    // A lock left behind would stall every rebuild for its full 5s TTL.
    expect(await getRedis().get(keys.statusLock(org.slug))).toBeNull();
  });

  it('is released even when the rebuild throws', async () => {
    const failing = { ...org, slug: 'failorg' };
    const status = await import('../../packages/api/src/services/status.js');
    const spy = vi
      .spyOn(status, 'composeStatusPayload')
      .mockRejectedValueOnce(new Error('mongo is down'));

    await expect(readStatus(failing)).rejects.toThrow('mongo is down');
    expect(await getRedis().get(keys.statusLock(failing.slug))).toBeNull();

    spy.mockRestore();
  });
});
