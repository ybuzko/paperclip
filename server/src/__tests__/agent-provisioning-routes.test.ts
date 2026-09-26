import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { agentProvisioningRoutes } from "../routes/agent-provisioning.js";
import { AGENT_PROVISION_PERMISSION_KEY, PROVISIONED_BY_METADATA_KEY } from "../services/agent-provisioning.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent provisioning routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-provisioning-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = (req.headers["x-test-actor"]
        ? JSON.parse(req.headers["x-test-actor"] as string)
        : { type: "none" }) as typeof req.actor;
      next();
    });
    app.use("/api", agentProvisioningRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function boardActor(userId = "board-user") {
    return {
      type: "board" as const,
      userId,
      source: "local_implicit" as const,
      isInstanceAdmin: true,
    };
  }

  function agentActor(agentId: string, companyId: string, overrides: Record<string, unknown> = {}) {
    return {
      type: "agent" as const,
      agentId,
      companyId,
      source: "agent_key" as const,
      keyId: randomUUID(),
      // The auth middleware always binds an agent key to its responsible user (the board
      // user who approved the key); a provisioned key inherits it.
      onBehalfOfUserId: "board-user",
      ...overrides,
    };
  }

  function withActor(req: request.Test, actor: Record<string, unknown>) {
    return req.set("x-test-actor", JSON.stringify(actor));
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Provisioning Co",
      issuePrefix: `PV${companyId.slice(0, 6)}`.toUpperCase(),
      status: "active",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: overrides.name ?? `Agent ${agentId.slice(0, 8)}`,
      role: overrides.role ?? "general",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
      ...overrides,
    });
    return agentId;
  }

  async function grantProvision(
    companyId: string,
    agentId: string,
    scope: {
      reportsTo: string | null;
    },
  ) {
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: AGENT_PROVISION_PERMISSION_KEY,
      scope,
      grantedByUserId: "board-user",
    });
  }

  it("lets a board user set, read, and clear the provisioning grant", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    const managerId = await seedAgent(companyId, { name: "Coordinator" });
    const app = createApp();

    const putRes = await withActor(
      request(app).put(`/api/agents/${provisionerId}/provision-grant`),
      boardActor(),
    ).send({
      enabled: true,
      scope: {
        reportsTo: managerId,
      },
    });
    expect(putRes.status, JSON.stringify(putRes.body)).toBe(200);
    expect(putRes.body).toMatchObject({
      enabled: true,
      scope: {
        reportsTo: managerId,
      },
      grantedByUserId: "board-user",
      provisionedAgentCount: 0,
    });

    const getRes = await withActor(
      request(app).get(`/api/agents/${provisionerId}/provision-grant`),
      boardActor(),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.body.enabled).toBe(true);
    expect(getRes.body.scope.reportsTo).toBe(managerId);

    const clearRes = await withActor(
      request(app).put(`/api/agents/${provisionerId}/provision-grant`),
      boardActor(),
    ).send({ enabled: false });
    expect(clearRes.status, JSON.stringify(clearRes.body)).toBe(200);
    expect(clearRes.body.enabled).toBe(false);
    expect(clearRes.body.scope).toBeNull();

    const activityRows = await db.select().from(activityLog);
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["agent.provision_grant_set", "agent.provision_grant_cleared"]),
    );
  });

  it("rejects an unknown scope.reportsTo with 422", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    const app = createApp();

    const res = await withActor(
      request(app).put(`/api/agents/${provisionerId}/provision-grant`),
      boardActor(),
    ).send({
      enabled: true,
      scope: {
        reportsTo: randomUUID(),
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
  });

  it("blocks an agent actor, even a ceo, from managing the grant", async () => {
    const companyId = await seedCompany();
    const ceoId = await seedAgent(companyId, { name: "Chief", role: "ceo" });
    const app = createApp();

    const putRes = await withActor(
      request(app).put(`/api/agents/${ceoId}/provision-grant`),
      agentActor(ceoId, companyId),
    ).send({ enabled: true, scope: { reportsTo: null } });
    expect(putRes.status).toBe(403);

    const getRes = await withActor(
      request(app).get(`/api/agents/${ceoId}/provision-grant`),
      agentActor(ceoId, companyId),
    );
    expect(getRes.status).toBe(403);
  });

  it("provisions a supervisor agent, forces reportsTo/role/metadata, and mints exactly one key", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    const managerId = await seedAgent(companyId, { name: "Coordinator" });
    await grantProvision(companyId, provisionerId, {
      reportsTo: managerId,
    });
    const app = createApp();

    const res = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      agentActor(provisionerId, companyId),
    ).send({
      name: "Supervisor A",
      adapterType: "process",
      adapterConfig: {},
      keyName: "provisioned-key",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent).toMatchObject({
      name: "Supervisor A",
      role: "general",
      reportsTo: managerId,
      status: "idle",
      adapterType: "process",
    });
    expect(res.body.agent.metadata).toMatchObject({ [PROVISIONED_BY_METADATA_KEY]: provisionerId });
    expect(res.body.agent.permissions.canCreateAgents).toBe(false);
    expect(typeof res.body.apiKey.token).toBe("string");
    expect(res.body.apiKey.token.length).toBeGreaterThan(10);

    const keyRows = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, res.body.agent.id));
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]?.keyHash).toBeTruthy();
    expect(keyRows[0]?.keyHash).not.toBe(res.body.apiKey.token);
    // Inherited from the provisioner's key; a key without one is refused by the auth middleware.
    expect(keyRows[0]?.responsibleUserId).toBe("board-user");

    const membership = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, res.body.agent.id)));
    expect(membership).toHaveLength(1);
    expect(membership[0]?.status).toBe("active");

    const activityRows = await db.select().from(activityLog).where(eq(activityLog.action, "agent.provisioned"));
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0]?.details).toMatchObject({
      provisionedByAgentId: provisionerId,
      adapterType: "process",
      reportsTo: managerId,
      responsibleUserId: "board-user",
    });
    expect(JSON.stringify(activityRows[0]?.details)).not.toContain(res.body.apiKey.token);
  });

  it("refuses to mint a key when the provisioner's key has no responsible user, creating nothing", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    await grantProvision(companyId, provisionerId, { reportsTo: null });
    const app = createApp();

    const res = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      agentActor(provisionerId, companyId, { onBehalfOfUserId: undefined }),
    ).send({ name: "Orphan", adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code ?? res.body.details?.code).toBe("RESPONSIBLE_USER_UNAVAILABLE");
    const created = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, "Orphan")));
    expect(created).toHaveLength(0);
  });

  it("with an unrestricted grant provisions any known adapter type and lets the caller choose reportsTo", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    const managerId = await seedAgent(companyId, { name: "Coordinator" });
    const app = createApp();

    const grantRes = await withActor(
      request(app).put(`/api/agents/${provisionerId}/provision-grant`),
      boardActor(),
    ).send({ enabled: true });
    expect(grantRes.status, JSON.stringify(grantRes.body)).toBe(200);

    const res = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      agentActor(provisionerId, companyId),
    ).send({ name: "Any Adapter", adapterType: "process", adapterConfig: {}, reportsTo: managerId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.reportsTo).toBe(managerId);
    expect(typeof res.body.apiKey.token).toBe("string");
  });

  it("rejects provisioning with no grant", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    const app = createApp();

    const res = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      agentActor(provisionerId, companyId),
    ).send({ name: "No Grant", adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("rejects a board actor on the provisioning endpoint", async () => {
    const companyId = await seedCompany();
    const app = createApp();

    const res = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      boardActor(),
    ).send({ name: "Board Attempt", adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("/api/companies/:companyId/agents");
  });

  it("is idempotent: a retry mints the key once, then 409s on a second attempt, and never double-creates", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    await grantProvision(companyId, provisionerId, {
      reportsTo: null,
    });
    // Simulate a crash between agent creation and key minting: the agent row
    // exists, provisioned by this actor, but has no API key yet.
    const preCreatedId = await seedAgent(companyId, {
      name: "Recoverable",
      metadata: { [PROVISIONED_BY_METADATA_KEY]: provisionerId },
    });
    const app = createApp();

    const retryRes = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      agentActor(provisionerId, companyId),
    ).send({ name: "Recoverable", adapterType: "process", adapterConfig: {} });
    expect(retryRes.status, JSON.stringify(retryRes.body)).toBe(201);
    expect(retryRes.body.agent.id).toBe(preCreatedId);
    expect(typeof retryRes.body.apiKey.token).toBe("string");

    const matching = await db.select().from(agents).where(eq(agents.name, "Recoverable"));
    expect(matching).toHaveLength(1);

    const secondRes = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      agentActor(provisionerId, companyId),
    ).send({ name: "Recoverable", adapterType: "process", adapterConfig: {} });
    expect(secondRes.status, JSON.stringify(secondRes.body)).toBe(409);
    expect(secondRes.body.agentId).toBe(preCreatedId);

    const keyRows = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, preCreatedId));
    expect(keyRows).toHaveLength(1);
  });

  it("rejects a name clash with an agent not provisioned by this actor", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    await grantProvision(companyId, provisionerId, {
      reportsTo: null,
    });
    await seedAgent(companyId, { name: "Board Made Me" }); // no PROVISIONED_BY metadata
    const app = createApp();

    const res = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      agentActor(provisionerId, companyId),
    ).send({ name: "Board Made Me", adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });

  it("fails closed on a malformed stored grant scope", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    // Insert a grant row with a scope that fails the zod schema (wrong type) directly, bypassing the PUT route's validation.
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: provisionerId,
      permissionKey: AGENT_PROVISION_PERMISSION_KEY,
      scope: { reportsTo: 12345 },
      grantedByUserId: "board-user",
    });
    const app = createApp();

    const res = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      agentActor(provisionerId, companyId),
    ).send({ name: "Should Not Exist", adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const created = await db.select().from(agents).where(eq(agents.name, "Should Not Exist"));
    expect(created).toHaveLength(0);
  });

  it("works for a plain agent API key with no run id", async () => {
    const companyId = await seedCompany();
    const provisionerId = await seedAgent(companyId, { name: "Ansible" });
    await grantProvision(companyId, provisionerId, {
      reportsTo: null,
    });
    const app = createApp();
    const actor = agentActor(provisionerId, companyId);
    expect(actor).not.toHaveProperty("runId");

    const res = await withActor(
      request(app).post(`/api/companies/${companyId}/agents/provision`),
      actor,
    ).send({ name: "No Run Id", adapterType: "process", adapterConfig: {} });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
