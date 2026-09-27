import { describe, expect, it } from "vitest";
import { governorParamsPatchSchema } from "./fleet.js";

describe("governor settings patch", () => {
  it("accepts cap schedules and rejects retired pace settings", () => {
    expect(governorParamsPatchSchema.safeParse({
      capSchedules: { anthropic: { seven_day: { timeZone: "America/Los_Angeles", segments: [
        { beforeResetHours: null, capPct: 70 }, { beforeResetHours: 10, capPct: 80 },
      ] } } },
    }).success).toBe(true);
    expect(governorParamsPatchSchema.safeParse({ amberPace: 1.15 }).success).toBe(false);
    expect(governorParamsPatchSchema.safeParse({
      capSchedules: { anthropic: { seven_day: { timeZone: "America/Los_Angeles", segments: [{ beforeResetHours: 10, capPct: 110 }] } } },
    }).success).toBe(false);
  });
});
