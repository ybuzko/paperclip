import { z } from "zod";

// Mirrors server/src/services/fleet/types.ts's GovernorParams shape (partial,
// for PATCH). Kept independent of that module (which must stay pure/import-free
// per its README) rather than imported from it.
export const governorParamsPatchSchema = z
  .object({
    amberPace: z.number().positive(),
    redPace: z.number().positive(),
    accelPace: z.number().positive(),
    accelEarliestDay: z.number().int().min(1).max(7),
    floor5h: z.number().min(0).max(100),
    red5h: z.number().min(0).max(100),
    hysteresisPp: z.number().min(0),
    bucketHoldPct: z.number().min(0).max(100),
    staleAfterMs: z.number().int().positive(),
    /** Fraction (0..1) of the weekly window before pace tiers apply (pace hypersensitivity fix). */
    minElapsedFraction: z.number().min(0).max(1),
    senseIntervalMs: z.number().int().positive(),
    defaultModels: z
      .object({
        supervisor: z.string().min(1),
        coder: z.string().min(1),
        evaluator: z.string().min(1),
      })
      .partial(),
    amberModel: z.string().min(1),
    amberEffort: z.string().min(1),
    amberConcurrencyStep: z.number().int().min(0),
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
