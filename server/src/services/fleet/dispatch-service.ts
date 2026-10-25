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

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";
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
import { RECOVERY_ORIGIN_KINDS } from "../recovery/origins.js";
import { issueService } from "../issues.js";
import {
  createJiraClient,
  JiraAuthError,
  JiraRequestError,
  JiraTransientError,
  type JiraClient,
  type JiraClientFactory,
  type JiraIssueDetail,
} from "./jira-client.js";
import {
  DEFAULT_DISPATCH_PARAMS,
  DEFAULT_READY_STATUSES,
  FLEET_ACK_FORMAT_V2,
  computeEpicsToClose,
  countsFingerprint,
  decideDeclineReassignment,
  decideDispatch,
  epicsToCloseCandidateJql,
  epicsToExplodeJql,
  isJiraIssueKey,
  parseFleetAck,
  readyTasksJql,
  selectAssignment,
  unfinishedChildrenJql,
  type DecideDispatchResult,
  type DeclineReassignTarget,
  type DispatchAckOutcome,
  type DispatchAssignment,
  type DispatchAssignmentKind,
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
export const DISPATCH_ISSUE_ORIGIN_KIND: string = RECOVERY_ORIGIN_KINDS.fleetDispatch;

/**
 * `fleet-ack:` line format the v2 nudge asks the supervisor to end its reply
 * with. The legacy form with `kind=<...>` between `worked=` and `outcome=` is
 * still accepted (see dispatch-policy.ts `parseFleetAck`).
 */
export const FLEET_ACK_FORMAT = FLEET_ACK_FORMAT_V2;

/** Version of the `context.fleetDispatch` payload this service emits. */
export const FLEET_DISPATCH_PAYLOAD_VERSION = 2;

/** wakeReason for the Jira dispatch nudge (rendered by the adapter as the short dispatch message). */
export const FLEET_DISPATCH_WAKE_REASON = "fleet_dispatch";

/**
 * wakeReason for a wake about a pending Paperclip issue assigned to the
 * supervisor; the adapter renders its generic wake for it, not the short
 * dispatch message.
 */
export const FLEET_PENDING_ISSUE_WAKE_REASON = "fleet_pending_issue";

const PENDING_ISSUE_STATUSES = ["todo", "in_progress"] as const;

/** Max characters of the supervisor's reply quoted into the Jira decline comment. */
const DECLINE_REPLY_EXCERPT_CHARS = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    source: "automation" | "assignment";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    contextSnapshot: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType?: "system";
    requestedByActorId?: string | null;
  },
) => Promise<unknown>;

export interface JiraSettings {
  baseUrl: string;
  email: string;
  tokenSecretId: string;
  /** Jira accountId of the human a declined assignment is reassigned to. Optional; no default. */
  humanAccountId?: string;
  /** Email of that human, shown to the supervisor and in the Jira comment. Optional; no default. */
  humanEmail?: string;
}

