import { ApiError } from '@statpulse/core';
import { User } from '@statpulse/core/models';
import { verifyAccessToken } from '../services/token.js';

/**
 * Verify the bearer token and attach its claims.
 *
 * Deliberately does not load the user from Mongo. The claims carry
 * everything the authorisation decision needs - id, org, role - and a
 * database read in front of every admin request buys nothing but
 * latency.
 *
 * The cost of that choice is that a change to an account takes up to
 * fifteen minutes to be felt. Where that is too slow - disabling an
 * account, demoting someone mid-incident - `tokenVersion` is the lever:
 * bump it and every token already issued stops verifying, which
 * `requireUser` below enforces on the routes that care.
 */
export function authenticate(req, res, next) {
  const header = req.get('authorization');

  if (!header) {
    return next(ApiError.unauthorized('missing_token', 'Authorization header is required'));
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(ApiError.unauthorized('malformed_token', 'Authorization must be "Bearer <token>"'));
  }

  try {
    const claims = verifyAccessToken(token);
    req.auth = {
      userId: claims.sub,
      orgId: claims.org,
      role: claims.role,
      tokenVersion: claims.tv ?? 0,
    };
    next();
  } catch (err) {
    // Expiry is told apart from every other failure because the client
    // can act on it - refresh, then retry. A bad signature is not
    // something an honest client can fix, and explaining why would help
    // whoever forged it more than it helps anyone else.
    if (err.name === 'TokenExpiredError') {
      return next(ApiError.unauthorized('token_expired', 'Token has expired'));
    }
    next(ApiError.unauthorized('invalid_token', 'Token is not valid'));
  }
}

/** Load the user document. For routes that need more than the claims. */
export async function requireUser(req, res, next) {
  try {
    const user = await User.findById(req.auth.userId);
    if (!user) {
      return next(ApiError.unauthorized('account_missing', 'Account no longer exists'));
    }
    // The other half of the tokenVersion lever: a stale token is refused
    // here even though its signature and expiry are both perfectly good.
    if ((user.tokenVersion ?? 0) !== req.auth.tokenVersion) {
      return next(ApiError.unauthorized('token_revoked', 'Session has been revoked'));
    }
    if (user.status === 'disabled') {
      return next(ApiError.forbidden('account_disabled', 'This account has been disabled'));
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
