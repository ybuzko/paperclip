import { z } from "zod";

/**
 * Scope carried by the `agents:provision` grant. The grant lets an agent provision other
 * agents (any adapter type) and their secrets without board access. The blast radius is bounded
 * by provenance, not by the scope: the grantee can only mint a key for, bind secrets to, and
 * rotate secrets of agents and secrets it created itself, and can never read a secret value.
 */
export const agentProvisionGrantScopeSchema = z.object({
  /**
   * Optional. When set, every provisioned agent reports to this agent and the caller cannot
   * choose another manager. When absent the caller may pass reportsTo itself.
   */
  reportsTo: z.string().guid().nullable().optional(),
});
export type AgentProvisionGrantScope = z.infer<typeof agentProvisionGrantScopeSchema>;

export const setAgentProvisionGrantSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true), scope: agentProvisionGrantScopeSchema.default({}) }),
  z.object({ enabled: z.literal(false) }),
]);
export type SetAgentProvisionGrant = z.infer<typeof setAgentProvisionGrantSchema>;

export const provisionAgentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  adapterType: z.string().trim().min(1),
  adapterConfig: z.record(z.string(), z.unknown()).default({}),
  title: z.string().trim().max(200).optional(),
  capabilities: z.string().trim().max(4000).optional(),
  /** Manager for the new agent; ignored when the grant scope forces one. */
  reportsTo: z.string().guid().nullable().optional(),
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
