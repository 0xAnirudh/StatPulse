import {
  config,
  log,
  connectMongo,
  connectRedis,
  disconnectMongo,
  disconnectRedis,
} from '@statpulse/core';
import { registerWorker, getQueue, closeQueues, QUEUE } from './queues.js';
import { sweep, scheduleSweeps, SWEEP_JOB, CHECK_JOB } from './ping.scheduler.js';
import { runCheck } from './ping.worker.js';
import { flush } from './flush.worker.js';
import { rollupDaily } from './rollup-daily.js';

/**
 * The worker process.
 *
 * Separate from the API on purpose. Checking two hundred URLs with a
 * five-second timeout can hold two hundred sockets and a second of CPU
 * in DNS and TLS work. Inside the API process that is two hundred slots
 * of the same event loop that owes visitors a 50ms p99 - during an
 * outage, when every target is timing out *and* traffic is at its peak.
 *
 * Kept separate, the checker can be scaled, restarted or crash-looped
 * without the status page noticing.
 */

const FLUSH_JOB = 'drain';
const ROLLUP_JOB = 'rollup-daily';

async function scheduleFlushes() {
  const queue = getQueue(QUEUE.FLUSH);
  const every = config.FLUSH_INTERVAL_MS;

  // Upserted, so restarting does not accumulate a second schedule.
  if (typeof queue.upsertJobScheduler === 'function') {
    await queue.upsertJobScheduler(FLUSH_JOB, { every }, { name: FLUSH_JOB });
  } else {
    await queue.add(FLUSH_JOB, {}, { repeat: { every }, jobId: FLUSH_JOB });
  }
}

/**
 * Nightly, at 03:10 UTC.
 *
 * Off the hour on purpose: everything else in this system fires on a
 * round number, and stacking a heavy aggregation on top of a sweep and a
 * flush at exactly 03:00 is a self-inflicted spike.
 */
async function scheduleRollups() {
  const queue = getQueue(QUEUE.FLUSH);
  const pattern = '10 3 * * *';

  if (typeof queue.upsertJobScheduler === 'function') {
    await queue.upsertJobScheduler(ROLLUP_JOB, { pattern }, { name: ROLLUP_JOB });
  } else {
    await queue.add(ROLLUP_JOB, {}, { repeat: { pattern }, jobId: ROLLUP_JOB });
  }
}

async function main() {
  await Promise.all([connectMongo(), connectRedis()]);

  registerWorker(
    QUEUE.PING,
    async (job) => {
      if (job.name === SWEEP_JOB) return { queued: await sweep() };
      if (job.name === CHECK_JOB) return runCheck(job.data);
      return null;
    },
    {
      // Fifty components finish well inside a minute at this width, and
      // it bounds how many sockets one tarpit target can tie up.
      concurrency: config.PING_CONCURRENCY,
      // Comfortably longer than the longest permitted check, so a slow
      // but healthy check is never mistaken for a dead worker and
      // handed to somebody else half-finished.
      lockDuration: 30_000,
    },
  );

  /**
   * The flusher, concurrency 1.
   *
   * Two flushers reading different entries of the same hour would both
   * increment the rollups legitimately and both be wrong about the
   * total. The Redis lock inside flush() guards against a second
   * *process*; this guards against a second job in this one.
   */
  registerWorker(QUEUE.FLUSH, (job) => (job.name === ROLLUP_JOB ? rollupDaily() : flush()), {
    concurrency: 1,
  });

  await scheduleSweeps();
  await scheduleFlushes();
  await scheduleRollups();

  log.info('worker running', {
    pingConcurrency: config.PING_CONCURRENCY,
    flushIntervalMs: config.FLUSH_INTERVAL_MS,
  });
}

main().catch((err) => {
  log.error('worker failed to start', { err: err.message });
  process.exit(1);
});

async function shutdown(signal) {
  log.info('worker shutting down', { signal });
  const forced = setTimeout(() => process.exit(1), 15_000);
  forced.unref();

  // Queues first: a worker closed cleanly finishes the job in its hand
  // rather than abandoning it to be redelivered.
  await closeQueues();
  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
