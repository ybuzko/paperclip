import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchFleetDispatchSettingsSchema, type PatchFleetDispatchSettings } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";
import {
  DISPATCH_MODE_SETTINGS_KEY,
  DISPATCH_PARAMS_SETTINGS_KEY,
  JIRA_SETTINGS_KEY,
  getSharedFleetDispatchService,
} from "../services/fleet/dispatch-service.js";
import { getRawFleetSettingValue, upsertFleetSetting } from "../services/fleet/governor-service.js";

/**
 * Fleet dispatch loop routes (see server/src/services/fleet/DISPATCH.md).
 * Instance-wide, instance-admin only — same guard as `/api/fleet/*`
 * (routes/fleet.ts), since this surfaces/changes operational behavior for
 * every dispatched project, not just one company's.
 */
export function fleetDispatchRoutes(db: Db) {
  const router = Router();
  // Fetched per-request, not once at mount time: `createApp()` mounts routes
  // before server/src/index.ts's startup block constructs the *real*
  // dispatch service (with the heartbeat scheduler's actual `wakeup`).
  // getSharedFleetDispatchService() only honors the `deps` passed by
  // whichever caller reaches it *first*, so calling it eagerly here would
  // permanently lock the shared instance to this route module's no-op
  // `wakeup` stub before startup gets a chance to supply the real one. The
  // server never accepts connections until startup finishes (`server.listen()`
  // is the last step in index.ts), so by the time a request can reach a
  // handler below, the shared instance — real `wakeup` included — already
  // exists; this call then just returns it.
  const dispatchService = () => getSharedFleetDispatchService({ db, logger, wakeup: async () => null });

  router.get("/fleet/dispatch", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await dispatchService().getStatus());
  });

  router.post("/fleet/dispatch/poll", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await dispatchService().tick());
  });

  router.patch("/fleet/dispatch/settings", validate(patchFleetDispatchSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const body = req.body as PatchFleetDispatchSettings;

    if (body.dispatch_mode !== undefined) {
      await upsertFleetSetting(db, DISPATCH_MODE_SETTINGS_KEY, { mode: body.dispatch_mode }, actor.actorId);
    }
    if (body.dispatch_params !== undefined) {
      // Merge onto the raw stored overrides, not the resolved defaults, so a
      // partial PATCH doesn't clobber previously-set overrides for other
      // fields (mirrors routes/fleet.ts's governor_params PATCH).
      const existing = await getRawFleetSettingValue(db, DISPATCH_PARAMS_SETTINGS_KEY);
      const merged: Record<string, unknown> = { ...existing, ...body.dispatch_params };
      await upsertFleetSetting(db, DISPATCH_PARAMS_SETTINGS_KEY, merged, actor.actorId);
    }
    if (body.jira !== undefined) {
      await upsertFleetSetting(db, JIRA_SETTINGS_KEY, { ...body.jira }, actor.actorId);
    }

    res.json(await dispatchService().getStatus());
  });

  return router;
}
