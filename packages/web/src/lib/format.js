export const SEVERITY = {
  OPERATIONAL: 'ok',
  DEGRADED: 'warn',
  PARTIAL_OUTAGE: 'warn',
  MAJOR_OUTAGE: 'bad',
  MAINTENANCE: 'warn',
  DOWN: 'bad',
};

export const HEADLINE = {
  OPERATIONAL: 'All systems operational',
  DEGRADED: 'Degraded performance',
  PARTIAL_OUTAGE: 'Partial outage',
  MAJOR_OUTAGE: 'Major outage',
  MAINTENANCE: 'Under maintenance',
};

export const STATUS_LABEL = {
  OPERATIONAL: 'Operational',
  DEGRADED: 'Degraded',
  DOWN: 'Down',
};

export const INCIDENT_LABEL = {
  INVESTIGATING: 'Investigating',
  IDENTIFIED: 'Identified',
  MONITORING: 'Monitoring',
  RESOLVED: 'Resolved',
};

export const IMPACT_SEVERITY = { minor: 'warn', major: 'warn', critical: 'bad' };

export function ago(iso) {
  if (!iso) return '—';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const ms = (n) => (n == null ? '—' : `${n} ms`);

/**
 * Uptime, shown honestly.
 *
 * The API returns null for a component nothing has measured yet, and
 * that is not the same as 100%. Printing a perfect score for something
 * never checked is the one lie a status page cannot afford.
 */
export const uptime = (n) => (n == null ? 'no data' : `${n}%`);
