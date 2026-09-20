/**
 * The fleet dispatch loop's "ready work" definition and nudge decision --
 * pure functions, no I/O. See ./DISPATCH.md for the module contract, the
 * JQL shapes, and the decision rules in prose.
 *
 * The dispatch loop never chooses tickets; it only counts what is ready for
 * a supervisor and decides, from the governor's throttle state and the
 * project's class, whether it is allowed to nudge that supervisor awake.
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

export type ThrottleStateLike = "GREEN" | "AMBER" | "RED" | "ACCELERATE";

export interface DispatchGovernorInput {
  state: ThrottleStateLike;
  stale: boolean;
  fiveHourPct: number | null;
  floor5h: number;
}

export interface DispatchAckInput {
  at: Date;
  worked: string;
  kind: "task" | "epic_explode" | "epic_close";
  outcome: "done" | "declined" | "partial";
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
    lastNudgeAt != null && lastAckAt != null && lastAckAt.getTime() >= lastNudgeAt.getTime();
  const countsUnchangedSinceLastNudge =
    input.previousCountsFingerprint != null && input.previousCountsFingerprint === fingerprint;

  // Backoff bookkeeping happens regardless of whether we nudge this tick: an
  // ack (after the last nudge) always resets the level; otherwise it
  // escalates only when the previous nudge produced no ack AND the counts
  // fingerprint hasn't changed since.
  let nextBackoffLevel = input.backoffLevel;
  if (ackedSinceLastNudge) {
    nextBackoffLevel = 0;
  } else if (lastNudgeAt != null && countsUnchangedSinceLastNudge) {
    nextBackoffLevel = Math.min(params.maxBackoffLevel, input.backoffLevel + 1);
  }

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

  // At the cap, a further un-acked, unchanged-counts poll needs a human --
  // the loop stops nudging until the counts change or someone acks.
  if (
    nextBackoffLevel >= params.maxBackoffLevel &&
    lastNudgeAt != null &&
    !ackedSinceLastNudge &&
    countsUnchangedSinceLastNudge
  ) {
    return { nudge: false, reason: "needs_human", nextBackoffLevel };
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
    if (input.backoffLevel > 0) {
      const backoffDelay =
        params.backoffMs[Math.min(input.backoffLevel, params.backoffMs.length) - 1] ??
        params.backoffMs[params.backoffMs.length - 1] ??
        0;
      if (elapsedSinceNudge < backoffDelay) {
        return {
          nudge: false,
          reason: `backoff: at level ${input.backoffLevel}, only ${Math.round(elapsedSinceNudge / 1000)}s since the last nudge (min ${Math.round(backoffDelay / 1000)}s)`,
          nextBackoffLevel,
        };
      }
    }
  }

  return {
    nudge: true,
    reason: `nudge: governor ${governor.state}, project class ${input.projectClass}, ready work present (${fingerprint})`,
    nextBackoffLevel,
  };
}
