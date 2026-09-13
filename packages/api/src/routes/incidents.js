import { Router } from 'express';
import { Component } from '@statpulse/core/models';
import { publicTenant } from '../middleware/tenant.js';
import { validateQuery } from '../middleware/validate.js';
import { statusRateLimit } from '../middleware/rateLimit.js';
import { listIncidentsSchema } from '../schemas/incident.js';
import { listIncidents, findIncident, toPublicJson } from '../services/incident.js';

export const incidentsRouter = Router();

/**
 * The public incident history.
 *
 * Not cached the way the status payload is: it is read far less often,
 * it is paginated, and unlike the status matrix it does not have to
 * answer during a traffic surge - people hammer the front page, not
 * page four of the archive.
 */
async function slugMap(orgId) {
  const components = await Component.find({ orgId }).select('_id slug').lean();
  return new Map(components.map((c) => [c._id.toString(), c.slug]));
}

incidentsRouter.get(
  '/',
  statusRateLimit,
  validateQuery(listIncidentsSchema),
  publicTenant,
  async (req, res) => {
    const { status, limit, cursor } = req.validatedQuery;
    const [{ incidents, nextCursor }, slugs] = await Promise.all([
      listIncidents(req.org, { status, limit, cursor }),
      slugMap(req.org._id),
    ]);

    res.set('Cache-Control', 'public, max-age=30');
    res.json({ incidents: incidents.map((i) => toPublicJson(i, slugs)), nextCursor });
  },
);

incidentsRouter.get('/:slug', statusRateLimit, publicTenant, async (req, res, next) => {
  try {
    const [incident, slugs] = await Promise.all([
      findIncident(req.org, req.params.slug),
      slugMap(req.org._id),
    ]);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({ incident: toPublicJson(incident, slugs) });
  } catch (err) {
    next(err);
  }
});
