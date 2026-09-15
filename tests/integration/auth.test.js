import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { User } from '../../packages/core/src/models/User.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';

const app = createApp();

const CREDENTIALS = { email: 'ops@acme.com', password: 'a-perfectly-fine-passphrase' };

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

const register = () => request(app).post('/api/v1/auth/register').send(CREDENTIALS);
const login = (over = {}) =>
  request(app)
    .post('/api/v1/auth/login')
    .send({ ...CREDENTIALS, ...over });

const cookieFrom = (res) => res.headers['set-cookie']?.find((c) => c.startsWith('sp_rt='));

describe('registration', () => {
  it('creates the first account as an owner', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('owner');
    expect(res.body.accessToken).toBeTruthy();
    // No hash, ever, by any route.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('refuses the second account', async () => {
    // The first stranger to find this URL must not become an
    // administrator of someone else's status page.
    await register();
    const second = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'someone@else.com', password: 'another-fine-passphrase' });

    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('registration_closed');
  });

  it('sets an httpOnly refresh cookie scoped to the auth routes', async () => {
    const cookie = cookieFrom(await register());

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // Scoped, so it does not ride along on every public status request.
    expect(cookie).toContain('Path=/api/v1/auth');
  });
});

describe('login', () => {
  beforeEach(async () => {
    await register();
  });

  it('accepts the right password', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    // Anything else is a free account-enumeration oracle.
    const wrong = await login({ password: 'not-the-right-passphrase' });
    const unknown = await login({ email: 'nobody@acme.com' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('refuses a disabled account', async () => {
    await User.updateOne({ email: CREDENTIALS.email }, { $set: { status: 'disabled' } });
    const res = await login();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('account_disabled');
  });
});

describe('the session lifecycle', () => {
  it('refreshes, rotating the cookie', async () => {
    const cookie = cookieFrom(await register());

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    expect(cookieFrom(refreshed)).not.toBe(cookie);
  });

  it('kills every session when a rotated cookie is replayed', async () => {
    // Two parties holding one token means one of them stole it, and
    // there is no way to tell which. Trust neither.
    const cookie = cookieFrom(await register());
    await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);

    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('token_replayed');
  });

  it('logs out immediately rather than waiting for expiry', async () => {
    const cookie = cookieFrom(await register());

    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(204);

    const after = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('identifies the caller on /me', async () => {
    const { body } = await register();
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(CREDENTIALS.email);
    expect(res.body.organization.slug).toBe('default');
  });

  it('rejects an access token whose account has been revoked', async () => {
    // The tokenVersion lever: the signature and expiry are both still
    // perfectly good, and the token is refused anyway.
    const { body } = await register();
    await User.updateOne({ email: CREDENTIALS.email }, { $inc: { tokenVersion: 1 } });

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${body.accessToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('token_revoked');
  });
});
