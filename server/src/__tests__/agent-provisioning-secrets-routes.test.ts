import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { agentProvisioningSecretRoutes } from "../routes/agent-provisioning-secrets.js";
import { agentProvisioningService } from "../services/agent-provisioning.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const SECRET_VALUE = "super-secret-inject-token-value";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent provisioning secret routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-provisioning-secrets-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-provisioning-secret-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  const GRANT_SCOPE = {
    adapterTypes: ["claudeclaw_gateway"],
    reportsTo: null as string | null,
    secretNamePrefix: "ansible/",
  };

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Provisioning secrets co",
      issuePrefix: `S${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    return companyId;
  }

  async function seedAnsibleAgent(companyId: string, grant = true) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ansible coordinator",
      role: "coordinator",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    });
    if (grant) {
      await agentProvisioningService(db).setGrant(companyId, agentId, GRANT_SCOPE, "test-board-user");
    }
    return agentId;
  }

  async function seedProvisionedAgent(
    companyId: string,
    provisionedByAgentId: string | null,
    adapterConfig: Record<string, unknown> = { url: "http://10.0.0.1:4632", telegramChatId: "-1001" },
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Supervisor host1",
      role: "supervisor",
      adapterType: "claudeclaw_gateway",
      adapterConfig,
      status: "idle",
      metadata: provisionedByAgentId ? { provisionedByAgentId } : null,
    });
    return agentId;
  }

  function agentActor(agentId: string, companyId: string) {
    return {
      type: "agent" as const,
      agentId,
      companyId,
      source: "agent_key" as const,
      keyId: randomUUID(),
      keyScope: { kind: "standard" as const },
      // No runId: a long-lived provisioning key never carries a heartbeat run id.
    };
  }

  function boardActor(companyId: string) {
    return {
      type: "board" as const,
      userId: "board-user-1",
      source: "session" as const,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "admin" }],
    };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as unknown as Express.Request["actor"];
      next();
    });
    app.use("/api", agentProvisioningSecretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function provisionSecret(
    companyId: string,
    actorAgentId: string,
    name: string,
    value = SECRET_VALUE,
  ) {
    return request(createApp(agentActor(actorAgentId, companyId)))
      .put(`/api/companies/${companyId}/provisioned-secrets`)
      .send({ name, value });
  }

  it("creates a provisioned secret and never echoes the value", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);

    const res = await provisionSecret(companyId, actorAgentId, "ansible/host1-token");

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      name: "ansible/host1-token",
      version: 1,
      created: true,
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE);

    const [row] = await db.select().from(companySecrets).where(eq(companySecrets.id, res.body.id));
    expect(row).toBeTruthy();
    expect(row.companyId).toBe(companyId);
    expect(row.name).toBe("ansible/host1-token");
    expect(row.createdByAgentId).toBe(actorAgentId);
    expect(row.latestVersion).toBe(1);
  });

  it("rotates a secret it previously provisioned and bumps the version", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);

    const first = await provisionSecret(companyId, actorAgentId, "ansible/host1-token", "value-v1");
    expect(first.status).toBe(201);

    const second = await provisionSecret(companyId, actorAgentId, "ansible/host1-token", "value-v2");
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      id: first.body.id,
      name: "ansible/host1-token",
      version: 2,
      created: false,
    });

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, first.body.id));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);

    const [row] = await db.select().from(companySecrets).where(eq(companySecrets.id, first.body.id));
    expect(row.latestVersion).toBe(2);
  });

  it("rejects a secret name outside the grant's prefix with 403", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);

    const res = await provisionSecret(companyId, actorAgentId, "not-allowed/host1-token");

    expect(res.status).toBe(403);
    const [row] = await db.select().from(companySecrets);
    expect(row).toBeUndefined();
  });

  it("rejects an agent with no agents:provision grant with 403", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId, /* grant */ false);

    const res = await provisionSecret(companyId, actorAgentId, "ansible/host1-token");

    expect(res.status).toBe(403);
  });

  it("rejects a board actor with 403 pointing at the normal secrets routes", async () => {
    const companyId = await seedCompany();

    const res = await request(createApp(boardActor(companyId)))
      .put(`/api/companies/${companyId}/provisioned-secrets`)
      .send({ name: "ansible/host1-token", value: SECRET_VALUE });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/secrets routes/i);
  });

  it("returns 409 when rotating a secret this agent did not create", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);
    const otherAgentId = await seedAnsibleAgent(companyId, false);

    const svc = secretService(db);
    await svc.create(
      companyId,
      { name: "ansible/host1-token", provider: "local_encrypted", managedMode: "paperclip_managed", value: "someone-elses-value" },
      { userId: null, agentId: otherAgentId },
    );

    const res = await provisionSecret(companyId, actorAgentId, "ansible/host1-token", "attempted-takeover");

    expect(res.status).toBe(409);
  });

  it("binds a provisioned secret to a config path on an agent it provisioned", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);
    const targetAgentId = await seedProvisionedAgent(companyId, actorAgentId, {
      url: "http://10.0.0.1:4632",
      telegramChatId: "-1001",
    });

    const created = await provisionSecret(companyId, actorAgentId, "ansible/host1-token");
    expect(created.status).toBe(201);

    const res = await request(createApp(agentActor(actorAgentId, companyId)))
      .put(`/api/agents/${targetAgentId}/provisioned-secret-binding`)
      .send({ secretName: "ansible/host1-token", configPath: "apiToken" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agentId: targetAgentId,
      configPath: "apiToken",
      secretId: created.body.id,
      secretName: "ansible/host1-token",
    });

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, targetAgentId));
    const adapterConfig = agentRow.adapterConfig as Record<string, unknown>;
    // normalizeAdapterConfigForPersistence canonicalizes the binding, which adds default
    // projectionClass/projectionAllowlistKey fields alongside the ones this route sets.
    expect(adapterConfig.apiToken).toMatchObject({
      type: "secret_ref",
      secretId: created.body.id,
      version: "latest",
    });
    // Other adapter config keys are untouched.
    expect(adapterConfig.url).toBe("http://10.0.0.1:4632");
    expect(adapterConfig.telegramChatId).toBe("-1001");

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, targetAgentId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      companyId,
      secretId: created.body.id,
      targetType: "agent",
      targetId: targetAgentId,
      configPath: "apiToken",
      versionSelector: "latest",
    });
  });

  it("rejects binding to an agent not provisioned by the actor with 403", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);
    const unrelatedAgentId = await seedProvisionedAgent(companyId, /* provisionedBy */ null);

    const created = await provisionSecret(companyId, actorAgentId, "ansible/host1-token");
    expect(created.status).toBe(201);

    const res = await request(createApp(agentActor(actorAgentId, companyId)))
      .put(`/api/agents/${unrelatedAgentId}/provisioned-secret-binding`)
      .send({ secretName: "ansible/host1-token", configPath: "apiToken" });

    expect(res.status).toBe(403);
  });

  it("rejects binding a secret created by someone else with 403/404", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);
    const otherAgentId = await seedAnsibleAgent(companyId, false);
    const targetAgentId = await seedProvisionedAgent(companyId, actorAgentId);

    const svc = secretService(db);
    const secret = await svc.create(
      companyId,
      { name: "ansible/host2-token", provider: "local_encrypted", managedMode: "paperclip_managed", value: "someone-elses-value" },
      { userId: null, agentId: otherAgentId },
    );

    const res = await request(createApp(agentActor(actorAgentId, companyId)))
      .put(`/api/agents/${targetAgentId}/provisioned-secret-binding`)
      .send({ secretName: secret.name, configPath: "apiToken" });

    expect([403, 404]).toContain(res.status);
  });

  it("rejects a disallowed configPath with 422", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);
    const targetAgentId = await seedProvisionedAgent(companyId, actorAgentId);

    const created = await provisionSecret(companyId, actorAgentId, "ansible/host1-token");
    expect(created.status).toBe(201);

    const res = await request(createApp(agentActor(actorAgentId, companyId)))
      .put(`/api/agents/${targetAgentId}/provisioned-secret-binding`)
      .send({ secretName: "ansible/host1-token", configPath: "url" });

    expect(res.status).toBe(422);

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, targetAgentId));
    expect((agentRow.adapterConfig as Record<string, unknown>).url).toBe("http://10.0.0.1:4632");
  });

  it("never leaks the secret value in responses or activity log details", async () => {
    const companyId = await seedCompany();
    const actorAgentId = await seedAnsibleAgent(companyId);
    const targetAgentId = await seedProvisionedAgent(companyId, actorAgentId);

    const created = await provisionSecret(companyId, actorAgentId, "ansible/host1-token", SECRET_VALUE);
    expect(created.status).toBe(201);
    const rotated = await provisionSecret(companyId, actorAgentId, "ansible/host1-token", "rotated-" + SECRET_VALUE);
    expect(rotated.status).toBe(200);
    const bound = await request(createApp(agentActor(actorAgentId, companyId)))
      .put(`/api/agents/${targetAgentId}/provisioned-secret-binding`)
      .send({ secretName: "ansible/host1-token", configPath: "apiToken" });
    expect(bound.status).toBe(200);

    for (const res of [created, rotated, bound]) {
      expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(res.body)).not.toContain("rotated-" + SECRET_VALUE);
    }

    const activityRows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(activityRows.length).toBeGreaterThan(0);
    for (const row of activityRows) {
      const serialized = JSON.stringify(row.details ?? {});
      expect(serialized).not.toContain(SECRET_VALUE);
      expect(serialized).not.toContain("rotated-" + SECRET_VALUE);
    }
  });
});
