import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPATCH_PARAMS,
  computeEpicsToClose,
  countsFingerprint,
  decideDispatch,
  epicsToCloseCandidateJql,
  epicsToExplodeJql,
  jqlQuote,
  readyTasksJql,
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

  it("respects the backoff delay at level 1 (60 min) even after minNudgeGap has passed", () => {
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 30 * 60 * 1000), // 30 min ago: past the 15 min gap, short of 60 min backoff
        backoffLevel: 1,
        // A different fingerprint than the current counts, so this tick does not
        // escalate to needs_human -- it should be gated by the backoff delay instead.
        previousCountsFingerprint: countsFingerprint({ readyTasks: 999, epicsToExplode: 0, epicsToClose: 0 }),
      }),
    );
    expect(result.nudge).toBe(false);
    expect(result.reason).toContain("backoff");
  });

  it("nudges again once the level-1 backoff delay (60 min) has elapsed", () => {
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 61 * 60 * 1000),
        backoffLevel: 1,
        // Counts changed since the last nudge, so this tick does not escalate further.
        previousCountsFingerprint: countsFingerprint({ readyTasks: 99, epicsToExplode: 0, epicsToClose: 0 }),
      }),
    );
    expect(result.nudge).toBe(true);
  });

  it("escalates backoff to level 1 when the previous nudge went unacked and counts are unchanged", () => {
    const fp = countsFingerprint({ readyTasks: 1, epicsToExplode: 0, epicsToClose: 0 });
    const result = decideDispatch(
      baseInput({
        lastNudgeAt: new Date(NOW.getTime() - 61 * 60 * 1000),
        backoffLevel: 0,
        previousCountsFingerprint: fp,
        lastAckAt: null,
      }),
    );
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
    expect(result.nextBackoffLevel).toBe(2);
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
