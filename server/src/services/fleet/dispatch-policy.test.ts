import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPATCH_PARAMS,
  computeEpicsToClose,
  countsFingerprint,
  decideDeclineReassignment,
  decideDispatch,
  epicsToCloseCandidateJql,
  epicsToExplodeJql,
  jqlQuote,
  parseFleetAck,
  readyTasksJql,
  selectAssignment,
  unfinishedChildrenJql,
  type DecideDispatchInput,
} from "./dispatch-policy.js";

describe("jqlQuote", () => {
  it("wraps in double quotes", () => {
    expect(jqlQuote("To Do")).toBe('"To Do"');
  });

  it("escapes embedded double quotes and backslashes", () => {
    expect(jqlQuote('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });
});

describe("JQL builders", () => {
  it("readyTasksJql builds the default ready-status query", () => {
    expect(readyTasksJql({ jiraProject: "FT", jiraAccountId: "acc-1" })).toBe(
      'project = "FT" AND issuetype != Epic AND status in ("To Do", "In Progress") AND assignee = "acc-1"',
    );
  });

  it("readyTasksJql respects a readyStatuses override", () => {
    expect(
      readyTasksJql({ jiraProject: "FT", jiraAccountId: "acc-1", readyStatuses: ["To Do", "In Review"] }),
    ).toBe('project = "FT" AND issuetype != Epic AND status in ("To Do", "In Review") AND assignee = "acc-1"');
  });

  it("quotes a project key or account id containing special characters", () => {
    expect(readyTasksJql({ jiraProject: 'F"T', jiraAccountId: "acc-1" })).toContain('project = "F\\"T"');
  });

  it("epicsToExplodeJql builds the To Do epic query", () => {
    expect(epicsToExplodeJql({ jiraProject: "FT", jiraAccountId: "acc-1" })).toBe(
      'project = "FT" AND issuetype = Epic AND status = "To Do" AND assignee = "acc-1"',
    );
  });

  it("epicsToCloseCandidateJql builds the In Progress epic query", () => {
    expect(epicsToCloseCandidateJql({ jiraProject: "FT", jiraAccountId: "acc-1" })).toBe(
      'project = "FT" AND issuetype = Epic AND status = "In Progress" AND assignee = "acc-1"',
    );
  });

  it("unfinishedChildrenJql lists parent keys unquoted", () => {
    expect(unfinishedChildrenJql("FT", ["FT-1", "FT-2"])).toBe(
      'project = "FT" AND parent in (FT-1, FT-2) AND statusCategory != Done',
    );
  });

  it("unfinishedChildrenJql drops keys that don't look like Jira issue keys", () => {
    expect(unfinishedChildrenJql("FT", ["FT-1", "not a key", "DROP TABLE"])).toBe(
      'project = "FT" AND parent in (FT-1) AND statusCategory != Done',
    );
  });
});

describe("computeEpicsToClose", () => {
  it("returns candidates with zero unfinished children, including epics with no children at all", () => {
    expect(computeEpicsToClose(["FT-1", "FT-2", "FT-3"], ["FT-2"])).toEqual(["FT-1", "FT-3"]);
  });

  it("returns nothing when every candidate has an unfinished child", () => {
    expect(computeEpicsToClose(["FT-1", "FT-2"], ["FT-1", "FT-2"])).toEqual([]);
  });

  it("returns every candidate when none have unfinished children", () => {
    expect(computeEpicsToClose(["FT-1", "FT-2"], [])).toEqual(["FT-1", "FT-2"]);
  });
});

describe("countsFingerprint", () => {
  it("is stable for equal counts and differs for different counts", () => {
    expect(countsFingerprint({ readyTasks: 1, epicsToExplode: 2, epicsToClose: 3 })).toBe(
      countsFingerprint({ readyTasks: 1, epicsToExplode: 2, epicsToClose: 3 }),
    );
    expect(countsFingerprint({ readyTasks: 1, epicsToExplode: 2, epicsToClose: 3 })).not.toBe(
      countsFingerprint({ readyTasks: 1, epicsToExplode: 2, epicsToClose: 4 }),
    );
  });
});

const NOW = new Date("2026-01-01T12:00:00.000Z");

function baseInput(overrides: Partial<DecideDispatchInput> = {}): DecideDispatchInput {
  return {
    governor: { state: "GREEN", stale: false, fiveHourPct: 10, floor5h: 80 },
    projectClass: "P2",
    counts: { readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 },
    agentBusy: false,
    lastNudgeAt: null,
    backoffLevel: 0,
    lastAckAt: null,
    now: NOW,
    previousCountsFingerprint: null,
    ...overrides,
  };
}

describe("decideDispatch", () => {
  it("does not nudge when there is no work", () => {
    const result = decideDispatch(
      baseInput({ counts: { readyTasks: 0, epicsToExplode: 0, epicsToClose: 0 } }),
    );
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("no_work");
  });

  it("nudges when only epicsToExplode is nonzero", () => {
    const result = decideDispatch(
      baseInput({ counts: { readyTasks: 0, epicsToExplode: 1, epicsToClose: 0 } }),
    );
    expect(result.nudge).toBe(true);
  });

  it("nudges when only epicsToClose is nonzero", () => {
    const result = decideDispatch(
      baseInput({ counts: { readyTasks: 0, epicsToExplode: 0, epicsToClose: 1 } }),
    );
    expect(result.nudge).toBe(true);
  });

  it("does not nudge when the agent is busy", () => {
    const result = decideDispatch(baseInput({ agentBusy: true }));
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("agent_busy");
  });

  it("does not nudge when the governor is stale", () => {
    const result = decideDispatch(baseInput({ governor: { state: "GREEN", stale: true, fiveHourPct: 10, floor5h: 80 } }));
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("governor_stale");
  });

  it("does not nudge when the governor is RED", () => {
    const result = decideDispatch(baseInput({ governor: { state: "RED", stale: false, fiveHourPct: 50, floor5h: 80 } }));
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("governor_red");
  });

  it("does not nudge when 5h utilization is at/above the floor, even in GREEN", () => {
    const result = decideDispatch(
      baseInput({ governor: { state: "GREEN", stale: false, fiveHourPct: 85, floor5h: 80 } }),
    );
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("governor_floor");
  });

  it("AMBER nudges P0", () => {
    const result = decideDispatch(
      baseInput({ projectClass: "P0", governor: { state: "AMBER", stale: false, fiveHourPct: 10, floor5h: 80 } }),
    );
    expect(result.nudge).toBe(true);
  });

  it("AMBER nudges P1", () => {
    const result = decideDispatch(
      baseInput({ projectClass: "P1", governor: { state: "AMBER", stale: false, fiveHourPct: 10, floor5h: 80 } }),
    );
    expect(result.nudge).toBe(true);
  });

  it("AMBER does not nudge P2", () => {
    const result = decideDispatch(
      baseInput({ projectClass: "P2", governor: { state: "AMBER", stale: false, fiveHourPct: 10, floor5h: 80 } }),
    );
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("governor_amber");
  });

  it("GREEN nudges P2", () => {
    const result = decideDispatch(baseInput({ projectClass: "P2", governor: { state: "GREEN", stale: false, fiveHourPct: 10, floor5h: 80 } }));
    expect(result.nudge).toBe(true);
  });

  it("ACCELERATE nudges P2", () => {
    const result = decideDispatch(
      baseInput({ projectClass: "P2", governor: { state: "ACCELERATE", stale: false, fiveHourPct: 10, floor5h: 80 } }),
    );
    expect(result.nudge).toBe(true);
  });

  it("does not nudge before minNudgeGapMs has elapsed since the last nudge", () => {
    const result = decideDispatch(
      baseInput({ lastNudgeAt: new Date(NOW.getTime() - 5 * 60 * 1000) }),
    );
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("min_nudge_gap");
  });

  it("nudges again once minNudgeGapMs has elapsed with backoffLevel 0", () => {
    const result = decideDispatch(
      baseInput({ lastNudgeAt: new Date(NOW.getTime() - 16 * 60 * 1000) }),
    );
    expect(result.nudge).toBe(true);
  });

  it("holds a stuck level-0 nudge for the first backoff delay (60 min) without escalating per poll", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 30 * 60 * 1000), // past the 15 min gap, short of the 60 min backoff
        backoffLevel: 0,
        previousCountsFingerprint: fp,
      }),
    );
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("backoff");
    expect(result.nextBackoffLevel).toBe(0);
  });

  it("holds a stuck level-1 nudge for the second backoff delay (6 h)", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 61 * 60 * 1000),
        backoffLevel: 1,
        previousCountsFingerprint: fp,
      }),
    );
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("backoff");
    expect(result.nextBackoffLevel).toBe(1);
  });

  it("nudges again and resets the level once the counts change", () => {
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 61 * 60 * 1000),
        backoffLevel: 1,
        // Counts changed since the last nudge, so this tick does not escalate further.
        previousCountsFingerprint: countsFingerprint({ readyTasks: 99, epicsToExplode: 0, epicsToClose: 0 }),
      }),
    );
    expect(result.nudge).toBe(true);
    expect(result.nextBackoffLevel).toBe(0);
  });

  it("re-nudges and escalates to level 1 once a stuck nudge has waited out the first backoff delay", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 61 * 60 * 1000),
        backoffLevel: 0,
        previousCountsFingerprint: fp,
        lastAckAt: null,
      }),
    );
    expect(result.nudge).toBe(true);
    expect(result.nextBackoffLevel).toBe(1);
  });

  it("does not escalate backoff when the counts changed since the last nudge", () => {
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 61 * 60 * 1000),
        backoffLevel: 0,
        previousCountsFingerprint: countsFingerprint({ readyTasks: 999, epicsToExplode: 0, epicsToClose: 0 }),
        lastAckAt: null,
      }),
    );
    expect(result.nextBackoffLevel).toBe(0);
  });

  it("does not escalate backoff when an ack landed after the last nudge", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const lastNudgeAt = new Date(NOW.getTime() - 61 * 60 * 1000);
    const result = decideDispatch(
      baseInput({
        lastNudgeAt,
        backoffLevel: 1,
        previousCountsFingerprint: fp,
        lastAckAt: new Date(lastNudgeAt.getTime() + 60 * 1000),
      }),
    );
    expect(result.nextBackoffLevel).toBe(0);
  });

  it("does not reset backoff when the only ack on record predates the last nudge", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const lastNudgeAt = new Date(NOW.getTime() - 61 * 60 * 1000);
    const result = decideDispatch(
      baseInput({
        lastNudgeAt,
        backoffLevel: 1,
        previousCountsFingerprint: fp,
        lastAckAt: new Date(lastNudgeAt.getTime() - 60 * 1000), // before the nudge, stale ack
      }),
    );
    expect(result.nextBackoffLevel).toBe(1);
  });

  it("caps backoff escalation at maxBackoffLevel and reports needs_human once capped and still stuck", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 400 * 60 * 1000),
        backoffLevel: DEFAULT_DISPATCH_PARAMS.maxBackoffLevel,
        previousCountsFingerprint: fp,
        lastAckAt: null,
      }),
    );
    expect(result.nextBackoffLevel).toBe(DEFAULT_DISPATCH_PARAMS.maxBackoffLevel);
    expect(result.nudge).toBe(false);
    expect(result.reason).toBe("needs_human");
  });

  it("recovers from needs_human once the counts change", () => {
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 400 * 60 * 1000),
        backoffLevel: DEFAULT_DISPATCH_PARAMS.maxBackoffLevel,
        previousCountsFingerprint: countsFingerprint({ readyTasks: 42, epicsToExplode: 0, epicsToClose: 0 }),
        lastAckAt: null,
      }),
    );
    expect(result.nudge).toBe(true);
  });

  it("recovers from needs_human once acked", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const lastNudgeAt = new Date(NOW.getTime() - 400 * 60 * 1000);
    const result = decideDispatch(
      baseInput({
        lastNudgeAt,
        backoffLevel: DEFAULT_DISPATCH_PARAMS.maxBackoffLevel,
        previousCountsFingerprint: fp,
        lastAckAt: new Date(lastNudgeAt.getTime() + 1000),
      }),
    );
    expect(result.nextBackoffLevel).toBe(0);
    expect(result.nudge).toBe(true);
  });

  it("nudges immediately on the very first poll for a project (no lastNudgeAt)", () => {
    const result = decideDispatch(baseInput({ lastNudgeAt: null, backoffLevel: 0, previousCountsFingerprint: null }));
    expect(result.nudge).toBe(true);
  });
});

