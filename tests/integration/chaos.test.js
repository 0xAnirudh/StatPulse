import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { connectRedis, disconnectRedis, getRedis } from '../../packages/core/src/redis/client.js';
import * as keys from '../../packages/core/src/redis/keys.js';

/**
 * What happens when a dependency goes away.
 *
 * A status page that dies with the service it reports on is worse than
 * no status page, because it destroys trust at the exact moment trust is
 * the only thing left. These are the documented degraded states from
 * plan §8, asserted rather than hoped for.
 *
 * Redis is taken away by killing the socket rather than by mocking, so
 * what is measured is how ioredis and this configuration actually behave
 * together - which is the part that could surprise us.
 */
const app = createApp();

/** Nothing here may block. A hang is a worse failure than an error. */
async function withinTimeout(promise, ms = 4_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`hung for ${ms}ms`)), ms)),
  ]);
}

beforeAll(async () => {
  await connectRedis();
  // Prime the org so tenant resolution is not the thing under test.
  await getRedis().set(
    keys.orgCache('127.0.0.1'),
    JSON.stringify({ _id: '000000000000000000000001', slug: 'default', name: 'StatPulse' }),
    'EX',
    600,
  );
});

afterAll(disconnectRedis);

describe('when Redis vanishes mid-flight', () => {
  beforeAll(() => {
    // The socket dies and does not come back. Not a mock - the real
    // client in the real failure mode.
    getRedis().disconnect(false);
  });

  afterAll(async () => {
    await getRedis()
      .connect()
      .catch(() => {});
  });

  it('fails commands fast rather than queueing them forever', async () => {
    // The property everything else here depends on. If a command issued
    // against a dead connection merely queued, every catch block in the
    // codebase would be decoration and the whole process would stall
    // behind a store that is never coming back.
    const started = Date.now();
    await expect(withinTimeout(getRedis().get('anything'))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('still answers liveness, so nothing restarts the container', async () => {
    // Killing a healthy process because a shared store blinked turns one
    // store outage into a restart loop across every instance at once.
    const res = await withinTimeout(request(app).get('/health/live'));
    expect(res.status).toBe(200);
  });

  it('reports itself unready, naming Redis', async () => {
    const res = await withinTimeout(request(app).get('/health'));
    expect(res.status).toBe(503);
    expect(res.body.stores.redis.connected).toBe(false);
  });

  it('lets public traffic through rather than refusing it', async () => {
    // The limiter fails open. Rate limiting protects against abuse, and
    // refusing everyone because the abuse-protection layer is down turns
    // a degradation into an outage - on a status page, going dark during
    // someone else's incident.
    const res = await withinTimeout(request(app).get('/api/v1/status'));

    // It cannot serve a payload with no cache and no database, but it
    // must fail as the documented degraded state, not as a bug and not
    // by hanging.
    expect(res.status).toBe(503);
    expect(res.body.error.code).toMatch(/unavailable/);
  });

  it('serves a metrics scrape instead of hanging on it', async () => {
    // The gauges read Redis. A scrape must never be the thing that takes
    // a process down.
    const res = await withinTimeout(request(app).get('/metrics'));
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
  });
});

describe('after Redis comes back', () => {
  it('serves normally again without a restart', async () => {
    await connectRedis();
    await getRedis().set(
      keys.statusCache('default'),
      JSON.stringify({ status: 'OPERATIONAL' }),
      'EX',
      60,
    );

    const res = await withinTimeout(request(app).get('/api/v1/status'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPERATIONAL');
  });
});
