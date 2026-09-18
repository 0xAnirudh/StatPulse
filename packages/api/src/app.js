import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { log, ApiError, config } from '@statpulse/core';
import { healthRouter } from './routes/health.js';
import { metricsRouter } from './routes/metrics.js';
import { observeRequests } from './middleware/observe.js';
import { authRouter } from './routes/auth.js';
import { statusRouter } from './routes/status.js';
import { incidentsRouter } from './routes/incidents.js';
import { adminRouter } from './routes/admin.js';

/**
 * The Express application, with no server attached.
 *
 * Keeping `app` separate from `server.js` is what lets Supertest drive
 * the real app in-process without binding a port, which every
 * integration test depends on.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');

  /**
   * Behind a load balancer every request arrives from the proxy.
   *
   * Without this, req.ip is the proxy for everyone: the per-IP rate
   * limiter throttles the entire internet into one bucket, which during
   * an outage means the status page rate-limits the people it exists to
   * inform. Set too high, a client can spoof X-Forwarded-For and mint
   * unlimited buckets. It has to match the real number of proxies in
   * front of this process - one, on Render or Fly.
   */
  app.set('trust proxy', 1);

  // Before the routers, so it times everything including 404s.
  app.use(observeRequests);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  /**
   * CORS.
   *
   * Public status reads are open to everyone - that is the product. The
   * authenticated routes are not: WEB_ORIGIN is an explicit allow-list,
   * because a wildcard plus credentials would let any site on the
   * internet drive an admin's session.
   */
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const allowed = config.WEB_ORIGIN.split(',').filter(Boolean);

    if (origin && allowed.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Credentials', 'true');
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-None-Match');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.set('Access-Control-Expose-Headers', 'ETag, Retry-After, RateLimit-Remaining');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  /**
   * The status page itself.
   *
   * Served by the API rather than by a separate frontend, and that is
   * the point: a status page hosted somewhere that can fail
   * independently of this process is one more thing that can be down
   * when it is needed. One file, no build step, no CDN - it renders from
   * a single fetch of the endpoint below.
   */
  app.use(
    express.static(join(dirname(fileURLToPath(import.meta.url)), 'public'), {
      // The page is tiny and changes rarely; the data it fetches is what
      // needs to be fresh, and that has its own cache headers.
      maxAge: '5m',
      etag: true,
    }),
  );

  app.use('/health', healthRouter);
  app.use('/metrics', metricsRouter);

  /**
   * Everything public is versioned.
   *
   * People write scripts against a status endpoint and then never touch
   * them again. A breaking change gets /v2 rather than breaking those,
   * and the unversioned path the original design sketched redirects
   * rather than 404ing anyone who bookmarked it.
   */
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/status', statusRouter);
  app.use('/api/v1/incidents', incidentsRouter);
  app.use('/api/v1/admin', adminRouter);

  app.use('/api/status', (req, res) => res.redirect(301, '/api/v1/status'));

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.path}` } });
  });

  // Express identifies an error handler by its arity, so `next` has to
  // stay in the signature even though it is unused.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.details) body.error.details = err.details;
      return res.status(err.status).json(body);
    }

    // Anything not deliberately thrown is a bug. Log it in full, tell
    // the client nothing - stack traces and driver messages leak schema
    // details and library versions, and on a public endpoint they leak
    // them to everyone.
    log.error('unhandled request error', {
      path: req.path,
      err: err.message,
      stack: err.stack,
    });
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong.' } });
  });

  return app;
}
