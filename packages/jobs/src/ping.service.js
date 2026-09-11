import http from 'node:http';
import https from 'node:https';
import axios from 'axios';
import { config, assertSafeTarget, UnsafeTargetError } from '@statpulse/core';
import { ERROR_CLASS } from '@statpulse/shared';

/**
 * Executing one health check.
 *
 * Returns a result for every call. A timeout is not an exception here -
 * it is the measurement. The only things that throw are our own bugs.
 */

/** We need a status line and a duration, not a page. */
const MAX_BYTES = 64 * 1024;

/** Redirect hops, each re-validated. */
const MAX_REDIRECTS = 3;

function classifyError(err) {
  if (err instanceof UnsafeTargetError) return ERROR_CLASS.BLOCKED;

  const code = err.code ?? '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || err.message?.includes('timeout')) {
    return ERROR_CLASS.TIMEOUT;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return ERROR_CLASS.DNS;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return ERROR_CLASS.CONN_REFUSED;
  if (
    code.startsWith('ERR_TLS') ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return ERROR_CLASS.TLS;
  }
  if (err.message?.includes('maxContentLength')) return ERROR_CLASS.TOO_LARGE;
  return ERROR_CLASS.UNKNOWN;
}

/**
 * One request, pinned to an address we already approved.
 *
 * A fresh agent per check rather than a shared keep-alive pool. That
 * gives up connection reuse, which at one check a minute is worth
 * nothing, and buys the thing that matters: the pinned lookup cannot
 * leak into a pooled socket belonging to a different target.
 */
async function request(url, lookup, component) {
  const agentOptions = { lookup, keepAlive: false };
  return axios({
    method: component.method ?? 'GET',
    url: url.toString(),
    timeout: component.timeoutMs ?? 5_000,
    // Each hop is re-validated by the caller rather than followed
    // blindly. A 302 to 169.254.169.254 is the oldest trick there is.
    maxRedirects: 0,
    // A 500 is data, not an exception. Whether it counts as a failure is
    // the component's own expectedStatusCodes decision, made later.
    validateStatus: () => true,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    decompress: false,
    headers: {
      'User-Agent': 'StatPulse/1.0 (+https://statpulse.dev/bot)',
      Accept: '*/*',
    },
    httpAgent: new http.Agent(agentOptions),
    httpsAgent: new https.Agent(agentOptions),
  });
}

const isRedirect = (status) => status >= 300 && status < 400;

/**
 * Check one component.
 *
 * The timer starts before DNS resolution, deliberately. A DNS failure is
 * an outage from a user's point of view even when the origin is
 * perfectly healthy, and timing only the socket would hide that.
 */
export async function checkComponent(
  component,
  { allowPrivate = config.ALLOW_PRIVATE_TARGETS } = {},
) {
  const started = process.hrtime.bigint();
  const elapsedMs = () => Number(process.hrtime.bigint() - started) / 1e6;

  let target = component.targetUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const { url, lookup } = await assertSafeTarget(target, { allowPrivate });

      const response = await request(url, lookup, component);

      if (isRedirect(response.status) && response.headers.location) {
        if (hop === MAX_REDIRECTS) {
          return {
            ok: false,
            statusCode: response.status,
            responseMs: Math.round(elapsedMs()),
            errorClass: ERROR_CLASS.HTTP_ERROR,
          };
        }
        // Resolved against the current URL so a relative Location works,
        // then straight back through the guard on the next pass.
        target = new URL(response.headers.location, url).toString();
        continue;
      }

      return {
        ok: true,
        statusCode: response.status,
        responseMs: Math.round(elapsedMs()),
        errorClass: null,
      };
    }

    // Unreachable: the loop either returns or continues.
    return { ok: false, responseMs: Math.round(elapsedMs()), errorClass: ERROR_CLASS.UNKNOWN };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      responseMs: Math.round(elapsedMs()),
      errorClass: classifyError(err),
      error: err.message,
    };
  }
}
