/**
 * The fleet dispatch loop's I/O layer (see ./DISPATCH.md for the module
 * contract in prose). This is the service that actually polls Jira, loads
 * the fleet governor's latest throttle decision, calls the pure
 * `decideDispatch()` policy in ./dispatch-policy.ts, persists per-project
 * state into `fleet_dispatch_state`, and — in `enforce` mode only — wakes a
 * project's supervisor with a "Fleet dispatch" context block.
 *
 * Mirrors the shape of ./governor-service.ts: a `deps`-injected factory,
 * `tick()`/`start()`/`getStatus()`, and a `getSharedFleetDispatchService()`
 * WeakMap-by-db singleton so the HTTP routes and the startup scheduler share
 * one instance (and one in-flight-tick guard) per database handle.
 */

import { and, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  agents,
  fleetDispatchState,
  fleetSettings,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import type { AgentEnvConfig } from "@paperclipai/shared";
import { secretService } from "../secrets.js";
import { issueService } from "../issues.js";
import {
  createJiraClient,
  JiraAuthError,
  JiraRequestError,
  JiraTransientError,
  type JiraClient,
  type JiraClientFactory,
} from "./jira-client.js";
import {
  DEFAULT_DISPATCH_PARAMS,
  DEFAULT_READY_STATUSES,
  computeEpicsToClose,
  countsFingerprint,
  decideDispatch,
  epicsToCloseCandidateJql,
  epicsToExplodeJql,
  readyTasksJql,
  unfinishedChildrenJql,
  type DecideDispatchResult,
  type DispatchParams,
  type ProjectClass,
  type ReadyWorkCounts,
  type ThrottleStateLike,
} from "./dispatch-policy.js";
import { getSharedFleetGovernorService, type FleetGovernorLogger } from "./governor-service.js";

export type FleetDispatchLogger = FleetGovernorLogger;

export type FleetDispatchMode = "shadow" | "enforce";

export const JIRA_SETTINGS_KEY = "jira";
export const DISPATCH_MODE_SETTINGS_KEY = "dispatch_mode";
export const DISPATCH_PARAMS_SETTINGS_KEY = "dispatch_params";

const DEFAULT_POLL_INTERVAL_MS = 10 * 60 * 1000;
/**
 * issues.origin_kind for the standing dispatch issue. Paperclip's recovery paths
 * (issue continuation, successful-run handoff, stranded-issue escalation) treat this
 * origin as externally managed and leave the issue alone; see recovery/origins.ts.
 */
export const DISPATCH_ISSUE_ORIGIN_KIND = "fleet_dispatch";

/** `fleet-ack:` line format the dispatch issue's description asks the supervisor to reply with. */
export const FLEET_ACK_FORMAT =
  "fleet-ack: worked=<KEY> kind=<task|epic_explode|epic_close> outcome=<done|declined|partial>";

const ACK_LINE_RE =
  /fleet-ack:\s*worked=(\S+)\s+kind=(task|epic_explode|epic_close)\s+outcome=(done|declined|partial)/;

/**
 * The subset of the heartbeat scheduler's real `WakeupOptions` this module
 * needs. Kept local (not imported from heartbeat.ts, which this task must
 * not touch) exactly like server/src/services/decision-wakeup.ts's
 * `HeartbeatWakeup` — `heartbeat.wakeup`'s real, wider parameter type is
 * structurally assignable to this narrower one.
 */
export type FleetDispatchWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    contextSnapshot: Record<string, unknown>;
    idempotencyKey: string;
  },
) => Promise<unknown>;

export interface JiraSettings {
  baseUrl: string;
  email: string;
  tokenSecretId: string;
}

export interface DispatchServiceParams extends DispatchParams {
  /** How often start() reschedules tick(). Default 10 minutes. */
  pollIntervalMs: number;
}

export const DEFAULT_DISPATCH_SERVICE_PARAMS: DispatchServiceParams = {
  ...DEFAULT_DISPATCH_PARAMS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

function mergeDispatchParams(overrides: Partial<DispatchServiceParams> | null | undefined): DispatchServiceParams {
  if (!overrides || typeof overrides !== "object") return DEFAULT_DISPATCH_SERVICE_PARAMS;
  return {
    ...DEFAULT_DISPATCH_SERVICE_PARAMS,
    ...overrides,
    backoffMs: Array.isArray(overrides.backoffMs) ? overrides.backoffMs : DEFAULT_DISPATCH_SERVICE_PARAMS.backoffMs,
  };
}

function resolveDispatchMode(value: unknown): FleetDispatchMode {
  if (value && typeof value === "object" && (value as { mode?: unknown }).mode === "enforce") return "enforce";
  return "shadow";
}

function isJiraSettings(value: unknown): value is JiraSettings {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.baseUrl === "string" &&
    record.baseUrl.trim().length > 0 &&
    typeof record.email === "string" &&
    record.email.trim().length > 0 &&
    typeof record.tokenSecretId === "string" &&
    record.tokenSecretId.trim().length > 0
  );
}

