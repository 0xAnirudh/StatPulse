import { config, log, getRedis } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { Component, PingSample, UptimeRollup } from '@statpulse/core/models';
import { OUTCOME, hourBucket, uptimePercent } from '@statpulse/shared';

/**
 * Draining the write-behind buffer.
 *
 * Fifty components on a one-minute interval is 72,000 samples a day, and
 * it scales linearly with customers. Each one is tiny, but each is also
 * an index update, a journal entry and an oplog record arriving at a
 * steady fifty a minute forever, competing with the reads that matter.
 *
 * Batched every ten minutes, those 72,000 individual writes become 144
 * bulkWrite calls a day.
 *
 * The cost, stated plainly: up to one flush interval of samples is lost
 * if Redis dies uncleanly. That is acceptable because these are
 * statistical - a gap costs a few tenths of a percent of resolution in a
 * chart. It is NOT acceptable for status transitions, which is exactly
 * why those are written synchronously the moment they happen.
 */

const CONSUMER = `flusher-${process.pid}`;
const BATCH = 5_000;

/** Reclaim from a consumer that died holding entries. */
const IDLE_RECLAIM_MS = 15 * 60_000;

/**
 * Only one flusher may run at a time.
 *
 * Two of them double-count the rollup increments. The watermark below
 * makes a *replay* safe, but two live flushers reading different entries
 * of the same hour would both increment legitimately and both be right
 * about their own batch and wrong about the total.
 */
const LOCK_KEY = 'lock:flush';

export async function ensureGroup(redis) {
  try {
    await redis.xgroup('CREATE', keys.METRICS_STREAM, keys.METRICS_GROUP, '0', 'MKSTREAM');
  } catch (err) {
    // Already there, which is the normal case after the first run.
    if (!err.message.includes('BUSYGROUP')) throw err;
  }
}

/** Stream entries arrive as a flat [k, v, k, v] array. */
function toObject(fields) {
  const out = {};
  for (let i = 0; i < fields.length; i += 2) out[fields[i]] = fields[i + 1];
  return out;
}

export function parseEntry([id, fields]) {
  const f = toObject(fields);
  return {
    id,
    componentId: f.c,
    orgId: f.o,
    ts: new Date(Number(f.t)),
    ok: f.ok === '1',
    statusCode: f.sc ? Number(f.sc) : null,
    responseMs: f.ms ? Number(f.ms) : null,
    errorClass: f.e || null,
    outcome: f.out,
  };
}

/**
 * Fold a batch into per-component, per-hour totals.
 *
 * `ok + degraded + down === total` is the invariant the uptime maths
 * depends on, so the three are counted from one classification rather
 * than derived from each other.
 */
export function aggregate(entries) {
  const buckets = new Map();

  for (const e of entries) {
    const bucket = hourBucket(e.ts);
    const key = `${e.componentId}:${bucket.getTime()}`;

    if (!buckets.has(key)) {
      buckets.set(key, {
        orgId: e.orgId,
        componentId: e.componentId,
        bucket,
        total: 0,
        ok: 0,
        degraded: 0,
        down: 0,
        sumMs: 0,
        maxMs: 0,
        maxId: '0-0',
      });
    }

    const b = buckets.get(key);
    b.total += 1;
    if (e.outcome === OUTCOME.FAIL) b.down += 1;
    else if (e.outcome === OUTCOME.SLOW) b.degraded += 1;
    else b.ok += 1;

    if (e.responseMs != null) {
      b.sumMs += e.responseMs;
      b.maxMs = Math.max(b.maxMs, e.responseMs);
    }
    // Stream ids are monotonic and lexicographically ordered, so a
    // string comparison is a valid ordering.
    if (e.id > b.maxId) b.maxId = e.id;
  }

  return [...buckets.values()];
}

async function writeSamples(entries) {
  if (entries.length === 0) return 0;

  const docs = entries.map((e) => ({
    _id: e.id,
    ts: e.ts,
    componentId: e.componentId,
    orgId: e.orgId,
    ok: e.ok,
    statusCode: e.statusCode,
    responseMs: e.responseMs,
    errorClass: e.errorClass,
  }));

  try {
    await PingSample.insertMany(docs, { ordered: false });
  } catch (err) {
    // Duplicate keys are the expected outcome of a redelivered batch -
    // that is what keying on the stream id is for. Anything else is real.
    if (err.code !== 11000 && !err.writeErrors?.every((w) => w.err?.code === 11000)) throw err;
  }
  return docs.length;
}

async function writeRollups(buckets) {
  if (buckets.length === 0) return;

  const operations = buckets.map((b) => ({
    updateOne: {
      /**
       * The watermark guard.
       *
       * $inc is not idempotent, and consumer groups are at-least-once:
       * a flusher that dies between writing and acknowledging is handed
       * the same entries again. Requiring the incoming batch to be
       * strictly newer than what this bucket has already absorbed means
       * a replay matches nothing and changes nothing.
       *
       * When it matches nothing, upsert tries to insert instead - and
       * collides with the unique index, which is precisely the
       * "already applied, do nothing" outcome. That duplicate-key error
       * is expected and swallowed below.
       */
      filter: {
        orgId: b.orgId,
        componentId: b.componentId,
        bucket: b.bucket,
        lastStreamId: { $lt: b.maxId },
      },
      update: {
        $inc: { total: b.total, ok: b.ok, degraded: b.degraded, down: b.down, sumMs: b.sumMs },
        $max: { maxMs: b.maxMs },
        $set: { lastStreamId: b.maxId },
        $setOnInsert: { orgId: b.orgId, componentId: b.componentId, bucket: b.bucket },
      },
      upsert: true,
    },
  }));

  try {
    await UptimeRollup.bulkWrite(operations, { ordered: false });
  } catch (err) {
    if (err.code !== 11000 && !err.writeErrors?.every((w) => w.err?.code === 11000)) throw err;
  }
}

