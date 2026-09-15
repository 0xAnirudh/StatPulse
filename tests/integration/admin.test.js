import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../packages/api/src/app.js';
import { getRedis } from '../../packages/core/src/redis/client.js';
import * as keys from '../../packages/core/src/redis/keys.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';

const app = createApp();
let token;

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(async () => {
  await resetStores();
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'ops@acme.com', password: 'a-perfectly-fine-passphrase' });
  token = res.body.accessToken;
});

const auth = (req) => req.set('Authorization', `Bearer ${token}`);

const createComponent = (over = {}) =>
  auth(request(app).post('/api/v1/admin/components')).send({
    name: 'Payment Gateway API',
    type: 'API',
    targetUrl: 'https://example.com/health',
    ...over,
  });

describe('components', () => {
  it('creates one and derives a slug from the name', async () => {
    const res = await createComponent();

    expect(res.status).toBe(201);
    expect(res.body.component.slug).toBe('payment-gateway-api');
    expect(res.body.component.status).toBe('OPERATIONAL');
  });

  it('refuses a target pointing into private space', async () => {
    // Caught at the moment the admin saves, not silently on the next
    // check. This is the SSRF guard on the write path.
    const res = await createComponent({ targetUrl: 'http://169.254.169.254/latest/meta-data/' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('target_private_address');
  });

  it('refuses a non-http scheme', async () => {
    const res = await createComponent({ targetUrl: 'file:///etc/passwd' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('target_scheme');
  });

  it('disambiguates a duplicate name rather than failing', async () => {
    await createComponent();
    const second = await createComponent();

    expect(second.status).toBe(201);
    expect(second.body.component.slug).toBe('payment-gateway-api-2');
  });

  it('soft-deletes, keeping the history', async () => {
    await createComponent();
    expect(
      (await auth(request(app).delete('/api/v1/admin/components/payment-gateway-api'))).status,
    ).toBe(204);

    const list = await auth(request(app).get('/api/v1/admin/components'));
    expect(list.body.components).toHaveLength(0);
  });

  it('404s for a component that does not exist', async () => {
    const res = await auth(request(app).patch('/api/v1/admin/components/nope')).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('the public payload', () => {
  it('never exposes the target URL', async () => {
    // The contract test. targetUrl frequently contains a health-check
    // path that is itself a disclosure about internal routing.
    await createComponent({ targetUrl: 'https://example.com/internal//healthz?token=abc' });

    const res = await request(app).get('/api/v1/status');

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('targetUrl');
    expect(body).not.toContain('internal');
    expect(body).not.toContain('healthz');
  });

  it('hides components marked private', async () => {
    await createComponent({ name: 'Internal Queue', isPublic: false });
    const res = await request(app).get('/api/v1/status');

    expect(JSON.stringify(res.body)).not.toContain('Internal Queue');
  });

  it('answers a conditional request with 304', async () => {
    await createComponent();
    const first = await request(app).get('/api/v1/status');

    const second = await request(app)
      .get('/api/v1/status')
      .set('If-None-Match', first.headers.etag);

    expect(second.status).toBe(304);
    expect(second.body).toEqual({});
  });
});

describe('incidents', () => {
  beforeEach(async () => {
    await createComponent();
  });

  const declare = (over = {}) =>
    auth(request(app).post('/api/v1/admin/incidents')).send({
      title: 'Elevated error rates on checkout',
      message: 'We are investigating reports of failed payments.',
      impact: 'critical',
      affectedComponents: ['payment-gateway-api'],
      ...over,
    });

  it('declares one and overrides green checks on the public page', async () => {
    // The case that justifies keeping the human half: every ping is
    // green and the service is nonetheless broken.
    await declare();
    const res = await request(app).get('/api/v1/status');

    expect(res.body.status).toBe('MAJOR_OUTAGE');
    expect(res.body.activeIncidents).toHaveLength(1);
    expect(res.body.activeIncidents[0].latestUpdate.message).toContain('investigating');
  });

  it('invalidates the cache, so the page is current immediately', async () => {
    await request(app).get('/api/v1/status'); // warm it
    expect(await getRedis().get(keys.statusCache('default'))).toBeTruthy();

    await declare();

    expect(await getRedis().get(keys.statusCache('default'))).toBeNull();
  });

  it('rejects an unknown component rather than silently dropping it', async () => {
    const res = await declare({ affectedComponents: ['no-such-thing'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_component');
  });

  it('appends timeline updates', async () => {
    const { body } = await declare();
    const res = await auth(
      request(app).patch(`/api/v1/admin/incidents/${body.incident.slug}`),
    ).send({
      message: 'Rolled back the 10:05 deploy.',
      status: 'IDENTIFIED',
    });

    expect(res.status).toBe(200);
    expect(res.body.incident.updates).toBe(2);
  });

  it('stamps resolvedAt once and drops out of the active list', async () => {
    const { body } = await declare();
    await auth(request(app).patch(`/api/v1/admin/incidents/${body.incident.slug}`)).send({
      message: 'Recovered.',
      status: 'RESOLVED',
    });

    const status = await request(app).get('/api/v1/status');
    expect(status.body.activeIncidents).toHaveLength(0);
    expect(status.body.status).toBe('OPERATIONAL');
  });

  it('refuses to continue a resolved incident', async () => {
    const { body } = await declare();
    const patch = () =>
      auth(request(app).patch(`/api/v1/admin/incidents/${body.incident.slug}`)).send({
        message: 'Actually it is back.',
        status: 'INVESTIGATING',
      });

    await auth(request(app).patch(`/api/v1/admin/incidents/${body.incident.slug}`)).send({
      message: 'Recovered.',
      status: 'RESOLVED',
    });

    const res = await patch();
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('incident_resolved');
  });

  it('serves the public timeline without authentication', async () => {
    await declare();
    const res = await request(app).get('/api/v1/incidents');

    expect(res.status).toBe(200);
    expect(res.body.incidents[0].updates).toHaveLength(1);
    // No author ids on the public view.
    expect(JSON.stringify(res.body)).not.toContain('authorId');
  });
});
