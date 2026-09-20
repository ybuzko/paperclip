import { Router } from "express";
import type { Db } from "@paperclipai/db";

/** Scoped agent provisioning routes (PIX-19); see server/src/services/agent-provisioning.ts. */
export function agentProvisioningRoutes(_db: Db) {
  const router = Router();
  return router;
}
