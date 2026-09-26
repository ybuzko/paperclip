/**
 * The fleet coordinator's "governor" policy — pure functions, no I/O.
 *
 * Implements /home/buzz/spec/fleet-coordinator-spec.md §2, §5 FR-1.3/FR-1.4,
 * §5 FR-4, §6, and §9 NFR-2. See ./README.md for the module contract.
 */

import {
  DEFAULT_GOVERNOR_PARAMS,
  type FleetWindow,
  type GovernorDecision,
  type GovernorParams,
  type LaunchParameters,
  type LimitSnapshot,
  type ThrottleState,
} from "./types.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

/** Latest snapshot per window, by `observedAt`. */
export function latestSnapshotByWindow(
  snapshots: LimitSnapshot[],
): Map<FleetWindow, LimitSnapshot> {
  const latest = new Map<FleetWindow, LimitSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.window);
    if (!current || snapshot.observedAt.getTime() > current.observedAt.getTime()) {
      latest.set(snapshot.window, snapshot);
    }
  }
  return latest;
}

/** FR-1.3: a window is STALE if no snapshot younger than `stale_after` exists. */
export function isStale(
  snapshot: LimitSnapshot | undefined,
  now: Date,
  params: GovernorParams,
): boolean {
  if (!snapshot) return true;
  return now.getTime() - snapshot.observedAt.getTime() > params.staleAfterMs;
}

/**
 * §2 Pace = `7d.used% ÷ (elapsed fraction of the weekly window × 100)`; 1.0 = on plan.
 * Window start = `resets_at - 7 days`. Elapsed fraction is clamped to [0.01, 1]
 * to avoid a divide-by-near-zero spike right after a reset.
 *
 * Returns null when `usedPct` or `resetsAt` is missing.
 */
export function computePace(sevenDay: LimitSnapshot, now: Date): number | null {
  if (sevenDay.usedPct == null || sevenDay.resetsAt == null) return null;
  const windowStart = sevenDay.resetsAt.getTime() - SEVEN_DAYS_MS;
  const rawFraction = (now.getTime() - windowStart) / SEVEN_DAYS_MS;
  const elapsedFraction = Math.min(1, Math.max(0.01, rawFraction));
  return sevenDay.usedPct / (elapsedFraction * 100);
}

/**
 * Fraction (0..1) of the weekly window that has elapsed, or null when
 * `resetsAt` is missing. Unlike {@link computePace}'s internal fraction, this
 * is NOT floored at 0.01 — callers that need to detect "early window"
 * conditions (a tiny, noisy denominator) want the true fraction, not the
 * divide-by-zero guard used for the pace ratio itself.
 */
export function weeklyElapsedFraction(sevenDay: LimitSnapshot, now: Date): number | null {
  if (sevenDay.resetsAt == null) return null;
  const windowStart = sevenDay.resetsAt.getTime() - SEVEN_DAYS_MS;
  const rawFraction = (now.getTime() - windowStart) / SEVEN_DAYS_MS;
  return Math.min(1, Math.max(0, rawFraction));
}

/** Day (1..7) of the current weekly window, or null when `resetsAt` is missing. */
export function weeklyDayIndex(sevenDay: LimitSnapshot, now: Date): number | null {
  if (sevenDay.resetsAt == null) return null;
  const windowStart = sevenDay.resetsAt.getTime() - SEVEN_DAYS_MS;
  const dayIndex = Math.floor((now.getTime() - windowStart) / ONE_DAY_MS) + 1;
  return Math.min(7, Math.max(1, dayIndex));
}

/**
 * Restrictiveness rank for hysteresis (FR-4.1). ACCELERATE is treated as
 * GREEN-level, per the task spec: "Restrictiveness order: RED > AMBER > GREEN,
 * with ACCELERATE treated as GREEN-level for hysteresis purposes."
 */
function restrictivenessRank(state: ThrottleState): 0 | 1 | 2 {
  if (state === "RED") return 2;
  if (state === "AMBER") return 1;
  return 0; // GREEN, ACCELERATE
}

/** Raw (pre-hysteresis) throttle tier from the pace thresholds (§6, FR-4.1/FR-4.5). */
function paceTier(
  pace: number | null,
  weeklyDay: number | null,
  params: GovernorParams,
): { tier: ThrottleState; usedFallback: boolean } {
  if (pace == null) {
    // Ambiguity resolution: the spec defines STALE (missing/old snapshot) but
    // does not say what to do when a fresh snapshot is missing usedPct/resetsAt
    // (so pace cannot be computed at all). We fail safe to AMBER, consistent
    // with FR-1.3's "when in doubt, hold new work" posture (C-8).
    return { tier: "AMBER", usedFallback: true };
  }
  if (pace >= params.redPace) return { tier: "RED", usedFallback: false };
  if (pace >= params.amberPace) return { tier: "AMBER", usedFallback: false };
  if (pace <= params.accelPace && weeklyDay != null && weeklyDay >= params.accelEarliestDay) {
    return { tier: "ACCELERATE", usedFallback: false };
  }
  return { tier: "GREEN", usedFallback: false };
}

