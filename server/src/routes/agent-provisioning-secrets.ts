import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { provisionSecretSchema, bindProvisionedSecretSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity, secretService, agentService } from "../services/index.js";
import { agentProvisioningService } from "../services/agent-provisioning.js";
import { findActiveServerAdapter } from "../adapters/index.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { getActorInfo } from "./authz.js";

/**
 * Scoped agent provisioning secret routes (PIX-19); see server/src/services/agent-provisioning.ts.
 *
 * These routes let an agent holding the `agents:provision` grant push a host's inject token
 * into company secrets and bind it to a supervisor agent it provisioned — write and bind only,
 * never read. Every handler here requires agent authentication with no heartbeat run id.
 */

// A configPath must be a simple key path: letters, digits, underscore, dot. No brackets,
// no leading/trailing dot segments beyond what the regex allows structurally.
const CONFIG_PATH_RE = /^[A-Za-z0-9_.]+$/;

// Fallback allow-list used only when the target adapter's config schema is unreachable
// (no `getConfigSchema`, or it throws). Kept intentionally narrow: the literal key
// "apiToken" (matches the claudeclaw_gateway fallback secret field declared in
// server/src/services/secrets.ts' FALLBACK_ADAPTER_SCHEMA_SECRET_FIELDS), plus the two
// adapter-agnostic conventions already understood by collectSecretRefs / the secrets
// service: "env.<KEY>" (env var injection) and "access.<alias>" (API-only secret access,
// see AGENT_ACCESS_CONFIG_PATH_PREFIX in server/src/services/secrets.ts).
const FALLBACK_ALLOWED_CONFIG_PATHS = new Set(["apiToken"]);
// Deliberately empty: env.* / access.* would let the grantee inject environment variables or
// API secret aliases into a provisioned agent, which is outside the provisioning blast radius.
// Adapters that need more secret fields must declare them in their config schema.
const FALLBACK_ALLOWED_CONFIG_PATH_PREFIXES: string[] = [];

function assertAgentActor(req: Request) {
  if (req.actor.type !== "agent") {
    throw forbidden(
      "Provisioned-secret routes require agent authentication. Board actors should use the normal " +
        "company secrets routes instead (POST /api/companies/:companyId/secrets, POST /api/secrets/:id/rotate).",
    );
  }
}

/**
 * Resolve the set of adapter-config keys the target adapter's own config schema marks as
 * secret fields (`meta.secret === true`), the same metadata
 * `server/src/services/secrets.ts`' `normalizeAdapterConfigForPersistence` consults via
 * `listAdapterSchemaSecretFieldKeys`. Returns null when that metadata is unreachable (no
 * adapter registered for the type, or it declares no `getConfigSchema`), signalling the
 * caller to fall back to the fixed allow-list above.
 */
async function resolveAdapterSchemaSecretFieldKeys(adapterType: string): Promise<string[] | null> {
  const adapter = findActiveServerAdapter(adapterType);
  if (!adapter?.getConfigSchema) return null;
  try {
    const schema = await adapter.getConfigSchema();
    return schema.fields
      .filter((field) => field.meta?.secret === true)
      .map((field) => field.key);
  } catch {
    return null;
  }
}

function isConfigPathAllowed(configPath: string, schemaSecretKeys: string[] | null): boolean {
  if (schemaSecretKeys) return schemaSecretKeys.includes(configPath);
  if (FALLBACK_ALLOWED_CONFIG_PATHS.has(configPath)) return true;
  return FALLBACK_ALLOWED_CONFIG_PATH_PREFIXES.some((prefix) => configPath.startsWith(prefix));
}

/**
 * Apply a secret reference at `configPath` inside `adapterConfig`, matching the same
 * layout `collectSecretRefs` (server/src/services/agent-secret-bindings.ts) reads back:
 * "env.<KEY>" nests under the `env` object (one level), every other configPath — including
 * "access.<alias>" and plain keys like "apiToken" — is a literal top-level key (which may
 * itself contain dots). No other key of `adapterConfig` is touched.
 */
function applyConfigPathSecretRef(
  adapterConfig: Record<string, unknown>,
  configPath: string,
  secretRef: { type: "secret_ref"; secretId: string; version: "latest" },
): Record<string, unknown> {
  if (configPath.startsWith("env.")) {
    const envKey = configPath.slice("env.".length);
    const existingEnv =
      adapterConfig.env && typeof adapterConfig.env === "object" && !Array.isArray(adapterConfig.env)
        ? (adapterConfig.env as Record<string, unknown>)
        : {};
    return {
      ...adapterConfig,
      env: { ...existingEnv, [envKey]: secretRef },
    };
  }
  return { ...adapterConfig, [configPath]: secretRef };
}

