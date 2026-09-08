import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { connectRedis, disconnectRedis, getRedis } from '../../packages/core/src/redis/client.js';
import {
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  listSessions,
  revokeSessionById,
  REFRESH_OUTCOME,
} from '../../packages/api/src/services/token.js';

const user = () => ({
  _id: new mongoose.Types.ObjectId(),
  orgId: new mongoose.Types.ObjectId(),
  role: 'admin',
  tokenVersion: 0,
});

beforeAll(connectRedis);
afterAll(disconnectRedis);
beforeEach(async () => {
  await getRedis().flushdb();
});

describe('access tokens', () => {
  it('carries the claims the request path needs and nothing it does not', () => {
    const u = user();
    const claims = verifyAccessToken(issueAccessToken(u));

    expect(claims.sub).toBe(u._id.toString());
    expect(claims.org).toBe(u.orgId.toString());
    expect(claims.role).toBe('admin');
    expect(claims.tv).toBe(0);
    // No email, no name. A JWT is signed, not encrypted: everything in
    // it is readable by anyone holding it.
    expect(claims).not.toHaveProperty('email');
  });

  it('refuses a token signed with the wrong key', () => {
    const forged = issueAccessToken(user()).slice(0, -3) + 'aaa';
    expect(() => verifyAccessToken(forged)).toThrow();
  });
});

describe('refresh tokens', () => {
  it('is opaque - it tells a reader nothing about whose it is', async () => {
    const u = user();
    const { token } = await issueRefreshToken(u);

    expect(token).not.toContain(u._id.toString());
    expect(token).not.toContain('.');
    // Whatever a cookie thief has, it is not a decodable user id.
    expect(() => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toThrow();
  });

  it('exchanges once and then is dead', async () => {
    const u = user();
    const { token } = await issueRefreshToken(u);

    const first = await consumeRefreshToken(token);
    expect(first.outcome).toBe(REFRESH_OUTCOME.OK);
    expect(first.session.userId).toBe(u._id.toString());

    // The whole point of rotation: the token just used is now worthless.
    const second = await consumeRefreshToken(token);
    expect(second.outcome).toBe(REFRESH_OUTCOME.REPLAYED);
  });

  it('destroys every session when a token is replayed', async () => {
    // Two devices logged in. One token is stolen and used after the
    // legitimate client has already rotated it. Both sessions die.
    const u = user();
    const stolen = await issueRefreshToken(u);
    await issueRefreshToken(u);
    expect(await listSessions(u._id.toString())).toHaveLength(2);

    await consumeRefreshToken(stolen.token);
    const replay = await consumeRefreshToken(stolen.token);

    expect(replay.outcome).toBe(REFRESH_OUTCOME.REPLAYED);
    expect(await listSessions(u._id.toString())).toHaveLength(0);
  });

  it('treats a token it has never seen as unknown, not as a replay', async () => {
    // Someone guessing, or a cookie left over from a wiped Redis. It is
    // a plain 401 - raising the alarm on it would make an expired
    // session look like a breach.
    const result = await consumeRefreshToken('not-a-token-anyone-issued');
    expect(result.outcome).toBe(REFRESH_OUTCOME.UNKNOWN);
  });
});

describe('revocation', () => {
  it('takes effect immediately, not at expiry', async () => {
    const u = user();
    const { token } = await issueRefreshToken(u);

    expect(await revokeRefreshToken(token)).toBe(true);
    expect((await consumeRefreshToken(token)).outcome).toBe(REFRESH_OUTCOME.UNKNOWN);
  });

  it('logs out everywhere in one call', async () => {
    const u = user();
    await issueRefreshToken(u);
    await issueRefreshToken(u);
    await issueRefreshToken(u);

    expect(await revokeAllSessions(u._id.toString())).toBe(3);
    expect(await listSessions(u._id.toString())).toHaveLength(0);
  });

  it('revokes one session by its public id without exposing the token', async () => {
    const u = user();
    const keep = await issueRefreshToken(u);
    const drop = await issueRefreshToken(u);

    expect(await revokeSessionById(u._id.toString(), drop.sessionId)).toBe(true);

    const left = await listSessions(u._id.toString());
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(keep.sessionId);
  });

  it('leaves no key behind when a session ends', async () => {
    // An unbounded keyspace is a production incident with a long fuse.
    const u = user();
    const { token } = await issueRefreshToken(u);
    await revokeRefreshToken(token);

    const leftover = await getRedis().keys('session:token:*');
    expect(leftover).toHaveLength(0);
  });
});

describe('the sessions list', () => {
  it('records where a session came from, for someone auditing their own', async () => {
    const u = user();
    await issueRefreshToken(u, { ip: '203.0.113.7', userAgent: 'Firefox/141' });

    const [session] = await listSessions(u._id.toString());
    expect(session.ip).toBe('203.0.113.7');
    expect(session.userAgent).toBe('Firefox/141');
    expect(session).not.toHaveProperty('token');
  });
});
