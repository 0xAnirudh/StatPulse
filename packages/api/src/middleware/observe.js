import { increment, observe } from '@statpulse/core';

/**
 * Time every request.
 *
 * The one thing to be careful about here is label cardinality. Using the
 * raw path as a label means every component slug, every incident slug
 * and every 404 probe from a scanner becomes its own time series - which
 * is how a Prometheus instance runs out of memory because of a status
 * page. Paths are normalised to their route shape instead, so
 * /api/v1/status/components/payments-api is reported as
 * /api/v1/status/components/:slug.
 */
const ROUTES = [
  [/^\/api\/v1\/status\/components\/[^/]+$/, '/api/v1/status/components/:slug'],
  [/^\/api\/v1\/status$/, '/api/v1/status'],
  [/^\/api\/v1\/incidents\/[^/]+$/, '/api/v1/incidents/:slug'],
  [/^\/api\/v1\/incidents$/, '/api/v1/incidents'],
  [/^\/api\/v1\/auth\/sessions\/[^/]+$/, '/api/v1/auth/sessions/:id'],
  [/^\/api\/v1\/auth\/[^/]+$/, '/api/v1/auth/:action'],
  [/^\/api\/v1\/admin\/components\/[^/]+\/check$/, '/api/v1/admin/components/:slug/check'],
  [/^\/api\/v1\/admin\/components\/[^/]+$/, '/api/v1/admin/components/:slug'],
  [/^\/api\/v1\/admin\/incidents\/[^/]+$/, '/api/v1/admin/incidents/:slug'],
  [/^\/api\/v1\/admin\/[^/]+$/, '/api/v1/admin/:collection'],
  [/^\/health/, '/health'],
  [/^\/metrics$/, '/metrics'],
];

export function normaliseRoute(path) {
  for (const [pattern, label] of ROUTES) if (pattern.test(path)) return label;
  // Everything unrecognised collapses into one series rather than
  // creating one per URL a scanner tries.
  return 'other';
}

export function observeRequests(req, res, next) {
  const started = process.hrtime.bigint();

  /**
   * Captured now, not in the finish handler.
   *
   * Express rewrites req.url and req.path to be relative to a mounted
   * router while that router is handling the request, so reading it
   * later can yield "/live" rather than "/health/live" - which then
   * falls through to the catch-all label and silently lumps real routes
   * in with scanner noise. originalUrl is never rewritten.
   */
  const route = normaliseRoute(req.originalUrl.split('?')[0]);

  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    observe('http_request_duration_seconds', seconds, { route });
    increment('http_requests_total', { route, status: res.statusCode });
  });

  next();
}
