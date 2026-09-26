# fleet governor policy

Pure, offline-testable implementation of the fleet coordinator's "governor"
throttle policy, per `/home/buzz/spec/fleet-coordinator-spec.md` §2, §5 FR-1/
FR-4, §6, and §9 NFR-2.

## Contract

`policy.ts`/`types.ts` must stay **pure**: no I/O, no database access, no
clock reads (`now` is always passed in), and no imports from other services or
packages. Every function takes plain data in and returns plain data out, so
decisions can be replayed and unit-tested offline against recorded snapshots.
`governor-service.ts` is the I/O layer around that pure core (see below) and
is exempt from the purity rule — it is the only file in this directory
allowed to touch the database or the clock directly.

- **Inputs**: `LimitSnapshot[]` (recorded `{window, usedPct, resetsAt,
  observedAt, source}` samples, see FR-1.1), the previous `ThrottleState`,
  `GovernorParams` (§6 thresholds, defaults in `DEFAULT_GOVERNOR_PARAMS`), and
  the current time `now: Date`.
- **Outputs**: a `GovernorDecision` — throttle state, staleness, pace,
  utilization, active holds/floors/bucket exclusions, `LaunchParameters` for
  new worker runs, and a human-readable `reason` for audit (FR-4.10).

## Parameters (§6, `GovernorParams`)

All defaults live in `DEFAULT_GOVERNOR_PARAMS` (`types.ts`) and can be
overridden instance-wide via `PATCH /api/fleet/settings` `{params: {...}}`
(merged onto the stored overrides, not replaced — see `governor-service.ts`'s
`mergeGovernorParams`).

| Param | Default | Meaning |
| --- | --- | --- |
| `amberPace` | 1.15 | Pace at/above which the governor enters AMBER. |
| `redPace` | 1.35 | Pace at/above which the governor enters RED. |
| `accelPace` | 0.80 | Pace at/below which the governor may ACCELERATE. |
| `accelEarliestDay` | 4 | Earliest day (1..7) of the weekly window ACCELERATE may trigger. |
| `floor5h` | 80 | 5h used% at/above which non-P0 worker launches are held (FR-4.6), independent of state. |
| `red5h` | 90 | 5h used% at/above which the state is RED regardless of pace (FR-4.4). |
| `hysteresisPp` | 5 | Hysteresis band in percentage points, applied to every step-down threshold (FR-4.1). |
| `bucketHoldPct` | 90 | Model-bucket used% at/above which that model is excluded for non-P0 runs (FR-4.8). |
| `staleAfterMs` | 15 min | A window is STALE if no snapshot younger than this exists (FR-1.3). Also used by `getAdmission()` to judge whether the *decision itself* is too old to trust. |
| `minElapsedFraction` | 0.10 | **Pace hypersensitivity fix.** Minimum fraction (0..1) of the weekly window that must have elapsed before pace tiers (`amberPace`/`redPace`/`accelPace`) apply. Below this, pace = usedPct / elapsedFraction has a tiny, noisy denominator and can swing wildly between senses (observed: hundreds of RED/AMBER/GREEN flips in the first day of a window). While elapsed fraction < `minElapsedFraction`, `decideThrottle` holds the previous state (GREEN if there is none) instead of computing a pace tier, with reason `"early window: elapsed X% < minElapsedFraction (…)"`. The fresh `red_5h` rule and the staleness rule are unaffected — they still apply during the early window. |
| `senseIntervalMs` | 5 min | Sensing cadence (FR-1.1). |
| `defaultModels` | `{supervisor: opus, coder: sonnet, evaluator: sonnet}` | Default launch models (decided). |
| `amberModel` | sonnet | Coder model while AMBER (FR-4.3). |
| `amberEffort` | medium | Coder effort while AMBER (FR-4.3). |
| `amberConcurrencyStep` | 1 | Coder concurrency reduction while AMBER (FR-4.3). |
| `maxConcurrency` | 1 | Fleet default concurrency (decided: 1 worker run per host). |
| `paramsVersion` | `v0-proposed` | Version tag for the parameter set in force, for audit (FR-4.10). |

## Files

- `types.ts` — shared types (`GovernorParams`, `GovernorDecision`,
  `FleetAdmission`, `ProjectClass`, …) and `DEFAULT_GOVERNOR_PARAMS`.
- `policy.ts` — `latestSnapshotByWindow`, `isStale`, `computePace`,
  `weeklyElapsedFraction`, `weeklyDayIndex`, `decideThrottle`, `nextSenseDueAt`.
- `policy.test.ts` — table-driven Vitest coverage of pace math, every state
  transition, hysteresis, staleness, the early-window hold, the interactive
  floor, model-bucket holds, and resense timing around a window reset.