describe("decideDispatch with a declined ack", () => {
  it("does not reset backoff on a declined ack when the counts are unchanged", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const lastNudgeAt = new Date(NOW.getTime() - 61 * 60 * 1000);
    const result = decideDispatch(
      baseInput({
        lastNudgeAt,
        backoffLevel: 1,
        previousCountsFingerprint: fp,
        lastAckAt: new Date(lastNudgeAt.getTime() + 60 * 1000),
        lastAckOutcome: "declined",
      }),
    );
    expect(result.nextBackoffLevel).toBe(1);
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("backoff");
  });

  it("resets backoff after a declined ack once the counts change (the reassignment moved them)", () => {
    const lastNudgeAt = new Date(NOW.getTime() - 61 * 60 * 1000);
    const result = decideDispatch(
      baseInput({
        lastNudgeAt,
        backoffLevel: 1,
        previousCountsFingerprint: countsFingerprint({ readyTasks: 2, epicsToExplode: 0, epicsToClose: 0 }),
        lastAckAt: new Date(lastNudgeAt.getTime() + 60 * 1000),
        lastAckOutcome: "declined",
      }),
    );
    expect(result.nextBackoffLevel).toBe(0);
    expect(result.nudge).toBe(true);
  });

  it("still resets backoff on a done or partial ack", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const lastNudgeAt = new Date(NOW.getTime() - 61 * 60 * 1000);
    for (const outcome of ["done", "partial"] as const) {
      const result = decideDispatch(
        baseInput({
          lastNudgeAt,
          backoffLevel: 1,
          previousCountsFingerprint: fp,
          lastAckAt: new Date(lastNudgeAt.getTime() + 60 * 1000),
          lastAckOutcome: outcome,
        }),
      );
      expect(result.nextBackoffLevel).toBe(0);
    }
  });

  it("nudges under OPEN, holds under CAPPED (weekly cap schedule) and STALE", () => {
    expect(decideDispatch(baseInput({ governor: { state: "OPEN", stale: false, fiveHourPct: 10, floor5h: 80 } })).nudge).toBe(true);
    const capped = decideDispatch(baseInput({ governor: { state: "CAPPED", stale: false, fiveHourPct: 10, floor5h: 80 } }));
    expect(capped.nudge).toBe(false);
    expect(capped.reason).toMatch(/^governor_capped/);
    expect(decideDispatch(baseInput({ governor: { state: "STALE", stale: true, fiveHourPct: 10, floor5h: 80 } })).nudge).toBe(false);
  });
});

