import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAIRNESS_PARAMS,
  orderProjectsForDispatch,
  type FairnessParams,
  type ReadyProject,
} from "./fairness.js";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const params = DEFAULT_FAIRNESS_PARAMS;

function project(overrides: Partial<ReadyProject> & Pick<ReadyProject, "projectId">): ReadyProject {
  return {
    classKey: "P2",
    readyCount: 1,
    lastNudgedAt: null,
    spentWeightedUnits: 0,
    ...overrides,
  };
}

describe("orderProjectsForDispatch", () => {
  it("ranks a new, unnudged project ahead of a project already nudged", () => {
    const result = orderProjectsForDispatch([
      project({ projectId: "active", lastNudgedAt: new Date(NOW.getTime() - 60_000) }),
      project({ projectId: "new" }),
    ], params, NOW);

    expect(result.map(({ projectId }) => projectId)).toEqual(["new", "active"]);
    expect(result[0]?.reason).toContain("never nudged");
  });

  it("changes virtual spend ordering when class weights change", () => {
    const ready = [
      project({ projectId: "P1", classKey: "P1", spentWeightedUnits: 120 }),
      project({ projectId: "P2", classKey: "P2", spentWeightedUnits: 50 }),
    ];
    const defaultOrder = orderProjectsForDispatch(ready, params, NOW);
    const adjustedOrder = orderProjectsForDispatch(ready, {
      classWeights: { ...params.classWeights, P1: 1, P2: 5 },
    }, NOW);

    expect(defaultOrder.map(({ projectId }) => projectId)).toEqual(["P1", "P2"]);
    expect(adjustedOrder.map(({ projectId }) => projectId)).toEqual(["P2", "P1"]);
    expect(defaultOrder[0]?.virtualSpend).toBe(40);
  });

  it("always puts P0 first and uses its scalar only within the P0 tier", () => {
    const ready = [
      project({ projectId: "background", classKey: "P1", spentWeightedUnits: 0 }),
      project({ projectId: "p0-higher", classKey: "P0", spentWeightedUnits: 100 }),
      project({ projectId: "p0-lower", classKey: "P0", spentWeightedUnits: 50 }),
    ];
    const result = orderProjectsForDispatch(ready, params, NOW);

    expect(result.map(({ projectId }) => projectId)).toEqual(["p0-lower", "p0-higher", "background"]);
    expect(result[0]?.reason).toContain("P0 priority tier");
  });

  it("uses oldest nudge first, then ready count, then codepoint project id", () => {
    const tied = [
      project({ projectId: "z", spentWeightedUnits: 20, readyCount: 9, lastNudgedAt: new Date("2026-09-26T10:00:00Z") }),
      project({ projectId: "b", spentWeightedUnits: 20, readyCount: 1, lastNudgedAt: new Date("2026-09-26T09:00:00Z") }),
      project({ projectId: "a", spentWeightedUnits: 20, readyCount: 3, lastNudgedAt: new Date("2026-09-26T10:00:00Z") }),
      project({ projectId: "c", spentWeightedUnits: 20, readyCount: 3, lastNudgedAt: new Date("2026-09-26T10:00:00Z") }),
    ];

    expect(orderProjectsForDispatch(tied, params, NOW).map(({ projectId }) => projectId)).toEqual(["b", "z", "a", "c"]);
  });

  it("excludes projects with no ready work and assigns contiguous ranks", () => {
    const result = orderProjectsForDispatch([
      project({ projectId: "empty", readyCount: 0 }),
      project({ projectId: "ready", readyCount: 2 }),
    ], params, NOW);

    expect(result).toEqual([
      expect.objectContaining({ projectId: "ready", rank: 1 }),
    ]);
  });

  it("is deterministic for equal inputs and does not mutate the input", () => {
    const ready = [
      project({ projectId: "zeta", spentWeightedUnits: 20 }),
      project({ projectId: "alpha", spentWeightedUnits: 20 }),
    ];
    const before = ready.map((entry) => ({ ...entry }));
    const first = orderProjectsForDispatch(ready, params, NOW);
    const second = orderProjectsForDispatch(ready, params, NOW);

    expect(first).toEqual(second);
    expect(first.map(({ projectId }) => projectId)).toEqual(["alpha", "zeta"]);
    expect(ready).toEqual(before);
  });

  it("uses a neutral fallback for nonpositive or nonfinite class weights", () => {
    const invalidParams: FairnessParams = {
      classWeights: { P0: Number.NaN, P1: 0, P2: -1, P3: Number.POSITIVE_INFINITY },
    };
    const result = orderProjectsForDispatch([
      project({ projectId: "weight-one", spentWeightedUnits: 4 }),
      project({ projectId: "weight-invalid", classKey: "P1", spentWeightedUnits: 4 }),
    ], invalidParams, NOW);

    expect(result.map(({ virtualSpend }) => virtualSpend)).toEqual([4, 4]);
  });
});
