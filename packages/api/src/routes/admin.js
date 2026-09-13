import { Router } from 'express';
import { authenticate, requireUser } from '../middleware/authenticate.js';
import { tokenTenant } from '../middleware/tenant.js';
import { validateBody } from '../middleware/validate.js';
import { adminWriteRateLimit } from '../middleware/rateLimit.js';
import { createComponentSchema, updateComponentSchema } from '../schemas/component.js';
import { createIncidentSchema, updateIncidentSchema } from '../schemas/incident.js';
import {
  listComponents,
  createComponent,
  updateComponent,
  deleteComponent,
  toAdminJson,
} from '../services/component.js';
import { createIncident, addUpdate, listIncidents, findIncident } from '../services/incident.js';

export const adminRouter = Router();

// Everything below is authenticated, tenant-scoped and rate limited.
adminRouter.use(authenticate, tokenTenant, requireUser, adminWriteRateLimit);

/* ---- components ------------------------------------------------------ */

adminRouter.get('/components', async (req, res) => {
  const components = await listComponents(req.org);
  res.json({ components: components.map(toAdminJson) });
});

adminRouter.post('/components', validateBody(createComponentSchema), async (req, res) => {
  const component = await createComponent(req.org, req.body);
  res.status(201).json({ component: toAdminJson(component) });
});

adminRouter.patch(
  '/components/:slug',
  validateBody(updateComponentSchema),
  async (req, res, next) => {
    try {
      const component = await updateComponent(req.org, req.params.slug, req.body);
      res.json({ component: toAdminJson(component) });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.delete('/components/:slug', async (req, res, next) => {
  try {
    await deleteComponent(req.org, req.params.slug);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

/* ---- incidents ------------------------------------------------------- */

adminRouter.get('/incidents', async (req, res) => {
  const { incidents, nextCursor } = await listIncidents(req.org, { status: 'all', limit: 50 });
  res.json({ incidents, nextCursor });
});

adminRouter.post('/incidents', validateBody(createIncidentSchema), async (req, res) => {
  const incident = await createIncident(req.org, req.body, req.user);
  res
    .status(201)
    .json({ incident: { slug: incident.slug, title: incident.title, status: incident.status } });
});

adminRouter.patch(
  '/incidents/:slug',
  validateBody(updateIncidentSchema),
  async (req, res, next) => {
    try {
      const incident = await addUpdate(req.org, req.params.slug, req.body, req.user);
      res.json({
        incident: {
          slug: incident.slug,
          status: incident.status,
          resolvedAt: incident.resolvedAt,
          updates: incident.updates.length,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get('/incidents/:slug', async (req, res, next) => {
  try {
    res.json({ incident: await findIncident(req.org, req.params.slug) });
  } catch (err) {
    next(err);
  }
});