/** `declineReassignTo` from the `jira` settings, or null unless both human fields are set. */
export function resolveDeclineReassignTarget(settings: JiraSettings | null): DeclineReassignTarget | null {
  const accountId = typeof settings?.humanAccountId === "string" ? settings.humanAccountId.trim() : "";
  const email = typeof settings?.humanEmail === "string" ? settings.humanEmail.trim() : "";
  return accountId && email ? { accountId, email } : null;
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

export function dispatchIssueDescription(jiraProject: string): string {
  return [
    `This is the standing dispatch issue for the ${jiraProject} Jira project's fleet supervisor.`,
    "",
    "The fleet dispatch loop nudges this supervisor awake when there is ready work assigned to it in Jira and the fleet governor's throttle state allows new work. The server picks the ONE Jira item each nudge is about (tasks In Progress first, then To Do, then epics to close, then epics to explode) and names it in the nudge; work that item, not another one.",
    "",
    "End your reply to the nudge with one line in this exact format so the loop can detect it:",
    "",
    FLEET_ACK_FORMAT,
    "",
    "- <KEY> is the Jira issue key the nudge named (e.g. FT-123).",
    '- outcome is "done" (completed), "partial" (started but not finished), or "declined" (you cannot advance it).',
    '- "declined" means the loop reassigns the Jira issue to the configured human for investigation, with a comment quoting your reply. Say why in your reply.',
    "",
    "The ack is read from your reply to the nudge. An ack comment on this issue in the same format is still accepted as a fallback (the older form with kind=<task|epic_explode|epic_close> before outcome= is accepted too).",
    "",
    "Paperclip issues assigned to you take priority: while you have any in todo or in_progress, the loop wakes you for the oldest of those instead of sending a Jira nudge.",
    "",
    "If a nudge goes un-acked, the loop backs off automatically and eventually stops nudging until a human checks in.",
  ].join("\n");
}

type FleetDispatchStateRow = typeof fleetDispatchState.$inferSelect;

/** Outcome of handling a declined ack, recorded on `last_ack.decline`. */
export interface DeclineHandlingRecord {
  /** dispatch-policy.ts `DeclineReassignmentAction["action"]`, or `"error"`. */
  action: string;
  at: string;
  key: string;
  toAccountId?: string;
  toEmail?: string;
  currentAssigneeAccountId?: string | null;
  error?: string;
  /** True when the error was transient; the same ack is retried on the next tick. */
  retryable?: boolean;
  commentError?: string;
}

/** Persisted as `fleet_dispatch_state.last_ack`. */
export interface DispatchAckLike {
  /**
   * Stable identity of the ack (`run:<heartbeat run id>` or
   * `comment:<issue comment id>`). Decline handling runs once per identity,
   * so it is idempotent across ticks and restarts. Absent on pre-v2 rows.
   */
  id?: string;
  source?: "run_result" | "issue_comment";
  at: string;
  worked: string;
  kind: DispatchAssignmentKind | null;
  outcome: DispatchAckOutcome;
  decline?: DeclineHandlingRecord;
}

interface FoundAck {
  ack: DispatchAckLike;
  /** The text the ack was found in (run result or comment body). */
  replyText: string;
}

/**
 * Persisted as `fleet_dispatch_state.last_decision` (jsonb): the
 * decideDispatch() verdict plus the ticket-selection and Paperclip-priority
 * bookkeeping, so no migration is needed.
 */
export interface DispatchDecisionRecord extends DecideDispatchResult {
  /** The item selected this tick (null when nothing is ready). */
  assignment: DispatchAssignment | null;
  /** The item the last Jira nudge was about; carried forward between nudges. */
  nudgedAssignment: DispatchAssignment | null;
  /** The pending Paperclip issue that took priority this tick, if any. */
  pendingIssue?: { id: string; identifier: string | null } | null;
  /** The last wake sent for a pending Paperclip issue; carried forward. */
  pendingIssueWake?: { issueId: string; identifier: string | null; at: string; runId: string | null } | null;
}

/** The `context.fleetDispatch` payload, version 2 (see the claudeclaw_gateway adapter). */
export interface FleetDispatchPayloadV2 {
  version: 2;
  jiraProject: string;
  assignment: DispatchAssignment | null;
  declineReassignTo?: DeclineReassignTarget;
  throttleState: ThrottleStateLike;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  modelExclusions: string[];
  ackFormat: string;
  readyTasks: number;
  epicsToExplode: number;
  epicsToClose: number;
  epicKeysToClose: string[];
}

export function buildFleetDispatchPayload(input: {
  jiraProject: string;
  assignment: DispatchAssignment | null;
  declineReassignTo: DeclineReassignTarget | null;
  governor: Pick<GovernorView, "state" | "fiveHourPct" | "sevenDayPct" | "sevenDayResetsAt" | "modelExclusions">;
  counts: ReadyWorkCounts;
}): FleetDispatchPayloadV2 {
  return {
    version: FLEET_DISPATCH_PAYLOAD_VERSION,
    jiraProject: input.jiraProject,
    assignment: input.assignment,
    ...(input.declineReassignTo ? { declineReassignTo: input.declineReassignTo } : {}),
    throttleState: input.governor.state,
    fiveHourPct: input.governor.fiveHourPct,
    sevenDayPct: input.governor.sevenDayPct,
    sevenDayResetsAt: input.governor.sevenDayResetsAt,
    modelExclusions: input.governor.modelExclusions,
    ackFormat: FLEET_ACK_FORMAT,
    readyTasks: input.counts.readyTasks,
    epicsToExplode: input.counts.epicsToExplode,
    epicsToClose: input.counts.epicsToClose,
    epicKeysToClose: input.counts.epicKeysToClose,
  };
}

/** e.g. "Oct 14, 2026, 6:53 AM PDT". */
export function formatPacificTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
    .format(date)
    // Newer ICU puts a narrow no-break space before AM/PM; keep Jira text plain.
    .replace(/[\u202f\u00a0]/g, " ");
}

