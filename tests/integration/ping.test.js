import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { checkComponent } from '../../packages/jobs/src/ping.service.js';
import { ERROR_CLASS } from '../../packages/shared/src/index.js';

/**
 * A real HTTP server on loopback, driven through the real check.
 *
 * Loopback is blocked by the SSRF guard - which is the point of the
 * first test. The rest pass `allowPrivate`, the same switch a
 * self-hosted install uses to monitor its own internal services.
 */
let server;
let base;
const local = { allowPrivate: true };

const component = (path, overrides = {}) => ({
  targetUrl: `${base}${path}`,
  method: 'GET',
  timeoutMs: 2_000,
  ...overrides,
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, base);

    if (url.pathname === '/ok') return res.writeHead(200).end('fine');
    if (url.pathname === '/teapot') return res.writeHead(418).end('short and stout');
    if (url.pathname === '/boom') return res.writeHead(500).end('broken');
    if (url.pathname === '/slow') {
      return setTimeout(() => res.writeHead(200).end('eventually'), 300);
    }
    if (url.pathname === '/tarpit') return; // never answers
    if (url.pathname === '/redirect-once') {
      return res.writeHead(302, { location: '/ok' }).end();
    }
    if (url.pathname === '/redirect-to-metadata') {
      return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    }
    if (url.pathname === '/redirect-to-redis') {
      return res.writeHead(302, { location: 'http://127.0.0.1:6379/' }).end();
    }
    if (url.pathname === '/redirect-loop') {
      return res.writeHead(302, { location: '/redirect-loop' }).end();
    }
    if (url.pathname === '/huge') {
      res.writeHead(200);
      return res.end('x'.repeat(200 * 1024));
    }
    res.writeHead(404).end();
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((done) => server.close(done)));

describe('the SSRF guard, in the path', () => {
  it('refuses loopback by default', async () => {
    // Not a configuration detail - this is the guard actually wired into
    // the thing that makes requests.
    const result = await checkComponent(component('/ok'));

    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe(ERROR_CLASS.BLOCKED);
  });

  it('re-validates every redirect hop, not just the first URL', async () => {
    // The oldest trick: pass validation with a harmless URL, then 302
    // somewhere forbidden. The destination here is a blocked *port*,
    // which is refused regardless of allowPrivate - so this proves the
    // second hop went back through the guard rather than being followed
    // on the strength of the first one passing.
    const result = await checkComponent(component('/redirect-to-redis'), local);

    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe(ERROR_CLASS.BLOCKED);
  });

  it('allowPrivate is all-or-nothing, including for redirect targets', async () => {
    // Worth stating plainly: a self-hosted install that opts into
    // private targets has also opted into private redirect destinations.
    // There is no coherent middle ground - if 10.0.0.5 is a legitimate
    // thing to monitor, a redirect to it is legitimate too.
    const result = await checkComponent(component('/redirect-to-metadata'), local);
    expect(result.errorClass).not.toBe(ERROR_CLASS.BLOCKED);
  });
});

describe('a successful check', () => {
  it('records the status code and a plausible duration', async () => {
    const result = await checkComponent(component('/ok'), local);

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.responseMs).toBeGreaterThanOrEqual(0);
    expect(result.responseMs).toBeLessThan(2_000);
    expect(result.errorClass).toBeNull();
  });

  it('reports a 500 as a successful check that saw a 500', async () => {
    // Whether that counts as an outage is the component's own
    // expectedStatusCodes decision, made later by classify().
    const result = await checkComponent(component('/boom'), local);

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('measures a slow response rather than giving up on it', async () => {
    const result = await checkComponent(component('/slow'), local);

    expect(result.ok).toBe(true);
    expect(result.responseMs).toBeGreaterThanOrEqual(250);
  });

  it('follows a redirect to its destination', async () => {
    const result = await checkComponent(component('/redirect-once'), local);

    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('gives up on a redirect loop instead of following it forever', async () => {
    const result = await checkComponent(component('/redirect-loop'), local);

    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe(ERROR_CLASS.HTTP_ERROR);
  });
});

describe('failure', () => {
  it('times out rather than holding a worker slot forever', async () => {
    // A tarpit that accepts the connection and never answers is the
    // worst case for a checker: without a timeout it holds a slot until
    // the process dies.
    const started = Date.now();
    const result = await checkComponent(component('/tarpit', { timeoutMs: 400 }), local);

    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe(ERROR_CLASS.TIMEOUT);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('refuses a body larger than a status line needs', async () => {
    // We need a status code and a duration. Downloading 200KB from every
    // target every minute would be someone else's bandwidth bill.
    const result = await checkComponent(component('/huge'), local);
    expect(result.ok).toBe(false);
  });

  it('classifies a refused connection', async () => {
    // Port 1 on loopback: nothing is listening.
    const result = await checkComponent(
      { targetUrl: 'http://127.0.0.1:1/', timeoutMs: 1_000 },
      local,
    );

    expect(result.ok).toBe(false);
    expect([ERROR_CLASS.CONN_REFUSED, ERROR_CLASS.UNKNOWN]).toContain(result.errorClass);
  });

  it('never throws - a failed check is data, not an exception', async () => {
    // The worker depends on this: a throw would become a BullMQ retry,
    // and retrying a genuine outage erases the signal.
    await expect(
      checkComponent({ targetUrl: 'http://nope.invalid/' }, local),
    ).resolves.toMatchObject({ ok: false });
    await expect(checkComponent({ targetUrl: 'garbage' }, local)).resolves.toMatchObject({
      ok: false,
    });
  });
});
