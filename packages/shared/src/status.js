import { COMPONENT_STATUS, SYSTEM_STATUS, INCIDENT_IMPACT } from './constants.js';

/**
 * Deriving the one word at the top of the status page.
 *
 * Pure functions over plain objects, with no database and no clock, so
 * every combination that matters can be checked directly rather than
 * assembled through four collections and an HTTP request.
 */

/**
 * Severity ordering.
 *
 * MAINTENANCE is absent on purpose: a planned window is not a point on
 * this scale, it is a different kind of statement, and forcing it into
 * the ordering would mean either a maintenance window hides a real
 * outage or an outage hides the maintenance notice. It gets applied
 * separately, above this function, when it arrives.
 */
const SEVERITY = {
  [SYSTEM_STATUS.OPERATIONAL]: 0,
  [SYSTEM_STATUS.DEGRADED]: 1,
  [SYSTEM_STATUS.PARTIAL_OUTAGE]: 2,
  [SYSTEM_STATUS.MAJOR_OUTAGE]: 3,
};

export function worse(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * What the checkers think.
 *
 * "Some components are down" and "everything is down" are different
 * messages to a customer - the first means try another feature, the
 * second means go and get a coffee - so they get different words.
 */
export function deriveFromComponents(components) {
  if (components.length === 0) return SYSTEM_STATUS.OPERATIONAL;

  const down = components.filter((c) => c.status === COMPONENT_STATUS.DOWN).length;
  const degraded = components.filter((c) => c.status === COMPONENT_STATUS.DEGRADED).length;

  if (down === components.length) return SYSTEM_STATUS.MAJOR_OUTAGE;
  if (down > 0) return SYSTEM_STATUS.PARTIAL_OUTAGE;
  if (degraded > 0) return SYSTEM_STATUS.DEGRADED;
  return SYSTEM_STATUS.OPERATIONAL;
}

/**
 * What a human has declared.
 *
 * Each impact grade maps to a distinct system status. The plan folded
 * minor and major together into DEGRADED, which made the two grades
 * indistinguishable on the page and left an admin choosing between three
 * labels that produced two outcomes.
 */
const IMPACT_STATUS = {
  [INCIDENT_IMPACT.MINOR]: SYSTEM_STATUS.DEGRADED,
  [INCIDENT_IMPACT.MAJOR]: SYSTEM_STATUS.PARTIAL_OUTAGE,
  [INCIDENT_IMPACT.CRITICAL]: SYSTEM_STATUS.MAJOR_OUTAGE,
};

export function deriveFromIncidents(openIncidents) {
  return openIncidents.reduce(
    (acc, incident) => worse(acc, IMPACT_STATUS[incident.impact] ?? SYSTEM_STATUS.DEGRADED),
    SYSTEM_STATUS.OPERATIONAL,
  );
}

/**
 * The overall status: the worse of what the machines measured and what a
 * human declared.
 *
 * Both halves are necessary and neither may override the other.
 * Automated checks miss what they cannot see - payments accepted but
 * settling wrongly, a queue silently backing up - and humans miss what
 * they are not watching at 4am. So when an admin declares a critical
 * incident the page says so even though every ping is green, and when
 * every ping fails the page says so even though nobody has written an
 * update yet.
 */
export function deriveSystemStatus({ components = [], openIncidents = [] } = {}) {
  return worse(deriveFromComponents(components), deriveFromIncidents(openIncidents));
}