export function declineCommentText(input: {
  agentName: string;
  at: Date;
  toEmail: string;
  replyText: string;
}): string {
  const excerpt = input.replyText.trim().slice(0, DECLINE_REPLY_EXCERPT_CHARS);
  return `Declined by fleet supervisor ${input.agentName} at ${formatPacificTime(input.at)}; reassigned to ${input.toEmail} for investigation. Agent reply: ${excerpt || "(no reply text)"}`;
}

/**
 * Model slugs the governor currently excludes from new launches, lowercased,
 * from the latest `fleet_throttle_states.launch_parameters.excludedModels`
 * (./policy.ts `decideThrottle`: model-scoped weekly buckets at/above
 * `bucketHoldPct`). [] when there is no decision or nothing is excluded.
 */
export function readModelExclusions(launchParameters: unknown): string[] {
  const raw = (launchParameters as { excludedModels?: unknown } | null | undefined)?.excludedModels;
  if (!Array.isArray(raw)) return [];
  const slugs = raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return [...new Set(slugs)];
}

interface GovernorView {
  state: ThrottleStateLike;
  stale: boolean;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  floor5h: number;
  modelExclusions: string[];
}

interface EligibleProject {
  id: string;
  companyId: string;
  env: AgentEnvConfig | null;
  leadAgentId: string;
  leadAgentName: string;
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
  decision?: DispatchDecisionRecord;
  counts?: ReadyWorkCounts;
  assignment?: DispatchAssignment | null;
  /** Set when a pending Paperclip issue took priority over the Jira nudge this tick. */
  pendingIssue?: { id: string; identifier: string | null };
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
        name: agents.name,
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
        leadAgentName: agent.name,
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

