/**
 * Types for the fleet coordinator's "governor" policy.
 *
 * See /home/buzz/spec/fleet-coordinator-spec.md — §2 (definitions), §5 FR-1/FR-4,
 * §6 (throttle parameters), §9 NFR-2 ("Governor decisions and gate verdicts are
 * pure functions of published state and parameters").
 *
 * This module (and everything under server/src/services/fleet/) must stay pure:
 * no I/O, no database access, no imports from other services. See ./README.md.
 */

/** §2 Window: the rolling 5-hour window, the weekly window, and model-specific weekly buckets. */
export type FleetWindow =
  | "five_hour"
  | "seven_day"
  | "seven_day_sonnet"
  | "seven_day_opus";

/**
 * §5 FR-1.1: one recorded utilization sample for a window.
 *
 * `usedPct` and `resetsAt` are nullable because a snapshot can be recorded
 * before the underlying source has populated those fields (e.g. a bucket that
 * has not been used yet has no `resets_at`).
 */
export interface LimitSnapshot {
  window: FleetWindow;
  usedPct: number | null;
  resetsAt: Date | null;
  observedAt: Date;
  source: string;
}

/** §2 Throttle state. */
export type ThrottleState = "GREEN" | "AMBER" | "RED" | "ACCELERATE";

/**
 * §6 Throttle parameters table. Defaults below use the `[proposed: …]` values
 * from the spec (v0.2, 2026-09-13).
 */
export interface GovernorParams {
  /** Pace at/above which the governor enters AMBER. §6 `amber_pace` [proposed: 1.15]. */
  amberPace: number;
  /** Pace at/above which the governor enters RED. §6 `red_pace` [proposed: 1.35]. */
  redPace: number;
  /** Pace at/below which the governor may ACCELERATE. §6 `accel_pace` [proposed: 0.80]. */
  accelPace: number;
  /** Earliest day (1..7) of the weekly window ACCELERATE may trigger. §6 `accel_earliest_day` [proposed: day 4]. */
  accelEarliestDay: number;
  /** 5h used% at/above which non-P0 worker launches are held (FR-4.6). §6 `floor_5h` = 80 (decided). */
  floor5h: number;
  /** 5h used% at/above which the state is RED regardless of pace. §6 `red_5h` [proposed: 90]. */
  red5h: number;
  /** Hysteresis band in percentage points, applied to every threshold (FR-4.1). §6 `hysteresis` [proposed: 5 pp]. */
  hysteresisPp: number;
  /** Model-bucket used% at/above which that model is excluded for non-P0 runs (FR-4.8). §6 `bucket_hold` [proposed: 90]. */
  bucketHoldPct: number;
  /** A window is STALE if no snapshot younger than this exists (FR-1.3). §6 `stale_after` [proposed: 15 min]. */
  staleAfterMs: number;
  /** Sensing cadence (FR-1.1). §6 `sense_interval` [proposed: 5 min]. */
  senseIntervalMs: number;
  /** §6 `default_model` (decided): supervisors opus; coders sonnet; evaluators sonnet. */
  defaultModels: { supervisor: string; coder: string; evaluator: string };
  /** §6 `amber_model` [proposed: sonnet] — coder model while AMBER (FR-4.3). */
  amberModel: string;
  /** §6 `amber_effort` [proposed: medium] — coder effort while AMBER (FR-4.3). */
  amberEffort: string;
  /** §6 `amber_concurrency_step` [proposed: 1] — coder concurrency reduction while AMBER (FR-4.3). */
  amberConcurrencyStep: number;
  /** §6 `max_concurrency` — fleet default (decided: 1 worker run per host). */
  maxConcurrency: number;
  /** Version tag for the parameter set in force, for audit (FR-4.10). */
  paramsVersion: string;
}

export const DEFAULT_GOVERNOR_PARAMS: GovernorParams = {
  amberPace: 1.15,
  redPace: 1.35,
  accelPace: 0.8,
  accelEarliestDay: 4,
  floor5h: 80,
  red5h: 90,
  hysteresisPp: 5,
  bucketHoldPct: 90,
  staleAfterMs: 15 * 60 * 1000,
  senseIntervalMs: 5 * 60 * 1000,
  defaultModels: { supervisor: "opus", coder: "sonnet", evaluator: "sonnet" },
  amberModel: "sonnet",
  amberEffort: "medium",
  amberConcurrencyStep: 1,
  maxConcurrency: 1,
  paramsVersion: "v0-proposed",
};

/** §2 Launch parameters in force for new worker runs. */
export interface LaunchParameters {
  coder: { model: string; effort: string | null };
  evaluator: { model: string; effort: string | null };
  supervisor: { model: string; effort: string | null };
  /** FR-4.8: models excluded for non-P0 runs because their weekly bucket is at/above `bucket_hold`. */
  excludedModels: string[];
  /** Concurrency in force for non-P0 dispatch (0 under RED per FR-4.4). */
  maxConcurrency: number;
}

/** Output of {@link decideThrottle}. */
export interface GovernorDecision {
  state: ThrottleState;
  /** True when the decision was forced by stale sensing data (FR-1.3). */
  stale: boolean;
  pace: number | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  /** FR-4.6: 5h used% >= floor_5h, independent of throttle state. */
  floorActive: boolean;
  /** FR-4.8: model-specific weekly buckets at/above bucket_hold. */
  bucketHolds: FleetWindow[];
  /** One human-readable sentence naming the inputs that drove the decision. */
  reason: string;
  paramsVersion: string;
  launchParameters: LaunchParameters;
  holds: {
    /** AMBER (FR-4.3): hold new P2+ epic dispatch. */
    newP2PlusDispatch: boolean;
    /** RED (FR-4.4): hold all new dispatch except P0. */
    allNonP0Dispatch: boolean;
    /** FR-4.6: hold all new non-P0 worker launches (coders and evaluators), driven by floorActive. */
    newNonP0WorkerLaunches: boolean;
    /** RED (FR-4.4/FR-4.7): interrupt running non-P0 runs. */
    interruptRunningNonP0: boolean;
    /** ACCELERATE (FR-4.5): release P3 sweeper work. */
    releaseP3Sweepers: boolean;
  };
}
