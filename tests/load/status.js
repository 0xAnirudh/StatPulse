/**
 * Load the public status page, on the path that matters.
 *
 * NFR-1 is a p99 under 50ms at two thousand requests a second on a cache
 * hit. That is the number the whole design exists to hold, and it is
 * specifically about the *hit* path: during an outage the cache is warm
 * and everybody is reading it.
 *
 * So the cache is populated directly rather than by letting the app
 * rebuild it. That is not cheating - it is isolating the thing under
 * test. What this measures is Redis GET plus JSON plus Express, which is
 * exactly what two thousand concurrent readers actually pay for. The
 * rebuild path is measured separately by the stampede test, which cares
 * about how many rebuilds happen rather than how fast one is.
 *
 *   node tests/load/status.js
 *   node tests/load/status.js --duration 30 --connections 200
 */

/**
 * Environment first, and everything else through a dynamic import.
 *
 * ESM hoists static imports and evaluates them before any top-level
 * statement runs, so setting this after an `import` line would set it
 * long after config.js had already read it. The first version of this
 * script did exactly that and spent its whole run measuring how fast the
 * system can answer 429.
 *
 * The limiter is raised, not disabled: 120 requests a minute per client
 * is the production setting, and a hundred connections from one loopback
 * address is one client by every definition the limiter has. Raising it
 * isolates the read path; the limiter has its own tests.
 */
process.env.STATUS_RATE_LIMIT = process.env.STATUS_RATE_LIMIT ?? '1000000';

/**
 * Run against an isolated Redis database, the way the test suite does.
 *
 * This script writes a synthetic fifty-component payload and a fake
 * organization, both with an hour-long TTL. Pointed at the development
 * database - which is what REDIS_URL means by default - it leaves that
 * sitting in front of the real seeded data until it expires, and the dev
 * status page shows fifty services called "service-0" that do not exist.
 *
 * That is exactly what happened the first time this was run.
 */
const LOAD_REDIS_DB = 14;
{
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  url.pathname = `/${LOAD_REDIS_DB}`;
  process.env.REDIS_URL = url.toString();
}

const [autocannonMod, appMod, redisMod, keys, statusMod] = await Promise.all([
  import('autocannon'),
  import('../../packages/api/src/app.js'),
  import('../../packages/core/src/redis/client.js'),
  import('../../packages/core/src/redis/keys.js'),
  import('../../packages/api/src/services/status.js'),
]);

const autocannon = autocannonMod.default;
const { createApp } = appMod;
const { connectRedis, disconnectRedis, getRedis } = redisMod;
const { etagFor } = statusMod;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const DURATION = arg('duration', 10);
const CONNECTIONS = arg('connections', 100);
const COMPONENTS = arg('components', 50);

/** A payload the size a real fifty-component org would produce. */
function samplePayload() {
  const components = Array.from({ length: COMPONENTS }, (_, i) => ({
    slug: `service-${i}`,
    name: `Service ${i}`,
    description: null,
    type: 'API',
    status: i === 3 ? 'DEGRADED' : 'OPERATIONAL',
    responseTimeMs: 40 + (i % 200),
    lastCheckedAt: new Date().toISOString(),
    uptime: { '24h': 99.98, '7d': 99.95, '90d': 99.91 },
  }));

  return {
    status: 'DEGRADED',
    updatedAt: new Date().toISOString(),
    stale: false,
    groups: [
      { name: 'Core', components: components.slice(0, Math.ceil(COMPONENTS / 2)) },
      { name: 'Support', components: components.slice(Math.ceil(COMPONENTS / 2)) },
    ],
    activeIncidents: [
      {
        slug: 'elevated-latency',
        title: 'Elevated latency on the API',
        status: 'MONITORING',
        impact: 'minor',
        startedAt: new Date().toISOString(),
        resolvedAt: null,
        affectedComponents: ['service-3'],
        latestUpdate: {
          message: 'Latency is recovering. Continuing to monitor.',
          status: 'MONITORING',
          timestamp: new Date().toISOString(),
        },
      },
    ],
  };
}

async function main() {
  await connectRedis();
  const redis = getRedis();

  const payload = samplePayload();
  const json = JSON.stringify(payload);
  const etag = etagFor(payload);

  await redis
    .multi()
    .set(keys.statusCache('default'), json, 'EX', 3_600)
    .set(keys.statusEtag('default'), etag, 'EX', 3_600)
    // The organization too. Tenant resolution is on this path, and if it
    // went to Mongo the run would be measuring a database round trip
    // rather than a cache hit.
    .set(
      keys.orgCache('127.0.0.1'),
      JSON.stringify({ _id: '000000000000000000000001', slug: 'default', name: 'StatPulse' }),
      'EX',
      3_600,
    )
    .exec();

  const server = createApp().listen(0);
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/v1/status`;

  console.log(
    `payload ${(Buffer.byteLength(json) / 1024).toFixed(1)}KB · ` +
      `${CONNECTIONS} connections · ${DURATION}s\n`,
  );

  // One plain request first, so a misconfigured run says what went wrong
  // instead of reporting a beautiful latency figure for the wrong
  // reason.
  const probe = await fetch(url);
  if (!probe.ok) {
    console.error(`probe returned ${probe.status}: ${(await probe.text()).slice(0, 200)}`);
    server.close();
    await disconnectRedis();
    process.exit(1);
  }

  await autocannon({ url, connections: 10, duration: 2 });

  const result = await autocannon({ url, connections: CONNECTIONS, duration: DURATION });

  const rows = [
    ['requests/sec', result.requests.average.toFixed(0)],
    ['latency p50', `${result.latency.p50} ms`],
    ['latency p99', `${result.latency.p99} ms`],
    ['latency max', `${result.latency.max} ms`],
    ['non-2xx', String(result.non2xx)],
    ['errors', String(result.errors)],
  ];
  console.log(rows.map(([k, v]) => `  ${k.padEnd(14)} ${v}`).join('\n'));

  /**
   * The assertion, not just the report.
   *
   * A load script that prints numbers and always exits 0 is a script
   * nobody reads the output of. This one fails.
   */
  const failures = [];
  if (result.latency.p99 > 50) failures.push(`p99 ${result.latency.p99}ms exceeds 50ms (NFR-1)`);
  if (result.non2xx > 0) failures.push(`${result.non2xx} non-2xx responses`);
  if (result.errors > 0) failures.push(`${result.errors} errors`);

  console.log();
  if (failures.length) {
    console.error(`FAIL\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS  p99 ${result.latency.p99}ms at ${result.requests.average.toFixed(0)} req/s`);
  }

  // Leave nothing behind. The isolated database makes this belt and
  // braces, but a load script that grows a keyspace every run is a
  // slow-motion problem.
  await redis.flushdb();
  server.close();
  await disconnectRedis();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
