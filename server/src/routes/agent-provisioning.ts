import { Router, type Request, type Response } from "express";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  provisionAgentSchema,
  setAgentProvisionGrantSchema,
  type AgentProvisionGrantScope,
  type ProvisionAgent,
} from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentService } from "../services/agents.js";
import { accessService } from "../services/access.js";
import { secretService } from "../services/secrets.js";
import { logActivity } from "../services/activity-log.js";
import {
  agentProvisioningService,
  PROVISIONED_BY_METADATA_KEY,
} from "../services/agent-provisioning.js";
import { findServerAdapter } from "../adapters/index.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectAgentAdapterWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertBoard, getAccessibleResource, getActorInfo } from "./authz.js";

const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

/**
 * Adapter-type gate mirroring `assertKnownAdapterType` in routes/agents.ts. Kept as a local
 * copy (that helper is a private closure inside `agentRoutes`, not exported) rather than
 * refactoring the large agents router; the behaviour is intentionally identical: unknown
 * adapter type fails closed with 422.
 */
function assertKnownAdapterType(type: string | null | undefined): string {
  const adapterType = typeof type === "string" ? type.trim() : "";
  if (!adapterType) {
    throw unprocessable("Adapter type is required");
  }
  if (!findServerAdapter(adapterType)) {
    throw unprocessable(`Unknown adapter type: ${adapterType}`);
  }
  return adapterType;
}