/**
 * Push the document snapshots forward.
 *
 * These are the fields the original design had the checker writing every
 * sixty seconds. Written here instead, they cost one bulkWrite per flush
 * and are accurate to within one interval - which is all anything reads
 * them for, since the status page takes its live values from Redis.
 */
async function writeSnapshots(entries) {
  const latest = new Map();
  for (const e of entries) {
    const held = latest.get(e.componentId);
    if (!held || e.ts > held.ts) latest.set(e.componentId, e);
  }
  if (latest.size === 0) return;

  await Component.bulkWrite(
    [...latest.values()].map((e) => ({
      updateOne: {
        filter: { _id: e.componentId },
        update: { $set: { lastCheckedAt: e.ts, responseTimeMs: e.responseMs } },
      },
    })),
    { ordered: false },
  );
}

/**
 * Recompute the uptime percentages the status page merges in.
 *
 * Deliberately here rather than on the read path. A ninety-day
 * aggregation is the single most expensive query in the system, and
 * running it on a cache miss would put it on the one path that only
 * happens when things are already going badly.
 */
export async function refreshUptimeCache(orgIds) {
  const redis = getRedis();
  const now = Date.now();
  const since = {
    '24h': new Date(now - 24 * 3_600_000),
    '7d': new Date(now - 7 * 24 * 3_600_000),
    '90d': new Date(now - 90 * 24 * 3_600_000),
  };

  for (const orgId of orgIds) {
    const rollups = await UptimeRollup.find({ orgId, bucket: { $gte: since['90d'] } }).lean();
    if (rollups.length === 0) continue;

    const byComponent = new Map();
    for (const r of rollups) {
      const id = r.componentId.toString();
      if (!byComponent.has(id)) byComponent.set(id, []);
      byComponent.get(id).push(r);
    }

    const payload = {};
    for (const [componentId, buckets] of byComponent) {
      payload[componentId] = JSON.stringify({
        '24h': uptimePercent(buckets.filter((b) => b.bucket >= since['24h'])),
        '7d': uptimePercent(buckets.filter((b) => b.bucket >= since['7d'])),
        '90d': uptimePercent(buckets),
      });
    }

    const slug = await orgSlug(orgId);
    if (!slug || Object.keys(payload).length === 0) continue;

    await redis
      .multi()
      .del(keys.uptimeCache(slug))
      .hset(keys.uptimeCache(slug), payload)
      .expire(keys.uptimeCache(slug), 900)
      .exec();
  }
}

async function orgSlug(orgId) {
  const { orgSlugById } = await import('@statpulse/core');
  return orgSlugById(orgId);
}

/**
 * One drain. Loops while batches come back full, so a backlog from a
 * dead flusher is cleared in one run rather than ten minutes at a time.
 */
export async function flush() {
  const redis = getRedis();
  await ensureGroup(redis);

  const held = await redis.set(LOCK_KEY, CONSUMER, 'NX', 'PX', config.FLUSH_INTERVAL_MS - 60_000);
  if (held !== 'OK') {
    log.debug('another flusher holds the lock, skipping');
    return { skipped: true };
  }

  let written = 0;
  const orgIds = new Set();

  try {
    // Anything a dead consumer was holding comes back first, so a crash
    // costs a delay rather than the data.
    const [, reclaimed = []] = await redis.xautoclaim(
      keys.METRICS_STREAM,
      keys.METRICS_GROUP,
      CONSUMER,
      IDLE_RECLAIM_MS,
      '0-0',
      'COUNT',
      BATCH,
    );

    let pending = reclaimed.map(parseEntry);

    for (;;) {
      if (pending.length === 0) {
        const response = await redis.xreadgroup(
          'GROUP',
          keys.METRICS_GROUP,
          CONSUMER,
          'COUNT',
          BATCH,
          'STREAMS',
          keys.METRICS_STREAM,
          '>',
        );
        if (!response) break;
        pending = response[0][1].map(parseEntry);
      }
      if (pending.length === 0) break;

      for (const e of pending) orgIds.add(e.orgId);

      await writeSamples(pending);
      await writeRollups(aggregate(pending));
      await writeSnapshots(pending);

      // Acknowledged last. Anything that fails above is redelivered
      // rather than silently dropped - which is the whole reason this is
      // a stream with a consumer group and not a list.
      await redis.xack(keys.METRICS_STREAM, keys.METRICS_GROUP, ...pending.map((e) => e.id));

      written += pending.length;
      const wasFull = pending.length >= BATCH;
      pending = [];
      if (!wasFull) break;
    }

    if (orgIds.size) await refreshUptimeCache([...orgIds]);
  } finally {
    await redis.unlock(LOCK_KEY, CONSUMER).catch(() => {});
  }

  if (written) log.info('flushed metrics', { samples: written, orgs: orgIds.size });
  return { written };
}
