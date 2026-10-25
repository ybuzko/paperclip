/**
 * Pure project ordering for fair fleet dispatch. This module has no I/O and
 * reads no clock state; callers pass the observation time to describe nudge
 * recency in the returned log reason.
 */

export type ReadyProject = {
  projectId: string;
  classKey: "P0" | "P1" | "P2" | "P3";
  readyCount: number;
  lastNudgedAt: Date | null;
  spentWeightedUnits: number;
};

export type FairnessParams = { classWeights: Record<string, number> };

export type DispatchOrderEntry = {
  projectId: string;
  virtualSpend: number;
  rank: number;
  reason: string;
};

/** Default virtual-spend weights from the fleet fairness proposal (§6). */
export const DEFAULT_FAIRNESS_PARAMS: FairnessParams = {
  classWeights: { P0: 1, P1: 3, P2: 1, P3: 0.25 },
};

function effectiveClassWeight(classKey: ReadyProject["classKey"], params: FairnessParams): number {
  const weight = params.classWeights[classKey];
  // Invalid or missing weights use a documented neutral scalar so malformed
  // settings cannot produce NaN, negative spend, or divide-by-zero ordering.
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function normalizedSpend(spend: number): number {
  return Number.isFinite(spend) && spend >= 0 ? spend : 0;
}

function virtualSpend(project: ReadyProject, params: FairnessParams): number {
  const spend = normalizedSpend(project.spentWeightedUnits);
  const value = spend / effectiveClassWeight(project.classKey, params);
  return Number.isFinite(value) ? value : Number.MAX_VALUE;
}

function nudgedAtMillis(project: ReadyProject): number | null {
  if (!project.lastNudgedAt) return null;
  const value = project.lastNudgedAt.getTime();
  return Number.isFinite(value) ? value : null;
}

function compareProjectIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReadyProjects(
  left: ReadyProject,
  right: ReadyProject,
  params: FairnessParams,
): number {
  // P0 is an explicit interactive/critical tier and always precedes the
  // weighted background classes. Its class weight still orders P0 projects.
  if (left.classKey === "P0" && right.classKey !== "P0") return -1;
  if (right.classKey === "P0" && left.classKey !== "P0") return 1;

  const leftVirtualSpend = virtualSpend(left, params);
  const rightVirtualSpend = virtualSpend(right, params);
  if (leftVirtualSpend !== rightVirtualSpend) return leftVirtualSpend < rightVirtualSpend ? -1 : 1;

  const leftNudgedAt = nudgedAtMillis(left);
  const rightNudgedAt = nudgedAtMillis(right);
  if (leftNudgedAt == null && rightNudgedAt != null) return -1;
  if (rightNudgedAt == null && leftNudgedAt != null) return 1;
  if (leftNudgedAt != null && rightNudgedAt != null && leftNudgedAt !== rightNudgedAt) {
    return leftNudgedAt < rightNudgedAt ? -1 : 1;
  }

  if (left.readyCount !== right.readyCount) return left.readyCount > right.readyCount ? -1 : 1;
  return compareProjectIds(left.projectId, right.projectId);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ");
}

function nudgeAge(lastNudgedAt: number | null, now: Date): string {
  if (lastNudgedAt == null) return "never nudged";
  const elapsedMs = now.getTime() - lastNudgedAt;
  if (!Number.isFinite(elapsedMs)) return "nudge age unknown";
  if (elapsedMs < 0) return "nudged in the future";
  return `nudged ${formatNumber(elapsedMs / 60_000)}m ago`;
}

/** Order ready projects by their weighted virtual spend and deterministic tie-breaks. */
export function orderProjectsForDispatch(
  ready: ReadyProject[],
  params: FairnessParams,
  now: Date,
): DispatchOrderEntry[] {
  const candidates = ready.filter((project) => Number.isFinite(project.readyCount) && project.readyCount > 0);
  const ordered = [...candidates].sort((left, right) => compareReadyProjects(left, right, params));

  return ordered.map((project, index) => {
    const weight = effectiveClassWeight(project.classKey, params);
    const spend = normalizedSpend(project.spentWeightedUnits);
    const projectVirtualSpend = virtualSpend(project, params);
    const p0Tier = project.classKey === "P0" ? "P0 priority tier; " : "";
    const reason = `${p0Tier}${oneLine(project.projectId)} ${formatNumber(spend)} wu / w${formatNumber(weight)} = ${formatNumber(projectVirtualSpend)} virtual wu; ${project.readyCount} ready; ${nudgeAge(nudgedAtMillis(project), now)}`;

    return {
      projectId: project.projectId,
      virtualSpend: projectVirtualSpend,
      rank: index + 1,
      reason,
    };
  });
}
