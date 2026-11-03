/**
 * Pure token usage weighting for fleet fairness and metering.
 *
 * These values are proxy ratios expressed as units per token. They are not
 * current billing facts, and callers must not present weighted units as money.
 * This module does no I/O; callers load the fleet setting and pass its JSON
 * value to {@link loadWeightTable}.
 */

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ModelWeights {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ProviderWeights = Record<string, ModelWeights>;
export type WeightTable = Record<string, ProviderWeights & { "*": ModelWeights }>;

const fableWeights: ModelWeights = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 };
const haikuWeights: ModelWeights = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

/**
 * Seeded from Anthropic API list-price ratios per million tokens as of
 * 2026-09. The ratios are proxy weights for metering, not billing facts.
 */
export const DEFAULT_WEIGHT_TABLE: WeightTable = {
  anthropic: {
    "claude-fable-5-1": fableWeights,
    "claude-fable-5": fableWeights,
    "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    "claude-haiku-4-5-20251001": haikuWeights,
    "claude-haiku-4-5": haikuWeights,
    "*": fableWeights,
  },
  openai: {
    // Placeholder only; OpenAI weights have not been fitted.
    "*": { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
  },
};

const WEIGHT_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.hasOwn(record, key);
}

function isValidWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Deep-merge a `fleet_settings.provider_weights` JSON value over the defaults.
 * Unknown or malformed entries are ignored; valid fields in partial model
 * overrides still apply. An empty model key is a wildcard alias.
 */
export function loadWeightTable(settingsValue: unknown): WeightTable {
  const merged = Object.create(null) as WeightTable;
  for (const [provider, models] of Object.entries(DEFAULT_WEIGHT_TABLE)) {
    const providerModels = Object.create(null) as ProviderWeights & { "*": ModelWeights };
    for (const [model, weights] of Object.entries(models)) providerModels[model] = { ...weights };
    merged[provider] = providerModels;
  }

  if (!isRecord(settingsValue)) return merged;

  for (const [rawProvider, rawModels] of Object.entries(settingsValue)) {
    if (!rawProvider || !isRecord(rawModels)) continue;
    const provider = rawProvider;
    if (!hasOwn(merged, provider)) {
      merged[provider] = Object.assign(Object.create(null), {
        "*": { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
    const providerTable = merged[provider];

    for (const [rawModel, rawWeights] of Object.entries(rawModels)) {
      if (!isRecord(rawWeights)) continue;
      const model = rawModel || "*";
      const existing = (hasOwn(providerTable, model) ? providerTable[model] : undefined)
        ?? (hasOwn(providerTable, "*") ? providerTable["*"] : undefined)
        ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const next = { ...existing };
      let changed = false;
      for (const field of WEIGHT_FIELDS) {
        const value = rawWeights[field];
        if (isValidWeight(value)) {
          next[field] = value;
          changed = true;
        }
      }
      if (changed || hasOwn(providerTable, model)) providerTable[model] = next;
    }

    // A provider added only with exact models still needs a deterministic
    // wildcard for all its other models. An unconfigured provider remains 0.
    if (!hasOwn(providerTable, "*")) {
      providerTable["*"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
  }

  return merged;
}

function validCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Calculate weighted usage units for one provider/model usage record. */
export function weightedUnits(
  provider: string,
  model: string,
  counts: TokenCounts,
  table: WeightTable = DEFAULT_WEIGHT_TABLE,
): number {
  if (!hasOwn(table, provider)) return 0;
  const providerWeights = table[provider];

  let weights = hasOwn(providerWeights, model) ? providerWeights[model] : undefined;
  if (!weights) {
    let longestPrefix = "";
    for (const candidate of Object.keys(providerWeights)) {
      if (candidate !== "*" && model.startsWith(candidate) && candidate.length > longestPrefix.length) {
        longestPrefix = candidate;
      }
    }
    if (longestPrefix) weights = providerWeights[longestPrefix];
  }
  if (!weights && hasOwn(providerWeights, "*")) weights = providerWeights["*"];
  if (!weights) return 0;

  return validCount(counts.inputTokens) * weights.input
    + validCount(counts.outputTokens) * weights.output
    + validCount(counts.cacheReadInputTokens) * weights.cacheRead
    + validCount(counts.cacheCreationInputTokens) * weights.cacheWrite;
}
