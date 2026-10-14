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
  dispatchIssueDescription,
  DISPATCH_MODE_SETTINGS_KEY,
  JIRA_SETTINGS_KEY,
  type FleetDispatchWakeup,
} from "./dispatch-service.js";
import type { FleetDispatchLogger } from "./dispatch-service.js";
import type { JiraClient, JiraClientFactory, JiraIssueDetail, JiraIssueSummary } from "./jira-client.js";

function fakeLogger(): FleetDispatchLogger {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

interface FakeIssue {
  key: string;
  summary?: string;
  status?: string;
  created?: string;
  updated?: string;
}

interface FakeJiraScript {
  /** A number generates that many "To Do" tasks FT-1..FT-n. */
  readyTasks: number | FakeIssue[];
  epicsToExplode: number | FakeIssue[];
  closeCandidateKeys: string[];
  /** Candidate epic keys that still have an unfinished child (i.e. NOT ready to close). */
  unfinishedParentKeys: string[];
  /** Current Jira assignee accountId per issue key for getIssue(); default "acc-1" (the supervisor). */
  assignees?: Record<string, string | null>;
}

function toIssues(value: number | FakeIssue[], prefix: string, status: string, issueType: string): JiraIssueDetail[] {
  const list: FakeIssue[] = Array.isArray(value)
    ? value
    : Array.from({ length: value }, (_, i) => ({
        key: `${prefix}-${i + 1}`,
        created: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
      }));
  return list.map((issue) => ({
    key: issue.key,
    summary: issue.summary ?? `Summary of ${issue.key}`,
    issueTypeName: issueType,
    statusName: issue.status ?? status,
    statusCategoryKey: null,
    parentKey: null,
    created: issue.created ?? null,
    updated: issue.updated ?? null,
  }));
}

function fakeJiraFactory(script: FakeJiraScript): {
  factory: JiraClientFactory;
  calls: string[];
  assigns: Array<{ key: string; accountId: string }>;
  comments: Array<{ key: string; text: string }>;
  getIssueCalls: string[];
} {
  const calls: string[] = [];
  const assigns: Array<{ key: string; accountId: string }> = [];
  const comments: Array<{ key: string; text: string }> = [];
  const getIssueCalls: string[] = [];
  const assignees: Record<string, string | null> = { ...(script.assignees ?? {}) };
  const searchIssues = async (jql: string): Promise<JiraIssueDetail[]> => {
    calls.push(jql);
    if (jql.includes("issuetype != Epic")) return toIssues(script.readyTasks, "FT", "To Do", "Task");
    if (jql.includes("issuetype = Epic") && jql.includes('status = "To Do"')) {
      return toIssues(script.epicsToExplode, "FTE", "To Do", "Epic");
    }
    if (jql.includes("issuetype = Epic") && jql.includes('status = "In Progress"')) {
      return toIssues(script.closeCandidateKeys.map((key) => ({ key })), "FTC", "In Progress", "Epic");
    }
    if (jql.includes("parent in")) {
      return script.unfinishedParentKeys.map((parentKey) => ({
        key: `${parentKey}-CHILD`,
        summary: null,
        issueTypeName: "Task",
        statusName: "In Progress",
        statusCategoryKey: "indeterminate",
        parentKey,
        created: null,
        updated: null,
      }));
    }
    return [];
  };
  const client: JiraClient = {
    approximateCount: async (jql: string) => {
      calls.push(jql);
      return 0;
    },
    searchIssues,
    searchKeys: async (jql: string): Promise<JiraIssueSummary[]> => searchIssues(jql),
    getIssue: async (key: string) => {
      getIssueCalls.push(key);
      const accountId = key in assignees ? assignees[key] : "acc-1";
      return { key, fields: { assignee: accountId ? { accountId } : null } };
    },
    assignIssue: async (key: string, accountId: string) => {
      assigns.push({ key, accountId });
      assignees[key] = accountId;
    },
    addComment: async (key: string, text: string) => {
      comments.push({ key, text });
    },
  };
  return { factory: () => client, calls, assigns, comments, getIssueCalls };
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

  async function seedJiraSettings(opts: { human?: boolean } = {}): Promise<void> {
    await db.insert(fleetSettings).values({
      key: JIRA_SETTINGS_KEY,
      value: {
        baseUrl: "https://example.atlassian.net",
        email: "bot@example.com",
        tokenSecretId: "unused-in-tests",
        ...(opts.human ? { humanAccountId: "human-acc", humanEmail: "human@example.com" } : {}),
      },
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

  async function seedGreenGovernor(ts: Date, opts: { state?: string; excludedModels?: string[] } = {}): Promise<void> {
    const state = opts.state ?? "OPEN";
    await db.insert(fleetThrottleStates).values({
      ts,
      mode: "shadow",
      state,
      stale: false,
      pace: null,
      fiveHourPct: 10,
      sevenDayPct: 40,
      floorActive: false,
      reason: `${state}: seeded for dispatch test`,
      paramsVersion: "v1-cap-schedule",
      inputs: {},
      launchParameters: { excludedModels: opts.excludedModels ?? [], maxConcurrency: 1 },
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
      version: 2,
      jiraProject: "FT",
      assignment: { key: "FT-1", summary: "Summary of FT-1", status: "To Do", kind: "task" },
      readyTasks: 3,
      epicsToExplode: 1,
      epicsToClose: 0,
      throttleState: "OPEN",
      modelExclusions: [],
      ackFormat: "fleet-ack: worked=<KEY> outcome=<done|declined|partial>",
    });
    // No human configured in jira settings -> no declineReassignTo.
    expect(payload.fleetDispatch).not.toHaveProperty("declineReassignTo");

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
  describe("fleet dispatch v2", () => {
    async function seedNudgedState(input: {
      projectId: string;
      companyId: string;
      leadAgentId: string;
      runId: string;
      nudgeAt: Date;
      countsFingerprint?: string;
      backoffLevel?: number;
    }): Promise<void> {
      await db.insert(fleetDispatchState).values({
        projectId: input.projectId,
        companyId: input.companyId,
        jiraProject: "FT",
        leadAgentId: input.leadAgentId,
        lastNudgeAt: input.nudgeAt,
        lastNudgeWakeId: input.runId,
        countsFingerprint: input.countsFingerprint ?? "1:0:0",
        backoffLevel: input.backoffLevel ?? 0,
        updatedAt: input.nudgeAt,
      });
    }

    async function seedFinishedRun(input: {
      runId: string;
      companyId: string;
      agentId: string;
      finishedAt: Date;
      summary: string;
    }): Promise<void> {
      await db.insert(heartbeatRuns).values({
        id: input.runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "succeeded",
        invocationSource: "automation",
        finishedAt: input.finishedAt,
        resultJson: { ok: true, summary: input.summary },
        stdoutExcerpt: `${input.summary}\n`,
      });
    }

    it("selects In Progress tasks first (oldest updated), and carries declineReassignTo, modelExclusions and CAPPED", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      await seedProject(companyId, leadAgentId);
      await seedJiraSettings({ human: true });
      await seedEnforceMode();
      await seedGreenGovernor(NOW, { state: "CAPPED", excludedModels: ["Fable"] });

      const jira = fakeJiraFactory({
        readyTasks: [
          { key: "FT-1", status: "To Do", created: "2025-01-01T00:00:00.000Z" },
          { key: "FT-2", status: "In Progress", created: "2026-01-05T00:00:00.000Z", updated: "2026-01-20T00:00:00.000Z" },
          { key: "FT-3", status: "In Progress", created: "2026-01-06T00:00:00.000Z", updated: "2026-01-10T00:00:00.000Z" },
        ],
        epicsToExplode: 1,
        closeCandidateKeys: ["FT-10"],
        unfinishedParentKeys: [],
      });
      const wakeup = fakeWakeup();
      const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

      const result = await svc.tick();

      expect(result.projects[0]?.nudged).toBe(true);
      const payload = wakeup.calls[0]?.opts.payload as { fleetDispatch: Record<string, unknown> };
      expect(payload.fleetDispatch).toMatchObject({
        version: 2,
        assignment: { key: "FT-3", status: "In Progress", kind: "task" },
        declineReassignTo: { accountId: "human-acc", email: "human@example.com" },
        throttleState: "CAPPED",
        modelExclusions: ["fable"],
        readyTasks: 3,
        epicsToExplode: 1,
        epicsToClose: 1,
        epicKeysToClose: ["FT-10"],
      });

      const rows = await db.select().from(fleetDispatchState);
      const lastDecision = rows[0]?.lastDecision as { assignment?: { key: string }; nudgedAssignment?: { key: string } };
      expect(lastDecision.assignment?.key).toBe("FT-3");
      expect(lastDecision.nudgedAssignment?.key).toBe("FT-3");
    });

    it("selects an epic to close before an epic to explode when no tasks are ready", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      await seedProject(companyId, leadAgentId);
      await seedJiraSettings();
      await seedEnforceMode();
      await seedGreenGovernor(NOW);

      const jira = fakeJiraFactory({ readyTasks: 0, epicsToExplode: 2, closeCandidateKeys: ["FT-10"], unfinishedParentKeys: [] });
      const wakeup = fakeWakeup();
      const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

      await svc.tick();

      const payload = wakeup.calls[0]?.opts.payload as { fleetDispatch: { assignment: { key: string; kind: string } } };
      expect(payload.fleetDispatch.assignment).toMatchObject({ key: "FT-10", kind: "epic_close" });
    });

    it("reads a v2 ack from the finished nudge run's result and resets backoff", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      const projectId = await seedProject(companyId, leadAgentId);
      await seedJiraSettings({ human: true });
      await seedEnforceMode();
      const runId = randomUUID();
      await seedNudgedState({ projectId, companyId, leadAgentId, runId, nudgeAt: NOW, backoffLevel: 1 });
      await seedFinishedRun({
        runId,
        companyId,
        agentId: leadAgentId,
        finishedAt: new Date(NOW.getTime() + 60_000),
        summary: "Pushed the fix.\nfleet-ack: worked=FT-1 outcome=done",
      });

      const now = new Date(NOW.getTime() + 16 * 60 * 1000);
      await seedGreenGovernor(now);
      const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
      const wakeup = fakeWakeup();
      const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => now });

      const result = await svc.tick();

      expect(result.projects[0]?.nudged).toBe(true);
      const rows = await db.select().from(fleetDispatchState);
      expect(rows[0]?.backoffLevel).toBe(0);
      expect(rows[0]?.lastAck).toMatchObject({ id: `run:${runId}`, source: "run_result", worked: "FT-1", kind: null, outcome: "done" });
      expect(jira.assigns).toHaveLength(0);
    });

    it("a finished nudge run without an ack counts as un-acked (backoff holds)", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      const projectId = await seedProject(companyId, leadAgentId);
      await seedJiraSettings();
      await seedEnforceMode();
      const runId = randomUUID();
      await seedNudgedState({ projectId, companyId, leadAgentId, runId, nudgeAt: NOW });
      await seedFinishedRun({ runId, companyId, agentId: leadAgentId, finishedAt: new Date(NOW.getTime() + 60_000), summary: "Looked around." });

      const now = new Date(NOW.getTime() + 16 * 60 * 1000);
      await seedGreenGovernor(now);
      const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
      const wakeup = fakeWakeup();
      const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => now });

      const result = await svc.tick();

      expect(wakeup.calls).toHaveLength(0);
      expect(result.projects[0]?.decision?.reason).toContain("backoff");
    });

    it("reassigns a declined issue to the human once, comments, and does not let the decline reset backoff", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      const projectId = await seedProject(companyId, leadAgentId);
      await seedJiraSettings({ human: true });
      await seedEnforceMode();
      const runId = randomUUID();
      await seedNudgedState({ projectId, companyId, leadAgentId, runId, nudgeAt: NOW, countsFingerprint: "2:0:0", backoffLevel: 1 });
      const reply = `Blocked on credentials I do not have. ${"x".repeat(600)}\nfleet-ack: worked=FT-1 outcome=declined`;
      await seedFinishedRun({ runId, companyId, agentId: leadAgentId, finishedAt: new Date("2026-02-01T12:01:00.000Z"), summary: reply });

      const now = new Date(NOW.getTime() + 16 * 60 * 1000);
      await seedGreenGovernor(now);
      const jira = fakeJiraFactory({ readyTasks: 2, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
      const wakeup = fakeWakeup();
      let clock = now;
      const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => clock });

      const first = await svc.tick();

      expect(jira.assigns).toEqual([{ key: "FT-1", accountId: "human-acc" }]);
      expect(jira.comments).toHaveLength(1);
      expect(jira.comments[0]?.key).toBe("FT-1");
      expect(jira.comments[0]?.text).toBe(
        `Declined by fleet supervisor Supervisor at Feb 1, 2026, 4:01 AM PST; reassigned to human@example.com for investigation. Agent reply: ${reply.slice(0, 500)}`,
      );
      // The reassigned key is excluded from this tick's selection and counts,
      // so the counts moved (2 -> 1) and the next nudge is about FT-2.
      expect(first.projects[0]?.counts?.readyTasks).toBe(1);
      expect(first.projects[0]?.nudged).toBe(true);
      const payload = wakeup.calls[0]?.opts.payload as { fleetDispatch: { assignment: { key: string } } };
      expect(payload.fleetDispatch.assignment.key).toBe("FT-2");

      const rows = await db.select().from(fleetDispatchState);
      expect(rows[0]?.lastAck).toMatchObject({
        id: `run:${runId}`,
        outcome: "declined",
        decline: { action: "reassigned", key: "FT-1", toEmail: "human@example.com" },
      });

      // Idempotent: the same ack seen again (restart with the same state) is not re-processed.
      await db.update(fleetDispatchState).set({ lastNudgeWakeId: runId });
      clock = new Date(now.getTime() + 20 * 60 * 1000);
      await seedGreenGovernor(clock);
      const svc2 = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => clock });
      await svc2.tick();
      expect(jira.getIssueCalls).toEqual(["FT-1"]);
      expect(jira.assigns).toHaveLength(1);
      expect(jira.comments).toHaveLength(1);
    });

    it("records decline_mismatch and leaves Jira alone when the declined issue is assigned to someone else", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      const projectId = await seedProject(companyId, leadAgentId);
      await seedJiraSettings({ human: true });
      await seedEnforceMode();
      const runId = randomUUID();
      await seedNudgedState({ projectId, companyId, leadAgentId, runId, nudgeAt: NOW });
      await seedFinishedRun({
        runId,
        companyId,
        agentId: leadAgentId,
        finishedAt: new Date(NOW.getTime() + 60_000),
        summary: "fleet-ack: worked=FT-1 kind=task outcome=declined",
      });

      const now = new Date(NOW.getTime() + 16 * 60 * 1000);
      await seedGreenGovernor(now);
      const jira = fakeJiraFactory({
        readyTasks: 1,
        epicsToExplode: 0,
        closeCandidateKeys: [],
        unfinishedParentKeys: [],
        assignees: { "FT-1": "someone-else" },
      });
      const wakeup = fakeWakeup();
      const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => now });

      const result = await svc.tick();

      expect(jira.getIssueCalls).toEqual(["FT-1"]);
      expect(jira.assigns).toHaveLength(0);
      expect(jira.comments).toHaveLength(0);
      const rows = await db.select().from(fleetDispatchState);
      expect(rows[0]?.lastAck).toMatchObject({
        kind: "task",
        outcome: "declined",
        decline: { action: "decline_mismatch", currentAssigneeAccountId: "someone-else" },
      });
      // Declined and counts unchanged: the decline does not reset backoff, so
      // the stuck nudge is held for the backoff delay.
      expect(result.projects[0]?.nudged).toBe(false);
      expect(result.projects[0]?.decision?.reason).toContain("backoff");
    });

    it("shadow mode only logs what it would do with a declined ack", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      const projectId = await seedProject(companyId, leadAgentId);
      await seedJiraSettings({ human: true });
      const runId = randomUUID();
      await seedNudgedState({ projectId, companyId, leadAgentId, runId, nudgeAt: NOW });
      await seedFinishedRun({
        runId,
        companyId,
        agentId: leadAgentId,
        finishedAt: new Date(NOW.getTime() + 60_000),
        summary: "fleet-ack: worked=FT-1 outcome=declined",
      });

      const now = new Date(NOW.getTime() + 16 * 60 * 1000);
      await seedGreenGovernor(now);
      const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
      const wakeup = fakeWakeup();
      const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => now });

      await svc.tick();

      expect(jira.assigns).toHaveLength(0);
      expect(jira.comments).toHaveLength(0);
      expect(wakeup.calls).toHaveLength(0);
      const rows = await db.select().from(fleetDispatchState);
      expect(rows[0]?.lastAck).toMatchObject({ decline: { action: "shadow_would_reassign", toEmail: "human@example.com" } });
    });

    it("skips reassignment with a warning when no human is configured", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      const projectId = await seedProject(companyId, leadAgentId);
      await seedJiraSettings();
      await seedEnforceMode();
      const runId = randomUUID();
      await seedNudgedState({ projectId, companyId, leadAgentId, runId, nudgeAt: NOW });
      await seedFinishedRun({
        runId,
        companyId,
        agentId: leadAgentId,
        finishedAt: new Date(NOW.getTime() + 60_000),
        summary: "fleet-ack: worked=FT-1 outcome=declined",
      });

      const now = new Date(NOW.getTime() + 16 * 60 * 1000);
      await seedGreenGovernor(now);
      const jira = fakeJiraFactory({ readyTasks: 1, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
      const logger = fakeLogger();
      const svc = createFleetDispatchService({ db, logger, jira: jira.factory, wakeup: fakeWakeup().fn, now: () => now });

      await svc.tick();

      expect(jira.getIssueCalls).toHaveLength(0);
      expect(jira.assigns).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: "FT-1" }),
        expect.stringContaining("humanAccountId/humanEmail are not configured"),
      );
      const rows = await db.select().from(fleetDispatchState);
      expect(rows[0]?.lastAck).toMatchObject({ decline: { action: "skip_no_target" } });
    });

    it("wakes the supervisor for its oldest pending Paperclip issue instead of a Jira nudge", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      const projectId = await seedProject(companyId, leadAgentId);
      await seedJiraSettings();
      await seedEnforceMode();
      await seedGreenGovernor(NOW);
      const olderId = randomUUID();
      await db.insert(issues).values([
        {
          id: randomUUID(),
          companyId,
          title: "newer",
          status: "in_progress",
          assigneeAgentId: leadAgentId,
          identifier: "PIX-9",
          createdAt: new Date("2026-01-20T00:00:00.000Z"),
        },
        {
          id: olderId,
          companyId,
          title: "older",
          status: "todo",
          assigneeAgentId: leadAgentId,
          identifier: "PIX-7",
          createdAt: new Date("2026-01-10T00:00:00.000Z"),
        },
        {
          id: randomUUID(),
          companyId,
          title: "Fleet dispatch: FT",
          status: "in_progress",
          assigneeAgentId: leadAgentId,
          identifier: "PIX-1",
          originKind: "fleet_dispatch",
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
        {
          id: randomUUID(),
          companyId,
          title: "done one",
          status: "done",
          assigneeAgentId: leadAgentId,
          identifier: "PIX-2",
          createdAt: new Date("2025-06-01T00:00:00.000Z"),
        },
      ]);

      const jira = fakeJiraFactory({ readyTasks: 2, epicsToExplode: 0, closeCandidateKeys: [], unfinishedParentKeys: [] });
      const wakeup = fakeWakeup();
      const svc = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => NOW });

      const result = await svc.tick();

      expect(wakeup.calls).toHaveLength(1);
      expect(wakeup.calls[0]?.opts.reason).toBe("fleet_pending_issue");
      expect(wakeup.calls[0]?.opts.payload).toMatchObject({ issueId: olderId });
      expect(wakeup.calls[0]?.opts.contextSnapshot).toMatchObject({ issueId: olderId });
      expect(wakeup.calls[0]?.opts.contextSnapshot).not.toHaveProperty("fleetDispatch");
      expect(result.projects[0]?.decision?.reason).toBe("paperclip_issue_priority: PIX-7");

      const rows = await db.select().from(fleetDispatchState);
      expect(rows[0]?.projectId).toBe(projectId);
      expect(rows[0]?.lastNudgeAt).toBeNull();
      expect(rows[0]?.lastDecision).toMatchObject({
        reason: "paperclip_issue_priority: PIX-7",
        pendingIssueWake: { issueId: olderId, identifier: "PIX-7" },
      });

      // Within the min nudge gap of that wake: no second wake of either kind.
      const later = new Date(NOW.getTime() + 5 * 60 * 1000);
      const svc2 = createFleetDispatchService({ db, logger: fakeLogger(), jira: jira.factory, wakeup: wakeup.fn, now: () => later });
      const second = await svc2.tick();
      expect(wakeup.calls).toHaveLength(1);
      expect(second.projects[0]?.decision?.reason).toContain("paperclip_issue_priority: PIX-7 (held: min_nudge_gap");
    });

    it("a pending Paperclip issue respects agent_busy and still suppresses the Jira nudge", async () => {
      const companyId = await seedCompany();
      const leadAgentId = await seedLeadAgent(companyId);
      await seedProject(companyId, leadAgentId);
      await seedJiraSettings();
      await seedEnforceMode();
      await seedGreenGovernor(NOW);
      await db.insert(issues).values({
        companyId,
        title: "pending",
        status: "todo",
        assigneeAgentId: leadAgentId,
        identifier: "PIX-3",
      });
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
      expect(result.projects[0]?.decision?.reason).toContain("paperclip_issue_priority: PIX-3 (held: agent_busy");
    });

    it("the standing dispatch issue description documents the v2 ack and rules", () => {
      const text = dispatchIssueDescription("FT");
      expect(text).toContain("fleet-ack: worked=<KEY> outcome=<done|declined|partial>");
      expect(text).toContain("reassigns the Jira issue to the configured human");
      expect(text).toContain("Paperclip issues assigned to you take priority");
    });
  });
});
