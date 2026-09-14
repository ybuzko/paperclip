# fleet governor policy

Pure, offline-testable implementation of the fleet coordinator's "governor"
throttle policy, per `/home/buzz/spec/fleet-coordinator-spec.md` §2, §5 FR-1/
FR-4, §6, and §9 NFR-2.

## Contract

This module must stay **pure**: no I/O, no database access, no clock reads
(`now` is always passed in), and no imports from other services or packages.
Every function takes plain data in and returns plain data out, so decisions
can be replayed and unit-tested offline against recorded snapshots.

- **Inputs**: `LimitSnapshot[]` (recorded `{window, usedPct, resetsAt,
  observedAt, source}` samples, see FR-1.1), the previous `ThrottleState`,
  `GovernorParams` (§6 thresholds, defaults in `DEFAULT_GOVERNOR_PARAMS`), and
  the current time `now: Date`.
- **Outputs**: a `GovernorDecision` — throttle state, staleness, pace,
  utilization, active holds/floors/bucket exclusions, `LaunchParameters` for
  new worker runs, and a human-readable `reason` for audit (FR-4.10).

## Files

- `types.ts` — shared types and `DEFAULT_GOVERNOR_PARAMS`.
- `policy.ts` — `latestSnapshotByWindow`, `isStale`, `computePace`,
  `weeklyDayIndex`, `decideThrottle`, `nextSenseDueAt`.
- `policy.test.ts` — table-driven Vitest coverage of pace math, every state
  transition, hysteresis, staleness, the interactive floor, model-bucket
  holds, and resense timing around a window reset.

Callers (the actual sensing loop, the state publisher, the in-run gate) live
elsewhere and are responsible for all I/O; they should call into this module
with the data they've already collected.
