import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { connectRedis, disconnectRedis } from '../../packages/core/src/redis/client.js';

const app = createApp();

afterAll(async () => {
  await disconnectRedis();
});

describe('liveness', () => {
  it('answers without touching a store', async () => {
    // Deliberately before anything connects. An orchestrator restarts a
    // container that fails this, so it must not depend on a shared
    // database that a dozen instances would fail together.
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });
});

describe('readiness', () => {
  it('reports each store separately and is ready only when both are', async () => {
    await connectRedis();
    const res = await request(app).get('/health');

    expect(res.body.stores).toHaveProperty('mongo');
    expect(res.body.stores).toHaveProperty('redis');
    expect(res.body.stores.redis.connected).toBe(true);

    // The contract, whichever way the stores happen to be: 200 exactly
    // when both are up, 503 and a named culprit otherwise.
    const bothUp = res.body.stores.mongo.connected && res.body.stores.redis.connected;
    expect(res.status).toBe(bothUp ? 200 : 503);
    expect(res.body.status).toBe(bothUp ? 'ok' : 'degraded');
  });
});

describe('the error envelope', () => {
  it('shapes an unknown route like every other error', async () => {
    // Clients branch on error.code, so the envelope has to be the same
    // shape whether the failure came from a route or from the handler.
    const res = await request(app).get('/no-such-route');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(typeof res.body.error.message).toBe('string');
  });
});
