import { Router } from 'express';
import { authenticate, requireUser, requireRole } from '../middleware/authenticate.js';
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
  findComponent,
  toAdminJson,
} from '../services/component.js';
import { createIncident, addUpdate, listIncidents, findIncident } from '../services/incident.js';
import { requestCheck } from '../services/queue.js';
import { inviteUser, listUsers, updateUser } from '../services/invite.js';
import { inviteSchema, updateUserSchema } from '../schemas/auth.js';

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

/**
 * Check this component now, without waiting for the next sweep.
 *
 * 202, not 200. The check runs in the worker; answering "done" here
 * would mean holding an HTTP request open for a five-second network
 * timeout, which is the coupling the separate worker exists to avoid.
 */
adminRouter.post('/components/:slug/check', async (req, res, next) => {
  try {
    const component = await findComponent(req.org, req.params.slug);
    await requestCheck(component);
    res.status(202).json({ queued: true, slug: component.slug });
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

/* ---- people ---------------------------------------------------------- */

/**
 * Owner only, all of it.
 *
 * Declaring an incident at 3am and deciding who else holds the keys are
 * different kinds of authority, and an admin needs the first without the
 * second.
 */
const ownerOnly = requireRole('owner');

adminRouter.get('/users', ownerOnly, async (req, res) => {
  const users = await listUsers(req.org);
  res.json({
    users: users.map((u) => ({
      id: u._id.toString(),
      email: u.email,
      role: u.role,
      status: u.status,
      lastLoginAt: u.lastLoginAt ?? null,
      memberSince: u.createdAt,
    })),
  });
});

adminRouter.post('/users/invite', ownerOnly, validateBody(inviteSchema), async (req, res, next) => {
  try {
    const { user, token, expiresInSec } = await inviteUser(req.org, req.body, req.user);
    /**
     * The token comes back in the response.
     *
     * There is no email provider wired up yet, so the owner passes it on
     * themselves. That is honest for now and it is also why the token is
     * short-lived and single-use - but it does mean the invitation
     * travels through whatever channel they choose, which is worth
     * knowing. Sending it directly is the job of the notification
     * worker, when that exists.
     */
    res.status(201).json({
      user: { id: user._id.toString(), email: user.email, role: user.role, status: user.status },
      token,
      expiresInSec,
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.patch(
  '/users/:id',
  ownerOnly,
  validateBody(updateUserSchema),
  async (req, res, next) => {
    try {
      const user = await updateUser(req.org, req.params.id, req.body, req.user);
      res.json({ user: { id: user._id.toString(), role: user.role, status: user.status } });
    } catch (err) {
      next(err);
    }
  },
);
