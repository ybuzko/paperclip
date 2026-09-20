import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, principalPermissionGrants } from "@paperclipai/db";
import { agentProvisionGrantScopeSchema, type AgentProvisionGrantScope } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";

/**
 * Scoped agent provisioning (PIX-19).
 *
 * A board user may give an agent the `agents:provision` grant. The grant applies to every key
 * the agent holds (no heartbeat run id needed) and its scope bounds what the agent can do:
 * create agents of the listed adapter types under a forced manager, mint each new agent's
 * API key once, and create / rotate / bind company secrets under a name prefix, only for
 * agents it provisioned itself. It never grants secret reads or board access.
 *
 * Provenance lives in agents.metadata[PROVISIONED_BY_METADATA_KEY] = the provisioning agent id.
 */
export const AGENT_PROVISION_PERMISSION_KEY = "agents:provision" as const;
export const PROVISIONED_BY_METADATA_KEY = "provisionedByAgentId";

export type ProvisionActor = {
  type: string;
  agentId?: string | null;
  companyId?: string | null;
};

export type ProvisionGrant = {
  scope: AgentProvisionGrantScope;
  grantedByUserId: string | null;
  updatedAt: Date;
};

export function agentProvisioningService(db: Db) {
  const access = accessService(db);

  async function getGrant(companyId: string, agentId: string): Promise<ProvisionGrant | null> {
    const row = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, agentId),
          eq(principalPermissionGrants.permissionKey, AGENT_PROVISION_PERMISSION_KEY),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    // A grant with a missing or malformed scope is treated as no grant: fail closed.
    const parsed = agentProvisionGrantScopeSchema.safeParse(row.scope);
    if (!parsed.success) return null;
    return { scope: parsed.data, grantedByUserId: row.grantedByUserId ?? null, updatedAt: row.updatedAt };
  }

  async function setGrant(companyId: string, agentId: string, scope: AgentProvisionGrantScope, grantedByUserId: string) {
    await access.setPrincipalPermission(
      companyId,
      "agent",
      agentId,
      AGENT_PROVISION_PERMISSION_KEY,
      true,
      grantedByUserId,
      scope as unknown as Record<string, unknown>,
    );
  }

  async function clearGrant(companyId: string, agentId: string) {
    await access.setPrincipalPermission(companyId, "agent", agentId, AGENT_PROVISION_PERMISSION_KEY, false, null);
  }

  /** Resolve the calling agent's grant for this company or throw 403. Board actors are not handled here. */
  async function requireGrantForActor(actor: ProvisionActor, companyId: string) {
    if (actor.type !== "agent" || !actor.agentId) throw forbidden("Agent authentication required");
    if (actor.companyId && actor.companyId !== companyId) throw forbidden("Agent key cannot access another company");
    const grant = await getGrant(companyId, actor.agentId);
    if (!grant) throw forbidden("Missing agents:provision grant");
    return { actorAgentId: actor.agentId, scope: grant.scope };
  }

  function isProvisionedBy(agent: { metadata?: Record<string, unknown> | null }, actorAgentId: string) {
    return agent.metadata?.[PROVISIONED_BY_METADATA_KEY] === actorAgentId;
  }

  async function countProvisionedBy(companyId: string, actorAgentId: string) {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          sql`${agents.metadata} ->> ${PROVISIONED_BY_METADATA_KEY} = ${actorAgentId}`,
          sql`${agents.status} <> 'terminated'`,
        ),
      );
    return rows[0]?.n ?? 0;
  }

  function assertSecretNameAllowed(scope: AgentProvisionGrantScope, name: string) {
    if (!name.startsWith(scope.secretNamePrefix)) {
      throw forbidden(`Secret name must start with ${scope.secretNamePrefix}`);
    }
  }

  return { getGrant, setGrant, clearGrant, requireGrantForActor, isProvisionedBy, countProvisionedBy, assertSecretNameAllowed };
}
