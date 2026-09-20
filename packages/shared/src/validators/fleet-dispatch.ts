import { z } from "zod";

// Mirrors server/src/services/fleet/dispatch-service.ts's
// `DispatchServiceParams` shape (partial, for PATCH). Kept independent of
// that module and of server/src/services/fleet/dispatch-policy.ts (which
// must stay pure/import-free per fleet/README.md) rather than imported from
// either.
export const dispatchParamsPatchSchema = z
  .object({
    minNudgeGapMs: z.number().int().positive(),
    backoffMs: z.array(z.number().int().positive()).min(1),
    maxBackoffLevel: z.number().int().min(0),
    pollIntervalMs: z.number().int().positive(),
  })
  .partial()
  .strict();

export const dispatchModeSchema = z.enum(["shadow", "enforce"]);

export const dispatchJiraSettingsSchema = z
  .object({
    baseUrl: z.string().min(1),
    email: z.string().min(1),
    tokenSecretId: z.string().min(1),
  })
  .strict();

export const patchFleetDispatchSettingsSchema = z
  .object({
    dispatch_mode: dispatchModeSchema.optional(),
    dispatch_params: dispatchParamsPatchSchema.optional(),
    jira: dispatchJiraSettingsSchema.optional(),
  })
  .strict();

export type DispatchParamsPatch = z.infer<typeof dispatchParamsPatchSchema>;
export type DispatchJiraSettings = z.infer<typeof dispatchJiraSettingsSchema>;
export type PatchFleetDispatchSettings = z.infer<typeof patchFleetDispatchSettingsSchema>;
