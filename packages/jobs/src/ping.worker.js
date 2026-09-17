import { log, getRedis, invalidateStatusByOrgId } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { Component } from '@statpulse/core/models';
import { classify, applyOutcome, EMPTY_COUNTERS } from '@statpulse/shared';
import { checkComponent } from './ping.service.js';

/**
 * One check, and the consequences of it.
 *
 * The important property here is how little the common case costs. A
 * component that is fine and stays fine writes nothing to Mongo at all:
 *
 *   every check      XADD a sample, HSET the live values, bump counters
 *   on a transition  update the document, drop the cache, publish
 *
 * At fifty components on a one-minute interval that is the difference
 * between 72,000 database writes a day and a few dozen a month.
 */

async function readCounters(redis, componentId) {
  const stored = await redis.hgetall(keys.componentHealth(componentId));
  if (!stored || !Object.keys(stored).length) return EMPTY_COUNTERS;
  return {
    fail: Number(stored.fail ?? 0),
    ok: Number(stored.ok ?? 0),
    slow: Number(stored.slow ?? 0),
    up: Number(stored.up ?? 0),
  };
}

export async function runCheck({ componentId }) {
  const component = await Component.findById(componentId).lean();
  if (!component || !component.isActive || component.deletedAt) {
    // Paused or deleted between the sweep and now. Not an error.
    return { skipped: true };
  }

  const result = await checkComponent(component);
  const redis = getRedis();

  const outcome = classify(result, component);
  const counters = await readCounters(redis, componentId);
  const next = applyOutcome({ status: component.status, counters, outcome, thresholds: {} });

  const checkedAt = new Date();

  /**
   * Everything that happens on every single check, in one round trip.
   *
   * The sample goes into a stream rather than into Mongo - see the
   * flusher. The live hash is what the status page actually reads for
   * latency, because the document's copy is a ten-minute-old snapshot.
   */
  const pipeline = redis
    .multi()
    .xadd(
      keys.METRICS_STREAM,
      'MAXLEN',
      '~',
      '200000',
      '*',
      'c',
      componentId.toString(),
      'o',
      component.orgId.toString(),
      't',
      String(checkedAt.getTime()),
      'ok',
      result.ok ? '1' : '0',
      'ms',
      String(result.responseMs ?? ''),
      'sc',
      String(result.statusCode ?? ''),
      'e',
      result.errorClass ?? '',
      'out',
      outcome,
    )
    .hset(keys.componentLive(componentId), {
      responseMs: result.responseMs ?? '',
      statusCode: result.statusCode ?? '',
      checkedAt: checkedAt.toISOString(),
      status: next.status,
      errorClass: result.errorClass ?? '',
    })
    // Live values are refreshed constantly; the TTL only matters for a
    // component that stops being checked, whose stale latency should
    // disappear rather than linger on the page forever.
    .expire(keys.componentLive(componentId), 300)
    .hset(keys.componentHealth(componentId), next.counters)
    .expire(keys.componentHealth(componentId), 3_600);

  await pipeline.exec();

  if (!next.changed) return { status: next.status, changed: false };

  /**
   * A transition. This is the expensive path, and it runs a few times a
   * month per component rather than 1,440 times a day.
   */
  await Component.updateOne(
    { _id: componentId },
    { $set: { status: next.status, statusChangedAt: checkedAt } },
  );

  // Dropped after the write commits, never before: deleting first opens
  // a window for a reader to repopulate the cache from pre-write data.
  await invalidateStatusByOrgId(component.orgId);

  await redis.publish(
    keys.EVENTS_CHANNEL,
    JSON.stringify({
      type: 'component.transition',
      componentId: componentId.toString(),
      orgId: component.orgId.toString(),
      from: component.status,
      to: next.status,
      at: checkedAt.toISOString(),
    }),
  );

  /**
   * Say why, not just what.
   *
   * There are two entirely different ways to fail and the log has to
   * tell them apart. A transport failure carries an errorClass and no
   * status code; a service answering 503 when 200 was expected carries a
   * status code and no errorClass - and logging only the errorClass made
   * that second case read as "went DOWN, reason: null", which is the
   * least useful sentence a status page could write about an outage.
   *
   * Both fields, always, plus how long it took.
   */
  log.info('component changed state', {
    component: component.slug,
    from: component.status,
    to: next.status,
    reason:
      result.errorClass ??
      (result.statusCode ? `unexpected status ${result.statusCode}` : 'unknown'),
    statusCode: result.statusCode ?? null,
    responseMs: result.responseMs ?? null,
  });

  return { status: next.status, changed: true, from: component.status };
}
