import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../../packages/core/src/db/mongo.js';
import { connectRedis, disconnectRedis, getRedis } from '../../packages/core/src/redis/client.js';
import { config } from '../../packages/core/src/config.js';
import { clearSlugCache } from '../../packages/core/src/cache.js';
import { clearTenantCache } from '../../packages/api/src/middleware/tenant.js';

/**
 * Test store lifecycle.
 *
 * `reset` destroys data, so before it is allowed to run, the targets are
 * checked to be the test ones. vitest.config.js already forces both, but
 * a guard costing one comparison is worth having in front of an
 * operation that cannot be undone - a misconfiguration that silently
 * wiped a real database would be discovered far too late.
 */

const EXPECTED_DB = 'statpulse_test';
const EXPECTED_REDIS_DB = 15;

function assertSafeTargets() {
  if (config.MONGO_DB_NAME !== EXPECTED_DB) {
    throw new Error(
      `refusing to reset: MONGO_DB_NAME is "${config.MONGO_DB_NAME}", expected "${EXPECTED_DB}"`,
    );
  }
  const redisDb = Number(new URL(config.REDIS_URL).pathname.slice(1) || 0);
  if (redisDb !== EXPECTED_REDIS_DB) {
    throw new Error(
      `refusing to reset: REDIS_URL points at logical database ${redisDb}, expected ${EXPECTED_REDIS_DB}`,
    );
  }
}

export async function setupStores() {
  assertSafeTargets();
  await Promise.all([connectMongo({ maxAttempts: 3 }), connectRedis()]);
  // Indexes are what several of these tests actually assert on - unique
  // email, unique slug - and mongoose builds them lazily.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}

export async function resetStores() {
  assertSafeTargets();
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  await getRedis().flushdb();
  // Both caches memoise an organization that has just been deleted.
  clearSlugCache();
  clearTenantCache();
}

export async function teardownStores() {
  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
}
