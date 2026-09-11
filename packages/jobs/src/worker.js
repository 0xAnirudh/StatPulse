import {
  config,
  log,
  connectMongo,
  connectRedis,
  disconnectMongo,
  disconnectRedis,
} from '@statpulse/core';
import { registerWorker, closeQueues, QUEUE } from './queues.js';
import { sweep, scheduleSweeps, SWEEP_JOB, CHECK_JOB } from './ping.scheduler.js';
import { runCheck } from './ping.worker.js';

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

  await scheduleSweeps();
  log.info('ping worker running', { concurrency: config.PING_CONCURRENCY });
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
