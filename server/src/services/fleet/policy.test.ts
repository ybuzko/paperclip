import { describe, expect, it } from "vitest";
import { capFor, decideThrottle, latestSnapshotByWindow, nextSenseDueAt } from "./policy.js";
import { DEFAULT_GOVERNOR_PARAMS, type LimitSnapshot } from "./types.js";

const schedule = DEFAULT_GOVERNOR_PARAMS.capSchedules.anthropic!.seven_day!;
const now = new Date("2026-09-20T10:00:00Z");
const reset = new Date("2026-09-20T13:00:00Z");
function snapshot(window: string, usedPct: number | null, resetsAt: Date | null = reset, observedAt = now): LimitSnapshot {
  return { provider: "anthropic", window, modelScope: null, usedPct, resetsAt, observedAt, source: "test" };
}
function decide(five = 20, weekly = 50, options: {now?: Date; previousState?: "OPEN"|"CAPPED"|"RED"|"STALE"|null; previousCapPct?: number; extra?: LimitSnapshot[]; weeklyReset?: Date|null; observedAt?: Date} = {}) {
  return decideThrottle({
    snapshots: [snapshot("five_hour", five, reset, options.observedAt), snapshot("seven_day", weekly, options.weeklyReset === undefined ? reset : options.weeklyReset, options.observedAt), ...(options.extra ?? [])],
    previousState: options.previousState ?? null, previousCapPct: options.previousCapPct, now: options.now ?? now,
  });
}
const local = (date: Date) => new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(date).replace(",", "");

describe("cap schedule", () => {
  it.each([
    ["ordinary PDT", "2026-09-20T13:00:00Z", "Sat 8:00 PM PDT", "Sun 1:00 AM PDT"],
    ["ordinary PST", "2026-12-20T14:00:00Z", "Sat 8:00 PM PST", "Sun 1:00 AM PST"],
    ["spring transition", "2026-03-08T13:00:00Z", "Sat 7:00 PM PST", "Sun 12:00 AM PST"],
    ["fall transition", "2026-11-01T14:00:00Z", "Sat 9:00 PM PDT", "Sun 1:00 AM PST"],
  ])("uses elapsed instants across %s", (_name, resetIso, firstLocal, secondLocal) => {
    const resetAt = new Date(resetIso);
    const first = new Date(resetAt.getTime() - 10 * 3_600_000);
    const second = new Date(resetAt.getTime() - 5 * 3_600_000);
    expect(local(first)).toBe(firstLocal);
    expect(local(second)).toBe(secondLocal);
    expect(capFor(new Date(first.getTime() - 1), resetAt, schedule).capPct).toBe(70);
    expect(capFor(first, resetAt, schedule)).toMatchObject({capPct:70,segmentIndex:0,nextChangeAt:new Date(first.getTime()+1)});
    expect(capFor(new Date(first.getTime() + 1), resetAt, schedule).capPct).toBe(80);
    expect(capFor(second, resetAt, schedule)).toMatchObject({capPct:80,segmentIndex:1,nextChangeAt:new Date(second.getTime()+1)});
    expect(capFor(new Date(second.getTime() + 1), resetAt, schedule)).toMatchObject({capPct:99,segmentIndex:2,nextChangeAt:null});
  });
  it("wakes sensing at the next cap change", () => {
    const resetAt = new Date(now.getTime()+10*3_600_000+60_000);
    const latest = latestSnapshotByWindow([snapshot("seven_day", 30, resetAt)]);
    expect(nextSenseDueAt(latest, now, DEFAULT_GOVERNOR_PARAMS)).toEqual(new Date(now.getTime()+60_001));
  });
});

describe("cap-based throttle", () => {
  it("enters CAPPED, holds hysteresis, then releases on clearance", () => {
    expect(decide(20, 99)).toMatchObject({
      state: "CAPPED", launchParameters: { maxConcurrency: 0 },
      holds: { newP2PlusDispatch: true, allNonP0Dispatch: true, newNonP0WorkerLaunches: true },
    });
    expect(decide(20, 97, {previousState:"CAPPED", previousCapPct:99}).state).toBe("CAPPED");
    expect(decide(20, 94, {previousState:"CAPPED", previousCapPct:99}).state).toBe("OPEN");
  });
  it("releases a CAPPED state at 75 when the cap steps from 70 to 80", () => {
    const at = new Date("2026-09-20T03:00:00.001Z");
    const result = decide(20, 75, {now:at, previousState:"CAPPED", previousCapPct:70, observedAt:at});
    expect(result).toMatchObject({state:"OPEN",capPct:80});
  });
  it("gives STALE precedence over RED and CAPPED; RED precedes CAPPED", () => {
    expect(decide(95, 99).state).toBe("RED");
    expect(decide(95, 99, {observedAt:new Date(now.getTime()-20*60_000)}).state).toBe("STALE");
    expect(decide(95, 99, {weeklyReset:null}).state).toBe("STALE");
  });
  it("excludes every held model slug, including Fable", () => {
    const result = decide(20, 50, {extra:[snapshot("seven_day_model:fable",90),snapshot("seven_day_sonnet",91),snapshot("seven_day_surface:claude_code",99)]});
    expect(result.excludedModels).toEqual(["fable","sonnet"]);
    expect(result.launchParameters.excludedModels).toEqual(result.excludedModels);
  });
  it("does not borrow legacy Anthropic snapshots for another provider", () => {
    const result = decideThrottle({
      provider: "openai", now,
      previousState: null,
      snapshots: [snapshot("five_hour", 10), snapshot("seven_day", 20)],
      params: { ...DEFAULT_GOVERNOR_PARAMS, capSchedules: { ...DEFAULT_GOVERNOR_PARAMS.capSchedules, openai: { seven_day: schedule } } },
    });
    expect(result.state).toBe("STALE");
  });
  it("keeps the five-hour floor independent of OPEN and CAPPED", () => {
    expect(decide(85, 50)).toMatchObject({state:"OPEN",floorActive:true,launchParameters:{maxConcurrency:0}});
    expect(decide(85, 99)).toMatchObject({state:"CAPPED",floorActive:true});
    expect(decide(20, 50)).toMatchObject({state:"OPEN",floorActive:false,launchParameters:{maxConcurrency:1}});
  });
});
