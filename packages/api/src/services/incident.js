import { ApiError, getRedis, invalidateStatus } from '@statpulse/core';
import { keys } from '@statpulse/core/redis';
import { Component, Incident } from '@statpulse/core/models';
import { INCIDENT_STATUS } from '@statpulse/shared';
import { slugify } from '../schemas/component.js';

/**
 * Incidents: the human half of the status page.
 *
 * Every mutation invalidates the cache and publishes an event, in that
 * order and after the write has committed.
 */

async function resolveComponentIds(orgId, slugs = []) {
  if (slugs.length === 0) return [];

  const components = await Component.find({ orgId, slug: { $in: slugs }, deletedAt: null })
    .select('_id slug')
    .lean();

  const found = new Set(components.map((c) => c.slug));
  const missing = slugs.filter((s) => !found.has(s));
  if (missing.length) {
    throw ApiError.badRequest('unknown_component', `No such component: ${missing.join(', ')}`);
  }

  return components.map((c) => c._id);
}

async function uniqueSlug(orgId, desired) {
  let slug = desired;
  for (let n = 2; n < 200; n += 1) {
    if (!(await Incident.exists({ orgId, slug }))) return slug;
    slug = `${desired}-${n}`;
  }
  throw ApiError.conflict('slug_exhausted', 'Could not derive a unique identifier');
}

async function announce(org, incident, type) {
  await invalidateStatus(org);
  await getRedis()
    .publish(
      keys.EVENTS_CHANNEL,
      JSON.stringify({
        type,
        orgId: org._id.toString(),
        slug: incident.slug,
        at: new Date().toISOString(),
      }),
    )
    .catch(() => {
      // A failed publish must not fail the write. The incident is
      // recorded and the cache is dropped; realtime is a convenience on
      // top of that, not a prerequisite for it.
    });
}

export async function createIncident(org, input, author) {
  const affected = await resolveComponentIds(org._id, input.affectedComponents);
  const status = input.status ?? INCIDENT_STATUS.INVESTIGATING;

  // Dated, because "database-latency" will happen again next quarter and
  // the first one should keep its URL.
  const base = `${slugify(input.title)}-${new Date().toISOString().slice(0, 10)}`;
  const slug = await uniqueSlug(org._id, base);

  const incident = await Incident.create({
    orgId: org._id,
    title: input.title,
    slug,
    status,
    impact: input.impact,
    affectedComponents: affected,
    createdBy: author?._id,
    // The declaration is itself the first timeline entry. An incident
    // with no updates would render as a headline with no explanation,
    // which is the thing everybody complains about on status pages.
    updates: [{ message: input.message, status, authorId: author?._id, timestamp: new Date() }],
    resolvedAt: status === INCIDENT_STATUS.RESOLVED ? new Date() : null,
  });

  await announce(org, incident, 'incident.created');
  return incident;
}

export async function addUpdate(org, slug, input, author) {
  const incident = await Incident.findOne({ orgId: org._id, slug });
  if (!incident) throw ApiError.notFound('incident_not_found', 'No such incident');

  if (incident.resolvedAt && input.status !== INCIDENT_STATUS.RESOLVED) {
    // Reopening is a real thing that happens - a fix that did not hold -
    // but it should be deliberate, not a side effect of posting a note.
    throw ApiError.unprocessable(
      'incident_resolved',
      'This incident is resolved. Open a new incident rather than continuing this one.',
    );
  }

  if (input.affectedComponents) {
    incident.affectedComponents = await resolveComponentIds(org._id, input.affectedComponents);
  }
  if (input.impact) incident.impact = input.impact;

  incident.status = input.status;
  incident.updates.push({
    message: input.message,
    status: input.status,
    authorId: author?._id,
    timestamp: new Date(),
  });

  // Stamped once. A second RESOLVED update should not move the time the
  // incident actually ended.
  if (input.status === INCIDENT_STATUS.RESOLVED && !incident.resolvedAt) {
    incident.resolvedAt = new Date();
  }

  await incident.save();
  await announce(org, incident, 'incident.updated');
  return incident;
}

export async function listIncidents(org, { status, limit, cursor }) {
  const filter = { orgId: org._id };
  if (status === 'active') filter.resolvedAt = null;
  if (status === 'resolved') filter.resolvedAt = { $ne: null };

  // Cursor rather than offset: an offset skips and duplicates rows when
  // a new incident is declared between two pages, which on this data is
  // not hypothetical - pages get read during incidents.
  if (cursor) filter.startedAt = { ...filter.startedAt, $lt: new Date(cursor) };

  const incidents = await Incident.find(filter)
    .sort({ startedAt: -1 })
    .limit(limit + 1)
    .lean();

  const hasMore = incidents.length > limit;
  const page = hasMore ? incidents.slice(0, limit) : incidents;

  return {
    incidents: page,
    nextCursor: hasMore ? page[page.length - 1].startedAt.toISOString() : null,
  };
}

export async function findIncident(org, slug) {
  const incident = await Incident.findOne({ orgId: org._id, slug }).lean();
  if (!incident) throw ApiError.notFound('incident_not_found', 'No such incident');
  return incident;
}

/** The public shape: no author ids, no internal references. */
export function toPublicJson(incident, slugById = new Map()) {
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
    updates: (incident.updates ?? []).map((u) => ({
      message: u.message,
      status: u.status,
      timestamp: u.timestamp?.toISOString() ?? null,
    })),
  };
}
