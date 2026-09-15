import { Router } from 'express';
import { getRedis, registerGauge, render } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { QUEUE } from '@statpulse/shared';

export const metricsRouter = Router();

/**
 * Gauges read at scrape time.
 *
 * Both of these are already exact in Redis, so mirroring them into local
 * counters would only create a second number that can disagree with the
 * first. The stream length in particular is the health signal for the
 * whole write-behind design: if it climbs, the flusher has stopped.
 */
/**
 * Only ask Redis when Redis is actually connected.
 *
 * ioredis queues commands issued before the connection is up rather than
 * rejecting them, so a scrape that arrives during startup - or while
 * Redis is down - would hang until the command timed out, holding the
 * request open. A try/catch does not help: the promise never rejects, it
 * simply never settles.
 *
 * A scrape must never be the thing that takes a process down, so an
 * unavailable gauge is omitted rather than waited on.
 */
function whenReady(read) {
  return async () => {
    const redis = getRedis();
    if (redis.status !== 'ready') return null;
    try {
      return await read(redis);
    } catch {
      return null;
    }
  };
}

registerGauge(
  'metrics_stream_length',
  whenReady((redis) => redis.xlen(keys.METRICS_STREAM)),
);

registerGauge(
  'queue_depth',
  whenReady(async (redis) => {
    const [ping, flush] = await Promise.all([
      redis.llen(`bull:${QUEUE.PING}:wait`),
      redis.llen(`bull:${QUEUE.FLUSH}:wait`),
    ]);
    return { '{"queue":"ping"}': ping, '{"queue":"flush"}': flush };
  }),
);

/**
 * Internal only.
 *
 * Not authenticated, because a scraper inside the deployment has no
 * token - but it must not be routable from the internet either. Request
 * counts by route and status are a map of the system's surface and its
 * traffic, which is reconnaissance, and the queue depths would tell an
 * attacker exactly when the workers are struggling.
 *
 * Exposed on the same port for simplicity; a deployment should block
 * /metrics at the ingress. A separate bind address is the better answer
 * and the obvious next step if this is ever hosted somewhere the ingress
 * cannot be trusted to do it.
 */
metricsRouter.get('/', async (req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(await render());
});
