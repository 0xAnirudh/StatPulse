import mongoose from 'mongoose';
import { config } from '../config.js';
import { log } from '../log.js';
import { backoffDelay, sleep } from '../util/backoff.js';

/**
 * MongoDB connection.
 *
 * Mongo is the source of truth for state - components, incidents,
 * accounts - but it is deliberately not on the hot read path. The public
 * status page is served from Redis, and when Mongo is unreachable the
 * page falls back to the last-known-good copy rather than failing.
 *
 * So the API retries indefinitely instead of crashing: a status page
 * that exits because its database blinked is the one failure mode the
 * whole design exists to avoid.
 */

/**
 * How long a query waits for a connection before giving up.
 *
 * Mongoose buffers operations issued while disconnected and, by default,
 * holds them for ten seconds before rejecting. On this system that is
 * the wrong default twice over: the public read path has a fifty
 * millisecond budget, and at two thousand requests a second a ten-second
 * hold means twenty thousand requests sitting on sockets waiting for a
 * database that is not coming back.
 *
 * A chaos test found exactly that - with both stores down, the status
 * endpoint hung for over four seconds instead of returning the
 * documented 503.
 *
 * Buffering is not turned off entirely, because the API binds its port
 * before the stores connect (see server.js) and a request arriving in
 * that window should wait briefly rather than fail. Two seconds covers
 * the startup gap and bounds the outage case.
 */
mongoose.set('bufferTimeoutMS', 2_000);

let connecting = null;

export async function connectMongo({ maxAttempts = Infinity } = {}) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connecting) return connecting;

  connecting = (async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await mongoose.connect(config.MONGO_URI, {
          dbName: config.MONGO_DB_NAME,
          // Bounded, and deliberately shorter than the driver default of
          // 30s. Every query on the read path is behind a cache, so a
          // request that does reach Mongo while it is unhealthy should
          // find out quickly and fall back, not hold a socket open for
          // half a minute at 2,000 requests a second.
          serverSelectionTimeoutMS: 8_000,
        });
        log.info('mongo connected', { db: config.MONGO_DB_NAME });
        return mongoose.connection;
      } catch (err) {
        const delay = backoffDelay(attempt);
        log.warn('mongo connection failed, retrying', {
          attempt: attempt + 1,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay);
      }
    }
    throw new Error(`mongo failed to connect after ${maxAttempts} attempts`);
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

export function mongoStatus() {
  const { readyState } = mongoose.connection;
  return {
    connected: readyState === 1,
    state: READY_STATES[readyState] ?? 'unknown',
  };
}

export async function disconnectMongo() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  log.info('mongo disconnected');
}

mongoose.connection.on('disconnected', () => log.warn('mongo disconnected unexpectedly'));
mongoose.connection.on('reconnected', () => log.info('mongo reconnected'));