/**
 * Whether the metrics that could have produced `fromState` have cleared their
 * threshold by the hysteresis band (FR-4.1), i.e. it is safe to step down away
 * from `fromState`. Missing data is treated conservatively (not cleared).
 */
function hasClearedForStepDown(
  fromState: ThrottleState,
  fiveHourPct: number | null,
  pace: number | null,
  params: GovernorParams,
): boolean {
  const paceMargin = params.hysteresisPp / 100;
  if (fromState === "RED") {
    const fiveHourCleared =
      fiveHourPct != null && fiveHourPct < params.red5h - params.hysteresisPp;
    const paceCleared = pace != null && pace < params.redPace - paceMargin;
    return fiveHourCleared && paceCleared;
  }
  if (fromState === "AMBER") {
    return pace != null && pace < params.amberPace - paceMargin;
  }
  return true; // GREEN / ACCELERATE: nothing more restrictive to clear.
}

function buildLaunchParameters(
  state: ThrottleState,
  bucketHolds: FleetWindow[],
  params: GovernorParams,
): LaunchParameters {
  const isAmber = state === "AMBER";
  const isRed = state === "RED";

  const excludedModels: string[] = [];
  for (const window of bucketHolds) {
    if (window === "seven_day_sonnet") excludedModels.push("sonnet");
    if (window === "seven_day_opus") excludedModels.push("opus");
  }

  const coder = isAmber
    ? { model: params.amberModel, effort: params.amberEffort }
    : { model: params.defaultModels.coder, effort: null };

  // FR-4.3: evaluator launch parameters are unchanged under AMBER.
  const evaluator = { model: params.defaultModels.evaluator, effort: null };
  const supervisor = { model: params.defaultModels.supervisor, effort: null };

  let maxConcurrency = params.maxConcurrency;
  if (isRed) {
    maxConcurrency = 0;
  } else if (isAmber) {
    maxConcurrency = Math.max(1, params.maxConcurrency - params.amberConcurrencyStep);
  }

  return { coder, evaluator, supervisor, excludedModels, maxConcurrency };
}

