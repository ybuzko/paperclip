import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, fleetDispatchState, fleetLimitSnapshots, fleetThrottleStates } from "@paperclipai/db";

/**
 * Fleet health for external monitors (Uptime Kuma, blackbox probes).
 *
 * The ordinary /api/health answers "the process is up", which stayed green
 * through the 2026-10-26 → 11-01 freeze. This check answers "is the fleet
 * actually able to work": sensing is fresh, the governor is not parked in
 * STALE, no agent is stuck in error, and the dispatch loop is ticking. The
 * body carries states, ages and agent names only: no usage percentages, no
 * credentials, nothing an anonymous caller should not see.
 */

export interface FleetHealthThresholds {
  /** Latest successful sensing snapshot may be at most this old. */
  sensingMaxAgeMs: number;
  /** A STALE governor decision may persist at most this long before it is an incident. */
  staleHoldMaxMs: number;
  /** An agent may sit in `error` status at most this long. */
  agentErrorMaxMs: number;
  /** The dispatch loop must have updated some project's state within this window. */
  dispatchMaxAgeMs: number;
}

export const DEFAULT_FLEET_HEALTH_THRESHOLDS: FleetHealthThresholds = {
  sensingMaxAgeMs: 15 * 60 * 1000,
  staleHoldMaxMs: 60 * 60 * 1000,
  agentErrorMaxMs: 15 * 60 * 1000,
  dispatchMaxAgeMs: 5 * 60 * 1000,
};

export interface FleetHealthInputs {
  /** observed_at of the newest ok=true seven_day snapshot, or null if none. */
  lastSensingOkAt: Date | null;
  /** Newest governor decision row: its state and when that state began. */
  governor: { state: string; since: Date } | null;
  /** Agents in `error` status (not paused) with when they last changed. */
  agentsInError: Array<{ name: string; since: Date }>;
  /** Newest fleet_dispatch_state.updated_at, or null when the loop has no projects. */
  lastDispatchTickAt: Date | null;
}

export interface FleetHealthReport {
  status: "ok" | "unhealthy";
  checkedAt: string;
  reasons: string[];
  checks: {
    sensing: { ok: boolean; ageSeconds: number | null };
    governor: { ok: boolean; state: string | null; forSeconds: number | null };
    agents: { ok: boolean; inError: string[] };
    dispatch: { ok: boolean; ageSeconds: number | null };
  };
}

function ageSeconds(from: Date | null, now: Date): number | null {
  if (!from) return null;
  return Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
}

export function evaluateFleetHealth(
  input: FleetHealthInputs,
  now: Date,
  thresholds: FleetHealthThresholds = DEFAULT_FLEET_HEALTH_THRESHOLDS,
): FleetHealthReport {
  const reasons: string[] = [];

  const sensingAge = ageSeconds(input.lastSensingOkAt, now);
  const sensingOk = sensingAge !== null && sensingAge * 1000 <= thresholds.sensingMaxAgeMs;
  if (!sensingOk) {
    reasons.push(
      sensingAge === null
        ? "sensing: no successful usage snapshot recorded"
        : `sensing: last successful usage snapshot is ${sensingAge}s old`,
    );
  }

  const governorFor = ageSeconds(input.governor?.since ?? null, now);
  const governorState = input.governor?.state ?? null;
  const governorOk =
    governorState !== null &&
    (governorState !== "STALE" || (governorFor !== null && governorFor * 1000 <= thresholds.staleHoldMaxMs));
  if (!governorOk) {
    reasons.push(
      governorState === null
        ? "governor: no decision recorded"
        : `governor: STALE for ${governorFor}s`,
    );
  }

  const stuck = input.agentsInError.filter(
    (agent) => now.getTime() - agent.since.getTime() > thresholds.agentErrorMaxMs,
  );
  const agentsOk = stuck.length === 0;
  if (!agentsOk) {
    reasons.push(`agents: in error status: ${stuck.map((agent) => agent.name).join(", ")}`);
  }

  const dispatchAge = ageSeconds(input.lastDispatchTickAt, now);
  // No dispatch rows means no dispatch-eligible project is configured; that is
  // not a fault of the loop, so it passes.
  const dispatchOk = dispatchAge === null || dispatchAge * 1000 <= thresholds.dispatchMaxAgeMs;
  if (!dispatchOk) {
    reasons.push(`dispatch: loop last updated project state ${dispatchAge}s ago`);
  }

  return {
    status: reasons.length === 0 ? "ok" : "unhealthy",
    checkedAt: now.toISOString(),
    reasons,
    checks: {
      sensing: { ok: sensingOk, ageSeconds: sensingAge },
      governor: { ok: governorOk, state: governorState, forSeconds: governorFor },
      agents: { ok: agentsOk, inError: stuck.map((agent) => agent.name) },
      dispatch: { ok: dispatchOk, ageSeconds: dispatchAge },
    },
  };
}

export async function loadFleetHealthInputs(db: Db, now: Date = new Date()): Promise<FleetHealthInputs> {
  // Bounded lookback keeps the snapshot scan cheap; anything older is unhealthy anyway.
  const lookback = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [sensingRow] = await db
    .select({ observedAt: fleetLimitSnapshots.observedAt })
    .from(fleetLimitSnapshots)
    .where(
      and(
        eq(fleetLimitSnapshots.ok, true),
        eq(fleetLimitSnapshots.window, "seven_day"),
        gt(fleetLimitSnapshots.observedAt, lookback),
      ),
    )
    .orderBy(desc(fleetLimitSnapshots.observedAt))
    .limit(1);

  // Throttle rows are appended only when the decision changes, so the newest
  // row's ts is when the current state began.
  const [governorRow] = await db
    .select({ state: fleetThrottleStates.state, ts: fleetThrottleStates.ts })
    .from(fleetThrottleStates)
    .orderBy(desc(fleetThrottleStates.ts))
    .limit(1);

  const errorAgents = await db
    .select({ name: agents.name, updatedAt: agents.updatedAt })
    .from(agents)
    .where(eq(agents.status, "error"));

  const [dispatchRow] = await db
    .select({ updatedAt: sql<Date | null>`max(${fleetDispatchState.updatedAt})` })
    .from(fleetDispatchState);

  return {
    lastSensingOkAt: sensingRow?.observedAt ?? null,
    governor: governorRow ? { state: governorRow.state, since: governorRow.ts } : null,
    agentsInError: errorAgents.map((agent) => ({ name: agent.name, since: agent.updatedAt })),
    lastDispatchTickAt: dispatchRow?.updatedAt ? new Date(dispatchRow.updatedAt) : null,
  };
}
