/**
 * The fleet dispatch loop's "ready work" definition and nudge decision --
 * pure functions, no I/O. See ./DISPATCH.md for the module contract, the
 * JQL shapes, and the decision rules in prose.
 *
 * The dispatch loop counts what is ready for a supervisor, picks the ONE
 * item a nudge is about ({@link selectAssignment}), and decides, from the
 * governor's throttle state and the project's class, whether it is allowed to
 * nudge that supervisor awake ({@link decideDispatch}). It also parses the
 * supervisor's `fleet-ack:` line ({@link parseFleetAck}) and decides what to
 * do with a declined assignment ({@link decideDeclineReassignment}).
 */

/** Mirrors server/src/services/fleet/types.ts's `ProjectClass` (kept local so this module stays import-free). Sourced from the project's env, key `FLEET_CLASS`; defaults to `P2`. */
export type ProjectClass = "P0" | "P1" | "P2";

export const DEFAULT_READY_STATUSES: readonly string[] = ["To Do", "In Progress"];

/** Escapes a value for a JQL double-quoted string literal (`"`  and `\` per Jira's JQL grammar). */
export function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Builds a JQL `in (...)` list of double-quoted string literals. */
function jqlStringList(values: readonly string[]): string {
  return `(${values.map(jqlQuote).join(", ")})`;
}

/** Builds a JQL `in (...)` list of bare issue keys (keys are not user input -- no quoting needed, but they are validated). */
const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

function jqlKeyList(keys: readonly string[]): string {
  const valid = keys.filter((key) => JIRA_KEY_RE.test(key));
  return `(${valid.join(", ")})`;
}

export interface ReadyWorkJqlInput {
  jiraProject: string;
  jiraAccountId: string;
  /** Overrides the "ready" status names; defaults to {@link DEFAULT_READY_STATUSES}. */
  readyStatuses?: readonly string[];
}

/** JQL for tasks (non-Epic) ready for this supervisor: in a ready status and assigned to them. */
export function readyTasksJql(input: ReadyWorkJqlInput): string {
  const statuses = input.readyStatuses?.length ? input.readyStatuses : DEFAULT_READY_STATUSES;
  return `project = ${jqlQuote(input.jiraProject)} AND issuetype != Epic AND status in ${jqlStringList(statuses)} AND assignee = ${jqlQuote(input.jiraAccountId)}`;
}

/** JQL for Epics ready to be exploded into child work: To Do and assigned to this supervisor. */
export function epicsToExplodeJql(input: Pick<ReadyWorkJqlInput, "jiraProject" | "jiraAccountId">): string {
  return `project = ${jqlQuote(input.jiraProject)} AND issuetype = Epic AND status = "To Do" AND assignee = ${jqlQuote(input.jiraAccountId)}`;
}

/** JQL for Epics that are candidates to close: In Progress and assigned to this supervisor. Candidates still need the child-completeness check below. */
export function epicsToCloseCandidateJql(input: Pick<ReadyWorkJqlInput, "jiraProject" | "jiraAccountId">): string {
  return `project = ${jqlQuote(input.jiraProject)} AND issuetype = Epic AND status = "In Progress" AND assignee = ${jqlQuote(input.jiraAccountId)}`;
}

/**
 * JQL for unfinished children (statusCategory != Done) of a set of candidate
 * epics, by key: `project = P AND parent in (K1,K2,...) AND statusCategory != Done`.
 * Empty `epicKeys` should not be queried -- callers should short-circuit (see
 * dispatch-service.ts, which skips this query and treats every candidate as
 * having zero children when there are no candidates).
 */
export function unfinishedChildrenJql(jiraProject: string, epicKeys: readonly string[]): string {
  return `project = ${jqlQuote(jiraProject)} AND parent in ${jqlKeyList(epicKeys)} AND statusCategory != Done`;
}

/**
 * Given the candidate "In Progress" epics assigned to a supervisor and the
 * set of unfinished-children parent keys returned by
 * {@link unfinishedChildrenJql}, returns the subset of candidate epic keys
 * that have zero unfinished children (including epics with no children at
 * all) -- i.e. the epics ready to close.
 */
export function computeEpicsToClose(
  candidateEpicKeys: readonly string[],
  unfinishedChildParentKeys: readonly string[],
): string[] {
  const hasUnfinishedChild = new Set(unfinishedChildParentKeys);
  return candidateEpicKeys.filter((key) => !hasUnfinishedChild.has(key));
}

export interface ReadyWorkCounts {
  readyTasks: number;
  epicsToExplode: number;
  epicsToClose: number;
  /** Keys of the epics counted in `epicsToClose`, capped by the caller (max 20 per DISPATCH.md). */
  epicKeysToClose: string[];
}

