import { config, log } from '@statpulse/core';
import { Component } from '@statpulse/core/models';
import { JOB } from '@statpulse/shared';
import { getQueue, QUEUE } from './queues.js';

/**
 * The sweep: once a minute, enqueue a check for everything due.
 *
 * Fan-out rather than one job that loops. A single looping job means one
 * unresponsive target holds up every component behind it in the list -
 * and the components most likely to be slow are exactly the ones you
 * most want checked promptly. One job each lets the worker's concurrency
 * do the parallelism and bounds the damage of a tarpit to one slot.
 */

export const SWEEP_JOB = JOB.SWEEP;
export const CHECK_JOB = JOB.CHECK;

/**
 * How far checks are spread out.
 *
 * Without jitter every check in the system leaves at :00. That is a
 * self-inflicted burst on our own egress and a synchronised thundering
 * herd against the customer's origin - fifty simultaneous requests once
 * a minute, forever, from a tool whose entire job is to not be the
 * problem.
 */
const JITTER_MS = 15_000;

export async function sweep() {
  const now = Date.now();

  const components = await Component.find({ isActive: true, deletedAt: null })
    .select('_id orgId checkIntervalSec')
    .lean();

  let queued = 0;
  const queue = getQueue(QUEUE.PING);

  for (const component of components) {
    const intervalSec = component.checkIntervalSec ?? config.PING_DEFAULT_INTERVAL_SEC;
    const slot = Math.floor(now / (intervalSec * 1_000));

    await queue.add(
      CHECK_JOB,
      { componentId: component._id.toString(), orgId: component.orgId.toString() },
      {
        /**
         * A deterministic id makes double-scheduling harmless.
         *
         * Two schedulers running during a deploy, or a sweep replayed
         * after a restart, both compute the same id for the same slot
         * and BullMQ drops the duplicate. That is far cheaper and more
         * reliable than trying to guarantee exactly one scheduler exists
         * at all times.
         */
        jobId: `check:${component._id}:${slot}`,
        delay: Math.floor(Math.random() * JITTER_MS),
        /**
         * Retries are for infrastructure, not for targets.
         *
         * A timeout from the monitored service is a *successful* job
         * with ok:false - retrying it would erase the very signal this
         * system exists to capture. Only our own failures (Redis gone,
         * a malformed component) reach this.
         */
        attempts: 2,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    );
    queued += 1;
  }

  log.debug('sweep queued checks', { queued, candidates: components.length });
  return queued;
}

/**
 * Install the repeating sweep.
 *
 * Upserted rather than added, so restarting a worker does not accumulate
 * a second schedule - which is how a system quietly ends up checking
 * everything twice a minute and nobody notices until the bill arrives.
 */
export async function scheduleSweeps() {
  const queue = getQueue(QUEUE.PING);
  const every = 60_000;

  if (typeof queue.upsertJobScheduler === 'function') {
    await queue.upsertJobScheduler(SWEEP_JOB, { every }, { name: SWEEP_JOB });
  } else {
    // Older BullMQ: the repeatable-job API before schedulers existed.
    await queue.add(SWEEP_JOB, {}, { repeat: { every }, jobId: SWEEP_JOB });
  }

  log.info('sweep scheduled', { everyMs: every });
}