- `governor-service.ts` — the I/O layer: `createFleetGovernorService` /
  `getSharedFleetGovernorService` (`senseOnce`, `evaluate`, `tick`, `start`,
  `getStatus`, `getAdmission`), settings read/write helpers
  (`fleet_settings` keys `governor_params`/`governor_mode`), and snapshot/
  throttle-state history queries. Backed by `fleet_limit_snapshots` and
  `fleet_throttle_states`.
- `governor-service.test.ts` — embedded-Postgres coverage of sensing,
  evaluation/persistence, settings overrides, `getStatus`, and
  `getAdmission` (shadow vs enforce, RED, floor, stale, AMBER-by-class,
  GREEN).

## Run admission (`getAdmission`)

`FleetGovernorService.getAdmission({companyId, agentId, projectId?})` answers
"can this run start right now?" as a **read of the governor's latest
decision** — it does not run `decideThrottle` itself, and (per FR-11.6) it
never dispatches, cancels, holds, or interrupts anything on its own; callers
(`server/src/services/heartbeat.ts`) decide what to do with the verdict.

**Which decision it reads**: the latest decision cached in-memory by this
process's own `evaluate()`/`tick()` calls, falling back to the newest
`fleet_throttle_states` row when this process hasn't ticked yet (e.g. right
after startup).

**Staleness**: if there is no decision at all, or the decision is older than
`params.staleAfterMs`, admission treats it as `stale: true` and blocks — an
unknown throttle state is treated as "hold new work", same posture as
`decideThrottle`'s own stale-sensing rule (FR-1.3).

**Project class**: resolved from the project's `env` jsonb (`projects.env`),
key `FLEET_CLASS`, accepting both the legacy plain-string form and
`{type: "plain", value: "P0"|"P1"|"P2"}`. Missing project, missing key,
unparseable value, or no `projectId` at all → defaults to `P2`.

**Block rules** (evaluated in this order; first match wins):

1. **Stale** — no trustworthy decision (see above).
2. **RED** — the throttle state is RED (blocks every project class, including P0).
3. **Floor** — the latest `five_hour` snapshot used% is at/above `params.floor5h` (FR-4.6), independent of state (so it can block even a GREEN decision).
4. **AMBER + P2** — AMBER blocks P2 projects only; P0 and P1 are admitted.
5. Otherwise (GREEN, ACCELERATE, or AMBER for P0/P1) → admitted.

**Shadow vs enforce** (`governor_mode` setting, `fleet_settings` key
`governor_mode`, `{"mode": "shadow"|"enforce"}`, default `shadow`):

- **shadow**: `allowed` is always `true` — the governor never actually blocks
  in shadow mode. When the block rules above would have blocked the run,
  `wouldBlock: true` and `reason` is prefixed `"shadow: would block — …"` so
  operators can see what enforce mode would do before turning it on.
- **enforce**: `allowed: !blocked` — a blocked run is genuinely refused
  admission. `wouldBlock` mirrors `blocked` regardless of mode.

**Counters**: `getAdmission()` maintains process-local counters
(`admissionsAllowed`, `admissionsBlocked`, `admissionsWouldBlock`, and
`lastBlock: {at, agentId, reason} | null`) exposed via `getStatus()` /
`GET /api/fleet/status`, for operator visibility into how often the governor
is (or would be) holding work back.

**Heartbeat integration** (`server/src/services/heartbeat.ts`): admission is
checked right after the existing budget-invocation-block check, at two
points, and fails open (logs and allows) on any error so a governor bug can
never crash the scheduler:

- `claimQueuedRun` (claiming a queued run to execute it): a blocked
  admission does **not** cancel the run — it is left `queued` and
  `claimQueuedRun` returns `null`, so a later scheduling pass retries it once
  the governor opens up (the same pattern already used for
  dependency-not-ready runs). The hold is logged once per run per distinct
  reason (rate-limited via an in-memory `runId -> reason` map, cleared once
  the run clears admission or is cancelled for another reason).
- `evaluateScheduledRetryGate` (promoting a due `scheduled_retry` run): a
  blocked admission returns `{allowed: false, errorCode: "fleet_throttled", …}`,
  mirroring the existing `budget_blocked` branch immediately above it. Unlike
  the queued-run case, this **cancels** the scheduled retry (the caller's
  existing behavior for every `allowed: false` gate result except
  `issue_not_found`) — the run's issue execution lock is released, so the
  issue stays workable and can be picked up again by a fresh wake.

Callers (the actual sensing loop, the state publisher) that need lower-level
policy access can still call into `policy.ts` directly with data they've
already collected; `governor-service.ts` is the recommended entry point for
anything backed by the database.
