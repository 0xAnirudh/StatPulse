import { createHash } from 'node:crypto';
import { getRedis } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { Component, Incident } from '@statpulse/core/models';
import { deriveSystemStatus } from '@statpulse/shared';

/**
 * Composing the public status payload.
 *
 * This is the expensive path - the one a cache miss pays for - so it is
 * written to be as cheap as it can be and then cached hard. Two Mongo
 * queries in parallel, one Redis pipeline, no aggregation.
 *
 * Uptime percentages are deliberately NOT computed here. A ninety-day
 * aggregation on every cache miss would put the single most expensive
 * query in the system on the path that only runs when the system is
 * already struggling. They are maintained by the flusher into a Redis
 * hash and merged in if present; a page that shows current status
 * instantly and uptime a beat later is strictly better than one that
 * shows neither for four hundred milliseconds.
 */

const UNGROUPED = 'Services';

/**
 * Build the public view of one component.
 *
 * Constructed field by field rather than by deleting keys from the
 * document. Deleting is a blacklist, and a blacklist fails open: add a
 * field to the schema and it is public until someone remembers. This
 * fails closed - a new field is invisible until it is named here.
 *
 * targetUrl in particular must never appear. It frequently contains a
 * health-check path that is itself a small disclosure about internal
 * routing.
 */
function publicComponent(component, live, uptime) {
  return {
    slug: component.slug,
    name: component.name,
    description: component.description ?? null,
    type: component.type,
    status: component.status,
    // The live values come from Redis, not from the document: the
    // document's copies are a ten-minute-old snapshot written by the
    // flusher, and on a status page ten minutes is the difference
    // between useful and misleading.
    responseTimeMs: live?.responseMs ? Number(live.responseMs) : null,
    lastCheckedAt: live?.checkedAt ?? component.lastCheckedAt?.toISOString() ?? null,
    uptime: uptime ?? null,
  };
}

function publicIncident(incident, slugById) {
  const latest = incident.updates?.[incident.updates.length - 1];
  return {
    slug: incident.slug,
    title: incident.title,
    status: incident.status,
    impact: incident.impact,
    startedAt: incident.startedAt?.toISOString() ?? null,
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    affectedComponents: (incident.affectedComponents ?? [])
      .map((id) => slugById.get(id.toString()))
      .filter(Boolean),
    latestUpdate: latest
      ? {
          message: latest.message,
          status: latest.status,
          timestamp: latest.timestamp?.toISOString() ?? null,
        }
      : null,
  };
}

function groupComponents(components, liveById, uptimeById) {
  const groups = new Map();

  for (const component of components) {
    const name = component.group?.trim() || UNGROUPED;
    if (!groups.has(name)) groups.set(name, []);
    groups
      .get(name)
      .push(
        publicComponent(
          component,
          liveById.get(component._id.toString()),
          uptimeById.get(component._id.toString()),
        ),
      );
  }

  return [...groups].map(([name, items]) => ({ name, components: items }));
}

export async function composeStatusPayload(org) {
  const orgId = org._id;

  const [components, openIncidents] = await Promise.all([
    Component.find({ orgId, isPublic: true, deletedAt: null }).sort({ displayOrder: 1 }).lean(),
    Incident.find({ orgId, resolvedAt: null }).sort({ startedAt: -1 }).lean(),
  ]);

  const redis = getRedis();
  const [liveResults, uptimeRaw] = await Promise.all([
    components.length
      ? redis.pipeline(components.map((c) => ['hgetall', keys.componentLive(c._id)])).exec()
      : Promise.resolve([]),
    redis.hgetall(keys.uptimeCache(org.slug)),
  ]);

  const liveById = new Map();
  components.forEach((c, i) => {
    // pipeline entries are [err, value]; a failed read is simply absent,
    // which renders as "not checked yet" rather than failing the page.
    const value = liveResults[i]?.[1];
    if (value && Object.keys(value).length) liveById.set(c._id.toString(), value);
  });

  const uptimeById = new Map();
  for (const [id, json] of Object.entries(uptimeRaw ?? {})) {
    try {
      uptimeById.set(id, JSON.parse(json));
    } catch {
      // A malformed cache entry is not worth failing the page over.
    }
  }

  const slugById = new Map(components.map((c) => [c._id.toString(), c.slug]));

  return {
    status: deriveSystemStatus({ components, openIncidents }),
    updatedAt: new Date().toISOString(),
    stale: false,
    groups: groupComponents(components, liveById, uptimeById),
    activeIncidents: openIncidents.map((i) => publicIncident(i, slugById)),
  };
}

/**
 * An ETag over the payload's content, ignoring the timestamp.
 *
 * `updatedAt` changes on every rebuild, so hashing the whole document
 * would produce a new ETag every sixty seconds even when nothing about
 * the service changed - and every poller would download an identical
 * payload instead of getting a 304. Hashing everything else means the
 * ETag changes exactly when the news does.
 */
export function etagFor(payload) {
  const { updatedAt: _updatedAt, stale: _stale, ...content } = payload;
  return `W/"${createHash('sha1').update(JSON.stringify(content)).digest('base64url')}"`;
}
