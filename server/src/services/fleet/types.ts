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

export const FIVE_HOUR_WINDOW = "five_hour";
export const SEVEN_DAY_WINDOW = "seven_day";
export const SEVEN_DAY_SONNET_WINDOW = "seven_day_sonnet";
export const SEVEN_DAY_OPUS_WINDOW = "seven_day_opus";

/** Provider window key, including dynamic model-scoped weekly keys. */
export type FleetWindow = string;

export function isModelScopedWindow(key: string): boolean {
  return key.startsWith("seven_day_model:") && key.length > "seven_day_model:".length;
}

/** Slug for a model bucket; surface-scoped windows are not model exclusions. */
export function modelScopeForWindow(key: string): string | null {
  if (key === SEVEN_DAY_SONNET_WINDOW) return "sonnet";
  if (key === SEVEN_DAY_OPUS_WINDOW) return "opus";
  return isModelScopedWindow(key) ? key.slice("seven_day_model:".length) : null;
}

/**
 * §5 FR-1.1: one recorded utilization sample for a window.
 *
 * `usedPct` and `resetsAt` are nullable because a snapshot can be recorded
 * before the underlying source has populated those fields (e.g. a bucket that
 * has not been used yet has no `resets_at`).
 */
export interface LimitSnapshot {
  provider: string;
  modelScope: string | null;
  window: FleetWindow;
  usedPct: number | null;
  resetsAt: Date | null;
  observedAt: Date;
  source: string;
}

/** §2 Throttle state. */
export type ThrottleState = "OPEN" | "CAPPED" | "RED" | "STALE";

/** Ordered cap steps relative to the weekly reset instant. */
export interface CapSchedule {
  timeZone: string;
  segments: Array<{ beforeResetHours: number | null; capPct: number }>;
}

/** Governor thresholds and provider/window cap schedules. */
export interface GovernorParams {
  /** Cap schedules keyed by provider and window. */
  capSchedules: Record<string, Record<string, CapSchedule>>;
  /** 5h used% at/above which new worker launches are held for every class. */
  floor5h: number;
  /** Fresh 5h used% at/above which the state is RED, unless required sensing is STALE. */
  red5h: number;
  /** Percentage-point clearance required to leave CAPPED without a cap increase. */
  hysteresisPp: number;
  /** Model-bucket used% at/above which that model is excluded from new launches. */
  bucketHoldPct: number;
  /** A window is STALE if no snapshot younger than this exists (FR-1.3). §6 `stale_after` [proposed: 15 min]. */
  staleAfterMs: number;
  /** Sensing cadence (FR-1.1). §6 `sense_interval` [proposed: 5 min]. */
  senseIntervalMs: number;
  /** §6 `max_concurrency` — fleet default (decided: 1 worker run per host). */
  maxConcurrency: number;
  /** Version tag for the parameter set in force, for audit (FR-4.10). */
  paramsVersion: string;
}

export const DEFAULT_GOVERNOR_PARAMS: GovernorParams = {
  capSchedules: {
    anthropic: {
      seven_day: {
        timeZone: "America/Los_Angeles",
        segments: [
          { beforeResetHours: null, capPct: 70 },
          { beforeResetHours: 10, capPct: 80 },
          { beforeResetHours: 5, capPct: 99 },
        ],
      },
    },
  },
  floor5h: 80,
  red5h: 90,
  hysteresisPp: 5,
  bucketHoldPct: 90,
  staleAfterMs: 15 * 60 * 1000,
  senseIntervalMs: 5 * 60 * 1000,
  maxConcurrency: 1,
  paramsVersion: "v1-cap-schedule",
};

/** §2 Launch parameters in force for new worker runs. */
export interface LaunchParameters {
  /** Models excluded because their weekly bucket is at/above `bucket_hold`. */
  excludedModels: string[];
  /** Concurrency in force for new worker launches across all classes. */
  maxConcurrency: number;
}

/** Output of {@link decideThrottle}. */
export interface GovernorDecision {
  state: ThrottleState;
  /** True when the decision was forced by stale sensing data (FR-1.3). */
  stale: boolean;
  /** Retained as null for the existing persistence column during migration. */
  pace: null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  capPct: number | null;
  nextCapChangeAt: Date | null;
  /** FR-4.6: 5h used% >= floor_5h, independent of throttle state. */
  floorActive: boolean;
  /** FR-4.8: model-specific weekly buckets at/above bucket_hold. */
  bucketHolds: FleetWindow[];
  /** Slugs for every held model-scoped weekly window. */
  excludedModels: string[];
  /** One human-readable sentence naming the inputs that drove the decision. */
  reason: string;
  paramsVersion: string;
  launchParameters: LaunchParameters;
  holds: {
    /** Legacy hold field: true whenever new work is blocked. */
    newP2PlusDispatch: boolean;
    /** Legacy hold field: true whenever new work is blocked. */
    allNonP0Dispatch: boolean;
    /** Hold worker launches when capped, red, stale, or the five-hour floor is active. */
    newNonP0WorkerLaunches: boolean;
    /** RED (FR-4.4/FR-4.7): interrupt running non-P0 runs. */
    interruptRunningNonP0: boolean;
    /** The cap policy does not accelerate sweepers. */
    releaseP3Sweepers: boolean;
  };
}

/**
 * Project priority class for run admission (task 2). Sourced from the
 * project's `env` jsonb, key `FLEET_CLASS`; defaults to `P2` when unset,
 * unparseable, or the project/projectId is unknown.
 */
export type ProjectClass = "P0" | "P1" | "P2";

/**
 * Output of `FleetGovernorService.getAdmission()` — whether a run is allowed
 * to start right now, independent of budgets. This is a read of the
 * governor's *latest decision*, not a new policy computation: the actual
 * throttle-state math stays in `decideThrottle` above.
 */
export interface FleetAdmission {
  /**
   * Whether the caller may proceed. In shadow mode this is always `true`
   * (the governor never blocks in shadow mode); in enforce mode it is `false`
   * when the admission rules would block this run.
   */
  allowed: boolean;
  mode: "shadow" | "enforce";
  /** The throttle state the decision was based on, or null if no decision exists yet. */
  state: ThrottleState | null;
  /** True when there is no recent-enough governor decision to trust (see getAdmission's rules). */
  stale: boolean;
  /** Human-readable explanation of the admission verdict, for logs/audit. */
  reason: string;
  projectClass: ProjectClass;
  /**
   * True when the admission rules evaluated to "block", regardless of mode.
   * In shadow mode this is the only signal that a run *would* have been
   * blocked under enforce; in enforce mode it mirrors `!allowed`.
   */
  wouldBlock: boolean;
}
