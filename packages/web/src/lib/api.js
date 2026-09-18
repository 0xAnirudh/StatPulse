/**
 * The API client.
 *
 * The access token lives in a module variable, not in localStorage. That
 * is deliberate: anything in localStorage is readable by any script that
 * ends up on the page, and a fifteen-minute token sitting there is a
 * fifteen-minute window for whatever got injected. Memory dies with the
 * tab, and the httpOnly refresh cookie is what survives a reload - which
 * is exactly the split the backend was designed around.
 */

let accessToken = null;
let onAuthLost = () => {};

export function setAccessToken(token) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

export function onSessionLost(fn) {
  onAuthLost = fn;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.details = details ?? [];
  }

  /** Server-side field errors, keyed for a form to render inline. */
  get fieldErrors() {
    const out = {};
    for (const d of this.details) if (d.field) out[d.field] = d.message;
    return out;
  }
}

/**
 * One refresh at a time.
 *
 * Three requests firing at once against an expired token would otherwise
 * each try to refresh - and because refresh tokens rotate, the second
 * and third would present a token the first had already exchanged. The
 * backend treats that as a replay and destroys every session, so the
 * user gets logged out for being slightly parallel. Sharing one promise
 * is what prevents it.
 */
let refreshing = null;

async function refresh() {
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) return null;
      const body = await res.json();
      accessToken = body.accessToken;
      return body;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function parse(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function send(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { ...headers },
  };

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (auth && accessToken) init.headers.Authorization = `Bearer ${accessToken}`;

  return fetch(path, init);
}

export async function request(path, options = {}) {
  let res = await send(path, options);

  /**
   * One retry, after a refresh.
   *
   * Access tokens last fifteen minutes, so an open dashboard will hit
   * this routinely. The user should never see it happen.
   */
  if (res.status === 401 && options.auth !== false && accessToken) {
    const renewed = await refresh();
    if (!renewed) {
      accessToken = null;
      onAuthLost();
    } else {
      res = await send(path, options);
    }
  }

  const payload = await parse(res);

  if (!res.ok) {
    const err = payload?.error ?? {};
    throw new ApiError(res.status, err.code, err.message, err.details);
  }

  return payload;
}

/* ---- the surface, named ------------------------------------------------ */

export const api = {
  // public
  status: () => request('/api/v1/status', { auth: false }),
  component: (slug) => request(`/api/v1/status/components/${slug}`, { auth: false }),
  incidents: (params = '') => request(`/api/v1/incidents${params}`, { auth: false }),
  incident: (slug) => request(`/api/v1/incidents/${slug}`, { auth: false }),

  // session
  login: (body) => request('/api/v1/auth/login', { method: 'POST', body, auth: false }),
  register: (body) => request('/api/v1/auth/register', { method: 'POST', body, auth: false }),
  acceptInvite: (body) =>
    request('/api/v1/auth/accept-invite', { method: 'POST', body, auth: false }),
  refresh,
  logout: () => request('/api/v1/auth/logout', { method: 'POST' }),
  me: () => request('/api/v1/auth/me'),
  sessions: () => request('/api/v1/auth/sessions'),
  revokeSession: (id) => request(`/api/v1/auth/sessions/${id}`, { method: 'DELETE' }),

  // admin - components
  adminComponents: () => request('/api/v1/admin/components'),
  createComponent: (body) => request('/api/v1/admin/components', { method: 'POST', body }),
  updateComponent: (slug, body) =>
    request(`/api/v1/admin/components/${slug}`, { method: 'PATCH', body }),
  deleteComponent: (slug) => request(`/api/v1/admin/components/${slug}`, { method: 'DELETE' }),
  checkNow: (slug) => request(`/api/v1/admin/components/${slug}/check`, { method: 'POST' }),

  // admin - incidents
  adminIncidents: () => request('/api/v1/admin/incidents'),
  createIncident: (body) => request('/api/v1/admin/incidents', { method: 'POST', body }),
  updateIncident: (slug, body) =>
    request(`/api/v1/admin/incidents/${slug}`, { method: 'PATCH', body }),

  // admin - people
  users: () => request('/api/v1/admin/users'),
  invite: (body) => request('/api/v1/admin/users/invite', { method: 'POST', body }),
  updateUser: (id, body) => request(`/api/v1/admin/users/${id}`, { method: 'PATCH', body }),
};
