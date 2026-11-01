import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { fleetHealthzRoutes } from "../routes/fleet-healthz.js";
import type { FleetHealthInputs } from "../services/fleet/healthz.js";

const now = new Date("2026-11-01T22:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

function appWith(inputs: FleetHealthInputs | Error) {
  const app = express();
  const loadInputs = vi.fn(async () => {
    if (inputs instanceof Error) throw inputs;
    return inputs;
  });
  app.use("/api", fleetHealthzRoutes({} as Db, { loadInputs, now: () => now }));
  return app;
}

describe("GET /api/fleet/healthz", () => {
  it("answers 200 without any credentials when the fleet is healthy", async () => {
    const res = await request(appWith({
      lastSensingOkAt: minutesAgo(1),
      governor: { state: "OPEN", since: minutesAgo(5) },
      agentsInError: [],
      lastDispatchTickAt: minutesAgo(1),
    })).get("/api/fleet/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.reasons).toEqual([]);
    // Redacted: no usage figures, no params, no settings.
    expect(JSON.stringify(res.body)).not.toMatch(/usedPct|params|token|secret/i);
  });

  it("answers 503 with reasons when the fleet is frozen", async () => {
    const res = await request(appWith({
      lastSensingOkAt: minutesAgo(60 * 24),
      governor: { state: "STALE", since: minutesAgo(60 * 24) },
      agentsInError: [{ name: "immich", since: minutesAgo(60 * 24) }],
      lastDispatchTickAt: minutesAgo(1),
    })).get("/api/fleet/healthz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
    expect(res.body.reasons).toEqual([
      "sensing: last successful usage snapshot is 86400s old",
      "governor: STALE for 86400s",
      "agents: in error status: immich",
    ]);
  });

  it("answers 503 when the database read itself fails", async () => {
    const res = await request(appWith(new Error("connection refused"))).get("/api/fleet/healthz");
    expect(res.status).toBe(503);
    expect(res.body.reasons).toEqual(["healthz: connection refused"]);
  });
});
