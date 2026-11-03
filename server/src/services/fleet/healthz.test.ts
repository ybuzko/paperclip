import { describe, expect, it } from "vitest";
import { DEFAULT_FLEET_HEALTH_THRESHOLDS, evaluateFleetHealth, type FleetHealthInputs } from "./healthz.js";

const now = new Date("2026-11-01T22:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

function healthy(): FleetHealthInputs {
  return {
    lastSensingOkAt: minutesAgo(2),
    governor: { state: "OPEN", since: minutesAgo(30) },
    agentsInError: [],
    lastDispatchTickAt: minutesAgo(1),
  };
}

describe("evaluateFleetHealth", () => {
  it("is ok when sensing is fresh, the governor is open, no agent errs and dispatch ticks", () => {
    const report = evaluateFleetHealth(healthy(), now);
    expect(report.status).toBe("ok");
    expect(report.reasons).toEqual([]);
    expect(report.checks.sensing).toEqual({ ok: true, ageSeconds: 120 });
    expect(report.checks.governor).toEqual({ ok: true, state: "OPEN", forSeconds: 1800 });
  });

  it("fails when the last successful usage snapshot is older than the sensing window", () => {
    const report = evaluateFleetHealth({ ...healthy(), lastSensingOkAt: minutesAgo(16) }, now);
    expect(report.status).toBe("unhealthy");
    expect(report.reasons).toEqual(["sensing: last successful usage snapshot is 960s old"]);
  });

  it("fails when no usage snapshot was ever recorded", () => {
    const report = evaluateFleetHealth({ ...healthy(), lastSensingOkAt: null }, now);
    expect(report.reasons).toEqual(["sensing: no successful usage snapshot recorded"]);
  });

  it("tolerates a brief STALE hold but not a long one", () => {
    const brief = evaluateFleetHealth({ ...healthy(), governor: { state: "STALE", since: minutesAgo(20) } }, now);
    expect(brief.status).toBe("ok");
    const long = evaluateFleetHealth({ ...healthy(), governor: { state: "STALE", since: minutesAgo(61) } }, now);
    expect(long.status).toBe("unhealthy");
    expect(long.reasons).toEqual(["governor: STALE for 3660s"]);
  });

  it("treats RED and CAPPED as healthy: they are the governor working, not failing", () => {
    for (const state of ["RED", "CAPPED", "AMBER"]) {
      const report = evaluateFleetHealth({ ...healthy(), governor: { state, since: minutesAgo(600) } }, now);
      expect(report.status).toBe("ok");
    }
  });

  it("fails when there is no governor decision at all", () => {
    const report = evaluateFleetHealth({ ...healthy(), governor: null }, now);
    expect(report.reasons).toEqual(["governor: no decision recorded"]);
  });

  it("names agents stuck in error past the grace period and ignores fresh errors", () => {
    const report = evaluateFleetHealth(
      { ...healthy(), agentsInError: [{ name: "immich", since: minutesAgo(16) }, { name: "dev", since: minutesAgo(1) }] },
      now,
    );
    expect(report.status).toBe("unhealthy");
    expect(report.reasons).toEqual(["agents: in error status: immich"]);
    expect(report.checks.agents.inError).toEqual(["immich"]);
  });

  it("fails when the dispatch loop stopped ticking, but passes when no project is configured", () => {
    const stopped = evaluateFleetHealth({ ...healthy(), lastDispatchTickAt: minutesAgo(6) }, now);
    expect(stopped.reasons).toEqual(["dispatch: loop last updated project state 360s ago"]);
    const none = evaluateFleetHealth({ ...healthy(), lastDispatchTickAt: null }, now);
    expect(none.status).toBe("ok");
  });

  it("reports every failing check at once", () => {
    const report = evaluateFleetHealth(
      {
        lastSensingOkAt: minutesAgo(60 * 24 * 6),
        governor: { state: "STALE", since: minutesAgo(60 * 24 * 6) },
        agentsInError: [{ name: "immich", since: minutesAgo(60 * 24 * 6) }],
        lastDispatchTickAt: minutesAgo(1),
      },
      now,
      DEFAULT_FLEET_HEALTH_THRESHOLDS,
    );
    expect(report.status).toBe("unhealthy");
    expect(report.reasons).toHaveLength(3);
  });
});
