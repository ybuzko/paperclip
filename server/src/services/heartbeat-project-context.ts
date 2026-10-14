import { envBindingSchema } from "@paperclipai/shared";

/**
 * Project facts handed to adapters through the execution context.
 *
 * Gateway adapters (for example `claudeclaw_gateway`) do not receive the
 * resolved run env that local adapters get, so they cannot see the project's
 * `env` at all. This helper exposes the project identity plus the project's
 * *plain* env values only. Secret-backed bindings (`secret_ref`,
 * `user_secret_ref`) are never included: the values would otherwise travel in
 * the wake message to a remote host.
 */
export type AdapterProjectContext = {
  projectId: string;
  projectName: string | null;
  projectEnv: Record<string, string>;
};

export function readPlainProjectEnv(envValue: unknown): Record<string, string> {
  if (typeof envValue !== "object" || envValue === null || Array.isArray(envValue)) return {};
  const out: Record<string, string> = {};
  for (const [key, rawBinding] of Object.entries(envValue as Record<string, unknown>)) {
    if (!key.trim()) continue;
    const parsed = envBindingSchema.safeParse(rawBinding);
    if (!parsed.success) continue;
    const binding = parsed.data;
    const value =
      typeof binding === "string"
        ? binding
        : binding.type === "plain"
          ? binding.value
          : null;
    if (value === null) continue;
    if (!value.trim()) continue;
    out[key] = value;
  }
  return out;
}

export function buildAdapterProjectContext(
  project: { id: string; name?: string | null; env?: unknown } | null | undefined,
): AdapterProjectContext | null {
  if (!project || typeof project.id !== "string" || !project.id.trim()) return null;
  const name = typeof project.name === "string" && project.name.trim() ? project.name.trim() : null;
  return {
    projectId: project.id,
    projectName: name,
    projectEnv: readPlainProjectEnv(project.env),
  };
}