/** A stable fingerprint of the ready-work counts, used to detect "nothing changed since the last nudge" for backoff. */
export function countsFingerprint(counts: Pick<ReadyWorkCounts, "readyTasks" | "epicsToExplode" | "epicsToClose">): string {
  return `${counts.readyTasks}:${counts.epicsToExplode}:${counts.epicsToClose}`;
}

/**
 * The governor's throttle state names. `OPEN | CAPPED | RED | STALE` are what
 * ./policy.ts's `decideThrottle` emits today (see ./types.ts `ThrottleState`);
 * `GREEN | AMBER | ACCELERATE` are the pre-2026-09-27 names, still accepted so
 * old `fleet_throttle_states` rows keep their original meaning below.
 */
export type ThrottleStateLike = "OPEN" | "CAPPED" | "RED" | "STALE" | "GREEN" | "AMBER" | "ACCELERATE";

export interface DispatchGovernorInput {
  state: ThrottleStateLike;
  stale: boolean;
  fiveHourPct: number | null;
  floor5h: number;
}

export type DispatchAssignmentKind = "task" | "epic_explode" | "epic_close";
export type DispatchAckOutcome = "done" | "declined" | "partial";

export interface DispatchAckInput {
  at: Date;
  worked: string;
  /** Only present on the legacy `kind=` ack form. */
  kind?: DispatchAssignmentKind | null;
  outcome: DispatchAckOutcome;
}

/** The ack line the v2 nudge asks for. */
export const FLEET_ACK_FORMAT_V2 = "fleet-ack: worked=<KEY> outcome=<done|declined|partial>";

/**
 * Matches both the v2 ack (`fleet-ack: worked=KEY outcome=X`) and the legacy
 * form with a `kind=` field in between (`fleet-ack: worked=KEY kind=K outcome=X`).
 */
const FLEET_ACK_RE =
  /fleet-ack:\s*worked=(\S+?)\s+(?:kind=(task|epic_explode|epic_close)\s+)?outcome=(done|declined|partial)\b/g;

export interface ParsedFleetAck {
  worked: string;
  kind: DispatchAssignmentKind | null;
  outcome: DispatchAckOutcome;
}

/**
 * Parses the LAST `fleet-ack:` line in `text` (the supervisor is asked to end
 * its reply with it), or null when there is none. Surrounding markdown such as
 * backticks after the outcome is ignored; a key wrapped in backticks/quotes is
 * unwrapped.
 */
