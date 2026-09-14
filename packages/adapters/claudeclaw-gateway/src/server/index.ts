import type { AdapterSessionCodec, AdapterSessionManagement } from "@paperclipai/adapter-utils";

export {
  execute,
  buildWakeMessage,
  mapInjectResponse,
  classifyHttpStatus,
  normalizeBaseUrl,
  resolveClaimedApiKeyPath,
} from "./execute.js";
export { testEnvironment } from "./test.js";
export { getConfigSchema } from "./config-schema.js";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * claudeclaw owns the session (`claude -p --resume <id>` from its own
 * session.json); Paperclip only records the id it reports for display and
 * continuity checks.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const claudeclawSessionId = readString(record.claudeclawSessionId) ?? readString(record.sessionId);
    return claudeclawSessionId ? { claudeclawSessionId } : null;
  },
  serialize(params) {
    if (!params) return null;
    const claudeclawSessionId = readString(params.claudeclawSessionId) ?? readString(params.sessionId);
    return claudeclawSessionId ? { claudeclawSessionId } : null;
  },
  getDisplayId(params) {
    if (!params) return null;
    return readString(params.claudeclawSessionId) ?? readString(params.sessionId);
  },
};

export const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "confirmed",
  defaultSessionCompaction: {
    enabled: false,
    maxSessionRuns: 0,
    maxRawInputTokens: 0,
    maxSessionAgeHours: 0,
  },
};
