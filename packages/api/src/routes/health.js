import { Router } from 'express';
import { mongoStatus, redisStatus } from '@statpulse/core';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * Liveness: is this process running at all?
 *
 * Never touches a store. An orchestrator uses this to decide whether to
 * kill and replace the container, and killing a healthy process because
 * a shared database is briefly unreachable would turn one store outage
 * into a restart loop across every instance at once.
 */
healthRouter.get('/live', (req, res) => {
  res.json({ status: 'alive', uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
});

/**
 * Readiness: can this process serve traffic?
 *
 * Checks both stores and answers 503 when either is down, so a load
 * balancer takes the instance out of rotation without killing it.
 *
 * Note the asymmetry with what the public status page actually does: the
 * page keeps answering from cache when Mongo is down, so "not ready" here
 * is a signal to prefer another instance, not an admission that this one
 * is useless. If every instance is in the same state the balancer sends
 * traffic anyway, and the degraded read path is what catches it.
 */
healthRouter.get('/', async (req, res) => {
  const [mongo, redis] = await Promise.all([Promise.resolve(mongoStatus()), redisStatus()]);

  const ready = mongo.connected && redis.connected;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    stores: { mongo, redis },
  });
});