export function agentProvisioningSecretRoutes(db: Db) {
  const router = Router();
  const provisioning = agentProvisioningService(db);
  const secretsSvc = secretService(db);
  const agentsSvc = agentService(db);
  const defaultProvider = getConfiguredSecretProvider();

  router.put(
    "/companies/:companyId/provisioned-secrets",
    validate(provisionSecretSchema),
    async (req, res) => {
      assertAgentActor(req);
      const companyId = req.params.companyId as string;
      const { actorAgentId, scope } = await provisioning.requireGrantForActor(req.actor, companyId);
      provisioning.assertSecretNameAllowed(scope, req.body.name);

      const actorInfo = getActorInfo(req);
      const name = req.body.name as string;
      const existing = await secretsSvc.getByName(companyId, name);

      if (!existing) {
        const created = await secretsSvc.create(
          companyId,
          {
            name,
            provider: defaultProvider,
            managedMode: "paperclip_managed",
            value: req.body.value,
            description: req.body.description ?? null,
          },
          { userId: null, agentId: actorAgentId },
        );

        await logActivity(db, {
          companyId,
          actorType: "agent",
          actorId: actorAgentId,
          agentId: actorAgentId,
          runId: actorInfo.runId,
          agentApiKeyId: actorInfo.agentApiKeyId,
          action: "secret.provisioned",
          entityType: "secret",
          entityId: created.id,
          details: { provisionedByAgentId: actorAgentId, secretName: created.name },
        });

        res.status(201).json({ id: created.id, name: created.name, version: created.latestVersion, created: true });
        return;
      }

      // Create-or-rotate by exact name within the company: a rotation is allowed only when
      // this same agent created the secret through this endpoint (provenance recorded on
      // company_secrets.created_by_agent_id by secretsSvc.create above). Any other existing
      // secret with this name — created by the board, another agent, or not through this
      // endpoint at all — is a 409, never silently overwritten.
      // getByName already excludes deleted secrets, so reaching here means an active,
      // non-deleted secret with this name exists.
      if (existing.createdByAgentId !== actorAgentId) {
        throw conflict(`Secret already exists and was not provisioned by this agent: ${name}`, {
          code: "provisioned_secret_not_owned",
        });
      }

      const rotated = await secretsSvc.rotate(
        existing.id,
        { value: req.body.value },
        { userId: null, agentId: actorAgentId },
      );

      await logActivity(db, {
        companyId,
        actorType: "agent",
        actorId: actorAgentId,
        agentId: actorAgentId,
        runId: actorInfo.runId,
        agentApiKeyId: actorInfo.agentApiKeyId,
        action: "secret.provision_rotated",
        entityType: "secret",
        entityId: rotated.id,
        details: { provisionedByAgentId: actorAgentId, secretName: rotated.name },
      });

      res.status(200).json({ id: rotated.id, name: rotated.name, version: rotated.latestVersion, created: false });
    },
  );

  router.put(
    "/agents/:agentId/provisioned-secret-binding",
    validate(bindProvisionedSecretSchema),
    async (req, res) => {
      assertAgentActor(req);
      const targetAgentId = req.params.agentId as string;
      const target = await agentsSvc.getById(targetAgentId);
      if (!target) throw notFound("Agent not found");

      const { actorAgentId, scope } = await provisioning.requireGrantForActor(req.actor, target.companyId);

      if (!provisioning.isProvisionedBy(target, actorAgentId)) {
        throw forbidden("Target agent was not provisioned by this actor");
      }

      const configPath = req.body.configPath as string;
      if (!CONFIG_PATH_RE.test(configPath)) {
        throw unprocessable("configPath must contain only letters, digits, underscores, and dots");
      }
      const schemaSecretKeys = await resolveAdapterSchemaSecretFieldKeys(target.adapterType);
      if (!isConfigPathAllowed(configPath, schemaSecretKeys)) {
        throw unprocessable(
          `configPath "${configPath}" is not an allowed secret field for adapter type ${target.adapterType}`,
        );
      }

      const secretName = req.body.secretName as string;
      provisioning.assertSecretNameAllowed(scope, secretName);
      const secret = await secretsSvc.getByName(target.companyId, secretName);
      if (!secret || secret.createdByAgentId !== actorAgentId) {
        throw notFound(`Provisioned secret not found: ${secretName}`);
      }

      const existingAdapterConfig = (target.adapterConfig as Record<string, unknown> | null) ?? {};
      const nextAdapterConfig = applyConfigPathSecretRef(existingAdapterConfig, configPath, {
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      });

      const actorInfo = getActorInfo(req);
      const updated = await agentsSvc.update(
        targetAgentId,
        { adapterConfig: nextAdapterConfig },
        {
          recordRevision: {
            createdByAgentId: actorAgentId,
            createdByUserId: null,
            source: "provisioned_secret_binding",
          },
        },
      );
      if (!updated) throw notFound("Agent not found");

      await logActivity(db, {
        companyId: target.companyId,
        actorType: "agent",
        actorId: actorAgentId,
        agentId: actorAgentId,
        runId: actorInfo.runId,
        agentApiKeyId: actorInfo.agentApiKeyId,
        action: "secret.provision_bound",
        entityType: "agent",
        entityId: targetAgentId,
        details: {
          provisionedByAgentId: actorAgentId,
          secretName: secret.name,
          targetAgentId,
          configPath,
        },
      });

      res.json({ agentId: targetAgentId, configPath, secretId: secret.id, secretName: secret.name });
    },
  );

  return router;
}
