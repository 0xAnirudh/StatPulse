import { COMPONENT_STATUS } from './constants.js';

/**
 * Deciding when a component has actually changed state.
 *
 * A single failed check means almost nothing. A dropped packet, a
 * rolling deploy, a garbage collection pause - all of them produce one
 * timeout from a service that is entirely healthy. Flipping the public
 * page to DOWN on that produces a page that cries wolf, and a page that
 * cries wolf is ignored during the one outage that matters.
 *
 * So a transition needs several checks to agree. The thresholds are
 * asymmetric on purpose: going down is a claim that needs evidence,
 * coming back up is one that needs less, because the cost of being
 * slightly slow to declare recovery is far lower than the cost of being
 * wrong about an outage.
 *
 * Pure: it takes counters and an outcome and returns new counters. The
 * caller decides where those live (Redis, in this system - they are
 * derived state and worthless after a gap).
 */

export const DEFAULT_THRESHOLDS = Object.freeze({
  /** Consecutive failures before the page says DOWN. 3 minutes at the default interval. */
  fail: 3,
  /** Consecutive slow-but-answering checks before it says DEGRADED. */
  slow: 2,
  /** Consecutive good checks before a component is allowed to recover. */
  recover: 2,
});

export const OUTCOME = Object.freeze({
  OK: 'ok',
  SLOW: 'slow',
  FAIL: 'fail',
});

export const EMPTY_COUNTERS = Object.freeze({ fail: 0, ok: 0, slow: 0, up: 0 });

/**
 * Classify one check.
 *
 * A component answering 401 to an unauthenticated probe is not down, so
 * what counts as success is per-component. Slow is measured against the
 * component's own ceiling: a 200ms database and a 3s report builder
 * cannot share one definition.
 */
export function classify({ ok, statusCode, responseMs }, { expectedStatusCodes, degradedAboveMs }) {
  if (!ok) return OUTCOME.FAIL;
  if (expectedStatusCodes?.length && !expectedStatusCodes.includes(statusCode)) return OUTCOME.FAIL;
  if (responseMs != null && responseMs > degradedAboveMs) return OUTCOME.SLOW;
  return OUTCOME.OK;
}

function advance(counters, outcome) {
  switch (outcome) {
    case OUTCOME.FAIL:
      return { fail: counters.fail + 1, ok: 0, slow: 0, up: 0 };
    case OUTCOME.SLOW:
      return { fail: 0, ok: 0, slow: counters.slow + 1, up: counters.up + 1 };
    default:
      return { fail: 0, ok: counters.ok + 1, slow: 0, up: counters.up + 1 };
  }
}

/**
 * Apply one outcome to a component's state.
 *
 * Returns the next status, the new counters, and whether anything
 * changed - because "changed" is the expensive signal. A transition
 * writes to Mongo, drops the cache and publishes an event; a
 * non-transition, which is the overwhelming majority, writes nothing.
 */
export function applyOutcome({ status, counters = EMPTY_COUNTERS, outcome, thresholds = {} }) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const next = advance(counters, outcome);

  let status_ = status;

  if (next.fail >= t.fail) {
    status_ = COMPONENT_STATUS.DOWN;
  } else if (status === COMPONENT_STATUS.DOWN) {
    // Leaving DOWN needs a run of checks that answered - of either
    // kind. A service that comes back slow is back, and saying so is
    // more useful than holding it at DOWN until it is also fast.
    if (next.up >= t.recover) {
      status_ = next.ok >= t.recover ? COMPONENT_STATUS.OPERATIONAL : COMPONENT_STATUS.DEGRADED;
    }
  } else if (next.slow >= t.slow) {
    status_ = COMPONENT_STATUS.DEGRADED;
  } else if (next.ok >= t.recover) {
    status_ = COMPONENT_STATUS.OPERATIONAL;
  }

  return { status: status_, counters: next, changed: status_ !== status };
}
