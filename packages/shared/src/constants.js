/**
 * The vocabulary of the whole system, in one place.
 *
 * These strings appear in the database, in the public API payload and on
 * the page. They are a contract with anyone who has written a script
 * against the status endpoint, so they are frozen objects rather than
 * loose literals scattered across files - a typo in a comparison is
 * otherwise silent and always false.
 */

/**
 * What a single monitored component can be.
 *
 * Three states, deliberately. A checker knows whether something answered
 * and how fast; anything more nuanced than that is a judgement a human
 * makes, and humans express it by declaring an incident.
 */
export const COMPONENT_STATUS = Object.freeze({
  OPERATIONAL: 'OPERATIONAL',
  DEGRADED: 'DEGRADED',
  DOWN: 'DOWN',
});

export const COMPONENT_TYPES = Object.freeze(['API', 'Database', 'Website', 'Webhook']);

/**
 * What the system as a whole is, which is a wider question.
 *
 * The interesting cases are the partial ones: "some things are down" is
 * a different message to a customer than "everything is down", and
 * collapsing them into one word is how status pages end up saying
 * nothing useful.
 */
export const SYSTEM_STATUS = Object.freeze({
  OPERATIONAL: 'OPERATIONAL',
  DEGRADED: 'DEGRADED',
  PARTIAL_OUTAGE: 'PARTIAL_OUTAGE',
  MAJOR_OUTAGE: 'MAJOR_OUTAGE',
  MAINTENANCE: 'MAINTENANCE',
});

/**
 * The stages of an incident, in the order they normally happen.
 *
 * Normally, not necessarily: an incident can go back from MONITORING to
 * IDENTIFIED when a fix does not hold, and the timeline should show that
 * honestly rather than pretending recovery was monotonic.
 */
export const INCIDENT_STATUS = Object.freeze({
  INVESTIGATING: 'INVESTIGATING',
  IDENTIFIED: 'IDENTIFIED',
  MONITORING: 'MONITORING',
  RESOLVED: 'RESOLVED',
});

export const INCIDENT_IMPACT = Object.freeze({
  MINOR: 'minor',
  MAJOR: 'major',
  CRITICAL: 'critical',
});

/**
 * How a check failed, when it did.
 *
 * Kept per sample because "the DNS record is gone" and "it returned 500"
 * lead to entirely different pages of a runbook, and a status page that
 * flattens both into "down" throws that away.
 */
export const ERROR_CLASS = Object.freeze({
  TIMEOUT: 'timeout',
  DNS: 'dns',
  CONN_REFUSED: 'conn_refused',
  TLS: 'tls',
  HTTP_ERROR: 'http_error',
  TOO_LARGE: 'too_large',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
});
