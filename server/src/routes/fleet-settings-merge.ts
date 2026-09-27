import type { GovernorParamsPatch } from "@paperclipai/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Merge a validated PATCH onto stored overrides, preserving other provider/window schedules. */
export function mergeFleetParamsPatch(
  existing: Record<string, unknown> | null,
  patch: GovernorParamsPatch,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, ...patch };
  if (patch.capSchedules === undefined) return merged;

  const existingSchedules = isRecord(existing?.capSchedules) ? existing.capSchedules : {};
  const capSchedules: Record<string, Record<string, unknown>> = {};
  for (const [provider, windows] of Object.entries(existingSchedules)) {
    capSchedules[provider] = isRecord(windows) ? { ...windows } : {};
  }
  for (const [provider, windows] of Object.entries(patch.capSchedules)) {
    capSchedules[provider] = { ...(capSchedules[provider] ?? {}), ...windows };
  }
  merged.capSchedules = capSchedules;
  return merged;
}
