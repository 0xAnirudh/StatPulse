/**
 * Every Redis key the application uses, in one place.
 *
 * Built through functions rather than by concatenation at the call site,
 * so the complete keyspace is knowable - which is what makes it possible
 * to say with confidence that nothing here grows without bound.
 *
 * One instance holds five unrelated things. They are namespaced by
 * prefix so that a future split (cache onto a volatile instance,
 * sessions and queues onto a durable one) is a configuration change
 * rather than a search-and-replace.
 */

/* ---- the public status cache ---------------------------------------- */

/**
 * The composed public payload.
 *
 * The `:v1` suffix is a deploy-time escape hatch. When the payload shape
 * changes, bumping it is cheaper and safer than reasoning about a mix of
 * old and new documents in flight during a rolling deploy.
 */
export const statusCache = (org) => `cache:status:${org}:v1`;

/** Last-known-good, kept far longer, read only when Mongo is down. */
export const statusStale = (org) => `cache:status:${org}:stale`;

/** The ETag of whatever is currently in statusCache. */
export const statusEtag = (org) => `cache:etag:${org}`;

/** Held by the one request permitted to rebuild a missing payload. */
export const statusLock = (org) => `lock:status:${org}`;

/** Uptime percentages, refreshed by the flusher, merged in on a miss. */
export const uptimeCache = (org) => `cache:uptime:${org}`;

/* ---- rate limiting --------------------------------------------------- */

/** Sliding window of request timestamps for one caller in one bucket. */
export const rateLimit = (bucket, identifier) => `rl:${bucket}:${identifier}`;

/* ---- sessions -------------------------------------------------------- */

/** The set of live refresh-token hashes for one user. SREM revokes. */
export const sessionSet = (userId) => `session:refresh:${userId}`;

/** Hash of one refresh token to the session it belongs to. */
export const sessionToken = (hash) => `session:token:${hash}`;

/**
 * A rotated token, kept briefly.
 *
 * Presenting a token that is no longer live but is still marked used
 * means it was replayed, which is the signal that one has been stolen.
 */
export const sessionUsed = (hash) => `session:used:${hash}`;

/* ---- component liveness ---------------------------------------------- */

/**
 * The live snapshot for one component: latency, last check, last code.
 *
 * Written every check. Deliberately not in Mongo - see the flusher for
 * why writing this 1,440 times a day per component is the thing the
 * whole metrics design exists to avoid.
 */
export const componentLive = (componentId) => `comp:${componentId}:live`;

/** Consecutive-failure counters. Derived state, worthless after a gap. */
export const componentHealth = (componentId) => `comp:${componentId}:health`;

/* ---- the write-behind buffer and events ------------------------------ */

/** The stream every check is appended to, drained by the flusher. */
export const METRICS_STREAM = 'metrics:pings';

/** Consumer group name for the flusher. */
export const METRICS_GROUP = 'flush';

/** Status transitions and incident updates, for realtime fan-out. */
export const EVENTS_CHANNEL = 'events:status';