describe("parseFleetAck", () => {
  it("parses the v2 form", () => {
    expect(parseFleetAck("Done.\nfleet-ack: worked=GAME-53 outcome=done")).toEqual({
      worked: "GAME-53",
      kind: null,
      outcome: "done",
    });
  });

  it("parses the legacy kind= form", () => {
    expect(parseFleetAck("fleet-ack: worked=FT-1 kind=epic_close outcome=partial")).toEqual({
      worked: "FT-1",
      kind: "epic_close",
      outcome: "partial",
    });
  });

  it("takes the last ack line when there are several", () => {
    expect(
      parseFleetAck("fleet-ack: worked=FT-1 outcome=done\nmore text\nfleet-ack: worked=FT-2 outcome=declined")?.worked,
    ).toBe("FT-2");
  });

  it("ignores surrounding markdown", () => {
    expect(parseFleetAck("`fleet-ack: worked=`FT-3` outcome=declined`")).toEqual({
      worked: "FT-3",
      kind: null,
      outcome: "declined",
    });
  });

  it("returns null for no ack, an unknown outcome, or empty input", () => {
    expect(parseFleetAck("all good")).toBeNull();
    expect(parseFleetAck("fleet-ack: worked=FT-1 outcome=maybe")).toBeNull();
    expect(parseFleetAck("fleet-ack: worked=FT-1 kind=bogus outcome=done")).toBeNull();
    expect(parseFleetAck(null)).toBeNull();
    expect(parseFleetAck("")).toBeNull();
  });
});

