import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { getRedis } from '../../packages/core/src/redis/client.js';
import * as keys from '../../packages/core/src/redis/keys.js';
import { PingSample, UptimeRollup } from '../../packages/core/src/models/index.js';
import { flush } from '../../packages/jobs/src/flush.worker.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';

/**
 * The write-behind buffer's one hard correctness property.
 *
 * Consumer groups are at-least-once: a flusher that dies between writing
 * to Mongo and acknowledging the stream is handed the same entries
 * again. Samples survive that because they are keyed on the stream id
 * and collide. The rollup counters cannot use that trick - $inc applied
 * twice is simply wrong - so they carry a watermark instead.
 *
 * Reasoning about it is not the same as watching it happen, and an
 * uptime figure that is quietly 2x is the kind of bug that surfaces in a
 * renewal conversation rather than in an alert.
 */
const orgId = new mongoose.Types.ObjectId();
const componentId = new mongoose.Types.ObjectId();

async function addSamples(count, { outcome = 'ok', ms = 100 } = {}) {
  const redis = getRedis();
  const at = Date.UTC(2026, 8, 17, 10, 0, 0);

  for (let i = 0; i < count; i += 1) {
    await redis.xadd(
      keys.METRICS_STREAM,
      '*',
      'c',
      componentId.toString(),
      'o',
      orgId.toString(),
      't',
      String(at + i * 1_000),
      'ok',
      outcome === 'fail' ? '0' : '1',
      'ms',
      String(ms),
      'sc',
      '200',
      'e',
      '',
      'out',
      outcome,
    );
  }
}

const rollup = () => UptimeRollup.findOne({ componentId }).lean();

/** Rewind the consumer group so every entry is delivered again. */
async function redeliverEverything() {
  await getRedis().xgroup('SETID', keys.METRICS_STREAM, keys.METRICS_GROUP, '0');
}

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

describe('draining the buffer', () => {
  it('writes one sample document per stream entry', async () => {
    await addSamples(10);
    const { written } = await flush();

    expect(written).toBe(10);
    expect(await PingSample.countDocuments()).toBe(10);
  });

  it('keeps ok, degraded and down summing to total', async () => {
    await addSamples(5, { outcome: 'ok' });
    await addSamples(3, { outcome: 'slow' });
    await addSamples(2, { outcome: 'fail' });
    await flush();

    const r = await rollup();
    expect(r.total).toBe(10);
    expect(r.ok).toBe(5);
    expect(r.degraded).toBe(3);
    expect(r.down).toBe(2);
    expect(r.ok + r.degraded + r.down).toBe(r.total);
  });

  it('folds everything in one hour into one bucket', async () => {
    await addSamples(10);
    await flush();

    expect(await UptimeRollup.countDocuments({ componentId })).toBe(1);
  });
});

describe('when the same batch is delivered twice', () => {
  it('does not double-count the rollups', async () => {
    // The whole point. A flusher that dies after writing and before
    // acknowledging gets these entries again on restart.
    await addSamples(10);
    await flush();

    const first = await rollup();
    expect(first.total).toBe(10);

    await redeliverEverything();
    const second = await flush();

    // It reads them again - that is at-least-once working as designed -
    // and changes nothing.
    expect(second.written).toBe(10);
    const after = await rollup();
    expect(after.total).toBe(10);
    expect(after.ok).toBe(10);
  });

  it('does not duplicate sample documents', async () => {
    await addSamples(10);
    await flush();
    await redeliverEverything();
    await flush();

    // Keyed on the stream entry id, so the second insert collides and is
    // skipped rather than producing a second copy.
    expect(await PingSample.countDocuments()).toBe(10);
  });

  it('still absorbs genuinely new entries after a replay', async () => {
    // The watermark must not wedge the bucket shut. A replay is ignored;
    // the next real batch is not.
    await addSamples(10);
    await flush();
    await redeliverEverything();
    await flush();

    await addSamples(4);
    await flush();

    expect((await rollup()).total).toBe(14);
  });
});

describe('the singleton lock', () => {
  it('lets only one flusher run at a time', async () => {
    // Two live flushers reading different halves of the same hour would
    // both increment legitimately and both be wrong about the total.
    await addSamples(10);

    const [a, b] = await Promise.all([flush(), flush()]);
    const skipped = [a, b].filter((r) => r.skipped);

    expect(skipped).toHaveLength(1);
    expect((await rollup()).total).toBe(10);
  });

  it('releases the lock when it finishes', async () => {
    await addSamples(2);
    await flush();
    expect(await getRedis().get('lock:flush')).toBeNull();
  });
});
