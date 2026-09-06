import Redis from 'ioredis';
import { config } from '../config.js';
import { log } from '../log.js';
import { backoffDelay } from '../util/backoff.js';

/**
 * Redis client.
 *
 * This one instance holds the status cache, the rate limit buckets, the
 * refresh-token whitelist, the job queues and the metrics buffer. That
 * is a wide blast radius on purpose - one dependency to run in
 * development - and it is why each of those five has a defined
 * behaviour when Redis is gone rather than one shared failure:
 *
 *   cache     - rebuild from Mongo, slower but correct
 *   limits    - fail open on public routes, closed on admin writes
 *   sessions  - everyone has to log in again
 *   queues    - checks pause and resume, nothing is lost that matters
 *   buffer    - up to one flush interval of samples lost, by design
 *
 * The client reconnects forever. A status page with a cold cache is
 * still a status page.
 */

let client = null;

export function getRedis() {
  if (client) return client;

  client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    retryStrategy: (attempt) => backoffDelay(attempt - 1, { base: 200, max: 10_000 }),
    reconnectOnError: (err) => {
      // A failover promotes a replica and the old primary starts
      // answering READONLY. Reconnecting picks up the new primary;
      // anything else is a real error and should surface.
      if (err.message.includes('READONLY')) return 2;
      return false;
    },
  });

  client.on('connect', () => log.info('redis connected'));
  client.on('error', (err) => log.warn('redis error', { err: err.message }));
  client.on('reconnecting', (delay) => log.warn('redis reconnecting', { delayMs: delay }));

  return client;
}

export async function connectRedis() {
  const redis = getRedis();
  if (redis.status === 'ready') return redis;
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  return redis;
}

export async function redisStatus() {
  const redis = getRedis();
  if (redis.status !== 'ready') return { connected: false, state: redis.status };
  try {
    // Pinged rather than trusted to report its own state: ioredis says
    // "ready" from the moment the socket connects, which is not the same
    // as the server answering commands.
    const started = process.hrtime.bigint();
    await redis.ping();
    const rttMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { connected: true, state: 'ready', rttMs: Number(rttMs.toFixed(2)) };
  } catch (err) {
    return { connected: false, state: redis.status, error: err.message };
  }
}

export async function disconnectRedis() {
  if (!client) return;
  await client.quit().catch(() => client.disconnect());
  client = null;
  log.info('redis disconnected');
}
