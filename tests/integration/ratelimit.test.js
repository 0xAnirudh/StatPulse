import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectRedis, disconnectRedis, getRedis } from '../../packages/core/src/redis/client.js';
import {
  BUCKETS,
  consume,
  clientIdentity,
  accountIdentity,
} from '../../packages/api/src/middleware/rateLimit.js';

beforeAll(connectRedis);
afterAll(disconnectRedis);
beforeEach(async () => {
  await getRedis().flushdb();
});

const bucket = (limit, windowMs) => ({ name: 'test', limit, windowMs, failOpen: true });

describe('the sliding window', () => {
  it('allows up to the limit and then refuses', async () => {
    const b = bucket(3, 60_000);
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await consume(b, 'caller'));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
  });

  it('counts each caller separately', async () => {
    const b = bucket(1, 60_000);
    expect((await consume(b, 'alice')).allowed).toBe(true);
    expect((await consume(b, 'bob')).allowed).toBe(true);
    expect((await consume(b, 'alice')).allowed).toBe(false);
  });

  it('lets a request back in as the oldest one slides out', async () => {
    // The property a fixed window does not have: recovery is gradual,
    // tied to when each request actually happened.
    const b = bucket(2, 300);
    await consume(b, 'caller');
    await consume(b, 'caller');
    expect((await consume(b, 'caller')).allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 340));
    expect((await consume(b, 'caller')).allowed).toBe(true);
  });

  it('refuses the burst a fixed window would have allowed', async () => {
    // The specific attack: a full window's worth at the very end of one
    // window and another full window's worth at the start of the next.
    // A counter that resets on a boundary permits double the rate; this
    // does not, because the earlier requests are still inside the
    // trailing window.
    const b = bucket(3, 400);
    for (let i = 0; i < 3; i += 1) await consume(b, 'burst');

    await new Promise((r) => setTimeout(r, 200)); // half a window later
    const second = [];
    for (let i = 0; i < 3; i += 1) second.push((await consume(b, 'burst')).allowed);

    expect(second).toEqual([false, false, false]);
  });

  it('reports when a retry could succeed', async () => {
    const b = bucket(1, 5_000);
    await consume(b, 'caller');
    const refused = await consume(b, 'caller');

    expect(refused.allowed).toBe(false);
    expect(refused.resetMs).toBeGreaterThan(0);
    expect(refused.resetMs).toBeLessThanOrEqual(5_000);
  });
});

describe('concurrency', () => {
  it('admits exactly the limit when fifty requests arrive at once', async () => {
    // The test that fails the moment anyone "optimises" the Lua script
    // into separate Redis calls. Read-then-write from Node means all
    // fifty read the same count, all see room, and all pass.
    const b = bucket(10, 60_000);
    const results = await Promise.all(Array.from({ length: 50 }, () => consume(b, 'swarm')));

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(40);
  });

  it('does not lose requests that land in the same millisecond', async () => {
    // Each request contributes a unique member. Without that, two in one
    // millisecond collapse into one sorted-set entry and one is free.
    const b = bucket(100, 60_000);
    await Promise.all(Array.from({ length: 20 }, () => consume(b, 'same-ms')));

    const remaining = (await consume(b, 'same-ms')).remaining;
    expect(remaining).toBe(79);
  });
});

describe('the keyspace', () => {
  it('expires on its own, with no sweeper', async () => {
    const b = bucket(5, 300);
    await consume(b, 'ephemeral');

    const key = 'rl:test:ephemeral';
    expect(await getRedis().pttl(key)).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 380));
    expect(await getRedis().exists(key)).toBe(0);
  });
});

describe('identity', () => {
  it('buckets IPv6 by /64, not by address', () => {
    // One residential customer is handed more v6 addresses than we have
    // memory for keys. Per-address counting would be no limit at all.
    const a = clientIdentity('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = clientIdentity('2001:db8:1234:5678:1111:2222:3333:4444');
    expect(a).toBe(b);
  });

  it('keeps distinct /64s apart', () => {
    expect(clientIdentity('2001:db8:1234:5678::1')).not.toBe(
      clientIdentity('2001:db8:1234:9999::1'),
    );
  });

  it('uses IPv4 addresses as they are', () => {
    expect(clientIdentity('203.0.113.7')).toBe('203.0.113.7');
  });

  it('hashes an email rather than putting it in a key', () => {
    // A rate-limit keyspace should not double as a customer list for
    // anyone who gets a Redis console.
    const id = accountIdentity('ops@acme.com');
    expect(id).not.toContain('acme');
    expect(id).not.toContain('@');
    expect(accountIdentity('OPS@ACME.COM')).toBe(id);
  });
});

describe('the configured buckets', () => {
  it('fails open on public routes and closed on admin writes', () => {
    // Stated as a test because it is a judgement, not an accident: going
    // dark during someone else's outage is the one thing a status page
    // must not do.
    expect(BUCKETS.PUBLIC_STATUS.failOpen).toBe(true);
    expect(BUCKETS.PUBLIC_SUBSCRIBE.failOpen).toBe(true);
    expect(BUCKETS.ADMIN_WRITE.failOpen).toBe(false);
  });

  it('limits login by address and by account', () => {
    expect(BUCKETS.AUTH_IP.limit).toBeGreaterThan(BUCKETS.AUTH_ACCOUNT.limit);
  });
});
