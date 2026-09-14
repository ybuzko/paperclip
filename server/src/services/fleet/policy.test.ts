import { describe, expect, it } from "vitest";
import {
  computePace,
  decideThrottle,
  isStale,
  latestSnapshotByWindow,
  nextSenseDueAt,
  weeklyDayIndex,
} from "./policy.js";
import { DEFAULT_GOVERNOR_PARAMS, type LimitSnapshot, type ThrottleState } from "./types.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;
const NOW = new Date("2026-09-14T12:00:00.000Z");
const params = DEFAULT_GOVERNOR_PARAMS;

/** A seven_day snapshot whose window is `elapsedFraction` of the way through, at `usedPct`. */
function sevenDaySnapshot(opts: {
  usedPct: number | null;
  elapsedFraction?: number | null;
  resetsAt?: Date | null;
  observedAt?: Date;
}): LimitSnapshot {
  const resetsAt =
    opts.resetsAt !== undefined
      ? opts.resetsAt
      : opts.elapsedFraction == null
        ? null
        : new Date(NOW.getTime() + (1 - opts.elapsedFraction) * SEVEN_DAYS_MS);
  return {
    window: "seven_day",
    usedPct: opts.usedPct,
    resetsAt,
    observedAt: opts.observedAt ?? NOW,
    source: "statusline",
  };
}

function fiveHourSnapshot(usedPct: number | null, observedAt: Date = NOW): LimitSnapshot {
  return {
    window: "five_hour",
    usedPct,
    resetsAt: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
    observedAt,
    source: "statusline",
  };
}

function bucketSnapshot(
  window: "seven_day_sonnet" | "seven_day_opus",
  usedPct: number,
  observedAt: Date = NOW,
): LimitSnapshot {
  return {
    window,
    usedPct,
    resetsAt: new Date(NOW.getTime() + 3 * ONE_DAY_MS),
    observedAt,
    source: "statusline",
  };
}

function freshSnapshots(overrides: {
  fiveHourPct?: number;
  usedPct?: number;
  elapsedFraction?: number;
  extra?: LimitSnapshot[];
}): LimitSnapshot[] {
  return [
    fiveHourSnapshot(overrides.fiveHourPct ?? 40),
    sevenDaySnapshot({
      usedPct: overrides.usedPct ?? 50,
      elapsedFraction: overrides.elapsedFraction ?? 0.5,
    }),
    ...(overrides.extra ?? []),
  ];
}

describe("latestSnapshotByWindow", () => {
  it("keeps the newest snapshot per window", () => {
    const older = fiveHourSnapshot(10, new Date(NOW.getTime() - 60_000));
    const newer = fiveHourSnapshot(20, NOW);
    const map = latestSnapshotByWindow([older, newer]);
    expect(map.get("five_hour")).toBe(newer);
  });
});

describe("isStale", () => {
  it("is stale when there is no snapshot", () => {
    expect(isStale(undefined, NOW, params)).toBe(true);
  });

  it("is stale when older than stale_after", () => {
    const snap = fiveHourSnapshot(10, new Date(NOW.getTime() - params.staleAfterMs - 1));
    expect(isStale(snap, NOW, params)).toBe(true);
  });

  it("is not stale when within stale_after", () => {
    const snap = fiveHourSnapshot(10, new Date(NOW.getTime() - params.staleAfterMs + 1));
    expect(isStale(snap, NOW, params)).toBe(false);
  });
});

describe("computePace", () => {
  it("is 1.0 on plan (50% used at 50% elapsed)", () => {
    const snap = sevenDaySnapshot({ usedPct: 50, elapsedFraction: 0.5 });
    expect(computePace(snap, NOW)).toBeCloseTo(1.0, 5);
  });

  it("is > 1.0 when over pace", () => {
    const snap = sevenDaySnapshot({ usedPct: 70, elapsedFraction: 0.5 });
    expect(computePace(snap, NOW)).toBeCloseTo(1.4, 5);
  });

  it("is < 1.0 when under pace", () => {
    const snap = sevenDaySnapshot({ usedPct: 30, elapsedFraction: 0.5 });
    expect(computePace(snap, NOW)).toBeCloseTo(0.6, 5);
  });

  it("is null when usedPct is missing", () => {
    const snap = sevenDaySnapshot({ usedPct: null, elapsedFraction: 0.5 });
    expect(computePace(snap, NOW)).toBeNull();
  });

  it("is null when resetsAt is missing", () => {
    const snap = sevenDaySnapshot({ usedPct: 50, resetsAt: null });
    expect(computePace(snap, NOW)).toBeNull();
  });

  it("clamps the elapsed fraction to 0.01 right after a reset", () => {
    // Window started 1 minute ago: raw elapsed fraction ~= 0.0000992, clamped to 0.01.
    const snap = sevenDaySnapshot({
      usedPct: 5,
      resetsAt: new Date(NOW.getTime() - 60_000 + SEVEN_DAYS_MS),
    });
    expect(computePace(snap, NOW)).toBeCloseTo(5 / (0.01 * 100), 5);
  });
});