describe("selectAssignment", () => {
  const issue = (key: string, statusName: string, created: string | null, updated: string | null = null) => ({
    key,
    summary: `S ${key}`,
    statusName,
    created,
    updated,
  });

  it("picks In Progress tasks first, oldest updated first", () => {
    expect(
      selectAssignment({
        tasks: [
          issue("FT-1", "To Do", "2025-01-01T00:00:00Z"),
          issue("FT-2", "In Progress", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"),
          issue("FT-3", "In Progress", "2026-02-01T00:00:00Z", "2026-02-15T00:00:00Z"),
        ],
        epicsToClose: [issue("FT-9", "In Progress", "2020-01-01T00:00:00Z")],
        epicsToExplode: [],
      }),
    ).toEqual({ key: "FT-3", summary: "S FT-3", status: "In Progress", kind: "task" });
  });

  it("then To Do tasks, oldest created first", () => {
    expect(
      selectAssignment({
        tasks: [
          issue("FT-5", "To Do", "2026-02-01T00:00:00Z", "2020-01-01T00:00:00Z"),
          issue("FT-4", "To Do", "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z"),
        ],
        epicsToClose: [],
        epicsToExplode: [],
      })?.key,
    ).toBe("FT-4");
  });

  it("puts other configured ready statuses after To Do", () => {
    expect(
      selectAssignment({
        tasks: [issue("FT-6", "In Review", "2020-01-01T00:00:00Z"), issue("FT-7", "To Do", "2026-01-01T00:00:00Z")],
        epicsToClose: [],
        epicsToExplode: [],
      })?.key,
    ).toBe("FT-7");
  });

  it("then epics to close, then epics to explode", () => {
    expect(
      selectAssignment({
        tasks: [],
        epicsToClose: [issue("FT-20", "In Progress", "2026-02-01T00:00:00Z"), issue("FT-21", "In Progress", "2026-01-01T00:00:00Z")],
        epicsToExplode: [issue("FT-30", "To Do", "2020-01-01T00:00:00Z")],
      }),
    ).toEqual({ key: "FT-21", summary: "S FT-21", status: "In Progress", kind: "epic_close" });
    expect(
      selectAssignment({ tasks: [], epicsToClose: [], epicsToExplode: [issue("FT-30", "To Do", "2020-01-01T00:00:00Z")] }),
    ).toMatchObject({ key: "FT-30", kind: "epic_explode" });
  });

  it("sorts missing timestamps last and breaks ties on the key", () => {
    expect(
      selectAssignment({
        tasks: [issue("FT-10", "To Do", null), issue("FT-9", "To Do", "2026-01-01T00:00:00Z"), issue("FT-8", "To Do", "2026-01-01T00:00:00Z")],
        epicsToClose: [],
        epicsToExplode: [],
      })?.key,
    ).toBe("FT-8");
  });

  it("returns null when nothing is ready", () => {
    expect(selectAssignment({ tasks: [], epicsToClose: [], epicsToExplode: [] })).toBeNull();
  });
});

describe("decideDeclineReassignment", () => {
  const target = { accountId: "human-acc", email: "human@example.com" };

  it("reassigns when the issue is still assigned to the supervisor", () => {
    expect(
      decideDeclineReassignment({ key: "FT-1", supervisorAccountId: "acc-1", currentAssigneeAccountId: "acc-1", target, mode: "enforce" }),
    ).toEqual({ action: "reassign", key: "FT-1", toAccountId: "human-acc", toEmail: "human@example.com" });
  });

  it("reports a mismatch when assigned to someone else or unassigned", () => {
    expect(
      decideDeclineReassignment({ key: "FT-1", supervisorAccountId: "acc-1", currentAssigneeAccountId: "other", target, mode: "enforce" }),
    ).toEqual({ action: "decline_mismatch", key: "FT-1", currentAssigneeAccountId: "other" });
    expect(
      decideDeclineReassignment({ key: "FT-1", supervisorAccountId: "acc-1", currentAssigneeAccountId: null, target, mode: "enforce" }),
    ).toEqual({ action: "decline_mismatch", key: "FT-1", currentAssigneeAccountId: null });
  });

  it("only reports in shadow mode", () => {
    expect(
      decideDeclineReassignment({ key: "FT-1", supervisorAccountId: "acc-1", currentAssigneeAccountId: "acc-1", target, mode: "shadow" }).action,
    ).toBe("shadow_would_reassign");
    expect(
      decideDeclineReassignment({ key: "FT-1", supervisorAccountId: "acc-1", currentAssigneeAccountId: "other", target, mode: "shadow" }).action,
    ).toBe("shadow_decline_mismatch");
  });

  it("skips without a configured human or with a non-key", () => {
    expect(
      decideDeclineReassignment({ key: "FT-1", supervisorAccountId: "acc-1", currentAssigneeAccountId: "acc-1", target: null, mode: "enforce" }).action,
    ).toBe("skip_no_target");
    expect(
      decideDeclineReassignment({ key: "none", supervisorAccountId: "acc-1", currentAssigneeAccountId: "acc-1", target, mode: "enforce" }).action,
    ).toBe("skip_invalid_key");
  });
});
