import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { config, log } from '@statpulse/core';
import { QUEUE, JOB } from '@statpulse/shared';

/**
 * The API's one reason to touch a queue: an on-demand check.
 *
 * A producer only - the API never runs a worker. It still needs its own
 * connection with `maxRetriesPerRequest: null`, because BullMQ refuses
 * any other, and sharing the application client would put queue traffic
 * on the connection serving the status page.
 */

let queue = null;

function pingQueue() {
  if (queue) return queue;
  queue = new Queue(QUEUE.PING, {
    connection: new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    }),
    defaultJobOptions: { removeOnComplete: { count: 100 }, removeOnFail: { count: 100 } },
  });
  return queue;
}

/**
 * Ask for a component to be checked now.
 *
 * Deliberately not awaited by the caller for its result - the API
 * enqueues and returns 202. Running the check inline would put a
 * five-second network timeout on an HTTP request, which is exactly the
 * coupling the separate worker process exists to prevent.
 *
 * The job id includes a coarse timestamp so that mashing the button
 * enqueues one check every ten seconds rather than one per click.
 */
export async function requestCheck(component) {
  const slot = Math.floor(Date.now() / 10_000);
  await pingQueue().add(
    JOB.CHECK,
    { componentId: component._id.toString(), orgId: component.orgId.toString(), onDemand: true },
    { jobId: `ondemand:${component._id}:${slot}`, priority: 1, attempts: 1 },
  );
  log.info('on-demand check requested', { component: component.slug });
}

export async function closeQueue() {
  if (!queue) return;
  await queue.close();
  queue = null;
}
