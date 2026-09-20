import { z } from "zod";

/**
 * Scope carried by the `agents:provision` grant. The grant lets an agent provision other
 * agents and their secrets without board access; the scope is what bounds the blast radius.
 */
export const agentProvisionGrantScopeSchema = z.object({
  /** Adapter types the grantee may create agents for, e.g. ["claudeclaw_gateway"]. */
  adapterTypes: z.array(z.string().trim().min(1)).min(1).max(16),
  /** Every provisioned agent reports to this agent (the coordinator); null = no manager. */
  reportsTo: z.string().guid().nullable(),
  /** Secrets the grantee may create, rotate and bind must have a name starting with this. */
  secretNamePrefix: z.string().trim().min(3).max(120),
  /** Optional cap on the number of agents this grantee may have provisioned at once. */
  maxAgents: z.number().int().min(1).max(1000).optional(),
});
export type AgentProvisionGrantScope = z.infer<typeof agentProvisionGrantScopeSchema>;

export const setAgentProvisionGrantSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true), scope: agentProvisionGrantScopeSchema }),
  z.object({ enabled: z.literal(false) }),
]);
export type SetAgentProvisionGrant = z.infer<typeof setAgentProvisionGrantSchema>;

export const provisionAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapterType: z.string().trim().min(1),
  adapterConfig: z.record(z.string(), z.unknown()).default({}),
  title: z.string().trim().max(200).optional(),
  capabilities: z.string().trim().max(4000).optional(),
  /** Label for the API key minted for the new agent. */
  keyName: z.string().trim().min(1).max(120).default("provisioned"),
});
export type ProvisionAgent = z.infer<typeof provisionAgentSchema>;

export const provisionSecretSchema = z.object({
  name: z.string().trim().min(1).max(200),
  value: z.string().min(1).max(65536),
  description: z.string().trim().max(1000).optional(),
});
export type ProvisionSecret = z.infer<typeof provisionSecretSchema>;

export const bindProvisionedSecretSchema = z.object({
  secretName: z.string().trim().min(1).max(200),
  /** Adapter-config path that receives the secret reference, e.g. "apiToken". */
  configPath: z.string().trim().min(1).max(200),
});
export type BindProvisionedSecret = z.infer<typeof bindProvisionedSecretSchema>;
