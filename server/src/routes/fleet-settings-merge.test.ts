import { describe, expect, it } from "vitest";
import { mergeFleetParamsPatch } from "./fleet-settings-merge.js";

const schedule = (capPct: number) => ({
  timeZone: "America/Los_Angeles",
  segments: [{ beforeResetHours: null, capPct }],
});

describe("fleet settings PATCH merge", () => {
  it("preserves other providers, windows, and scalar settings", () => {
    const existing = {
      floor5h: 85,
      capSchedules: {
        anthropic: { seven_day: schedule(70), "seven_day_model:fable": schedule(65) },
        openai: { seven_day: schedule(60) },
      },
    };
    const merged = mergeFleetParamsPatch(existing, {
      red5h: 95,
      capSchedules: { anthropic: { seven_day: schedule(80) } },
    });
    expect(merged).toEqual({
      floor5h: 85,
      red5h: 95,
      capSchedules: {
        anthropic: { seven_day: schedule(80), "seven_day_model:fable": schedule(65) },
        openai: { seven_day: schedule(60) },
      },
    });
    expect(existing.capSchedules.anthropic.seven_day).toEqual(schedule(70));
  });
  it("handles absent stored overrides", () => {
    expect(mergeFleetParamsPatch(null, { floor5h: 81 })).toEqual({ floor5h: 81 });
  });
});
