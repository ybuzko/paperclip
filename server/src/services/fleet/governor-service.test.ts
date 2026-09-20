import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  fleetLimitSnapshots,
  fleetSettings,
  fleetThrottleStates,
  getEmbeddedPostgresTestSupport,
  projects,
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
    await db.delete(projects);
    await db.delete(companies);
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Admission Test Co",
      status: "active",
      issuePrefix: companyId.slice(0, 8),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedProject(companyId: string, fleetClass: "P0" | "P1" | "P2"): Promise<string> {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Project ${fleetClass}`,
      env: { FLEET_CLASS: { type: "plain", value: fleetClass } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return projectId;
  }

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
      expect(status.admissionsAllowed).toBe(0);
      expect(status.admissionsBlocked).toBe(0);
      expect(status.admissionsWouldBlock).toBe(0);
      expect(status.lastBlock).toBeNull();
    });
  });

  describe("getAdmission", () => {
    const NOW = new Date("2026-01-02T00:00:00.000Z");

    /**
     * Windows with elapsedFraction exactly 0.5 (well past the default
     * minElapsedFraction, and — at weekly day 4 — right at the earliest day
     * ACCELERATE can trigger, so callers should keep sevenDayPct's implied
     * pace clearly above accel_pace (0.8) unless ACCELERATE is intended).
     */
    function quotaResult(opts: { fiveHourPct: number; sevenDayPct: number }): ProviderQuotaResult {
      return {
        provider: "anthropic",
        source: "oauth_usage",
        ok: true,
        windows: [
          { label: "Current session", key: "five_hour", usedPercent: opts.fiveHourPct, resetsAt: null, valueLabel: null, detail: null },
          {
            label: "Current week (all models)",
            key: "seven_day",
            usedPercent: opts.sevenDayPct,
            resetsAt: "2026-01-05T12:00:00.000Z",
            valueLabel: null,
            detail: null,
          },
        ],
      };
    }

    async function evaluatedService(opts: {
      fiveHourPct: number;
      sevenDayPct: number;
      mode?: "shadow" | "enforce";
    }) {
      if (opts.mode) {
        await db.insert(fleetSettings).values({
          key: GOVERNOR_MODE_SETTINGS_KEY,
          value: { mode: opts.mode },
          version: "v1",
          updatedAt: new Date(),
          updatedBy: "test-admin",
        });
      }
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [quotaResult(opts)],
        now: () => NOW,
      });
      await svc.senseOnce();
      await svc.evaluate();
      return svc;
    }

    it("shadow mode: RED never blocks, but reports wouldBlock and the shadow reason", async () => {
      const companyId = await seedCompany();
      const svc = await evaluatedService({ fiveHourPct: 95, sevenDayPct: 40 }); // fresh 5h breach -> RED

      const admission = await svc.getAdmission({ companyId, agentId: "agent-1" });

      expect(admission.state).toBe("RED");
      expect(admission.mode).toBe("shadow");
      expect(admission.allowed).toBe(true);
      expect(admission.wouldBlock).toBe(true);
      expect(admission.reason).toMatch(/^shadow: would block/);
      expect(admission.reason).toMatch(/RED/);
    });

    it("enforce mode: RED blocks", async () => {
      const companyId = await seedCompany();
      const svc = await evaluatedService({ fiveHourPct: 95, sevenDayPct: 40, mode: "enforce" });

      const admission = await svc.getAdmission({ companyId, agentId: "agent-1" });

      expect(admission.state).toBe("RED");
      expect(admission.mode).toBe("enforce");
      expect(admission.allowed).toBe(false);
      expect(admission.wouldBlock).toBe(true);
      expect(admission.reason).toMatch(/RED/);
    });

    it("enforce mode: the interactive floor blocks even under GREEN", async () => {
      const companyId = await seedCompany();
      // 5h at 85% (>= floor_5h 80, < red_5h 90); pace on-plan (45/50=0.9, above
      // accel_pace so it doesn't ACCELERATE at weekly day 4) -> GREEN with floorActive.
      const svc = await evaluatedService({ fiveHourPct: 85, sevenDayPct: 45, mode: "enforce" });

      const admission = await svc.getAdmission({ companyId, agentId: "agent-1" });

      expect(admission.state).toBe("GREEN");
      expect(admission.allowed).toBe(false);
      expect(admission.reason).toMatch(/floor/i);
    });

    it("enforce mode: AMBER blocks P2 projects but allows P0/P1", async () => {
      const companyId = await seedCompany();
      const p0 = await seedProject(companyId, "P0");
      const p1 = await seedProject(companyId, "P1");
      const p2 = await seedProject(companyId, "P2");
      // sevenDayPct 60 at elapsedFraction 0.5 -> pace 1.2 (between amber_pace and red_pace).
      const svc = await evaluatedService({ fiveHourPct: 40, sevenDayPct: 60, mode: "enforce" });

      const admissionP0 = await svc.getAdmission({ companyId, agentId: "agent-1", projectId: p0 });
      const admissionP1 = await svc.getAdmission({ companyId, agentId: "agent-1", projectId: p1 });
      const admissionP2 = await svc.getAdmission({ companyId, agentId: "agent-1", projectId: p2 });

      expect(admissionP0.state).toBe("AMBER");
      expect(admissionP0.projectClass).toBe("P0");
      expect(admissionP0.allowed).toBe(true);

      expect(admissionP1.projectClass).toBe("P1");
      expect(admissionP1.allowed).toBe(true);

      expect(admissionP2.projectClass).toBe("P2");
      expect(admissionP2.allowed).toBe(false);
      expect(admissionP2.reason).toMatch(/AMBER/);
    });

    it("a project with no FLEET_CLASS set, or no projectId at all, defaults to P2", async () => {
      const companyId = await seedCompany();
      const untaggedProject = await seedProject(companyId, "P0");
      // Overwrite env to omit FLEET_CLASS entirely.
      await db.update(projects).set({ env: {} }).where(eq(projects.id, untaggedProject));
      const svc = await evaluatedService({ fiveHourPct: 40, sevenDayPct: 50 }); // GREEN

      const noProject = await svc.getAdmission({ companyId, agentId: "agent-1" });
      const untagged = await svc.getAdmission({ companyId, agentId: "agent-1", projectId: untaggedProject });

      expect(noProject.projectClass).toBe("P2");
      expect(untagged.projectClass).toBe("P2");
    });

    it("GREEN allows regardless of project class", async () => {
      const companyId = await seedCompany();
      const p2 = await seedProject(companyId, "P2");
      const svc = await evaluatedService({ fiveHourPct: 40, sevenDayPct: 45, mode: "enforce" }); // GREEN

      const admission = await svc.getAdmission({ companyId, agentId: "agent-1", projectId: p2 });

      expect(admission.state).toBe("GREEN");
      expect(admission.allowed).toBe(true);
      expect(admission.wouldBlock).toBe(false);
    });

    it("no decision yet (nothing sensed/evaluated) is stale and blocks in enforce mode", async () => {
      const companyId = await seedCompany();
      await db.insert(fleetSettings).values({
        key: GOVERNOR_MODE_SETTINGS_KEY,
        value: { mode: "enforce" },
        version: "v1",
        updatedAt: new Date(),
        updatedBy: "test-admin",
      });
      const svc = createFleetGovernorService({ db, logger: fakeLogger(), now: () => NOW });

      const admission = await svc.getAdmission({ companyId, agentId: "agent-1" });

      expect(admission.state).toBeNull();
      expect(admission.stale).toBe(true);
      expect(admission.allowed).toBe(false);
      expect(admission.reason).toMatch(/stale/i);
    });

    it("falls back to the newest fleet_throttle_states row when there is no in-memory decision", async () => {
      const companyId = await seedCompany();
      await db.insert(fleetThrottleStates).values({
        ts: NOW,
        mode: "shadow",
        state: "GREEN",
        stale: false,
        pace: 1.0,
        fiveHourPct: 10,
        sevenDayPct: 50,
        floorActive: false,
        reason: "GREEN: seeded row for DB-fallback test",
        paramsVersion: DEFAULT_GOVERNOR_PARAMS.paramsVersion,
        inputs: {},
        launchParameters: {},
      });
      // Freshly constructed service: no senseOnce()/evaluate() call, so
      // getAdmission() must fall back to the DB row above.
      const svc = createFleetGovernorService({ db, logger: fakeLogger(), now: () => NOW });

      const admission = await svc.getAdmission({ companyId, agentId: "agent-1" });

      expect(admission.state).toBe("GREEN");
      expect(admission.stale).toBe(false);
      expect(admission.allowed).toBe(true);
    });

    it("a decision older than staleAfterMs is treated as stale even when cached in-memory", async () => {
      const companyId = await seedCompany();
      let clock = NOW;
      const svc = createFleetGovernorService({
        db,
        logger: fakeLogger(),
        fetchQuota: async () => [quotaResult({ fiveHourPct: 40, sevenDayPct: 40 })],
        now: () => clock,
      });
      await svc.senseOnce();
      await svc.evaluate();

      clock = new Date(NOW.getTime() + DEFAULT_GOVERNOR_PARAMS.staleAfterMs + 1);
      const admission = await svc.getAdmission({ companyId, agentId: "agent-1" });

      expect(admission.stale).toBe(true);
      expect(admission.reason).toMatch(/stale/i);
    });

    it("updates getStatus() admission counters and lastBlock", async () => {
      const companyId = await seedCompany();
      const svc = await evaluatedService({ fiveHourPct: 95, sevenDayPct: 40, mode: "enforce" }); // RED

      await svc.getAdmission({ companyId, agentId: "agent-allowed-would-not-apply" }); // blocked (RED)
      await svc.getAdmission({ companyId, agentId: "agent-2" }); // blocked (RED)

      const status = await svc.getStatus();
      expect(status.admissionsBlocked).toBe(2);
      expect(status.admissionsAllowed).toBe(0);
      expect(status.lastBlock).toMatchObject({ agentId: "agent-2" });
      expect(status.lastBlock?.reason).toMatch(/RED/);
    });
  });
});
