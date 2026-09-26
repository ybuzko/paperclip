import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  fleetDispatchState,
  fleetSettings,
  fleetThrottleStates,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  createFleetDispatchService,
  DISPATCH_MODE_SETTINGS_KEY,
  JIRA_SETTINGS_KEY,
  type FleetDispatchWakeup,
} from "./dispatch-service.js";
import type { FleetDispatchLogger } from "./dispatch-service.js";
import type { JiraClient, JiraClientFactory, JiraIssueSummary } from "./jira-client.js";

function fakeLogger(): FleetDispatchLogger {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

interface FakeJiraScript {
  readyTasks: number;
  epicsToExplode: number;
  closeCandidateKeys: string[];
  /** Candidate epic keys that still have an unfinished child (i.e. NOT ready to close). */
  unfinishedParentKeys: string[];
}

function fakeJiraFactory(script: FakeJiraScript): { factory: JiraClientFactory; calls: string[] } {
  const calls: string[] = [];
  const client: JiraClient = {
    approximateCount: async (jql: string) => {
      calls.push(jql);
      if (jql.includes("issuetype != Epic")) return script.readyTasks;
      if (jql.includes("issuetype = Epic") && jql.includes('status = "To Do"')) return script.epicsToExplode;
      return 0;
    },
    searchKeys: async (jql: string): Promise<JiraIssueSummary[]> => {
      calls.push(jql);
      if (jql.includes("issuetype = Epic") && jql.includes('status = "In Progress"')) {
        return script.closeCandidateKeys.map((key) => ({
          key,
          issueTypeName: "Epic",
          statusName: "In Progress",
          statusCategoryKey: "indeterminate",
          parentKey: null,
        }));
      }
      if (jql.includes("parent in")) {
        return script.unfinishedParentKeys.map((parentKey) => ({
          key: `${parentKey}-CHILD`,
          issueTypeName: "Task",
          statusName: "In Progress",
          statusCategoryKey: "indeterminate",
          parentKey,
        }));
      }
      return [];
    },
  };
  return { factory: () => client, calls };
}

function fakeWakeup(): { fn: FleetDispatchWakeup; calls: Array<{ agentId: string; opts: Parameters<FleetDispatchWakeup>[1] }> } {
  const calls: Array<{ agentId: string; opts: Parameters<FleetDispatchWakeup>[1] }> = [];
  const fn: FleetDispatchWakeup = async (agentId, opts) => {
    calls.push({ agentId, opts });
    return { id: `wake-${calls.length}` };
  };
  return { fn, calls };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping fleet dispatch service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("fleet dispatch service (embedded postgres)", () => {
  let stopDb: (() => Promise<void>) | undefined;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("fleet-dispatch-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    // Deletion order matters: fleet_dispatch_state and issue_comments
    // reference issues, issues and heartbeat_runs reference projects/agents,
    // and projects references agents (lead_agent_id) -- deleting agents or
    // projects too early throws a foreign-key violation and (silently, from
    // this test file's point of view) leaves stale rows for the next test.
    await db.delete(fleetDispatchState);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(fleetThrottleStates);
    await db.delete(fleetSettings);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Dispatch Test Co",
      status: "active",
      issuePrefix: companyId.slice(0, 8).toUpperCase(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedLeadAgent(
    companyId: string,
    opts: { jiraAccountId?: string | null; status?: string } = {},
  ): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Supervisor",
      adapterType: "claudeclaw_gateway",
      adapterConfig: opts.jiraAccountId === undefined ? { jiraAccountId: "acc-1" } : opts.jiraAccountId ? { jiraAccountId: opts.jiraAccountId } : {},
      status: opts.status ?? "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return agentId;
  }

  async function seedProject(
    companyId: string,
    leadAgentId: string,
    opts: { jiraProject?: string; fleetDispatch?: "on" | "off"; fleetClass?: "P0" | "P1" | "P2" } = {},
  ): Promise<string> {
    const projectId = randomUUID();
    const env: Record<string, unknown> = {
      JIRA_PROJECT: { type: "plain", value: opts.jiraProject ?? "FT" },
    };
    if (opts.fleetDispatch) env.FLEET_DISPATCH = { type: "plain", value: opts.fleetDispatch };
    if (opts.fleetClass) env.FLEET_CLASS = { type: "plain", value: opts.fleetClass };
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Fleet Test Project",
      leadAgentId,
      env: env as never,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return projectId;
  }

  async function seedJiraSettings(): Promise<void> {
    await db.insert(fleetSettings).values({
      key: JIRA_SETTINGS_KEY,
      value: { baseUrl: "https://example.atlassian.net", email: "bot@example.com", tokenSecretId: "unused-in-tests" },
      version: "v1",
      updatedAt: new Date(),
      updatedBy: "test-admin",
    });
  }

  async function seedEnforceMode(): Promise<void> {
    await db.insert(fleetSettings).values({
      key: DISPATCH_MODE_SETTINGS_KEY,
      value: { mode: "enforce" },
      version: "v1",
      updatedAt: new Date(),
      updatedBy: "test-admin",
    });
  }

  async function seedGreenGovernor(ts: Date): Promise<void> {
    await db.insert(fleetThrottleStates).values({
      ts,
      mode: "shadow",
      state: "GREEN",
      stale: false,
      pace: 0.9,
      fiveHourPct: 10,
      sevenDayPct: 40,
      floorActive: false,
      reason: "GREEN: seeded for dispatch test",
      paramsVersion: "v0-proposed",
      inputs: {},
      launchParameters: {},
    });
  }

  const NOW = new Date("2026-02-01T12:00:00.000Z");

  it("does nothing when jira settings are not configured", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    await seedProject(companyId, leadAgentId);
    await seedGreenGovernor(NOW);

    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({
      db,
      logger: fakeLogger(),
      jira: fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] }).factory,
      wakeup: wakeup.fn,
      now: () => NOW,
    });

    const result = await svc.tick();

    expect(result.ok).toBe(true);
    expect(result.jiraConfigured).toBe(false);
    expect(result.projects).toHaveLength(0);
    expect(wakeup.calls).toHaveLength(0);
  });

  it("shadow mode records counts and the decision but never wakes the supervisor", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    const projectId = await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedGreenGovernor(NOW);

    const jira = fakeJiraFactory({ readyTasks: 2, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

    const result = await svc.tick();

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("shadow");
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.decision?.nudge).toBe(true);
    expect(result.projects[0]?.nudged).toBe(false);
    expect(wakeup.calls).toHaveLength(0);

    const rows = await db.select().from(fleetDispatchState);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectId).toBe(projectId);
    expect(rows[0]?.readyTasks).toBe(2);
    expect(rows[0]?.dispatchIssueId).toBeNull();
    expect(rows[0]?.lastNudgeAt).toBeNull();
  });

  it("enforce mode creates the standing dispatch issue and wakes the supervisor", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    const projectId = await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedEnforceMode();
    await seedGreenGovernor(NOW);

    const jira = fakeJiraFactory({ readyTasks: 3, epicsToExplode: 1, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

    const result = await svc.tick();

    expect(result.mode).toBe("enforce");
    expect(result.projects[0]?.nudged).toBe(true);
    expect(wakeup.calls).toHaveLength(1);
    expect(wakeup.calls[0]?.agentId).toBe(leadAgentId);
    expect(wakeup.calls[0]?.opts.reason).toBe("fleet_dispatch");
    expect(wakeup.calls[0]?.opts.source).toBe("automation");
    expect(wakeup.calls[0]?.opts.triggerDetail).toBe("system");
    expect(wakeup.calls[0]?.opts.idempotencyKey).toBe(`fleet_dispatch:${projectId}:${NOW.toISOString().slice(0, 16)}`);
    const payload = wakeup.calls[0]?.opts.payload as { issueId: string; fleetDispatch: Record<string, unknown> };
    expect(payload.fleetDispatch).toMatchObject({
      jiraProject: "FT",
      readyTasks: 3,
      epicsToExplode: 1,
      epicsToClose: 0,
      throttleState: "GREEN",
    });

    const dispatchRows = await db.select().from(fleetDispatchState);
    expect(dispatchRows[0]?.dispatchIssueId).toBe(payload.issueId);
    expect(dispatchRows[0]?.lastNudgeAt?.getTime()).toBe(NOW.getTime());
    expect(dispatchRows[0]?.backoffLevel).toBe(0);

    const createdIssues = await db.select().from(issues);
    expect(createdIssues).toHaveLength(1);
    expect(createdIssues[0]?.title).toBe("Fleet dispatch: FT");
    expect(createdIssues[0]?.status).toBe("in_progress");
    expect(createdIssues[0]?.assigneeAgentId).toBe(leadAgentId);
    expect(createdIssues[0]?.projectId).toBe(projectId);
  });

  it("does not nudge again before minNudgeGapMs has elapsed", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedEnforceMode();
    await seedGreenGovernor(NOW);

    const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    let now = NOW;
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => now });

    await svc.tick();
    expect(wakeup.calls).toHaveLength(1);

    now = new Date(NOW.getTime() + 5 * 60 * 1000);
    const second = await svc.tick();
    expect(wakeup.calls).toHaveLength(1);
    expect(second.projects[0]?.nudged).toBe(false);
    expect(second.projects[0]?.decision?.reason).toContain("min_nudge_gap");
  });

  it("an ack comment lets the next nudge through and keeps backoff at 0", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedEnforceMode();
    await seedGreenGovernor(NOW);

    const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    let now = NOW;
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => now });

    await svc.tick();
    const firstIssueId = (wakeup.calls[0]?.opts.payload as { issueId: string }).issueId;

    const ackAt = new Date(NOW.getTime() + 2 * 60 * 1000);
    await db.insert(issueComments).values({
      companyId,
      issueId: firstIssueId,
      authorAgentId: leadAgentId,
      authorType: "agent",
      body: "fleet-ack: worked=FT-1 kind=task outcome=done",
      createdAt: ackAt,
      updatedAt: ackAt,
    });

    // Past minNudgeGapMs (15 min) but still well short of the level-1 backoff
    // delay — reachable here because the ack keeps backoffLevel at 0. Re-seed
    // a fresh GREEN governor snapshot at `now`, since the first one (ts=NOW)
    // would otherwise be stale by staleAfterMs (default 15 min) at this point.
    now = new Date(NOW.getTime() + 16 * 60 * 1000);
    await seedGreenGovernor(now);
    const second = await svc.tick();

    expect(wakeup.calls).toHaveLength(2);
    expect(second.projects[0]?.nudged).toBe(true);

    const rows = await db.select().from(fleetDispatchState);
    expect(rows[0]?.backoffLevel).toBe(0);
    expect((rows[0]?.lastAck as { worked?: string } | null)?.worked).toBe("FT-1");
  });

  it("does not nudge while the supervisor already has a queued or running run", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedEnforceMode();
    await seedGreenGovernor(NOW);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: leadAgentId,
      status: "running",
      invocationSource: "on_demand",
    });

    const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

    const result = await svc.tick();

    expect(wakeup.calls).toHaveLength(0);
    expect(result.projects[0]?.decision?.reason).toContain("agent_busy");
  });

  it("does not nudge when the governor has never evaluated (stale)", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedEnforceMode();
    // No fleetThrottleStates row seeded at all.

    const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

    const result = await svc.tick();

    expect(wakeup.calls).toHaveLength(0);
    expect(result.projects[0]?.decision?.reason).toContain("governor_stale");
  });

  it("records a skip reason and skips a project whose lead agent has no jiraAccountId", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId, { jiraAccountId: null });
    const projectId = await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedEnforceMode();
    await seedGreenGovernor(NOW);

    const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

    const result = await svc.tick();

    expect(result.projects).toHaveLength(0);
    expect(wakeup.calls).toHaveLength(0);
    expect(jira.calls).toHaveLength(0);

    const rows = await db.select().from(fleetDispatchState);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectId).toBe(projectId);
    expect(rows[0]?.lastError).toContain("missing_jira_account_id");
  });

  it("computes epicsToClose from candidates minus those with unfinished children", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedGreenGovernor(NOW);

    const jira = fakeJiraFactory({
      readyTasks: 0,
      epicsToExplode: 0,
      closeCandidateKeys: ["FT-10", "FT-11", "FT-12"],
      unfinishedParentKeys: ["FT-11"],
    });
    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

    const result = await svc.tick();

    expect(result.projects[0]?.counts).toMatchObject({
      epicsToClose: 2,
      epicKeysToClose: ["FT-10", "FT-12"],
    });
  });

  it("skips a project whose FLEET_DISPATCH env is off", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    await seedProject(companyId, leadAgentId, { fleetDispatch: "off" });
    await seedJiraSettings();
    await seedGreenGovernor(NOW);

    const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

    const result = await svc.tick();

    expect(result.projects).toHaveLength(0);
    expect(jira.calls).toHaveLength(0);
  });

  it("getStatus reports mode, jiraConfigured, params, and persisted states", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedLeadAgent(companyId);
    await seedProject(companyId, leadAgentId);
    await seedJiraSettings();
    await seedGreenGovernor(NOW);

    const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
    const wakeup = fakeWakeup();
    const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

    await svc.tick();
    const status = await svc.getStatus();

    expect(status.mode).toBe("shadow");
    expect(status.jiraConfigured).toBe(true);
    expect(status.params.pollIntervalMs).toBeGreaterThan(0);
    expect(status.states).toHaveLength(1);
  });
});