export function parseFleetAck(text: string | null | undefined): ParsedFleetAck | null {
  if (!text) return null;
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(FLEET_ACK_RE)) last = match as RegExpExecArray;
  if (!last) return null;
  const worked = last[1]!.replace(/^[`'"*]+|[`'"*,;.]+$/g, "");
  if (!worked) return null;
  return {
    worked,
    kind: (last[2] as DispatchAssignmentKind | undefined) ?? null,
    outcome: last[3] as DispatchAckOutcome,
  };
}

/** True when `key` looks like a Jira issue key (`ABC-123`). */
export function isJiraIssueKey(key: string): boolean {
  return JIRA_KEY_RE.test(key);
}

/** One ready-work candidate as returned by the Jira search (see jira-client.ts `JiraIssueDetail`). */
export interface ReadyIssueCandidate {
  key: string;
  summary: string | null;
  statusName: string | null;
  created: string | null;
  updated: string | null;
}

/** The ONE item a v2 nudge is about. */
export interface DispatchAssignment {
  key: string;
  summary: string;
  status: string;
  kind: DispatchAssignmentKind;
}

function timeOrInfinity(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function taskStatusRank(statusName: string | null): number {
  const normalized = (statusName ?? "").trim().toLowerCase();
  if (normalized === "in progress") return 0;
  if (normalized === "to do") return 1;
  // Any other configured ready status (JIRA_READY_STATUSES override).
  return 2;
}

function compareByTimeThenKey(a: ReadyIssueCandidate, b: ReadyIssueCandidate, field: "created" | "updated"): number {
  const ta = timeOrInfinity(a[field]);
  const tb = timeOrInfinity(b[field]);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.key.localeCompare(b.key, "en", { numeric: true });
}

function toAssignment(candidate: ReadyIssueCandidate, kind: DispatchAssignmentKind): DispatchAssignment {
  return {
    key: candidate.key,
    summary: candidate.summary ?? "",
    status: candidate.statusName ?? "",
    kind,
  };
}

/**
 * Picks the ONE item a nudge is about. Order:
 * 1. tasks in "In Progress", oldest `updated` first;
 * 2. tasks in "To Do", oldest `created` first;
 * 3. tasks in any other configured ready status, oldest `created` first;
 * 4. epics to close (all children done), oldest `created` first;
 * 5. epics to explode, oldest `created` first.
 * Ties break on the issue key (numeric-aware). Returns null when nothing is ready.
 */
export function selectAssignment(input: {
  tasks: readonly ReadyIssueCandidate[];
  epicsToClose: readonly ReadyIssueCandidate[];
  epicsToExplode: readonly ReadyIssueCandidate[];
}): DispatchAssignment | null {
  if (input.tasks.length > 0) {
    const sorted = [...input.tasks].sort((a, b) => {
      const rankDiff = taskStatusRank(a.statusName) - taskStatusRank(b.statusName);
      if (rankDiff !== 0) return rankDiff;
      return compareByTimeThenKey(a, b, taskStatusRank(a.statusName) === 0 ? "updated" : "created");
    });
    return toAssignment(sorted[0]!, "task");
  }
  if (input.epicsToClose.length > 0) {
    const sorted = [...input.epicsToClose].sort((a, b) => compareByTimeThenKey(a, b, "created"));
    return toAssignment(sorted[0]!, "epic_close");
  }
  if (input.epicsToExplode.length > 0) {
    const sorted = [...input.epicsToExplode].sort((a, b) => compareByTimeThenKey(a, b, "created"));
    return toAssignment(sorted[0]!, "epic_explode");
  }
  return null;
}

export interface DeclineReassignTarget {
  accountId: string;
  email: string;
}

export type DeclineReassignmentAction =
  | { action: "reassign"; key: string; toAccountId: string; toEmail: string }
  | { action: "shadow_would_reassign"; key: string; toAccountId: string; toEmail: string }
  | { action: "decline_mismatch"; key: string; currentAssigneeAccountId: string | null }
  | { action: "shadow_decline_mismatch"; key: string; currentAssigneeAccountId: string | null }
  | { action: "skip_no_target"; key: string }
  | { action: "skip_invalid_key"; key: string };

/**
 * What to do about a NEW `outcome=declined` ack, given the declined Jira
 * issue's current assignee (null = unassigned). Only an issue still assigned
 * to the supervisor itself is reassigned; anything else is a mismatch and
 * Jira is left alone. In shadow mode the same verdict is reported with a
 * `shadow_` prefix and nothing is changed.
 */
export function decideDeclineReassignment(input: {
  key: string;
  supervisorAccountId: string;
  currentAssigneeAccountId: string | null;
  target: DeclineReassignTarget | null;
  mode: "shadow" | "enforce";
}): DeclineReassignmentAction {
  const { key } = input;
  if (!isJiraIssueKey(key)) return { action: "skip_invalid_key", key };
  if (!input.target) return { action: "skip_no_target", key };
  if (input.currentAssigneeAccountId !== input.supervisorAccountId) {
    return input.mode === "shadow"
      ? { action: "shadow_decline_mismatch", key, currentAssigneeAccountId: input.currentAssigneeAccountId }
      : { action: "decline_mismatch", key, currentAssigneeAccountId: input.currentAssigneeAccountId };
  }
  return input.mode === "shadow"
    ? { action: "shadow_would_reassign", key, toAccountId: input.target.accountId, toEmail: input.target.email }
    : { action: "reassign", key, toAccountId: input.target.accountId, toEmail: input.target.email };
}

export interface DispatchParams {
  minNudgeGapMs: number;
  /** Backoff delay in ms, indexed by backoff level (0-based, applies once `backoffLevel > 0`). `backoffMs[0]` is the delay while at level 1, etc. */
  backoffMs: readonly number[];
  maxBackoffLevel: number;
}

export const DEFAULT_DISPATCH_PARAMS: DispatchParams = {
  minNudgeGapMs: 15 * 60 * 1000,
  backoffMs: [60 * 60 * 1000, 360 * 60 * 1000],
  maxBackoffLevel: 2,
};

export interface DecideDispatchInput {
  governor: DispatchGovernorInput;
  projectClass: ProjectClass;
  counts: Pick<ReadyWorkCounts, "readyTasks" | "epicsToExplode" | "epicsToClose">;
  /** True when the agent already has a queued or running heartbeat run. */
  agentBusy: boolean;
  lastNudgeAt: Date | null;
  backoffLevel: number;
  /**
   * Timestamp of the most recent `fleet-ack:` comment observed on the
   * dispatch issue (see ./DISPATCH.md), or null if none has ever been seen.
   * An ack "counts" for resetting backoff only when it is at/after
   * `lastNudgeAt` -- an ack left over from an earlier nudge cycle does not
   * excuse a later, un-acked nudge.
   */
  lastAckAt: Date | null;
  /**
   * Outcome of the ack at `lastAckAt`. A `declined` ack does NOT count as an
   * ack for the backoff reset: the decline triggers a reassignment, and that
   * reassignment changing the ready-work counts is what resets backoff.
   * Omitted/null keeps the pre-v2 behavior (any ack counts).
   */
  lastAckOutcome?: DispatchAckOutcome | null;
  now: Date;
  params?: DispatchParams;
  /**
   * Fingerprint of the counts as of the *previous* poll (i.e. what
   * `countsFingerprint` returned last tick, persisted alongside
   * `lastNudgeAt`/`backoffLevel`), used to detect "nothing changed since the
   * last nudge" for backoff escalation. Pass null on the first poll for a
   * project (no escalation is possible with no history to compare against).
   */
  previousCountsFingerprint: string | null;
}

export interface DecideDispatchResult {
  nudge: boolean;
  reason: string;
  nextBackoffLevel: number;
}

/**
 * The dispatch loop's nudge decision. Pure: no I/O, no clock reads (`now`
 * is passed in). See ./DISPATCH.md "Decision rules" for the prose version
 * of every branch below, in the same order they are checked here.
 */
export function decideDispatch(input: DecideDispatchInput): DecideDispatchResult {
  const params = input.params ?? DEFAULT_DISPATCH_PARAMS;
  const { governor, counts, now, lastNudgeAt, lastAckAt } = input;

  const hasWork = counts.readyTasks > 0 || counts.epicsToExplode > 0 || counts.epicsToClose > 0;
  const fingerprint = countsFingerprint(counts);

  const ackedSinceLastNudge =
    lastNudgeAt != null &&
    lastAckAt != null &&
    input.lastAckOutcome !== "declined" &&
    lastAckAt.getTime() >= lastNudgeAt.getTime();
  const countsUnchangedSinceLastNudge =
    input.previousCountsFingerprint != null && input.previousCountsFingerprint === fingerprint;

  // An un-acked nudge whose counts have not moved since it was sent is "stuck".
  // The level rises once per stuck nudge (when the next nudge is sent), never
  // per poll, so the backoff delays hold at any poll interval. An ack (other
  // than a declined one) or a change in the counts resets the level.
  const stuck = lastNudgeAt != null && !ackedSinceLastNudge && countsUnchangedSinceLastNudge;
  let nextBackoffLevel = lastNudgeAt != null && !stuck ? 0 : input.backoffLevel;

  if (!hasWork) {
    return { nudge: false, reason: "no_work: no ready tasks, epics to explode, or epics to close", nextBackoffLevel };
  }

  if (input.agentBusy) {
    return { nudge: false, reason: "agent_busy: the supervisor already has a queued or running run", nextBackoffLevel };
  }

  if (governor.stale) {
    return { nudge: false, reason: "governor_stale: the throttle state is stale; holding new nudges", nextBackoffLevel };
  }

  if (governor.state === "RED") {
    return { nudge: false, reason: "governor_red: the fleet governor is RED; holding new nudges", nextBackoffLevel };
  }

  if (governor.fiveHourPct != null && governor.fiveHourPct >= governor.floor5h) {
    return {
      nudge: false,
      reason: `governor_floor: 5h utilization ${governor.fiveHourPct}% >= floor_5h (${governor.floor5h}%); holding new nudges`,
      nextBackoffLevel,
    };
  }

  if (governor.state === "AMBER" && input.projectClass !== "P0" && input.projectClass !== "P1") {
    return {
      nudge: false,
      reason: `governor_amber: AMBER only nudges P0/P1 projects (this project is ${input.projectClass})`,
      nextBackoffLevel,
    };
  }

  if (lastNudgeAt != null) {
    const elapsedSinceNudge = now.getTime() - lastNudgeAt.getTime();
    if (elapsedSinceNudge < params.minNudgeGapMs) {
      return {
        nudge: false,
        reason: `min_nudge_gap: only ${Math.round(elapsedSinceNudge / 1000)}s since the last nudge (min ${Math.round(params.minNudgeGapMs / 1000)}s)`,
        nextBackoffLevel,
      };
    }
    if (stuck) {
      // Every backoff step has been tried without an ack or any movement --
      // stop nudging until the counts change or someone acks.
      if (input.backoffLevel >= params.maxBackoffLevel) {
        return { nudge: false, reason: "needs_human", nextBackoffLevel };
      }
      const backoffDelay =
        params.backoffMs[Math.min(input.backoffLevel, params.backoffMs.length - 1)] ?? 0;
      if (elapsedSinceNudge < backoffDelay) {
        return {
          nudge: false,
          reason: `backoff: level ${input.backoffLevel}, only ${Math.round(elapsedSinceNudge / 1000)}s since the un-acked nudge (min ${Math.round(backoffDelay / 1000)}s)`,
          nextBackoffLevel,
        };
      }
      nextBackoffLevel = input.backoffLevel + 1;
    }
  }

  return {
    nudge: true,
    reason: `nudge: governor ${governor.state}, project class ${input.projectClass}, ready work present (${fingerprint})`,
    nextBackoffLevel,
  };
}
