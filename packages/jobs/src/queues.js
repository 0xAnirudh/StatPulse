import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config, log } from '@statpulse/core';

/**
 * Queue plumbing.
 *
 * BullMQ gets its own Redis connections rather than sharing the
 * application client, and that is not tidiness - it is required.
 * Blocking commands (BRPOPLPUSH, XREAD BLOCK) hold a connection for
 * their whole duration, so they need a connection nobody else is
 * issuing commands on.
 *
 * `maxRetriesPerRequest: null` is the specific gotcha. ioredis defaults
 * to 20, and a blocking command that exceeds it throws - which surfaces
 * as the worker dying in a way that looks like a Redis outage and is
 * not. BullMQ refuses to start without it for exactly this reason.
 */
export function queueConnection() {
  return new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

export const QUEUE = Object.freeze({
  PING: 'ping',
  FLUSH: 'flush',
});

const queues = new Map();
const workers = [];

export function getQueue(name) {
  if (!queues.has(name)) {
    queues.set(
      name,
      new Queue(name, {
        connection: queueConnection(),
        defaultJobOptions: {
          // Keep enough history to debug yesterday, not enough to fill
          // Redis. An unbounded completed-job list is the usual way a
          // BullMQ deployment runs out of memory.
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 1_000 },
        },
      }),
    );
  }
  return queues.get(name);
}

export function registerWorker(name, processor, options = {}) {
  const worker = new Worker(name, processor, {
    connection: queueConnection(),
    ...options,
  });

  worker.on('failed', (job, err) => {
    log.error('job failed', { queue: name, jobId: job?.id, err: err.message });
  });
  worker.on('error', (err) => log.error('worker error', { queue: name, err: err.message }));

  workers.push(worker);
  return worker;
}

export async function closeQueues() {
  await Promise.allSettled([
    ...workers.map((w) => w.close()),
    ...[...queues.values()].map((q) => q.close()),
  ]);
}
