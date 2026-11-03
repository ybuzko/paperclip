import { z } from "zod";

const capScheduleSchema = z.object({
  timeZone: z.string().min(1).refine((timeZone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA time zone"),
  segments: z.array(z.object({
    beforeResetHours: z.number().finite().positive().nullable(),
    capPct: z.number().finite().min(0).max(100),
  })).min(1).superRefine((segments, context) => {
    if (segments[0]?.beforeResetHours !== null) {
      context.addIssue({ code: "custom", message: "The first segment must be the null base", path: [0, "beforeResetHours"] });
    }
    let previousHours = Infinity;
    for (let i = 1; i < segments.length; i++) {
      const hours = segments[i]!.beforeResetHours;
      if (hours === null || hours >= previousHours) {
        context.addIssue({ code: "custom", message: "Step offsets must be strictly descending after the base", path: [i, "beforeResetHours"] });
      }
      if (hours !== null) previousHours = hours;
    }
  }),
}).strict();

// Mirrors server/src/services/fleet/types.ts's GovernorParams shape (partial,
// for PATCH). Kept independent of that module (which must stay pure/import-free
// per its README) rather than imported from it.
export const governorParamsPatchSchema = z
  .object({
    capSchedules: z.record(z.string(), z.record(z.string(), capScheduleSchema)),
    floor5h: z.number().min(0).max(100),
    red5h: z.number().min(0).max(100),
    hysteresisPp: z.number().min(0),
    bucketHoldPct: z.number().min(0).max(100),
    staleAfterMs: z.number().int().positive(),
    senseIntervalMs: z.number().int().positive(),
    maxConcurrency: z.number().int().min(0),
    paramsVersion: z.string().min(1),
  })
  .partial()
  .strict();

export const governorModeSchema = z.enum(["shadow", "enforce"]);

export const patchFleetSettingsSchema = z
  .object({
    mode: governorModeSchema.optional(),
    params: governorParamsPatchSchema.optional(),
  })
  .strict();

export type GovernorParamsPatch = z.infer<typeof governorParamsPatchSchema>;
export type PatchFleetSettings = z.infer<typeof patchFleetSettingsSchema>;
