import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClaudeQuota } from "./quota.js";

describe("fetchClaudeQuota scoped limits", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  function mockUsage(body: unknown): void {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => body } as Response);
  }

  const typed = {
    five_hour: { utilization: 9, resets_at: null },
    seven_day: { utilization: 82, resets_at: null },
    seven_day_sonnet: { utilization: 30, resets_at: null },
    seven_day_opus: { utilization: 20, resets_at: null },
    extra_usage: { is_enabled: false },
  };
  const fable = {
    kind: "weekly_scoped",
    group: "weekly",
    percent: 40,
    severity: "normal",
    resets_at: "2026-09-27T12:59:59.781798+00:00",
    scope: { model: { id: null, display_name: "Fable" }, surface: null },
    is_active: false,
  };

  it("adds only the model-scoped window from a mixed limits array", async () => {
    mockUsage({ ...typed, limits: [
      { kind: "session", group: "session", percent: 9, scope: null },
      { kind: "weekly_all", group: "weekly", percent: 82, scope: null },
      fable,
    ] });
    const windows = await fetchClaudeQuota("token");
    expect(windows).toHaveLength(6);
    expect(windows[5]).toEqual({
      label: "Current week (Fable only)",
      key: "seven_day_model:fable",
      usedPercent: 40,
      resetsAt: fable.resets_at,
      valueLabel: null,
      detail: null,
      raw: fable,
    });
  });

  it("keeps the five typed windows unchanged when limits is missing or malformed", async () => {
    mockUsage(typed);
    const withoutLimits = await fetchClaudeQuota("token");
    expect(withoutLimits.map((window) => window.key)).toEqual([
      "five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus", "extra_usage",
    ]);
    expect(withoutLimits.map((window) => window.label)).toEqual([
      "Current session", "Current week (all models)", "Current week (Sonnet only)",
      "Current week (Opus only)", "Extra usage",
    ]);
    mockUsage({ ...typed, limits: {} });
    expect(await fetchClaudeQuota("token")).toEqual(withoutLimits);
  });

  it("prefers a typed Opus window and deduplicates repeated scoped keys", async () => {
    mockUsage({ ...typed, limits: [
      { ...fable, scope: { model: { display_name: "Opus" }, surface: null } },
      fable,
      { ...fable, percent: 90 },
    ] });
    const windows = await fetchClaudeQuota("token");
    expect(windows.filter((window) => window.label === "Current week (Opus only)"))
      .toEqual([expect.objectContaining({ key: "seven_day_opus", usedPercent: 20 })]);
    expect(windows.filter((window) => window.key === "seven_day_model:fable")).toHaveLength(1);
    expect(windows).toHaveLength(6);
  });

  it("skips malformed scoped entries without losing valid ones", async () => {
    mockUsage({ limits: [
      null, 5, { ...fable, scope: null },
      { ...fable, scope: { model: { display_name: " " } } },
      { ...fable, percent: "40" },
      { ...fable, percent: Number.NaN },
      { ...fable, percent: -1 },
      { ...fable, resets_at: 123 },
      fable,
    ] });
    expect((await fetchClaudeQuota("token")).map((window) => window.key))
      .toEqual(["seven_day_model:fable"]);
  });

  it("uses percent values as percentage points, including zero and fractions", async () => {
    mockUsage({ limits: [
      { ...fable, percent: 0 },
      { ...fable, percent: 0.6, scope: { model: { display_name: "Haiku 4.5" } } },
    ] });
    expect((await fetchClaudeQuota("token")).map((window) => [window.key, window.usedPercent]))
      .toEqual([["seven_day_model:fable", 0], ["seven_day_model:haiku_4_5", 0.6]]);
  });

  it("uses null for an omitted scoped reset time", async () => {
    mockUsage({ limits: [{ kind: "weekly_scoped", percent: 40, scope: fable.scope }] });
    expect(await fetchClaudeQuota("token")).toEqual([expect.objectContaining({
      key: "seven_day_model:fable",
      resetsAt: null,
    })]);
  });

  it("uses the surface namespace when a model is absent", async () => {
    const surface = { ...fable, scope: { model: null, surface: { display_name: "Claude Code" } } };
    mockUsage({ limits: [surface] });
    expect(await fetchClaudeQuota("token")).toEqual([expect.objectContaining({
      label: "Current week (Claude Code only)",
      key: "seven_day_surface:claude_code",
      usedPercent: 40,
      raw: surface,
    })]);
  });
});