/** Scoped agent provisioning routes (PIX-19); see server/src/services/agent-provisioning.ts. */
export function agentProvisioningRoutes(db: Db) {
  const router = Router();
  const svc = agentService(db);
  const access = accessService(db);
  const secretsSvc = secretService(db);
  const provisioning = agentProvisioningService(db);

  async function buildGrantResponse(companyId: string, agentId: string) {
    const grant = await provisioning.getGrant(companyId, agentId);
    const provisionedAgentCount = await provisioning.countProvisionedBy(companyId, agentId);
    return {
      enabled: grant != null,
      scope: grant?.scope ?? null,
      grantedByUserId: grant?.grantedByUserId ?? null,
      updatedAt: grant?.updatedAt ?? null,
      provisionedAgentCount,
    };
  }

  // --- Grant management: board users only -----------------------------------

  router.get("/agents/:id/provision-grant", async (req: Request, res: Response) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
    if (!agent) return;

    res.json(await buildGrantResponse(agent.companyId, agent.id));
  });

  router.put(
    "/agents/:id/provision-grant",
    validate(setAgentProvisionGrantSchema),
    async (req: Request, res: Response) => {
      assertBoard(req);
      const id = req.params.id as string;
      const agent = await getAccessibleResource(req, res, svc.getById(id), "Agent not found");
      if (!agent) return;

      const actor = getActorInfo(req);
      const grantedByUserId = req.actor.userId ?? "board";

      if (req.body.enabled) {
        const scope = req.body.scope as AgentProvisionGrantScope;
        if (scope.reportsTo) {
          const manager = await svc.getById(scope.reportsTo);
          if (!manager || manager.companyId !== agent.companyId) {
            throw unprocessable("scope.reportsTo must reference an agent in the same company");
          }
        }
        await provisioning.setGrant(agent.companyId, agent.id, scope, grantedByUserId);
        await logActivity(db, {
          companyId: agent.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "agent.provision_grant_set",
          entityType: "agent",
          entityId: agent.id,
          details: { scope },
        });
      } else {
        await provisioning.clearGrant(agent.companyId, agent.id);
        await logActivity(db, {
          companyId: agent.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "agent.provision_grant_cleared",
          entityType: "agent",
          entityId: agent.id,
          details: {},
        });
      }

      res.json(await buildGrantResponse(agent.companyId, agent.id));
    },
  );

  // --- Provisioning: agent actors holding the grant only ---------------------

  router.post(
    "/companies/:companyId/agents/provision",
    validate(provisionAgentSchema),
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;

      if (req.actor.type === "board") {
        throw forbidden(
          "Board callers cannot use the provisioning endpoint. Use POST /api/companies/:companyId/agents instead.",
        );
      }

      const { actorAgentId, scope } = await provisioning.requireGrantForActor(req.actor, companyId);

      // The minted key inherits the provisioner's responsible user (the board user who
      // approved the provisioning agent's own key). Every agent key must resolve to a
      // responsible user or the auth middleware refuses it with RESPONSIBLE_USER_UNAVAILABLE,
      // so a key minted without one would be dead on arrival.
      const responsibleUserId = req.actor.onBehalfOfUserId?.trim() || null;
      if (!responsibleUserId) {
        throw forbidden("The provisioning agent's key has no responsible user; a provisioned key would be unusable", {
          code: "RESPONSIBLE_USER_UNAVAILABLE",
        });
      }

      const body = req.body as ProvisionAgent;

      const adapterType = assertKnownAdapterType(body.adapterType);

      const actor = getActorInfo(req);

      // Idempotency: a retry with the same name is either recovered (mint the
      // one-time key that never got minted) or rejected, never re-created.
      const existing = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.name, body.name), ne(agents.status, "terminated")))
        .then((rows) => rows[0] ?? null);

      if (existing) {
        if (!provisioning.isProvisionedBy(existing, actorAgentId)) {
          throw conflict(`An agent named "${body.name}" already exists in this company`);
        }
        const existingKeys = await svc.listKeys(existing.id);
        if (existingKeys.length > 0) {
          // Respond directly (rather than throwing HttpError) so `agentId` lands at the
          // top level of the body, per the documented { error, agentId } contract — the
          // shared error handler only promotes an allowlist of fields out of `details`.
          res.status(409).json({
            error: "This provisioned agent already has an API key",
            agentId: existing.id,
          });
          return;
        }

        const key = await svc.createApiKey(existing.id, body.keyName, { kind: "standard" }, {
          responsibleUserId,
        });
        const refreshed = await svc.getById(existing.id);

        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "agent.provisioned",
          entityType: "agent",
          entityId: existing.id,
          details: {
            provisionedByAgentId: actorAgentId,
            adapterType: refreshed?.adapterType ?? existing.adapterType,
            reportsTo: refreshed?.reportsTo ?? existing.reportsTo ?? null,
            keyId: key.id,
            responsibleUserId,
          },
        });

        res.status(201).json({
          agent: refreshed ?? existing,
          apiKey: { id: key.id, name: key.name, token: key.token },
        });
        return;
      }

      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }
      if (company.requireBoardApprovalForNewAgents) {
        throw conflict(
          "Agent provisioning is disabled while this company requires board approval for new agents.",
        );
      }

      // The grant scope may force the manager; otherwise the caller chooses one in its company.
      let reportsTo: string | null = scope.reportsTo ?? null;
      if (!scope.reportsTo && body.reportsTo) {
        const manager = await svc.getById(body.reportsTo);
        if (!manager || manager.companyId !== companyId) {
          throw unprocessable("reportsTo must reference an agent in the same company");
        }
        reportsTo = manager.id;
      }

      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        companyId,
        body.adapterConfig ?? {},
        { strictMode: strictSecretsMode, adapterType },
      );
      // A provisioning agent is an agent-authenticated caller of everything it
      // creates. It must never be able to smuggle a host-executed workspace
      // command into a supervisor agent's adapterConfig, the same rule the
      // create-agent route enforces for any agent-authenticated adapterConfig
      // write.
      assertNoAgentHostWorkspaceCommandMutation(
        req,
        collectAgentAdapterWorkspaceCommandPaths(normalizedAdapterConfig, "adapterConfig"),
      );

      // No existing agent to merge metadata from (the idempotent-retry branch
      // above already returned). Building the object this way (rather than a
      // bare literal) keeps this future-proof if a metadata input is ever
      // added to provisionAgentSchema.
      const metadata: Record<string, unknown> = {
        [PROVISIONED_BY_METADATA_KEY]: actorAgentId,
      };

      const created = await svc.create(companyId, {
        name: body.name,
        role: "general",
        title: body.title ?? null,
        reportsTo,
        capabilities: body.capabilities ?? null,
        adapterType,
        adapterConfig: normalizedAdapterConfig,
        permissions: { canCreateAgents: false },
        metadata,
        status: "idle",
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      });

      await access.ensureMembership(companyId, "agent", created.id, "member", "active");
      await access.setPrincipalPermission(companyId, "agent", created.id, "tasks:assign", true, null);

      const key = await svc.createApiKey(created.id, body.keyName, { kind: "standard" }, {
        responsibleUserId,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "agent.provisioned",
        entityType: "agent",
        entityId: created.id,
        details: {
          provisionedByAgentId: actorAgentId,
          adapterType: created.adapterType,
          reportsTo: created.reportsTo ?? null,
          keyId: key.id,
          responsibleUserId,
        },
      });

      res.status(201).json({
        agent: created,
        apiKey: { id: key.id, name: key.name, token: key.token },
      });
    },
  );

  return router;
}
