import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  evaluateFleetHealth,
  loadFleetHealthInputs,
  type FleetHealthInputs,
} from "../services/fleet/healthz.js";

/**
 * GET /api/fleet/healthz — public, unauthenticated fleet health for monitors.
 * 200 when the fleet can work, 503 with `reasons` otherwise. Deliberately
 * unguarded (unlike the rest of /api/fleet) and deliberately redacted: it
 * reports states, ages and agent names, never usage figures or settings.
 */
export function fleetHealthzRoutes(
  db: Db,
  deps: { loadInputs?: (db: Db, now: Date) => Promise<FleetHealthInputs>; now?: () => Date } = {},
) {
  const router = Router();
  const loadInputs = deps.loadInputs ?? loadFleetHealthInputs;
  const now = deps.now ?? (() => new Date());

  router.get("/fleet/healthz", async (_req, res) => {
    const asOf = now();
    try {
      const report = evaluateFleetHealth(await loadInputs(db, asOf), asOf);
      res.status(report.status === "ok" ? 200 : 503).json(report);
    } catch (err) {
      res.status(503).json({
        status: "unhealthy",
        checkedAt: asOf.toISOString(),
        reasons: [`healthz: ${err instanceof Error ? err.message : String(err)}`],
      });
    }
  });

  return router;
}
