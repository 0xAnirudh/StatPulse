import { Router } from 'express';
import { config, isProduction, ApiError } from '@statpulse/core';
import { User } from '@statpulse/core/models';
import { validateBody } from '../middleware/validate.js';
import { registerSchema, loginSchema, acceptInviteSchema } from '../schemas/auth.js';
import { register, authenticate as checkCredentials } from '../services/auth.js';
import { acceptInvite } from '../services/invite.js';
import { authenticate, requireUser } from '../middleware/authenticate.js';
import { publicTenant, tokenTenant } from '../middleware/tenant.js';
import { loginRateLimit, rateLimit, BUCKETS } from '../middleware/rateLimit.js';
import {
  issueAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  listSessions,
  revokeSessionById,
  REFRESH_OUTCOME,
} from '../services/token.js';

export const authRouter = Router();

const COOKIE = 'sp_rt';

/**
 * The refresh cookie.
 *
 * Path-scoped to the auth routes, which is not decoration: without it
 * the cookie rides along on every public status request too, which at
 * two thousand requests a second during an outage is both wasted
 * bandwidth and a secret being handed to a code path that has no use
 * for it.
 *
 * SameSite=Lax plus the origin check below is the CSRF defence. Lax
 * alone would still permit a top-level POST from another site; the
 * origin check closes that. If the dashboard ever moves to a different
 * origin than the API this has to become SameSite=None, and then a
 * double-submit token becomes mandatory rather than optional.
 */
function refreshCookieOptions(maxAgeSec) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: maxAgeSec * 1000,
  };
}

function assertSameOrigin(req) {
  const allowed = config.WEB_ORIGIN.split(',').filter(Boolean);
  const origin = req.get('origin');
  // No Origin header at all is a same-origin navigation or a non-browser
  // client; browsers always send one on a cross-site POST, which is the
  // case being defended against.
  if (!origin) return;
  if (!allowed.includes(origin)) {
    throw ApiError.forbidden('bad_origin', 'Request origin is not allowed');
  }
}

async function issueSession(req, res, user) {
  const { token, expiresInSec } = await issueRefreshToken(user, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.cookie(COOKIE, token, refreshCookieOptions(expiresInSec));
  return issueAccessToken(user);
}

/**
 * Validation runs before tenant resolution throughout, and the order is
 * deliberate: parsing a body costs nothing, resolving an organization is
 * a database read. On public endpoints - which are the ones that get
 * scanned and sprayed - a malformed request should be refused without
 * ever reaching Mongo.
 */
authRouter.post(
  '/register',
  validateBody(registerSchema),
  rateLimit(BUCKETS.AUTH_IP),
  publicTenant,
  async (req, res) => {
    const user = await register(req.body, req.org);
    const accessToken = await issueSession(req, res, user);
    res.status(201).json({ accessToken, user: user.toPrivate() });
  },
);

authRouter.post(
  '/login',
  validateBody(loginSchema),
  ...loginRateLimit,
  publicTenant,
  async (req, res) => {
    const user = await checkCredentials(req.body, req.org);
    const accessToken = await issueSession(req, res, user);
    res.json({ accessToken, user: user.toPrivate() });
  },
);

/**
 * Exchange a refresh cookie for a new access token, and rotate.
 *
 * A replayed token does not merely fail: every session for that user is
 * destroyed, because two parties holding one token means one of them
 * stole it and there is no way to tell which is which.
 */
/**
 * Redeem an invitation.
 *
 * Public, because the invitee has no account to authenticate with yet -
 * the token is the credential. Rate limited by address, since it is a
 * public endpoint that checks a secret.
 */
authRouter.post(
  '/accept-invite',
  validateBody(acceptInviteSchema),
  rateLimit(BUCKETS.AUTH_IP),
  async (req, res, next) => {
    try {
      const user = await acceptInvite(req.body);
      const accessToken = await issueSession(req, res, user);
      res.json({ accessToken, user: user.toPrivate() });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post('/refresh', async (req, res, next) => {
  try {
    assertSameOrigin(req);
    const presented = req.cookies?.[COOKIE];
    if (!presented) throw ApiError.unauthorized('no_refresh_token', 'No refresh cookie present');

    const result = await consumeRefreshToken(presented);

    if (result.outcome === REFRESH_OUTCOME.REPLAYED) {
      res.clearCookie(COOKIE, refreshCookieOptions(0));
      throw ApiError.unauthorized(
        'token_replayed',
        'This session was ended for security reasons. Please sign in again.',
      );
    }
    if (result.outcome !== REFRESH_OUTCOME.OK) {
      res.clearCookie(COOKIE, refreshCookieOptions(0));
      throw ApiError.unauthorized('invalid_refresh_token', 'Refresh token is not valid');
    }

    const user = await User.findById(result.session.userId);
    if (!user || user.status === 'disabled') {
      throw ApiError.unauthorized('account_missing', 'Account is no longer active');
    }

    const accessToken = await issueSession(req, res, user);
    res.json({ accessToken, user: user.toPrivate() });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    assertSameOrigin(req);
    const presented = req.cookies?.[COOKIE];
    if (presented) await revokeRefreshToken(presented);
    res.clearCookie(COOKIE, refreshCookieOptions(0));
    // 204 whether or not anything was revoked. Logging out is idempotent
    // and a client should never have to handle it failing.
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', authenticate, tokenTenant, requireUser, (req, res) => {
  res.json({
    user: req.user.toPrivate(),
    organization: { name: req.org.name, slug: req.org.slug },
  });
});

authRouter.get('/sessions', authenticate, requireUser, async (req, res) => {
  res.json({ sessions: await listSessions(req.auth.userId) });
});

authRouter.delete('/sessions/:id', authenticate, requireUser, async (req, res, next) => {
  try {
    const revoked = await revokeSessionById(req.auth.userId, req.params.id);
    if (!revoked) throw ApiError.notFound('session_not_found', 'No such session');
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/sessions/revoke-all', authenticate, requireUser, async (req, res) => {
  const count = await revokeAllSessions(req.auth.userId);
  res.clearCookie(COOKIE, refreshCookieOptions(0));
  res.json({ revoked: count });
});