  /**
   * Primary ack source: the nudge's own heartbeat run (`last_nudge_wake_id`).
   * Once that run has finished, the supervisor's reply text -- which the
   * claudeclaw_gateway adapter returns as the run `summary`, persisted by
   * heartbeat.ts into `result_json.summary` (and echoed to stdout, so also the
   * tail of `stdout_excerpt`) -- is scanned for a `fleet-ack:` line.
   */
  async function findRunAck(runId: string | null): Promise<FoundAck | null> {
    if (!runId || !UUID_RE.test(runId)) return null;
    const run = await deps.db
      .select({
        id: heartbeatRuns.id,
        finishedAt: heartbeatRuns.finishedAt,
        resultJson: heartbeatRuns.resultJson,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || !run.finishedAt) return null;

    const resultJson = (run.resultJson ?? {}) as Record<string, unknown>;
    const texts = [resultJson.summary, resultJson.result, run.stdoutExcerpt].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    for (const text of texts) {
      const parsed = parseFleetAck(text);
      if (parsed) {
        return {
          ack: {
            id: `run:${run.id}`,
            source: "run_result",
            at: run.finishedAt.toISOString(),
            worked: parsed.worked,
            kind: parsed.kind,
            outcome: parsed.outcome,
          },
          replyText: text,
        };
      }
    }
    return null;
  }

  /** Legacy fallback: most recent `fleet-ack:` comment on the dispatch issue strictly after `afterAt`, or null. */
  async function findCommentAck(dispatchIssueId: string, afterAt: Date): Promise<FoundAck | null> {
    const rows = await deps.db
      .select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt })
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
      const parsed = parseFleetAck(row.body);
      if (parsed) {
        return {
          ack: {
            id: `comment:${row.id}`,
            source: "issue_comment",
            at: row.createdAt.toISOString(),
            worked: parsed.worked,
            kind: parsed.kind,
            outcome: parsed.outcome,
          },
          replyText: row.body,
        };
      }
    }
    return null;
  }

  async function findAck(existing: FleetDispatchStateRow | null): Promise<FoundAck | null> {
    if (!existing?.lastNudgeAt) return null;
    const fromRun = await findRunAck(existing.lastNudgeWakeId ?? null);
    if (fromRun) return fromRun;
    return existing.dispatchIssueId ? await findCommentAck(existing.dispatchIssueId, existing.lastNudgeAt) : null;
  }

  /** Oldest todo/in_progress Paperclip issue assigned to the agent that is not the standing dispatch issue. */
  async function findOldestPendingIssue(
    companyId: string,
    agentId: string,
  ): Promise<{ id: string; identifier: string | null } | null> {
    const rows = await deps.db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agentId),
          inArray(issues.status, [...PENDING_ISSUE_STATUSES]),
          ne(issues.originKind, DISPATCH_ISSUE_ORIGIN_KIND),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Handles a NEW `outcome=declined` ack: if the Jira issue is still assigned
   * to the supervisor, reassign it to `declineReassignTo` and comment why;
   * otherwise record a mismatch. Shadow mode only reads and logs.
   */
  async function handleDecline(
    project: EligibleProject,
    found: FoundAck,
    jira: JiraClient,
    target: DeclineReassignTarget | null,
    mode: FleetDispatchMode,
    asOf: Date,
  ): Promise<DeclineHandlingRecord> {
    const key = found.ack.worked;
    const at = asOf.toISOString();
    const logCtx = { projectId: project.id, jiraProject: project.jiraProject, key, ackId: found.ack.id, mode };

    if (!isJiraIssueKey(key)) {
      deps.logger.warn(logCtx, "fleet dispatch: declined ack names something that is not a Jira issue key; not reassigning");
      return { action: "skip_invalid_key", at, key };
    }
    if (!target) {
      deps.logger.warn(
        logCtx,
        "fleet dispatch: declined ack but jira.humanAccountId/humanEmail are not configured; skipping reassignment",
      );
      return { action: "skip_no_target", at, key };
    }

    try {
      const issue = await jira.getIssue(key, ["assignee"]);
      const assignee = issue.fields.assignee as { accountId?: unknown } | null | undefined;
      const currentAssigneeAccountId = typeof assignee?.accountId === "string" ? assignee.accountId : null;
      const verdict = decideDeclineReassignment({
        key,
        supervisorAccountId: project.jiraAccountId,
        currentAssigneeAccountId,
        target,
        mode,
      });

      switch (verdict.action) {
        case "reassign": {
          await jira.assignIssue(key, verdict.toAccountId);
          let commentError: string | undefined;
          try {
            await jira.addComment(
              key,
              declineCommentText({
                agentName: project.leadAgentName,
                at: new Date(found.ack.at),
                toEmail: verdict.toEmail,
                replyText: found.replyText,
              }),
            );
          } catch (err) {
            commentError = err instanceof Error ? err.message : String(err);
            deps.logger.warn({ ...logCtx, err: commentError }, "fleet dispatch: reassigned declined issue but adding the Jira comment failed");
          }
          deps.logger.info({ ...logCtx, toEmail: verdict.toEmail }, "fleet dispatch: reassigned declined Jira issue to the human");
          return {
            action: "reassigned",
            at,
            key,
            toAccountId: verdict.toAccountId,
            toEmail: verdict.toEmail,
            ...(commentError ? { commentError } : {}),
          };
        }
        case "shadow_would_reassign":
          deps.logger.info(
            { ...logCtx, toEmail: verdict.toEmail },
            "fleet dispatch: shadow mode — would reassign declined Jira issue to the human and comment",
          );
          return { action: verdict.action, at, key, toAccountId: verdict.toAccountId, toEmail: verdict.toEmail };
        case "decline_mismatch":
        case "shadow_decline_mismatch":
          deps.logger.warn(
            { ...logCtx, currentAssigneeAccountId: verdict.currentAssigneeAccountId },
            "fleet dispatch: declined Jira issue is not assigned to the supervisor; leaving Jira unchanged",
          );
          return { action: verdict.action, at, key, currentAssigneeAccountId: verdict.currentAssigneeAccountId };
        default:
          return { action: verdict.action, at, key };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof JiraTransientError;
      deps.logger.warn({ ...logCtx, err: message, retryable }, "fleet dispatch: handling declined ack failed");
      return { action: "error", at, key, error: message, retryable };
    }
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

  async function fetchReadyWork(
    jira: JiraClient,
    project: EligibleProject,
    excludeKeys: ReadonlySet<string>,
  ): Promise<{ counts: ReadyWorkCounts; assignment: DispatchAssignment | null }> {
    const accountId = project.jiraAccountId;
    const notExcluded = (issue: JiraIssueDetail) => !excludeKeys.has(issue.key);
    const [tasks, epicsToExplode, closeCandidates] = await Promise.all([
      jira.searchIssues(
        readyTasksJql({ jiraProject: project.jiraProject, jiraAccountId: accountId, readyStatuses: project.readyStatuses }),
      ),
      jira.searchIssues(epicsToExplodeJql({ jiraProject: project.jiraProject, jiraAccountId: accountId })),
      jira.searchIssues(epicsToCloseCandidateJql({ jiraProject: project.jiraProject, jiraAccountId: accountId })),
    ]).then(([t, e, c]) => [t.filter(notExcluded), e.filter(notExcluded), c.filter(notExcluded)] as const);

    const candidateKeys = closeCandidates.map((issue) => issue.key);
    let epicsToCloseKeys: string[] = [];
    if (candidateKeys.length > 0) {
      const unfinished = await jira.searchKeys(unfinishedChildrenJql(project.jiraProject, candidateKeys), ["key", "parent"]);
      const unfinishedParentKeys = unfinished
        .map((issue) => issue.parentKey)
        .filter((key): key is string => key != null);
      epicsToCloseKeys = computeEpicsToClose(candidateKeys, unfinishedParentKeys);
    }
    const closeKeySet = new Set(epicsToCloseKeys);

    const assignment = selectAssignment({
      tasks,
      epicsToClose: closeCandidates.filter((issue) => closeKeySet.has(issue.key)),
      epicsToExplode,
    });

    return {
      counts: {
        readyTasks: tasks.length,
        epicsToExplode: epicsToExplode.length,
        epicsToClose: epicsToCloseKeys.length,
        epicKeysToClose: epicsToCloseKeys.slice(0, 20),
      },
      assignment,
    };
  }

  async function persistState(input: {
    project: EligibleProject;
    dispatchIssueId: string | null;
    lastPollAt: Date | null;
    counts: ReadyWorkCounts | null;
    fingerprint: string | null;
    decision: DispatchDecisionRecord | null;
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
    lastAck?: DispatchAckLike | null,
  ): Promise<void> {
    const insertValues: typeof fleetDispatchState.$inferInsert = {
      projectId: project.projectId,
      companyId: project.companyId,
      jiraProject: project.jiraProject,
      leadAgentId: project.leadAgentId,
      lastError: reason,
      updatedAt,
      ...(lastAck ? { lastAck: lastAck as unknown as Record<string, unknown> } : {}),
    };
    await deps.db
      .insert(fleetDispatchState)
      .values(insertValues)
      .onConflictDoUpdate({
        target: fleetDispatchState.projectId,
        set: {
          lastError: reason,
          updatedAt,
          jiraProject: project.jiraProject,
          leadAgentId: project.leadAgentId,
          ...(lastAck ? { lastAck: lastAck as unknown as Record<string, unknown> } : {}),
        },
      });
  }

  function wakeIdOf(wakeupResult: unknown): string | null {
    return wakeupResult && typeof wakeupResult === "object" && "id" in (wakeupResult as Record<string, unknown>)
      ? String((wakeupResult as Record<string, unknown>).id)
      : null;
  }

  async function processProject(
    project: EligibleProject,
    mode: FleetDispatchMode,
    params: DispatchServiceParams,
    governor: GovernorView,
    jiraSettings: JiraSettings,
    asOf: Date,
  ): Promise<FleetDispatchProjectOutcome> {
    const existing = await loadExistingState(project.id);
    const previousDecision = (existing?.lastDecision ?? null) as Partial<DispatchDecisionRecord> | null;
    const previousAck = (existing?.lastAck ?? null) as DispatchAckLike | null;
    const declineTarget = resolveDeclineReassignTarget(jiraSettings);
    const skipKey = { projectId: project.id, companyId: project.companyId, jiraProject: project.jiraProject, leadAgentId: project.leadAgentId };

    let jira: JiraClient;
    try {
      jira = await getJiraClientForCompany(project.companyId, jiraSettings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.warn({ projectId: project.id, jiraProject: project.jiraProject, err: message }, "fleet dispatch: Jira client setup failed");
      await recordSkip(skipKey, `jira_error: ${message}`, asOf);
      return { projectId: project.id, companyId: project.companyId, jiraProject: project.jiraProject, skipped: true, skipReason: "jira_error", error: message };
    }

    // 1. Ack for the last nudge (run result first, PIX comment fallback). A
    //    declined ack is handled exactly once per ack identity.
    const found = await findAck(existing);
    let ack: DispatchAckLike | null = null;
    const excludeKeys = new Set<string>();
    if (found) {
      const alreadyProcessed =
        previousAck?.id != null &&
        previousAck.id === found.ack.id &&
        !(previousAck.decline?.action === "error" && previousAck.decline.retryable);
      if (alreadyProcessed) {
        ack = previousAck;
      } else {
        ack = { ...found.ack };
        if (found.ack.outcome === "declined") {
          ack.decline = await handleDecline(project, found, jira, declineTarget, mode, asOf);
          // The issue is no longer this supervisor's; keep it out of this
          // tick's selection even if Jira's search index still lists it.
          if (ack.decline.action === "reassigned") excludeKeys.add(ack.decline.key);
        }
      }
    }
    const lastAckAt = ack ? new Date(ack.at) : null;
    const persistedAck = ack ?? previousAck ?? null;

    // 2. Ready work + the ONE selected item.
    let counts: ReadyWorkCounts;
    let assignment: DispatchAssignment | null;
    try {
      ({ counts, assignment } = await fetchReadyWork(jira, project, excludeKeys));
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
      // Persist a newly processed ack so a decline is not handled twice.
      await recordSkip(skipKey, `${kind}: ${message}`, asOf, ack && ack !== previousAck ? ack : null);
      return { projectId: project.id, companyId: project.companyId, jiraProject: project.jiraProject, skipped: true, skipReason: kind, error: message };
    }

    const fingerprint = countsFingerprint(counts);
    const agentBusy = await isAgentBusy(project.leadAgentId);
    const governorInput = {
      state: governor.state,
      stale: governor.stale,
      fiveHourPct: governor.fiveHourPct,
      floor5h: governor.floor5h,
    };

    let dispatchIssueId = existing?.dispatchIssueId ?? null;
    let lastNudgeAt = existing?.lastNudgeAt ?? null;
    let lastNudgeWakeId = existing?.lastNudgeWakeId ?? null;
    let nudgedAssignment = previousDecision?.nudgedAssignment ?? null;
    let pendingIssueWake = previousDecision?.pendingIssueWake ?? null;
    let nudged = false;
    let decision: DecideDispatchResult;
    let pendingIssue: { id: string; identifier: string | null } | null = null;

    // 3. Paperclip issues assigned to the supervisor take priority over Jira.
    pendingIssue = await findOldestPendingIssue(project.companyId, project.leadAgentId);
    if (pendingIssue) {
      const label = pendingIssue.identifier ?? pendingIssue.id;
      // Same gates as a Jira nudge (busy, governor, AMBER class rule, min
      // nudge gap since the last wake of either kind); no backoff -- the
      // pending issue is real work, not a "ready work" heuristic.
      const lastWakeMs = Math.max(
        lastNudgeAt?.getTime() ?? Number.NEGATIVE_INFINITY,
        pendingIssueWake?.at ? Date.parse(pendingIssueWake.at) : Number.NEGATIVE_INFINITY,
      );
      const gate = decideDispatch({
        governor: governorInput,
        projectClass: project.projectClass,
        counts: { readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 },
        agentBusy,
        lastNudgeAt: Number.isFinite(lastWakeMs) ? new Date(lastWakeMs) : null,
        backoffLevel: 0,
        lastAckAt: null,
        now: asOf,
        params,
        previousCountsFingerprint: null,
      });
      decision = {
        nudge: gate.nudge,
        reason: gate.nudge ? `paperclip_issue_priority: ${label}` : `paperclip_issue_priority: ${label} (held: ${gate.reason})`,
        // The Jira backoff is untouched while a Paperclip issue takes priority.
        nextBackoffLevel: existing?.backoffLevel ?? 0,
      };

      if (gate.nudge && mode === "enforce") {
        const wakeupResult = await deps.wakeup(project.leadAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: FLEET_PENDING_ISSUE_WAKE_REASON,
          payload: { issueId: pendingIssue.id, mutation: FLEET_PENDING_ISSUE_WAKE_REASON },
          contextSnapshot: { issueId: pendingIssue.id, source: "fleet_dispatch.pending_issue" },
          idempotencyKey: `${FLEET_PENDING_ISSUE_WAKE_REASON}:${project.id}:${pendingIssue.id}:${isoMinute(asOf)}`,
          requestedByActorType: "system",
          requestedByActorId: "fleet-dispatch",
        });
        pendingIssueWake = { issueId: pendingIssue.id, identifier: pendingIssue.identifier, at: asOf.toISOString(), runId: wakeIdOf(wakeupResult) };
        nudged = true;
        deps.logger.info(
          { projectId: project.id, jiraProject: project.jiraProject, agentId: project.leadAgentId, issueId: pendingIssue.id, identifier: label },
          "fleet dispatch: woke supervisor for a pending Paperclip issue (Jira nudge skipped)",
        );
      } else if (gate.nudge) {
        deps.logger.debug(
          { projectId: project.id, jiraProject: project.jiraProject, issueId: pendingIssue.id, identifier: label },
          "fleet dispatch: shadow mode — would wake supervisor for a pending Paperclip issue",
        );
      }
    } else {
      // 4. Jira nudge.
      decision = decideDispatch({
        governor: governorInput,
        projectClass: project.projectClass,
        counts,
        agentBusy,
        lastNudgeAt: existing?.lastNudgeAt ?? null,
        backoffLevel: existing?.backoffLevel ?? 0,
        lastAckAt,
        lastAckOutcome: ack?.outcome ?? null,
        now: asOf,
        params,
        previousCountsFingerprint: existing?.countsFingerprint ?? null,
      });

      if (decision.nudge && mode === "enforce") {
        dispatchIssueId = await ensureDispatchIssue(project, dispatchIssueId);
        if (!declineTarget) {
          deps.logger.warn(
            { projectId: project.id, jiraProject: project.jiraProject },
            "fleet dispatch: jira.humanAccountId/humanEmail not configured; nudge carries no declineReassignTo",
          );
        }

        const fleetDispatch = buildFleetDispatchPayload({
          jiraProject: project.jiraProject,
          assignment,
          declineReassignTo: declineTarget,
          governor,
          counts,
        });

        const wakeupResult = await deps.wakeup(project.leadAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: FLEET_DISPATCH_WAKE_REASON,
          payload: { issueId: dispatchIssueId, fleetDispatch },
          contextSnapshot: { issueId: dispatchIssueId, fleetDispatch },
          idempotencyKey: `fleet_dispatch:${project.id}:${isoMinute(asOf)}`,
        });

        lastNudgeAt = asOf;
        lastNudgeWakeId = wakeIdOf(wakeupResult);
        nudgedAssignment = assignment;
        nudged = true;

        deps.logger.info(
          {
            projectId: project.id,
            jiraProject: project.jiraProject,
            agentId: project.leadAgentId,
            reason: decision.reason,
            assignment: assignment?.key ?? null,
          },
          "fleet dispatch: nudged supervisor",
        );
      } else if (decision.nudge) {
        deps.logger.debug(
          { projectId: project.id, jiraProject: project.jiraProject, reason: decision.reason, assignment: assignment?.key ?? null },
          "fleet dispatch: shadow mode — would nudge",
        );
      }
    }

    const jiraNudged = nudged && !pendingIssue;
    const decisionRecord: DispatchDecisionRecord = {
      ...decision,
      assignment,
      nudgedAssignment,
      pendingIssue,
      pendingIssueWake,
    };

    await persistState({
      project,
      dispatchIssueId,
      lastPollAt: asOf,
      counts,
      // The fingerprint is the counts as of the last Jira nudge, so the policy
      // can tell whether anything moved since; polls between nudges leave it alone.
      fingerprint: jiraNudged || !existing?.countsFingerprint ? fingerprint : existing.countsFingerprint,
      decision: decisionRecord,
      lastNudgeAt,
      lastNudgeWakeId,
      ack: persistedAck,
      lastError: null,
      updatedAt: asOf,
    });

    return {
      projectId: project.id,
      companyId: project.companyId,
      jiraProject: project.jiraProject,
      skipped: false,
      nudged,
      decision: decisionRecord,
      counts,
      assignment,
      ...(pendingIssue ? { pendingIssue } : {}),
    };
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
    const governor: GovernorView = {
      state: (latestDecision?.state as ThrottleStateLike | undefined) ?? "STALE",
      stale: staleByAge || (latestDecision?.stale ?? true),
      fiveHourPct: latestDecision?.fiveHourPct ?? null,
      sevenDayPct: latestDecision?.sevenDayPct ?? null,
      sevenDayResetsAt: sevenDaySnapshot?.resetsAt ? sevenDaySnapshot.resetsAt.toISOString() : null,
      floor5h: governorStatus.params.floor5h,
      modelExclusions: readModelExclusions(latestDecision?.launchParameters),
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
