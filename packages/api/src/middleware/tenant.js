import { ApiError, log } from '@statpulse/core';
import { Organization } from '@statpulse/core/models';
import { defaultOrganization } from '../services/auth.js';

/**
 * Work out whose status page this request is for.
 *
 * Public routes resolve the tenant from the Host header, because a
 * visitor to status.acme.com has no token to carry an org id in. Admin
 * routes take it from the verified JWT claim, which cannot be spoofed by
 * setting a header.
 *
 * With one organization this is nearly a no-op. It exists now because
 * the alternative is adding an orgId argument to every query in the
 * codebase later and hoping none is missed - and the failure mode of
 * missing one is showing Acme's customers Globex's outage.
 */

// The org changes about never, and it is needed on every public request.
const CACHE_TTL_MS = 60_000;
let cached = null;

async function resolveByHost(host) {
  if (host) {
    const org = await Organization.findOne({ hosts: host.split(':')[0].toLowerCase() });
    if (org) return org;
  }
  // No host match: the single-tenant deployment, where every request
  // belongs to the only organization there is.
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.org;
  const org = await defaultOrganization();
  cached = { org, at: Date.now() };
  return org;
}

/**
 * Resolve the tenant, and survive Mongo being unreachable.
 *
 * This middleware runs before the status route's own fallback, so an
 * unguarded throw here produces a 500 from the endpoint whose entire
 * purpose is to keep answering during an outage. That was a real bug:
 * with Mongo down the status page returned "internal_error" instead of
 * serving its cached payload.
 *
 * Two defences. An expired cache entry is still used when the lookup
 * fails - organizations change about never, so a stale org record is a
 * perfectly good answer and letting it expire into a hard failure would
 * be throwing away the one thing that still works. And if there is
 * genuinely nothing cached, the result is a 503 with a documented code
 * rather than a 500, because this is the designed degraded state and not
 * a bug for someone to page about.
 */
export async function publicTenant(req, res, next) {
  try {
    req.org = await resolveByHost(req.get('host'));
    return next();
  } catch (err) {
    if (cached) {
      req.org = cached.org;
      req.tenantStale = true;
      return next();
    }
    return next(ApiError.unavailable('tenant_unavailable', 'Status is temporarily unavailable.'));
  }
}

/** For authenticated routes: the org comes from the token, not the host. */
export async function tokenTenant(req, res, next) {
  try {
    const org = await Organization.findById(req.auth.orgId);
    if (!org) return next(ApiError.unauthorized('org_missing', 'Organization no longer exists'));
    req.org = org;
    next();
  } catch (err) {
    next(err);
  }
}

/** Tests and the seed script reach for this directly. */
export function clearTenantCache() {
  cached = null;
}
