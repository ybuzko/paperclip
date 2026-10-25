/** Pure cap-based fleet governor policy. No I/O or clock reads. */
import {
  DEFAULT_GOVERNOR_PARAMS,
  type CapSchedule,
  type FleetWindow,
  type GovernorDecision,
  type GovernorParams,
  type LimitSnapshot,
  type ThrottleState,
  modelScopeForWindow,
} from "./types.js";

const HOUR_MS = 3_600_000;

/** Latest snapshot per window, by observation time. */
export function latestSnapshotByWindow(snapshots: LimitSnapshot[]): Map<FleetWindow, LimitSnapshot> {
  const latest = new Map<FleetWindow, LimitSnapshot>();
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.window);
    if (!current || snapshot.observedAt.getTime() > current.observedAt.getTime()) {
      latest.set(snapshot.window, snapshot);
    }
  }
  return latest;
}

export function isStale(snapshot: LimitSnapshot | undefined, now: Date, params: GovernorParams): boolean {
  return !snapshot || !Number.isFinite(snapshot.observedAt.getTime()) ||
    snapshot.observedAt.getTime() > now.getTime() ||
    now.getTime() - snapshot.observedAt.getTime() > params.staleAfterMs;
}

function capSegmentAt(nowMs: number, resetMs: number, schedule: CapSchedule): number {
  const hoursRemaining = (resetMs - nowMs) / HOUR_MS;
  let index = -1;
  for (let i = 0; i < schedule.segments.length; i++) {
    const segment = schedule.segments[i]!;
    if (segment.beforeResetHours === null || hoursRemaining < segment.beforeResetHours) index = i;
  }
  if (index < 0) throw new RangeError("cap schedule requires a base segment");
  return index;
}

/**
 * The offsets are elapsed hours before the reset instant, regardless of a
 * daylight-saving transition. Since the step condition is strict, the new cap
 * starts one millisecond after the exact T−N-hour boundary (Date precision).
 */
export function capFor(now: Date, resetsAt: Date, schedule: CapSchedule): {
  capPct: number;
  segmentIndex: number;
  nextChangeAt: Date | null;
} {
  const nowMs = now.getTime();
  const resetMs = resetsAt.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(resetMs)) throw new RangeError("invalid cap timestamp");
  const segmentIndex = capSegmentAt(nowMs, resetMs, schedule);
  let nextMs: number | null = null;
  for (const segment of schedule.segments) {
    if (segment.beforeResetHours === null) continue;
    const boundaryMs = resetMs - segment.beforeResetHours * HOUR_MS + 1;
    if (boundaryMs <= nowMs || boundaryMs >= resetMs) continue;
    if (capSegmentAt(boundaryMs, resetMs, schedule) === segmentIndex) continue;
    if (nextMs === null || boundaryMs < nextMs) nextMs = boundaryMs;
  }
  return {
    capPct: schedule.segments[segmentIndex]!.capPct,
    segmentIndex,
    nextChangeAt: nextMs === null ? null : new Date(nextMs),
  };
}

function formatInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    second: "2-digit", timeZoneName: "short",
  }).format(date);
}