/**
 * Reads a plain-text value out of a project's `env` jsonb (task 2's
 * `AgentEnvConfig`): a bare legacy string, or `{type:"plain", value}`.
 * `secret_ref`/`user_secret_ref` bindings are not meaningful for dispatch
 * config (JIRA_PROJECT, FLEET_DISPATCH, FLEET_CLASS, JIRA_READY_STATUSES are
 * never secrets) and are treated as unset.
 */
function readPlainEnvValue(env: AgentEnvConfig | null | undefined, key: string): string | null {
  const raw = (env as Record<string, unknown> | null | undefined)?.[key];
  if (raw == null) return null;
  if (typeof raw === "string") return raw.trim() || null;
  if (typeof raw === "object" && (raw as { type?: unknown }).type === "plain") {
    const value = (raw as { value?: unknown }).value;
    return typeof value === "string" ? value.trim() || null : null;
  }
  return null;
}

function resolveProjectClassFromEnv(env: AgentEnvConfig | null | undefined): ProjectClass {
  const raw = readPlainEnvValue(env, "FLEET_CLASS");
  return raw === "P0" || raw === "P1" ? raw : "P2";
}

function parseReadyStatuses(env: AgentEnvConfig | null | undefined): string[] {
  const raw = readPlainEnvValue(env, "JIRA_READY_STATUSES");
  if (!raw) return [...DEFAULT_READY_STATUSES];
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [...DEFAULT_READY_STATUSES];
}

function isoMinute(date: Date): string {
  return date.toISOString().slice(0, 16);
}

function dispatchIssueDescription(jiraProject: string): string {
  return [
    `This is the standing dispatch issue for the ${jiraProject} Jira project's fleet supervisor.`,
    "",
    'The fleet dispatch loop nudges this supervisor awake when there is ready work assigned to it in Jira (ready tasks, epics to explode, or in-progress epics whose children are all done) and the fleet governor\'s throttle state allows new work. Each nudge carries a "Fleet dispatch" context block describing the current counts; the nudge itself is not a task to execute.',
    "",
    "After working one ready item per turn (one task, one epic explosion, or one epic close), reply on this issue with a single-line ack comment in this exact format so the loop can detect it and reset backoff:",
    "",
    FLEET_ACK_FORMAT,
    "",
    "- <KEY> is the Jira issue key you worked (e.g. FT-123).",
    '- kind is "task" for a ready task, "epic_explode" for breaking an epic into children, or "epic_close" for closing a finished epic.',
    '- outcome is "done" (completed), "declined" (skipped — e.g. blocked or out of scope), or "partial" (started but not finished).',
    "",
    "If this issue goes quiet after a nudge (no ack), the loop backs off automatically and eventually stops nudging until a human checks in.",
  ].join("\n");
}

type FleetDispatchStateRow = typeof fleetDispatchState.$inferSelect;

export interface DispatchAckLike {
  at: string;
  worked: string;
  kind: "task" | "epic_explode" | "epic_close";
  outcome: "done" | "declined" | "partial";
}

interface EligibleProject {
  id: string;
  companyId: string;
  env: AgentEnvConfig | null;
  leadAgentId: string;
  jiraProject: string;
  jiraAccountId: string;
  readyStatuses: string[];
  projectClass: ProjectClass;
}

export interface FleetDispatchProjectOutcome {
  projectId: string;
  companyId: string;
  jiraProject: string;
  skipped: boolean;
  skipReason?: string;
  nudged?: boolean;
  decision?: DecideDispatchResult;
  counts?: ReadyWorkCounts;
  error?: string;
}

export interface FleetDispatchTickResult {
  ok: boolean;
  mode: FleetDispatchMode;
  jiraConfigured: boolean;
  projects: FleetDispatchProjectOutcome[];
  error?: string;
}

