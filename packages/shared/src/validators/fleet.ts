import { z } from "zod";

// Mirrors server/src/services/fleet/types.ts's GovernorParams shape (partial,
// for PATCH). Kept independent of that module (which must stay pure/import-free
// per its README) rather than imported from it.
export const governorParamsPatchSchema = z
  .object({
    capSchedules: z.record(z.string(), z.record(z.string(), z.object({
      timeZone: z.string().min(1),
      segments: z.array(z.object({
        beforeResetHours: z.number().positive().nullable(),
        capPct: z.number().min(0).max(100),
      })).min(1),
    }).strict())),
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
