import { describe, it, expect } from 'vitest';
import {
  COMPONENT_STATUS as CS,
  SYSTEM_STATUS as SS,
  INCIDENT_IMPACT as II,
  deriveFromComponents,
  deriveFromIncidents,
  deriveSystemStatus,
  worse,
} from '../../packages/shared/src/index.js';

const comp = (status) => ({ status });

describe('deriveFromComponents', () => {
  it('is operational when there is nothing to report', () => {
    expect(deriveFromComponents([])).toBe(SS.OPERATIONAL);
    expect(deriveFromComponents([comp(CS.OPERATIONAL), comp(CS.OPERATIONAL)])).toBe(SS.OPERATIONAL);
  });

  it('distinguishes some down from all down', () => {
    // The distinction the whole wider enum exists for: "try another
    // feature" versus "go and get a coffee".
    expect(deriveFromComponents([comp(CS.DOWN), comp(CS.OPERATIONAL)])).toBe(SS.PARTIAL_OUTAGE);
    expect(deriveFromComponents([comp(CS.DOWN), comp(CS.DOWN)])).toBe(SS.MAJOR_OUTAGE);
  });

  it('a single component that is down is a major outage, not a partial one', () => {
    // Every component being down happens to mean one component here.
    // From the customer's side the whole service is gone.
    expect(deriveFromComponents([comp(CS.DOWN)])).toBe(SS.MAJOR_OUTAGE);
  });

  it('lets down outrank degraded', () => {
    expect(deriveFromComponents([comp(CS.DEGRADED), comp(CS.DOWN)])).toBe(SS.PARTIAL_OUTAGE);
    expect(deriveFromComponents([comp(CS.DEGRADED), comp(CS.OPERATIONAL)])).toBe(SS.DEGRADED);
  });
});

describe('deriveFromIncidents', () => {
  it('maps each impact grade to a distinct status', () => {
    // Three labels an admin can pick, three outcomes on the page. If two
    // of them rendered identically the choice would be theatre.
    expect(deriveFromIncidents([{ impact: II.MINOR }])).toBe(SS.DEGRADED);
    expect(deriveFromIncidents([{ impact: II.MAJOR }])).toBe(SS.PARTIAL_OUTAGE);
    expect(deriveFromIncidents([{ impact: II.CRITICAL }])).toBe(SS.MAJOR_OUTAGE);
  });

  it('takes the worst of several open incidents', () => {
    expect(deriveFromIncidents([{ impact: II.MINOR }, { impact: II.CRITICAL }])).toBe(
      SS.MAJOR_OUTAGE,
    );
  });

  it('is operational when nothing is open', () => {
    expect(deriveFromIncidents([])).toBe(SS.OPERATIONAL);
  });
});

describe('deriveSystemStatus', () => {
  it('lets a human override green checks', () => {
    // The case that justifies keeping both halves: payments answer 200
    // and settle to the wrong ledger. No checker can see that.
    const status = deriveSystemStatus({
      components: [comp(CS.OPERATIONAL), comp(CS.OPERATIONAL)],
      openIncidents: [{ impact: II.CRITICAL }],
    });
    expect(status).toBe(SS.MAJOR_OUTAGE);
  });

  it('lets failing checks speak before anyone has written an update', () => {
    const status = deriveSystemStatus({
      components: [comp(CS.DOWN), comp(CS.OPERATIONAL)],
      openIncidents: [],
    });
    expect(status).toBe(SS.PARTIAL_OUTAGE);
  });

  it('never lets a mild incident downgrade a severe outage', () => {
    // A minor incident open while everything is down must not soften the
    // page to DEGRADED. The result is the worse of the two, always.
    const status = deriveSystemStatus({
      components: [comp(CS.DOWN)],
      openIncidents: [{ impact: II.MINOR }],
    });
    expect(status).toBe(SS.MAJOR_OUTAGE);
  });

  it('handles an empty system', () => {
    expect(deriveSystemStatus()).toBe(SS.OPERATIONAL);
  });
});

describe('worse', () => {
  it('is a total order over the system statuses', () => {
    const ordered = [SS.OPERATIONAL, SS.DEGRADED, SS.PARTIAL_OUTAGE, SS.MAJOR_OUTAGE];
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = 0; j < ordered.length; j += 1) {
        expect(worse(ordered[i], ordered[j])).toBe(ordered[Math.max(i, j)]);
      }
    }
  });
});