describe("weeklyDayIndex", () => {
  it.each([
    { elapsedFraction: 0 / 7, expected: 1 },
    { elapsedFraction: 3.5 / 7, expected: 4 },
    { elapsedFraction: 6.99 / 7, expected: 7 },
  ])("maps elapsed fraction $elapsedFraction to day $expected", ({ elapsedFraction, expected }) => {
    const snap = sevenDaySnapshot({ usedPct: 50, elapsedFraction });
    expect(weeklyDayIndex(snap, NOW)).toBe(expected);
  });

  it("clamps beyond day 7", () => {
    const snap = sevenDaySnapshot({
      usedPct: 50,
      resetsAt: new Date(NOW.getTime() - ONE_DAY_MS), // window "should" have already reset
    });
    expect(weeklyDayIndex(snap, NOW)).toBe(7);
  });

  it("is null without resetsAt", () => {
    const snap = sevenDaySnapshot({ usedPct: 50, resetsAt: null });
    expect(weeklyDayIndex(snap, NOW)).toBeNull();
  });
});

describe("decideThrottle: state transitions (no previous state)", () => {
  it.each([
    { name: "GREEN on plan", fiveHourPct: 40, usedPct: 50, elapsedFraction: 0.5, expected: "GREEN" },
    { name: "AMBER at amber_pace", fiveHourPct: 40, usedPct: 60, elapsedFraction: 0.5, expected: "AMBER" }, // pace 1.2
    { name: "RED at red_pace", fiveHourPct: 40, usedPct: 70, elapsedFraction: 0.5, expected: "RED" }, // pace 1.4
  ] satisfies { name: string; fiveHourPct: number; usedPct: number; elapsedFraction: number; expected: ThrottleState }[])(
    "$name",
    ({ fiveHourPct, usedPct, elapsedFraction, expected }) => {
      const decision = decideThrottle({
        snapshots: freshSnapshots({ fiveHourPct, usedPct, elapsedFraction }),
        previousState: null,
        params,
        now: NOW,
      });
      expect(decision.state).toBe(expected);
      expect(decision.stale).toBe(false);
    },
  );

  it("RED from 5h regardless of good pace", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 95, usedPct: 45, elapsedFraction: 0.5 }), // pace 0.9, on plan
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("RED");
    expect(decision.reason).toMatch(/5h/i);
    expect(decision.launchParameters.maxConcurrency).toBe(0);
  });

  it("ACCELERATE when pace is low and the weekly day is late enough", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 30, usedPct: 40, elapsedFraction: 4 / 7 }), // pace ~0.7, day 5
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("ACCELERATE");
    expect(decision.holds.releaseP3Sweepers).toBe(true);
  });

  it("does not ACCELERATE before accel_earliest_day even with low pace", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 30, usedPct: 20, elapsedFraction: 2 / 7 }), // pace 0.7, day 3
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("GREEN");
  });

  it("marks AMBER and stale when the seven_day snapshot is too old", () => {
    const staleSevenDay = sevenDaySnapshot({
      usedPct: 50,
      elapsedFraction: 0.5,
      observedAt: new Date(NOW.getTime() - params.staleAfterMs - 1),
    });
    const decision = decideThrottle({
      snapshots: [fiveHourSnapshot(40), staleSevenDay],
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("AMBER");
    expect(decision.stale).toBe(true);
    expect(decision.reason).toMatch(/stale/i);
    expect(decision.reason).toMatch(/seven_day/);
  });

  it("keeps RED from a fresh 5h breach even when the seven_day snapshot is stale", () => {
    const staleSevenDay = sevenDaySnapshot({
      usedPct: 40,
      elapsedFraction: 0.5,
      observedAt: new Date(NOW.getTime() - params.staleAfterMs - 1),
    });
    const decision = decideThrottle({
      snapshots: [fiveHourSnapshot(params.red5h), staleSevenDay],
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("RED");
    expect(decision.stale).toBe(true);
    expect(decision.holds.allNonP0Dispatch).toBe(true);
    expect(decision.reason).toMatch(/red_5h/);
  });

  it("does not let a STALE 5h reading force RED (stale wins as AMBER)", () => {
    const decision = decideThrottle({
      snapshots: [
        fiveHourSnapshot(99, new Date(NOW.getTime() - params.staleAfterMs - 1)),
        sevenDaySnapshot({ usedPct: 40, elapsedFraction: 0.5 }),
      ],
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("AMBER");
    expect(decision.stale).toBe(true);
  });

  it("marks AMBER and stale when the five_hour snapshot is missing entirely", () => {
    const decision = decideThrottle({
      snapshots: [sevenDaySnapshot({ usedPct: 50, elapsedFraction: 0.5 })],
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("AMBER");
    expect(decision.stale).toBe(true);
    expect(decision.reason).toMatch(/five_hour/);
  });

  it("activates the interactive floor on GREEN when 5h >= floor_5h but < red_5h", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 85, usedPct: 50, elapsedFraction: 0.5 }),
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("GREEN");
    expect(decision.floorActive).toBe(true);
    expect(decision.holds.newNonP0WorkerLaunches).toBe(true);
    // Floor does not imply the other, state-driven holds.
    expect(decision.holds.allNonP0Dispatch).toBe(false);
  });

  it("excludes a model whose weekly bucket is at/above bucket_hold", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({
        fiveHourPct: 40,
        usedPct: 50,
        elapsedFraction: 0.5,
        extra: [bucketSnapshot("seven_day_sonnet", 92)],
      }),
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.bucketHolds).toEqual(["seven_day_sonnet"]);
    expect(decision.launchParameters.excludedModels).toEqual(["sonnet"]);
  });

  it("sets amber_model/amber_effort and reduced concurrency for the coder under AMBER, evaluator unchanged", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 40, usedPct: 60, elapsedFraction: 0.5 }), // pace 1.2
      previousState: null,
      params,
      now: NOW,
    });
    expect(decision.state).toBe("AMBER");
    expect(decision.launchParameters.coder).toEqual({ model: "sonnet", effort: "medium" });
    expect(decision.launchParameters.evaluator).toEqual({ model: "sonnet", effort: null });
    expect(decision.launchParameters.maxConcurrency).toBe(
      Math.max(1, params.maxConcurrency - params.amberConcurrencyStep),
    );
    expect(decision.holds.newP2PlusDispatch).toBe(true);
  });
});

