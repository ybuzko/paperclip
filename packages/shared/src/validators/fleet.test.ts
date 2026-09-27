import { describe, expect, it } from "vitest";
import { governorParamsPatchSchema } from "./fleet.js";

const validSchedule = {
  timeZone: "America/Los_Angeles",
  segments: [
    { beforeResetHours: null, capPct: 70 },
    { beforeResetHours: 10, capPct: 80 },
    { beforeResetHours: 5, capPct: 99 },
  ],
};
const patch = (schedule: unknown) => ({ capSchedules: { anthropic: { seven_day: schedule } } });

describe("governor settings patch", () => {
  it("accepts a valid ordered cap schedule and rejects retired pace settings", () => {
    expect(governorParamsPatchSchema.safeParse(patch(validSchedule)).success).toBe(true);
    expect(governorParamsPatchSchema.safeParse({ amberPace: 1.15 }).success).toBe(false);
  });

  it.each([
    ["invalid time zone", { ...validSchedule, timeZone: "Mars/Olympus_Mons" }],
    ["missing null base", { ...validSchedule, segments: validSchedule.segments.slice(1) }],
    ["null base in wrong position", { ...validSchedule, segments: [...validSchedule.segments].reverse() }],
    ["duplicate null base", { ...validSchedule, segments: [validSchedule.segments[0], validSchedule.segments[0]] }],
    ["ascending offsets", { ...validSchedule, segments: [validSchedule.segments[0], validSchedule.segments[2], validSchedule.segments[1]] }],
    ["duplicate offsets", { ...validSchedule, segments: [validSchedule.segments[0], validSchedule.segments[1], validSchedule.segments[1]] }],
    ["negative offset", { ...validSchedule, segments: [validSchedule.segments[0], { beforeResetHours: -1, capPct: 80 }] }],
    ["infinite offset", { ...validSchedule, segments: [validSchedule.segments[0], { beforeResetHours: Infinity, capPct: 80 }] }],
    ["NaN cap", { ...validSchedule, segments: [{ beforeResetHours: null, capPct: NaN }] }],
    ["infinite cap", { ...validSchedule, segments: [{ beforeResetHours: null, capPct: Infinity }] }],
    ["cap over 100", { ...validSchedule, segments: [{ beforeResetHours: null, capPct: 110 }] }],
  ])("rejects %s", (_case, schedule) => {
    expect(governorParamsPatchSchema.safeParse(patch(schedule)).success).toBe(false);
  });
});