export interface FleetDispatchStatus {
  mode: FleetDispatchMode;
  jiraConfigured: boolean;
  params: DispatchServiceParams;
  states: FleetDispatchStateRow[];
}

export interface FleetDispatchServiceDeps {
  db: Db;
  logger: FleetDispatchLogger;
  /** Injectable for tests; defaults to building a real client from settings + a resolved secret. */
  jira?: JiraClientFactory;
  wakeup: FleetDispatchWakeup;
  /** Defaults to `() => new Date()`. Inject for deterministic tests. */
  now?: () => Date;
}

export interface FleetDispatchService {
  tick(): Promise<FleetDispatchTickResult>;
  start(): () => void;
  getStatus(): Promise<FleetDispatchStatus>;
}

export function createFleetDispatchService(deps: FleetDispatchServiceDeps): FleetDispatchService {
  const now = () => deps.now?.() ?? new Date();
  const secrets = secretService(deps.db);
  const jiraFactory: JiraClientFactory = deps.jira ?? createJiraClient;

  async function loadSettingsValue(key: string): Promise<Record<string, unknown> | null> {
    const rows = await deps.db.select().from(fleetSettings).where(eq(fleetSettings.key, key)).limit(1);
    return (rows[0]?.value as Record<string, unknown> | undefined) ?? null;
  }

  async function loadMode(): Promise<FleetDispatchMode> {
    return resolveDispatchMode(await loadSettingsValue(DISPATCH_MODE_SETTINGS_KEY));
  }

  async function loadParams(): Promise<DispatchServiceParams> {
    return mergeDispatchParams(
      (await loadSettingsValue(DISPATCH_PARAMS_SETTINGS_KEY)) as Partial<DispatchServiceParams> | null,
    );
  }

  async function loadJiraSettings(): Promise<JiraSettings | null> {
    const value = await loadSettingsValue(JIRA_SETTINGS_KEY);
    return isJiraSettings(value) ? value : null;
  }

  /** Discovers projects eligible for the dispatch loop (task 3's project-discovery rules). */
  async function discoverEligibleProjects(): Promise<{
    eligible: EligibleProject[];
    accountIdSkips: { projectId: string; companyId: string; jiraProject: string; leadAgentId: string }[];
  }> {
    const projectRows = await deps.db
      .select({
        id: projects.id,
        companyId: projects.companyId,
        env: projects.env,
        leadAgentId: projects.leadAgentId,
      })
      .from(projects)
      .where(and(isNull(projects.archivedAt), isNull(projects.pausedAt), isNotNull(projects.leadAgentId)));

    const candidates = projectRows
      .map((row) => {
        const jiraProject = readPlainEnvValue(row.env, "JIRA_PROJECT");
        const dispatchFlag = readPlainEnvValue(row.env, "FLEET_DISPATCH");
        if (!jiraProject || dispatchFlag === "off") return null;
        return { ...row, leadAgentId: row.leadAgentId as string, jiraProject };
      })
      .filter((row): row is NonNullable<typeof row> => row != null);

    if (candidates.length === 0) return { eligible: [], accountIdSkips: [] };

    const leadAgentIds = [...new Set(candidates.map((row) => row.leadAgentId))];
    const agentRows = await deps.db
      .select({
        id: agents.id,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
        status: agents.status,
      })
      .from(agents)
      .where(inArray(agents.id, leadAgentIds));
    const agentsById = new Map(agentRows.map((row) => [row.id, row]));

    const eligible: EligibleProject[] = [];
    const accountIdSkips: { projectId: string; companyId: string; jiraProject: string; leadAgentId: string }[] = [];

    for (const candidate of candidates) {
      const agent = agentsById.get(candidate.leadAgentId);
      if (!agent || agent.adapterType !== "claudeclaw_gateway" || agent.status === "paused") continue;

      const jiraAccountId = (agent.adapterConfig as { jiraAccountId?: unknown } | null)?.jiraAccountId;
      const resolvedAccountId = typeof jiraAccountId === "string" && jiraAccountId.trim() ? jiraAccountId.trim() : null;
      if (!resolvedAccountId) {
        accountIdSkips.push({
          projectId: candidate.id,
          companyId: candidate.companyId,
          jiraProject: candidate.jiraProject,
          leadAgentId: candidate.leadAgentId,
        });
        continue;
      }

      eligible.push({
        id: candidate.id,
        companyId: candidate.companyId,
        env: candidate.env,
        leadAgentId: candidate.leadAgentId,
        jiraProject: candidate.jiraProject,
        jiraAccountId: resolvedAccountId,
        readyStatuses: parseReadyStatuses(candidate.env),
        projectClass: resolveProjectClassFromEnv(candidate.env),
      });
    }

    return { eligible, accountIdSkips };
  }

  async function loadExistingState(projectId: string): Promise<FleetDispatchStateRow | null> {
    const rows = await deps.db
      .select()
      .from(fleetDispatchState)
      .where(eq(fleetDispatchState.projectId, projectId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function isAgentBusy(agentId: string): Promise<boolean> {
    const rows = await deps.db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .limit(1);
    return rows.length > 0;
  }

  /** Most recent `fleet-ack:` comment on the dispatch issue strictly after `afterAt`, or null. */
  async function findAck(dispatchIssueId: string, afterAt: Date): Promise<DispatchAckLike | null> {
    const rows = await deps.db
      .select({ body: issueComments.body, createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, dispatchIssueId),
          gt(issueComments.createdAt, afterAt),
          isNull(issueComments.deletedAt),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(20);

    for (const row of rows) {
      const match = ACK_LINE_RE.exec(row.body);
      if (match) {
        return {
          at: row.createdAt.toISOString(),
          worked: match[1],
          kind: match[2] as DispatchAckLike["kind"],
          outcome: match[3] as DispatchAckLike["outcome"],
        };
      }
    }
    return null;
  }

  async function ensureDispatchIssue(project: EligibleProject, existingIssueId: string | null): Promise<string> {
    const asOf = now();
    if (existingIssueId) {
      const existing = await deps.db
        .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId, originKind: issues.originKind })
        .from(issues)
        .where(eq(issues.id, existingIssueId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (
          existing.status !== "in_progress" ||
          existing.assigneeAgentId !== project.leadAgentId ||
          existing.originKind !== DISPATCH_ISSUE_ORIGIN_KIND
        ) {
          await deps.db
            .update(issues)
            .set({ status: "in_progress", assigneeAgentId: project.leadAgentId, originKind: DISPATCH_ISSUE_ORIGIN_KIND, updatedAt: asOf })
            .where(eq(issues.id, existing.id));
        }
        return existing.id;
      }
    }

    const created = await issueService(deps.db).create(project.companyId, {
      title: `Fleet dispatch: ${project.jiraProject}`,
      description: dispatchIssueDescription(project.jiraProject),
      projectId: project.id,
      assigneeAgentId: project.leadAgentId,
      status: "in_progress",
      originKind: DISPATCH_ISSUE_ORIGIN_KIND,
    });
    return created.id;
  }

  const jiraClientsByCompany = new Map<string, JiraClient>();
  const jiraTokensByCompany = new Map<string, Promise<string>>();

  async function getJiraClientForCompany(companyId: string, jiraSettings: JiraSettings): Promise<JiraClient> {
    const cached = jiraClientsByCompany.get(companyId);
    if (cached) return cached;

    let tokenPromise = jiraTokensByCompany.get(companyId);
    if (!tokenPromise) {
      tokenPromise = deps.jira
        ? Promise.resolve("")
        : secrets.resolveSecretValue(companyId, jiraSettings.tokenSecretId, "latest", {
            accessContext: {
              consumerType: "system",
              consumerId: "fleet-dispatch",
              actorType: "system",
              actorId: null,
              configPath: "jira.tokenSecretId",
            },
          });
      jiraTokensByCompany.set(companyId, tokenPromise);
    }
    const apiToken = await tokenPromise;

    const client = jiraFactory({ baseUrl: jiraSettings.baseUrl, email: jiraSettings.email, apiToken });
    jiraClientsByCompany.set(companyId, client);
    return client;
  }

  async function countReadyWork(
    jira: JiraClient,
    project: EligibleProject,
  ): Promise<ReadyWorkCounts> {
    const accountId = project.jiraAccountId;
    const [readyTasks, epicsToExplode, closeCandidates] = await Promise.all([
      jira.approximateCount(
        readyTasksJql({ jiraProject: project.jiraProject, jiraAccountId: accountId, readyStatuses: project.readyStatuses }),
      ),
      jira.approximateCount(epicsToExplodeJql({ jiraProject: project.jiraProject, jiraAccountId: accountId })),
      jira.searchKeys(epicsToCloseCandidateJql({ jiraProject: project.jiraProject, jiraAccountId: accountId }), ["key"]),
    ]);

    const candidateKeys = closeCandidates.map((issue) => issue.key);
    let epicsToCloseKeys: string[] = [];
    if (candidateKeys.length > 0) {
      const unfinished = await jira.searchKeys(unfinishedChildrenJql(project.jiraProject, candidateKeys), ["key", "parent"]);
      const unfinishedParentKeys = unfinished
        .map((issue) => issue.parentKey)
        .filter((key): key is string => key != null);
      epicsToCloseKeys = computeEpicsToClose(candidateKeys, unfinishedParentKeys);
    }

    return {
      readyTasks,
      epicsToExplode,
      epicsToClose: epicsToCloseKeys.length,
      epicKeysToClose: epicsToCloseKeys.slice(0, 20),
    };
  }

  async function persistState(input: {
    project: EligibleProject;
    dispatchIssueId: string | null;
    lastPollAt: Date | null;
    counts: ReadyWorkCounts | null;
    fingerprint: string | null;
    decision: DecideDispatchResult | null;
    lastNudgeAt: Date | null;
    lastNudgeWakeId: string | null;
    ack: DispatchAckLike | null;
    lastError: string | null;
    updatedAt: Date;
  }): Promise<void> {
    const { project } = input;
    const insertValues: typeof fleetDispatchState.$inferInsert = {
      projectId: project.id,
      companyId: project.companyId,
      jiraProject: project.jiraProject,
      leadAgentId: project.leadAgentId,
      dispatchIssueId: input.dispatchIssueId,
      lastPollAt: input.lastPollAt,
      readyTasks: input.counts?.readyTasks ?? 0,
      epicsToExplode: input.counts?.epicsToExplode ?? 0,
      epicsToClose: input.counts?.epicsToClose ?? 0,
      epicKeysToClose: input.counts?.epicKeysToClose ?? null,
      countsFingerprint: input.fingerprint,
      lastDecision: input.decision as unknown as Record<string, unknown> | null,
      lastNudgeAt: input.lastNudgeAt,
      lastNudgeWakeId: input.lastNudgeWakeId,
      backoffLevel: input.decision?.nextBackoffLevel ?? 0,
      lastAck: input.ack as unknown as Record<string, unknown> | null,
      lastError: input.lastError,
      updatedAt: input.updatedAt,
    };

    const updateSet: Partial<typeof fleetDispatchState.$inferInsert> = { ...insertValues };
    delete updateSet.projectId;

    await deps.db
      .insert(fleetDispatchState)
      .values(insertValues)
      .onConflictDoUpdate({ target: fleetDispatchState.projectId, set: updateSet });
  }

  async function recordSkip(
    project: { projectId: string; companyId: string; jiraProject: string; leadAgentId: string },
    reason: string,
    updatedAt: Date,
  ): Promise<void> {
    const insertValues: typeof fleetDispatchState.$inferInsert = {
      projectId: project.projectId,
      companyId: project.companyId,
      jiraProject: project.jiraProject,
      leadAgentId: project.leadAgentId,
      lastError: reason,
      updatedAt,
    };
    await deps.db
      .insert(fleetDispatchState)
      .values(insertValues)
      .onConflictDoUpdate({
        target: fleetDispatchState.projectId,
        set: { lastError: reason, updatedAt, jiraProject: project.jiraProject, leadAgentId: project.leadAgentId },
      });
  }

  async function processProject(
    project: EligibleProject,
    mode: FleetDispatchMode,
    params: DispatchServiceParams,
    governor: { state: ThrottleStateLike; stale: boolean; fiveHourPct: number | null; sevenDayPct: number | null; sevenDayResetsAt: string | null; floor5h: number },
    jiraSettings: JiraSettings,
    asOf: Date,
  ): Promise<FleetDispatchProjectOutcome> {
    const existing = await loadExistingState(project.id);

    let counts: ReadyWorkCounts;
    try {
      const jira = await getJiraClientForCompany(project.companyId, jiraSettings);
      counts = await countReadyWork(jira, project);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind =
        err instanceof JiraAuthError
          ? "jira_auth_error"
          : err instanceof JiraTransientError
            ? "jira_transient_error"
            : err instanceof JiraRequestError
              ? "jira_request_error"
              : "jira_error";
      deps.logger.warn({ projectId: project.id, jiraProject: project.jiraProject, kind, err: message }, "fleet dispatch: Jira query failed");
      await recordSkip(
        { projectId: project.id, companyId: project.companyId, jiraProject: project.jiraProject, leadAgentId: project.leadAgentId },
        `${kind}: ${message}`,
        asOf,
      );
      return { projectId: project.id, companyId: project.companyId, jiraProject: project.jiraProject, skipped: true, skipReason: kind, error: message };
    }

    const fingerprint = countsFingerprint(counts);
    const agentBusy = await isAgentBusy(project.leadAgentId);
    const ack =
      existing?.dispatchIssueId && existing.lastNudgeAt
        ? await findAck(existing.dispatchIssueId, existing.lastNudgeAt)
        : null;
    const lastAckAt = ack ? new Date(ack.at) : null;

    const decision = decideDispatch({
      governor: {
        state: governor.state,
        stale: governor.stale,
        fiveHourPct: governor.fiveHourPct,
        floor5h: governor.floor5h,
      },
      projectClass: project.projectClass,
      counts,
      agentBusy,
      lastNudgeAt: existing?.lastNudgeAt ?? null,
      backoffLevel: existing?.backoffLevel ?? 0,
      lastAckAt,
      now: asOf,
      params,
      previousCountsFingerprint: existing?.countsFingerprint ?? null,
    });

    let dispatchIssueId = existing?.dispatchIssueId ?? null;
    let lastNudgeAt = existing?.lastNudgeAt ?? null;
    let lastNudgeWakeId = existing?.lastNudgeWakeId ?? null;
    let nudged = false;

    if (decision.nudge && mode === "enforce") {
      dispatchIssueId = await ensureDispatchIssue(project, dispatchIssueId);

      const fleetDispatch = {
        jiraProject: project.jiraProject,
        readyTasks: counts.readyTasks,
        epicsToExplode: counts.epicsToExplode,
        epicsToClose: counts.epicsToClose,
        epicKeysToClose: counts.epicKeysToClose,
        throttleState: governor.state,
        fiveHourPct: governor.fiveHourPct,
        sevenDayPct: governor.sevenDayPct,
        sevenDayResetsAt: governor.sevenDayResetsAt,
        ackFormat: FLEET_ACK_FORMAT,
      };

      const wakeupResult = await deps.wakeup(project.leadAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "fleet_dispatch",
        payload: { issueId: dispatchIssueId, fleetDispatch },
        contextSnapshot: { issueId: dispatchIssueId, fleetDispatch },
        idempotencyKey: `fleet_dispatch:${project.id}:${isoMinute(asOf)}`,
      });

      const wakeId =
        wakeupResult && typeof wakeupResult === "object" && "id" in (wakeupResult as Record<string, unknown>)
          ? String((wakeupResult as Record<string, unknown>).id)
          : null;

      lastNudgeAt = asOf;
      lastNudgeWakeId = wakeId;
      nudged = true;

      deps.logger.info(
        { projectId: project.id, jiraProject: project.jiraProject, agentId: project.leadAgentId, reason: decision.reason },
        "fleet dispatch: nudged supervisor",
      );
    } else if (decision.nudge) {
      deps.logger.debug(
        { projectId: project.id, jiraProject: project.jiraProject, reason: decision.reason },
        "fleet dispatch: shadow mode — would nudge",
      );
    }

    await persistState({
      project,
      dispatchIssueId,
      lastPollAt: asOf,
      counts,
      // The fingerprint is the counts as of the last nudge, so the policy can tell
      // whether anything moved since; polls between nudges leave it alone.
      fingerprint: nudged || !existing?.countsFingerprint ? fingerprint : existing.countsFingerprint,
      decision,
      lastNudgeAt,
      lastNudgeWakeId,
      ack: ack ?? (existing?.lastAck as unknown as DispatchAckLike | null) ?? null,
      lastError: null,
      updatedAt: asOf,
    });

    return { projectId: project.id, companyId: project.companyId, jiraProject: project.jiraProject, skipped: false, nudged, decision, counts };
  }

  let tickInFlight: Promise<FleetDispatchTickResult> | null = null;

  async function runTick(): Promise<FleetDispatchTickResult> {
    const asOf = now();
    const [mode, params, jiraSettings] = await Promise.all([loadMode(), loadParams(), loadJiraSettings()]);

    if (!jiraSettings) {
      deps.logger.warn({}, "fleet dispatch: no jira settings configured; skipping tick");
      return { ok: true, mode, jiraConfigured: false, projects: [] };
    }

    let discovery: Awaited<ReturnType<typeof discoverEligibleProjects>>;
    try {
      discovery = await discoverEligibleProjects();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error({ err: message }, "fleet dispatch: project discovery failed");
      return { ok: false, mode, jiraConfigured: true, projects: [], error: message };
    }

    for (const skip of discovery.accountIdSkips) {
      deps.logger.warn(
        { projectId: skip.projectId, jiraProject: skip.jiraProject, leadAgentId: skip.leadAgentId },
        "fleet dispatch: lead agent has no adapter_config.jiraAccountId; skipping project",
      );
      await recordSkip(skip, "missing_jira_account_id: lead agent has no adapter_config.jiraAccountId", asOf);
    }

    const governorSvc = getSharedFleetGovernorService({ db: deps.db, logger: deps.logger });
    const governorStatus = await governorSvc.getStatus();
    const latestDecision = governorStatus.latestDecision;
    const decisionTs = latestDecision?.ts ?? null;
    const staleByAge = decisionTs == null || asOf.getTime() - decisionTs.getTime() > governorStatus.params.staleAfterMs;
    const sevenDaySnapshot = governorStatus.snapshots.find((snapshot) => snapshot.window === "seven_day") ?? null;
    const governor = {
      state: (latestDecision?.state as ThrottleStateLike | undefined) ?? "RED",
      stale: staleByAge || (latestDecision?.stale ?? true),
      fiveHourPct: latestDecision?.fiveHourPct ?? null,
      sevenDayPct: latestDecision?.sevenDayPct ?? null,
      sevenDayResetsAt: sevenDaySnapshot?.resetsAt ? sevenDaySnapshot.resetsAt.toISOString() : null,
      floor5h: governorStatus.params.floor5h,
    };

    const outcomes: FleetDispatchProjectOutcome[] = [];
    for (const project of discovery.eligible) {
      const outcome = await processProject(project, mode, params, governor, jiraSettings, asOf);
      outcomes.push(outcome);
    }

    return { ok: true, mode, jiraConfigured: true, projects: outcomes };
  }

  /** Never throws; concurrent calls share one in-flight tick (mirrors governor-service.ts). */
  async function tick(): Promise<FleetDispatchTickResult> {
    if (tickInFlight) return tickInFlight;
    tickInFlight = runTick().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error({ err: message }, "fleet dispatch: tick failed");
      return { ok: false, mode: "shadow" as FleetDispatchMode, jiraConfigured: false, projects: [], error: message };
    });
    try {
      return await tickInFlight;
    } finally {
      tickInFlight = null;
    }
  }

  function start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = async (): Promise<void> => {
      if (stopped) return;
      let intervalMs = DEFAULT_POLL_INTERVAL_MS;
      try {
        intervalMs = (await loadParams()).pollIntervalMs;
      } catch (err) {
        deps.logger.error({ err }, "fleet dispatch: failed to load params while scheduling; using default interval");
      }
      if (stopped) return;
      timer = setTimeout(() => {
        void runAndReschedule();
      }, Math.max(0, intervalMs));
      timer.unref?.();
    };

    const runAndReschedule = async (): Promise<void> => {
      if (stopped) return;
      await tick();
      await scheduleNext();
    };

    void runAndReschedule();

    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

  async function getStatus(): Promise<FleetDispatchStatus> {
    const [mode, params, jiraSettings, states] = await Promise.all([
      loadMode(),
      loadParams(),
      loadJiraSettings(),
      deps.db.select().from(fleetDispatchState).orderBy(desc(fleetDispatchState.updatedAt)),
    ]);
    return { mode, jiraConfigured: jiraSettings != null, params, states };
  }

  return { tick, start, getStatus };
}

const sharedDispatchInstances = new WeakMap<object, FleetDispatchService>();

/**
 * One dispatch service per database handle, mirroring
 * getSharedFleetGovernorService — startup wiring and the HTTP routes must
 * share the same instance so `/api/fleet/dispatch/poll` can't overlap the
 * scheduler's own tick.
 */
export function getSharedFleetDispatchService(deps: FleetDispatchServiceDeps): FleetDispatchService {
  const key = deps.db as unknown as object;
  const existing = sharedDispatchInstances.get(key);
  if (existing) return existing;
  const created = createFleetDispatchService(deps);
  sharedDispatchInstances.set(key, created);
  return created;
}
