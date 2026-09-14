import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchFleetSettingsSchema, type PatchFleetSettings } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";
import {
  getSharedFleetGovernorService,
  getRawFleetSettingValue,
  listFleetLimitSnapshots,
  listFleetThrottleStates,
  upsertFleetSetting,
  GOVERNOR_MODE_SETTINGS_KEY,
  GOVERNOR_PARAMS_SETTINGS_KEY,
} from "../services/fleet/governor-service.js";

const DEFAULT_LIMITS_HOURS = 24;
const MAX_LIMITS_HOURS = 24 * 14;
const DEFAULT_THROTTLE_LIMIT = 50;
const MAX_THROTTLE_LIMIT = 500;

function parseBoundedInt(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * Fleet governor routes (FR-1/FR-4/FR-11.6, §8.3/§8.7). Instance-wide — no
 * company scoping, since the governor coordinates across the whole fleet, not
 * within one company. Every endpoint is instance-admin only: this surfaces
 * subscription-wide operational state and lets an admin change throttle
 * behavior instance-wide, so it uses the same guard as instance settings.
 */
export function fleetRoutes(db: Db) {
  const router = Router();
  const governor = getSharedFleetGovernorService({ db, logger });

  router.get("/fleet/status", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await governor.getStatus());
  });

  router.get("/fleet/limits", async (req, res) => {
    assertInstanceAdmin(req);
    const hours = parseBoundedInt(req.query.hours, DEFAULT_LIMITS_HOURS, MAX_LIMITS_HOURS);
    res.json(await listFleetLimitSnapshots(db, { hours }));
  });

  router.get("/fleet/throttle", async (req, res) => {
    assertInstanceAdmin(req);
    const limit = parseBoundedInt(req.query.limit, DEFAULT_THROTTLE_LIMIT, MAX_THROTTLE_LIMIT);
    res.json(await listFleetThrottleStates(db, { limit }));
  });

  router.get("/fleet/settings", async (req, res) => {
    assertInstanceAdmin(req);
    const status = await governor.getStatus();
    res.json({ mode: status.mode, params: status.params });
  });

  router.patch("/fleet/settings", validate(patchFleetSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const body = req.body as PatchFleetSettings;

    if (body.mode !== undefined) {
      await upsertFleetSetting(db, GOVERNOR_MODE_SETTINGS_KEY, { mode: body.mode }, actor.actorId);
    }
    if (body.params !== undefined) {
      // Merge onto the raw stored overrides (not the resolved defaults) so a
      // partial PATCH doesn't clobber previously-set overrides for other
      // fields; DEFAULT_GOVERNOR_PARAMS is applied later, at evaluate() time.
      const existing = await getRawFleetSettingValue(db, GOVERNOR_PARAMS_SETTINGS_KEY);
      const existingDefaultModels =
        existing && typeof existing.defaultModels === "object" && existing.defaultModels !== null
          ? (existing.defaultModels as Record<string, unknown>)
          : {};
      const merged: Record<string, unknown> = {
        ...existing,
        ...body.params,
        ...(body.params.defaultModels !== undefined
          ? { defaultModels: { ...existingDefaultModels, ...body.params.defaultModels } }
          : {}),
      };
      await upsertFleetSetting(db, GOVERNOR_PARAMS_SETTINGS_KEY, merged, actor.actorId);
    }

    const evaluation = await governor.evaluate();
    res.json({ mode: evaluation.mode, params: evaluation.params, evaluation });
  });

  router.post("/fleet/sense", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await governor.tick());
  });

  return router;
}
