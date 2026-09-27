import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHT_TABLE,
  loadWeightTable,
  weightedUnits,
  type TokenCounts,
} from "./weights.js";

const counts: TokenCounts = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadInputTokens: 4,
  cacheCreationInputTokens: 3,
};

describe("fleet token weights", () => {
  it("uses an exact model entry before matching a prefix", () => {
    const table = loadWeightTable({
      anthropic: {
        "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        "claude-sonnet-5-special": { input: 7, output: 8, cacheRead: 9, cacheWrite: 10 },
      },
    });

    expect(weightedUnits("anthropic", "claude-sonnet-5-special", counts, table)).toBe(10 * 7 + 2 * 8 + 4 * 9 + 3 * 10);
  });

  it("uses the longest matching model prefix and then the provider wildcard", () => {
    const table = loadWeightTable({
      anthropic: {
        "exp": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
        "experiment-": { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
        "": { input: 3, output: 3, cacheRead: 3, cacheWrite: 3 },
      },
    });

    expect(weightedUnits("anthropic", "experiment-model-v2", counts, table)).toBe(2 * 19);
    expect(weightedUnits("anthropic", "custom-model", counts, table)).toBe(3 * 19);
    expect(weightedUnits("unknown", "custom-model", counts, table)).toBe(0);
  });

  it("sums token types using their separate weights", () => {
    expect(weightedUnits("anthropic", "claude-sonnet-5", counts)).toBe(10 * 2 + 2 * 10 + 4 * 0.2 + 3 * 2.5);
  });

  it("deep-merges a single cacheRead override and preserves other defaults", () => {
    const table = loadWeightTable({
      anthropic: { "claude-sonnet-5": { cacheRead: 0.75 } },
    });

    expect(table.anthropic["claude-sonnet-5"]).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.75,
      cacheWrite: 2.5,
    });
    expect(DEFAULT_WEIGHT_TABLE.anthropic["claude-sonnet-5"]?.cacheRead).toBe(0.2);
  });

  it("ignores invalid override weights and treats invalid counts as zero", () => {
    const table = loadWeightTable({
      anthropic: { "claude-sonnet-5": { input: -1, output: Number.POSITIVE_INFINITY, cacheRead: 0.75 } },
    });
    expect(table.anthropic["claude-sonnet-5"]).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.75,
      cacheWrite: 2.5,
    });
    expect(weightedUnits("anthropic", "claude-sonnet-5", {
      ...counts,
      inputTokens: -5,
      outputTokens: Number.NaN,
    }, table)).toBe(4 * 0.75 + 3 * 2.5);
  });

  it("does not treat inherited object properties as providers or models", () => {
    const table = loadWeightTable(JSON.parse(
      '{"__proto__":{"__proto__":{"input":999}},"anthropic":{"toString":{"input":7}}}',
    ));

    expect(weightedUnits("toString", "any-model", counts, table)).toBe(0);
    expect(weightedUnits("anthropic", "toString", counts, table)).toBe(10 * 7 + 2 * 50 + 4 * 0.25 + 3 * 12.5);
    expect(Object.getPrototypeOf(table)).toBeNull();
    expect(({} as { input?: number }).input).toBeUndefined();
  });
});