export function decideThrottle(input: {
  snapshots: LimitSnapshot[];
  previousState: ThrottleState | null;
  /** Cap used by the previous decision, needed to release on a scheduled step-up. */
  previousCapPct?: number | null;
  provider?: string;
  params?: GovernorParams;
  now: Date;
}): GovernorDecision {
  const params = input.params ?? DEFAULT_GOVERNOR_PARAMS;
  const provider = input.provider ?? "anthropic";
  const latest = latestSnapshotByWindow(input.snapshots.filter(s => s.provider === provider));
  const fiveHour = latest.get("five_hour");
  const sevenDay = latest.get("seven_day");
  const fiveHourPct = fiveHour?.usedPct ?? null;
  const sevenDayPct = sevenDay?.usedPct ?? null;
  const schedule = params.capSchedules[provider]?.seven_day;
  const reset = sevenDay?.resetsAt;
  const validPct = (pct: number | null): pct is number => pct !== null && Number.isFinite(pct) && pct >= 0 && pct <= 100;
  const stale = isStale(fiveHour, input.now, params) || isStale(sevenDay, input.now, params) ||
    !validPct(fiveHourPct) || !validPct(sevenDayPct) || !schedule || !reset ||
    !Number.isFinite(reset.getTime()) || reset.getTime() <= input.now.getTime();
  const cap = !stale && schedule && reset ? capFor(input.now, reset, schedule) : null;
  const floorActive = validPct(fiveHourPct) && fiveHourPct >= params.floor5h;
  const bucketHolds: FleetWindow[] = [];
  const excludedModels = new Set<string>();
  for (const [window, snapshot] of latest) {
    const slug = modelScopeForWindow(window);
    if (slug && validPct(snapshot.usedPct) && snapshot.usedPct >= params.bucketHoldPct) {
      bucketHolds.push(window);
      excludedModels.add(slug);
    }
  }

  let state: ThrottleState;
  if (stale) state = "STALE";
  else if (fiveHourPct !== null && fiveHourPct >= params.red5h) state = "RED";
  else if (sevenDayPct !== null && cap && sevenDayPct >= cap.capPct) state = "CAPPED";
  else if (
    input.previousState === "CAPPED" && sevenDayPct !== null && cap &&
    !(input.previousCapPct !== null && input.previousCapPct !== undefined && cap.capPct > input.previousCapPct) &&
    sevenDayPct > cap.capPct - params.hysteresisPp
  ) state = "CAPPED";
  else state = "OPEN";

  const capText = cap && schedule
    ? `weekly cap ${cap.capPct}%${cap.nextChangeAt ? `, next change ${formatInZone(cap.nextChangeAt, schedule.timeZone)}` : ""}`
    : "weekly cap unavailable";
  const reason = `${state}: five_hour ${fiveHourPct ?? "unknown"}%, seven_day ${sevenDayPct ?? "unknown"}%; ${capText}.` +
    (floorActive ? ` Five-hour floor ${params.floor5h}% active.` : "") +
    (excludedModels.size ? ` Excluded models: ${[...excludedModels].join(", ")}.` : "");
  const blocksNewWork = state === "RED" || state === "STALE" || state === "CAPPED";
  return {
    state, stale, pace: null, fiveHourPct, sevenDayPct,
    capPct: cap?.capPct ?? null, nextCapChangeAt: cap?.nextChangeAt ?? null,
    floorActive, bucketHolds, excludedModels: [...excludedModels], reason,
    paramsVersion: params.paramsVersion,
    launchParameters: { excludedModels: [...excludedModels], maxConcurrency: blocksNewWork || floorActive ? 0 : params.maxConcurrency },
    holds: {
      newP2PlusDispatch: blocksNewWork,
      allNonP0Dispatch: blocksNewWork,
      newNonP0WorkerLaunches: blocksNewWork || floorActive,
      interruptRunningNonP0: state === "RED",
      releaseP3Sweepers: false,
    },
  };
}

/** Next ordinary sense, reset follow-up, or cap step, whichever occurs first. */
export function nextSenseDueAt(
  latest: Map<FleetWindow, LimitSnapshot>, now: Date, params: GovernorParams,
): Date {
  let dueMs = now.getTime() + params.senseIntervalMs;
  for (const snapshot of latest.values()) {
    const resetMs = snapshot.resetsAt?.getTime();
    if (resetMs === undefined || !Number.isFinite(resetMs) || resetMs <= now.getTime()) continue;
    const resetFollowup = resetMs + 60_000;
    if (resetFollowup < dueMs) dueMs = resetFollowup;
    const schedule = params.capSchedules[snapshot.provider ?? "anthropic"]?.[snapshot.window];
    if (schedule) {
      const nextChangeMs = capFor(now, snapshot.resetsAt!, schedule).nextChangeAt?.getTime();
      if (nextChangeMs !== undefined && nextChangeMs < dueMs) dueMs = nextChangeMs;
    }
  }
  return new Date(dueMs);
}