describe("decideThrottle: hysteresis (FR-4.1)", () => {
  it("holds at RED when pace has not cleared the red_pace threshold by the hysteresis band", () => {
    // redPace=1.35, hysteresis=5pp -> needs pace < 1.30 to clear. 1.32 does not clear.
    // five_hour is well clear (80 < 85) but pace is not, so overall not cleared.
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 80, usedPct: 66, elapsedFraction: 0.5 }), // pace 1.32
      previousState: "RED",
      params,
      now: NOW,
    });
    expect(decision.state).toBe("RED");
    expect(decision.reason).toMatch(/hysteresis/i);
  });

  it("steps down from RED once pace and 5h have both cleared their thresholds by the hysteresis band", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 70, usedPct: 62.5, elapsedFraction: 0.5 }), // pace 1.25, cleared
      previousState: "RED",
      params,
      now: NOW,
    });
    expect(decision.state).toBe("AMBER");
  });

  it("holds at AMBER when pace has not cleared the amber_pace threshold by the hysteresis band", () => {
    // amberPace=1.15, hysteresis=5pp -> needs pace < 1.10 to clear. 1.12 does not clear.
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 40, usedPct: 56, elapsedFraction: 0.5 }), // pace 1.12
      previousState: "AMBER",
      params,
      now: NOW,
    });
    expect(decision.state).toBe("AMBER");
    expect(decision.reason).toMatch(/hysteresis/i);
  });

  it("releases from AMBER to GREEN once pace has cleared the amber_pace threshold by the hysteresis band", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 40, usedPct: 52.5, elapsedFraction: 0.5 }), // pace 1.05, cleared
      previousState: "AMBER",
      params,
      now: NOW,
    });
    expect(decision.state).toBe("GREEN");
  });

  it("escalates immediately from GREEN to RED without waiting on hysteresis", () => {
    const decision = decideThrottle({
      snapshots: freshSnapshots({ fiveHourPct: 40, usedPct: 70, elapsedFraction: 0.5 }), // pace 1.4
      previousState: "GREEN",
      params,
      now: NOW,
    });
    expect(decision.state).toBe("RED");
  });
});

describe("nextSenseDueAt", () => {
  it("returns now + sense_interval when nothing resets soon", () => {
    const snapshots = freshSnapshots({});
    const latest = latestSnapshotByWindow(snapshots);
    const due = nextSenseDueAt(latest, NOW, params);
    expect(due.getTime()).toBe(NOW.getTime() + params.senseIntervalMs);
  });

  it("re-senses within 60s of a reset that falls inside the interval", () => {
    const resetsAt = new Date(NOW.getTime() + 2 * 60 * 1000);
    const snapshots = [
      { ...fiveHourSnapshot(40), resetsAt },
      sevenDaySnapshot({ usedPct: 50, elapsedFraction: 0.5, resetsAt: new Date(NOW.getTime() + ONE_DAY_MS) }),
    ];
    const latest = latestSnapshotByWindow(snapshots);
    const due = nextSenseDueAt(latest, NOW, params);
    expect(due.getTime()).toBe(resetsAt.getTime() + 60_000);
  });

  it("picks the earliest reset when multiple windows reset within the interval", () => {
    const earlierReset = new Date(NOW.getTime() + 60 * 1000);
    const laterReset = new Date(NOW.getTime() + 3 * 60 * 1000);
    const snapshots = [
      { ...fiveHourSnapshot(40), resetsAt: laterReset },
      sevenDaySnapshot({ usedPct: 50, elapsedFraction: 0.5, resetsAt: earlierReset }),
    ];
    const latest = latestSnapshotByWindow(snapshots);
    const due = nextSenseDueAt(latest, NOW, params);
    expect(due.getTime()).toBe(earlierReset.getTime() + 60_000);
  });
});
