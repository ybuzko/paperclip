import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  fleetLimitSnapshots,
  fleetSettings,
  fleetThrottleStates,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import {
  createFleetGovernorService,
  GOVERNOR_MODE_SETTINGS_KEY,
  GOVERNOR_PARAMS_SETTINGS_KEY,
  type FleetGovernorLogger,
} from "./governor-service.js";
import { DEFAULT_GOVERNOR_PARAMS } from "./types.js";

function fakeLogger(): FleetGovernorLogger {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

const OK_ANTHROPIC_WINDOWS_BY_KEY: ProviderQuotaResult = {
  provider: "anthropic",
  source: "oauth_usage",
  ok: true,
  windows: [
    { label: "Current session", key: "five_hour", usedPercent: 12, resetsAt: "2026-01-01T00:00:00.000Z", valueLabel: null, detail: null },
    { label: "Current week (all models)", key: "seven_day", usedPercent: 40, resetsAt: "2026-01-05T00:00:00.000Z", valueLabel: null, detail: null },
    { label: "Current week (Sonnet only)", key: "seven_day_sonnet", usedPercent: 5, resetsAt: null, valueLabel: null, detail: null },
    { label: "Current week (Opus only)", key: "seven_day_opus", usedPercent: 91, resetsAt: null, valueLabel: null, detail: null },
    { label: "Extra usage", key: "extra_usage", usedPercent: null, resetsAt: null, valueLabel: "Not enabled", detail: null },
    { label: "Some future window", usedPercent: 1, resetsAt: null, valueLabel: null, detail: null },
  ],
};

const OK_ANTHROPIC_WINDOWS_BY_LABEL: ProviderQuotaResult = {
  provider: "anthropic",
  source: "claude-cli",
  ok: true,
  windows: OK_ANTHROPIC_WINDOWS_BY_KEY.windows.map(({ key: _key, ...rest }) => rest),
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping fleet governor service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("fleet governor service (embedded postgres)", () => {
  let stopDb: (() => Promise<void>) | undefined;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("fleet-governor-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(fleetThrottleStates);
    await db.delete(fleetLimitSnapshots);
    await db.delete(fleetSettings);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  describe("senseOnce", () => {
    it("maps windows by their stable key", async () => {
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [OK_ANTHROPIC_WINDOWS_BY_KEY],
        now: () => new Date("2026-01-02T00:00:00.000Z"),
      });

      const result = await svc.senseOnce();

      expect(result.ok).toBe(true);
      expect(result.snapshots).toHaveLength(5);
      const byWindow = new Map(result.snapshots.map((row) => [row.window, row]));
      expect(byWindow.get("five_hour")).toMatchObject({ usedPct: 12, ok: true });
      expect(byWindow.get("seven_day")).toMatchObject({ usedPct: 40, ok: true });
      expect(byWindow.get("seven_day_sonnet")).toMatchObject({ usedPct: 5, ok: true });
      expect(byWindow.get("seven_day_opus")).toMatchObject({ usedPct: 91, ok: true });
      expect(byWindow.get("extra_usage")).toMatchObject({ usedPct: null, ok: true });
      // The unmapped "Some future window" window is dropped, not written.
      expect(result.snapshots.some((row) => row.window === "Some future window")).toBe(false);
    });

    it("falls back to mapping by label when key is absent", async () => {
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [OK_ANTHROPIC_WINDOWS_BY_LABEL],
        now: () => new Date("2026-01-02T00:00:00.000Z"),
      });

      const result = await svc.senseOnce();

      expect(result.ok).toBe(true);
      const byWindow = new Map(result.snapshots.map((row) => [row.window, row]));
      expect(byWindow.get("five_hour")).toMatchObject({ usedPct: 12 });
      expect(byWindow.get("seven_day_opus")).toMatchObject({ usedPct: 91 });
      expect(byWindow.get("extra_usage")).toMatchObject({ usedPct: null });
      expect(result.snapshots).toHaveLength(5);
    });

    it("writes one failure row when the provider throws", async () => {
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => {
          throw new Error("boom");
        },
        now: () => new Date("2026-01-02T00:00:00.000Z"),
      });

      const result = await svc.senseOnce();

      expect(result.ok).toBe(false);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]).toMatchObject({
        window: "seven_day",
        ok: false,
        error: "boom",
        source: "anthropic",
      });
    });

    it("writes one failure row when the provider reports ok:false", async () => {
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [
          { provider: "anthropic", ok: false, error: "no local claude auth token", windows: [] },
        ],
        now: () => new Date("2026-01-02T00:00:00.000Z"),
      });

      const result = await svc.senseOnce();

      expect(result.ok).toBe(false);
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]).toMatchObject({
        window: "seven_day",
        ok: false,
        error: "no local claude auth token",
      });
    });
  });

  describe("evaluate", () => {
    it("persists on the first run and again when the decision changes", async () => {
      let now = new Date("2026-01-02T00:00:00.000Z");
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [OK_ANTHROPIC_WINDOWS_BY_KEY],
        now: () => now,
      });

      await svc.senseOnce();
      const first = await svc.evaluate();
      expect(first.persisted).toBe(true);

      const rowsAfterFirst = await db.select().from(fleetThrottleStates);
      expect(rowsAfterFirst).toHaveLength(1);

      // Move time forward (but well under the 60-minute heartbeat) and record
      // a snapshot that flips 5h utilization into RED — the decision changes.
      now = new Date(now.getTime() + 5 * 60 * 1000);
      await db.insert(fleetLimitSnapshots).values({
        window: "five_hour",
        usedPct: 95,
        resetsAt: null,
        source: "anthropic",
        ok: true,
        error: null,
        raw: null,
        observedAt: now,
      });

      const second = await svc.evaluate();
      expect(second.persisted).toBe(true);
      expect(second.decision.state).toBe("RED");

      const rowsAfterSecond = await db.select().from(fleetThrottleStates);
      expect(rowsAfterSecond).toHaveLength(2);
    });

    it("does not persist again when nothing changed within the heartbeat window", async () => {
      const now = new Date("2026-01-02T00:00:00.000Z");
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [OK_ANTHROPIC_WINDOWS_BY_KEY],
        now: () => now,
      });

      await svc.senseOnce();
      const first = await svc.evaluate();
      expect(first.persisted).toBe(true);

      const second = await svc.evaluate();
      expect(second.persisted).toBe(false);
      expect(second.decision.state).toBe(first.decision.state);

      const rows = await db.select().from(fleetThrottleStates);
      expect(rows).toHaveLength(1);
    });

    it("marks the decision stale when the only snapshots are old", async () => {
      const seededAt = new Date("2026-01-02T00:00:00.000Z");
      await db.insert(fleetLimitSnapshots).values([
        {
          window: "five_hour",
          usedPct: 10,
          resetsAt: null,
          source: "anthropic",
          ok: true,
          error: null,
          raw: null,
          observedAt: seededAt,
        },
        {
          window: "seven_day",
          usedPct: 20,
          resetsAt: new Date("2026-01-08T00:00:00.000Z"),
          source: "anthropic",
          ok: true,
          error: null,
          raw: null,
          observedAt: seededAt,
        },
      ]);

      // Evaluate 20 minutes later — past the 15-minute default staleAfterMs,
      // with no fresher snapshot recorded in between.
      const laterNow = new Date(seededAt.getTime() + 20 * 60 * 1000);
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [OK_ANTHROPIC_WINDOWS_BY_KEY],
        now: () => laterNow,
      });

      const result = await svc.evaluate();
      expect(result.decision.stale).toBe(true);
      expect(result.decision.state).toBe("AMBER");
    });
  });

  describe("settings merge", () => {
    it("applies stored governor_mode and governor_params overrides", async () => {
      await db.insert(fleetSettings).values([
        {
          key: GOVERNOR_MODE_SETTINGS_KEY,
          value: { mode: "enforce" },
          version: "v1",
          updatedAt: new Date(),
          updatedBy: "test-admin",
        },
        {
          key: GOVERNOR_PARAMS_SETTINGS_KEY,
          value: { amberPace: 2.5 },
          version: "v1",
          updatedAt: new Date(),
          updatedBy: "test-admin",
        },
      ]);

      const now = new Date("2026-01-02T00:00:00.000Z");
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [OK_ANTHROPIC_WINDOWS_BY_KEY],
        now: () => now,
      });

      await svc.senseOnce();
      const result = await svc.evaluate();

      expect(result.mode).toBe("enforce");
      expect(result.params.amberPace).toBe(2.5);
      // Unset fields still come from the defaults (deep-merge, not replace).
      expect(result.params.redPace).toBe(DEFAULT_GOVERNOR_PARAMS.redPace);
      expect(result.params.defaultModels).toEqual(DEFAULT_GOVERNOR_PARAMS.defaultModels);

      const [persisted] = await db.select().from(fleetThrottleStates);
      expect(persisted?.mode).toBe("enforce");
    });
  });

  describe("getStatus", () => {
    it("reports mode, params, and per-window staleness", async () => {
      const now = new Date("2026-01-02T00:00:00.000Z");
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [OK_ANTHROPIC_WINDOWS_BY_KEY],
        now: () => now,
      });

      await svc.senseOnce();
      const status = await svc.getStatus();

      expect(status.mode).toBe("shadow");
      expect(status.params).toEqual(DEFAULT_GOVERNOR_PARAMS);
      expect(status.snapshots.length).toBeGreaterThan(0);
      expect(status.snapshots.every((snapshot) => snapshot.stale === false)).toBe(true);
      expect(status.nextDueAt.getTime()).toBeGreaterThan(now.getTime());
    });
  });
});