export function decideThrottle(input: {
  snapshots: LimitSnapshot[];
  previousState: ThrottleState | null;
  params?: GovernorParams;
  now: Date;
}): GovernorDecision {
  const params = input.params ?? DEFAULT_GOVERNOR_PARAMS;
  const { now, previousState } = input;
  const latest = latestSnapshotByWindow(input.snapshots);

  const fiveHour = latest.get("five_hour");
  const sevenDay = latest.get("seven_day");

  const fiveHourStale = isStale(fiveHour, now, params);
  const sevenDayStale = isStale(sevenDay, now, params);

  const fiveHourPct = fiveHour?.usedPct ?? null;
  const sevenDayPct = sevenDay?.usedPct ?? null;
  const pace = sevenDay ? computePace(sevenDay, now) : null;
  const weeklyDay = sevenDay ? weeklyDayIndex(sevenDay, now) : null;
  const elapsedFraction = sevenDay ? weeklyElapsedFraction(sevenDay, now) : null;

  // FR-4.6: independent of state, and computed from whatever data is
  // available (even if stale) — the floor is a fail-safe on top of the state
  // machine, not gated by sensing freshness.
  const floorActive = fiveHourPct != null && fiveHourPct >= params.floor5h;

  // FR-4.8: model-specific weekly buckets. Not subject to the five_hour/
  // seven_day staleness rule (FR-1.3 names only those two windows).
  const bucketHolds: FleetWindow[] = [];
  for (const window of ["seven_day_sonnet", "seven_day_opus"] as const) {
    const bucket = latest.get(window);
    if (bucket?.usedPct != null && bucket.usedPct >= params.bucketHoldPct) {
      bucketHolds.push(window);
    }
  }

  let state: ThrottleState;
  let stale = false;
  let reason: string;

  if (!fiveHourStale && fiveHourPct != null && fiveHourPct >= params.red5h) {
    // Rule 1 (§6 red_5h, FR-4.4): a FRESH 5h reading at/above red_5h forces
    // RED regardless of pace and regardless of whether the weekly snapshot is
    // stale. A stale 7d window must never soften a hard 5h breach to AMBER.
    stale = sevenDayStale;
    state = "RED";
    reason = `RED: 5h utilization at ${fiveHourPct}% >= red_5h (${params.red5h}%).${
      sevenDayStale ? " (seven_day snapshot is stale.)" : ""
    }`;
  } else if (fiveHourStale || sevenDayStale) {
    // Rule 2 (FR-1.3): stale sensing forces AMBER. This bypasses the pace
    // rules and hysteresis below — we cannot trust stale metrics enough to run
    // threshold-clearance checks against them.
    stale = true;
    state = "AMBER";
    const staleWindows = [
      fiveHourStale ? "five_hour" : null,
      sevenDayStale ? "seven_day" : null,
    ].filter((w): w is string => w != null);
    reason = `AMBER (stale): no snapshot younger than ${Math.round(
      params.staleAfterMs / 60000,
    )} min for ${staleWindows.join(" and ")}; applying the AMBER policy per FR-1.3.`;
  } else if (elapsedFraction != null && elapsedFraction < params.minElapsedFraction) {
    // Rule 3 (pace hypersensitivity fix): early in the weekly window,
    // elapsedFraction is a tiny/noisy denominator, so pace = usedPct /
    // elapsedFraction swings wildly and flips the throttle tier on almost
    // every sense. Hold at the previous state (GREEN with no history) until
    // enough of the window has elapsed for pace to mean something. The fresh
    // 5h red_5h rule (Rule 1) and the staleness rule (Rule 2) above still
    // apply unconditionally — this only replaces the pace-tier rule below.
    state = previousState ?? "GREEN";
    reason = `early window: elapsed ${(elapsedFraction * 100).toFixed(1)}% < minElapsedFraction (${(
      params.minElapsedFraction * 100
    ).toFixed(0)}%); holding ${state}${previousState ? "" : " (no previous state)"} instead of applying pace tiers.`;
  } else {
    // Rule 4: pace-based tier.
    const { tier, usedFallback } = paceTier(pace, weeklyDay, params);
    const computedState = tier;

    // Rule 5: hysteresis (FR-4.1) — only step down from a previous, more
    // restrictive state once the metric has cleared its threshold by the
    // hysteresis band; otherwise hold the previous state.
    let held = false;
    if (
      previousState != null &&
      restrictivenessRank(previousState) > restrictivenessRank(computedState)
    ) {
      const cleared = hasClearedForStepDown(previousState, fiveHourPct, pace, params);
      if (cleared) {
        state = computedState;
      } else {
        state = previousState;
        held = true;
      }
    } else {
      state = computedState;
    }

    if (held) {
      reason = `${state} held by hysteresis: pace ${
        pace != null ? pace.toFixed(3) : "unknown"
      } has not cleared the ${previousState} threshold by ${params.hysteresisPp}pp yet (computed tier was ${computedState}).`;
    } else if (usedFallback) {
      reason = `${state}: pace could not be computed (missing usedPct/resetsAt on the seven_day snapshot); failing safe to AMBER.`;
    } else {
      reason = `${state}: pace ${pace != null ? pace.toFixed(3) : "unknown"} vs amber_pace=${
        params.amberPace
      }/red_pace=${params.redPace}/accel_pace=${params.accelPace}${
        weeklyDay != null ? `, weekly day ${weeklyDay}/7` : ""
      }.`;
    }
  }

  if (floorActive) {
    reason += ` Floor active: 5h utilization ${fiveHourPct}% >= floor_5h (${params.floor5h}%).`;
  }
  if (bucketHolds.length > 0) {
    reason += ` Bucket hold on ${bucketHolds.join(", ")} (>= bucket_hold ${params.bucketHoldPct}%).`;
  }

  const launchParameters = buildLaunchParameters(state, bucketHolds, params);

  const holds = {
    newP2PlusDispatch: state === "AMBER",
    allNonP0Dispatch: state === "RED",
    newNonP0WorkerLaunches: floorActive,
    interruptRunningNonP0: state === "RED",
    releaseP3Sweepers: state === "ACCELERATE",
  };

  return {
    state,
    stale,
    pace,
    fiveHourPct,
    sevenDayPct,
    floorActive,
    bucketHolds,
    reason,
    paramsVersion: params.paramsVersion,
    launchParameters,
    holds,
  };
}

/**
 * FR-1.4: when a window's `resets_at` passes, re-sense within 60s. Returns
 * the normal `now + sense_interval` unless some window resets sooner, in
 * which case it returns 60s after the earliest such reset.
 */
export function nextSenseDueAt(
  latest: Map<FleetWindow, LimitSnapshot>,
  now: Date,
  params: GovernorParams,
): Date {
  const normalDueAt = now.getTime() + params.senseIntervalMs;
  let earliestResetInWindow: number | null = null;

  for (const snapshot of latest.values()) {
    if (!snapshot.resetsAt) continue;
    const resetsAtMs = snapshot.resetsAt.getTime();
    if (resetsAtMs > now.getTime() && resetsAtMs <= normalDueAt) {
      if (earliestResetInWindow == null || resetsAtMs < earliestResetInWindow) {
        earliestResetInWindow = resetsAtMs;
      }
    }
  }

  if (earliestResetInWindow != null) {
    return new Date(earliestResetInWindow + 60_000);
  }
  return new Date(normalDueAt);
}
