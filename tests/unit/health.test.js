import { describe, it, expect } from 'vitest';
import {
  COMPONENT_STATUS as CS,
  OUTCOME,
  EMPTY_COUNTERS,
  classify,
  applyOutcome,
} from '../../packages/shared/src/index.js';

/** Feed a sequence of outcomes through the machine and report where it lands. */
function run(startStatus, outcomes, thresholds) {
  let state = { status: startStatus, counters: EMPTY_COUNTERS };
  const transitions = [];
  for (const outcome of outcomes) {
    const next = applyOutcome({ ...state, outcome, thresholds });
    if (next.changed) transitions.push(next.status);
    state = { status: next.status, counters: next.counters };
  }
  return { status: state.status, transitions };
}

const F = OUTCOME.FAIL;
const K = OUTCOME.OK;
const S = OUTCOME.SLOW;

describe('classify', () => {
  const component = { expectedStatusCodes: [200], degradedAboveMs: 1_000 };

  it('calls an unreachable target a failure', () => {
    expect(classify({ ok: false }, component)).toBe(F);
  });

  it('calls an unexpected status code a failure even though it answered', () => {
    expect(classify({ ok: true, statusCode: 500, responseMs: 20 }, component)).toBe(F);
  });

  it('respects a component that legitimately answers 401', () => {
    // An unauthenticated probe of a private API is not an outage.
    const guarded = { expectedStatusCodes: [401], degradedAboveMs: 1_000 };
    expect(classify({ ok: true, statusCode: 401, responseMs: 20 }, guarded)).toBe(K);
  });

  it('calls a slow but healthy answer slow, not failed', () => {
    expect(classify({ ok: true, statusCode: 200, responseMs: 2_500 }, component)).toBe(S);
  });

  it('measures slow against the component own ceiling', () => {
    // A report builder that always takes two seconds is not degraded.
    const slowByNature = { expectedStatusCodes: [200], degradedAboveMs: 5_000 };
    expect(classify({ ok: true, statusCode: 200, responseMs: 2_500 }, slowByNature)).toBe(K);
  });
});

describe('going down', () => {
  it('ignores a single failure', () => {
    // The whole reason this machine exists. One dropped packet is not an
    // outage, and a page that says it is gets ignored.
    expect(run(CS.OPERATIONAL, [F]).status).toBe(CS.OPERATIONAL);
    expect(run(CS.OPERATIONAL, [F]).transitions).toEqual([]);
  });

  it('ignores two failures', () => {
    expect(run(CS.OPERATIONAL, [F, F]).status).toBe(CS.OPERATIONAL);
  });

  it('declares DOWN on the third consecutive failure', () => {
    const { status, transitions } = run(CS.OPERATIONAL, [F, F, F]);
    expect(status).toBe(CS.DOWN);
    expect(transitions).toEqual([CS.DOWN]);
  });

  it('resets the run when a check succeeds in between', () => {
    // Two failures, a success, two more failures is not three in a row -
    // it is a flapping service, and flapping is not an outage.
    expect(run(CS.OPERATIONAL, [F, F, K, F, F]).status).toBe(CS.OPERATIONAL);
  });

  it('goes down from DEGRADED too', () => {
    expect(run(CS.DEGRADED, [F, F, F]).status).toBe(CS.DOWN);
  });
});

describe('degrading', () => {
  it('needs two consecutive slow checks', () => {
    expect(run(CS.OPERATIONAL, [S]).status).toBe(CS.OPERATIONAL);
    expect(run(CS.OPERATIONAL, [S, S]).status).toBe(CS.DEGRADED);
  });

  it('recovers to operational after two fast checks', () => {
    expect(run(CS.DEGRADED, [K, K]).status).toBe(CS.OPERATIONAL);
  });

  it('does not recover on a single fast check', () => {
    expect(run(CS.DEGRADED, [K]).status).toBe(CS.DEGRADED);
  });
});

describe('coming back up', () => {
  it('needs two consecutive successes, not one', () => {
    expect(run(CS.DOWN, [K]).status).toBe(CS.DOWN);
    expect(run(CS.DOWN, [K, K]).status).toBe(CS.OPERATIONAL);
  });

  it('comes back as DEGRADED when it returns slow', () => {
    // Back is back. Holding it at DOWN until it is also fast would tell
    // customers nothing had improved when something had.
    expect(run(CS.DOWN, [S, S]).status).toBe(CS.DEGRADED);
  });

  it('stays down if recovery is interrupted', () => {
    expect(run(CS.DOWN, [K, F, K]).status).toBe(CS.DOWN);
  });
});

describe('a realistic outage', () => {
  it('reports one transition down and one back up, not a flutter', () => {
    // Twelve checks: healthy, a deploy goes wrong, it is fixed. The page
    // should tell that story twice, not twelve times.
    const { transitions } = run(CS.OPERATIONAL, [K, K, F, F, F, F, F, K, K, K, K, K]);
    expect(transitions).toEqual([CS.DOWN, CS.OPERATIONAL]);
  });

  it('says nothing at all during a brief blip', () => {
    const { transitions } = run(CS.OPERATIONAL, [K, K, F, F, K, K, K]);
    expect(transitions).toEqual([]);
  });
});

describe('thresholds', () => {
  it('can be tightened per component for someone who wants speed over confidence', () => {
    expect(run(CS.OPERATIONAL, [F], { fail: 1 }).status).toBe(CS.DOWN);
  });

  it('can be loosened for a noisy target', () => {
    expect(run(CS.OPERATIONAL, [F, F, F], { fail: 5 }).status).toBe(CS.OPERATIONAL);
    expect(run(CS.OPERATIONAL, [F, F, F, F, F], { fail: 5 }).status).toBe(CS.DOWN);
  });
});

describe('the changed flag', () => {
  it('is false for the overwhelming majority of checks', () => {
    // This is the flag that decides whether a check costs a Mongo write,
    // a cache drop and a published event, or nothing at all.
    const steady = applyOutcome({
      status: CS.OPERATIONAL,
      counters: { fail: 0, ok: 50, slow: 0, up: 50 },
      outcome: K,
    });
    expect(steady.changed).toBe(false);
  });

  it('is true exactly once per transition', () => {
    let state = { status: CS.OPERATIONAL, counters: EMPTY_COUNTERS };
    const flags = [];
    for (const outcome of [F, F, F, F, F]) {
      const next = applyOutcome({ ...state, outcome });
      flags.push(next.changed);
      state = { status: next.status, counters: next.counters };
    }
    // Down on the third, then silence - not a write on every subsequent
    // failed check.
    expect(flags).toEqual([false, false, true, false, false]);
  });
});
