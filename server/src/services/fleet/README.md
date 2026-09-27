# fleet governor policy

Pure, offline-testable implementation of the fleet coordinator's "governor"
throttle policy, per `/home/buzz/spec/fleet-coordinator-spec.md` §2, §5 FR-1/
FR-4, §6, and §9 NFR-2.

## Contract

`policy.ts` and `types.ts` are pure: no I/O, database, clock reads, or
service imports. The caller passes recorded snapshots and `now`. The decision
reports the cap, next cap change, state, model exclusions, floor, and holds.

## Parameters (`GovernorParams`)

| Parameter | Default | Meaning |
| --- | --- | --- |
| `capSchedules.anthropic.seven_day` | 70%; 80% inside T−10h; 99% inside T−5h | Weekly utilization cap. Strict boundaries: at exactly T−10h the cap is still 70%; one millisecond later it is 80%. |
| `floor5h` | 80 | Independently holds new worker launches for every class. |
| `red5h` | 90 | Enters RED when a fresh five-hour reading reaches this percentage and required sensing is not STALE. |
| `hysteresisPp` | 5 | CAPPED clears at or below cap minus 5 percentage points; a cap step-up reevaluates usage against the new cap. |
| `bucketHoldPct` | 90 | Excludes model slugs whose model-scoped weekly usage reaches this percentage. |
| `staleAfterMs` | 15 min | Maximum sensing age for required five-hour and weekly windows. |
| `senseIntervalMs` | 5 min | Normal sensing cadence; a cap step may wake it earlier. |
| `maxConcurrency` | 1 | Worker concurrency across all classes when the floor and throttle holds are inactive. |
| `paramsVersion` | `v1-cap-schedule` | Audit version. |

Schedule hours are elapsed time before the reset instant, not fixed wall-clock
hours. The Pacific timezone formats status text. For a Sunday 06:00 Pacific
reset in ordinary PDT or PST weeks, steps occur Saturday 20:00 and Sunday
01:00. During the spring transition they occur Saturday 19:00 PST and Sunday
00:00 PST; during the fall transition they occur Saturday 21:00 PDT and the
second Sunday 01:00 PST.

PATCH accepts only runtime-supported IANA time zones and schedules with a
single null base segment first, followed by positive hour offsets in strictly
descending order. Caps must be finite percentages from 0 to 100.

The pure policy emits OPEN, CAPPED, RED, or STALE. STALE takes precedence over
RED; RED takes precedence over CAPPED. `previousCapPct` lets the caller
reevaluate CAPPED against a stepped-up cap; usage at or above the new cap
remains CAPPED. `pace` remains null solely for
the existing persistence column. Launch parameters contain only model
exclusions and maximum concurrency.

`governor-service.ts` persists the selected cap in the decision inputs so
hysteresis can recognize a scheduled step-up on the next evaluation. The API
settings validator accepts cap schedules and merges overrides by provider and
window. Broader dispatch coordination is a separate integration.

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
3. **Floor** — the latest `five_hour` snapshot used% is at/above `params.floor5h` (FR-4.6), independent of state (so it can block even an OPEN decision).
4. **CAPPED** — blocks every project class.
5. Otherwise (OPEN) → admitted.

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

## Provider quota windows

`FleetWindow` is an open string so the quota source can add windows without a
governor type release. Sensing persists every quota window with a non-empty
key. Anthropic rows include `provider: "anthropic"`; `modelScope` is the slug
for `seven_day_model:<slug>` windows (and the legacy Sonnet/Opus windows), and
is `null` for general and surface windows. The policy applies model bucket
holds to both legacy and dynamic model-scoped windows. `bucketHolds` continues
to contain window keys; `launchParameters.excludedModels` contains model
slugs.

`GET /api/fleet/status` groups each provider's latest successful windows under
`providers[provider].snapshots`. The top-level `snapshots` array remains
available during the transition and carries the same rows, including explicit
`modelScope: null` where a window is not model-scoped.

## Weights

`weights.ts` provides pure token weighting through `weightedUnits()` and
`loadWeightTable()`. The default per-token ratios are seeded from Anthropic
API list-price ratios as of 2026-09 and include an unfitted OpenAI placeholder.
They are proxy ratios for metering and fairness, not current billing facts or
currency amounts; operators may replace them with fitted values through the
`fleet_settings` `provider_weights` JSON setting. Overrides deep-merge by
provider, model, and token type, so unspecified defaults remain available.
Model selection uses an exact id first, then the longest matching prefix,
then the provider's `*` entry. An unknown provider contributes zero and should
be logged once by the caller. Invalid negative or non-finite override weights
are ignored, and invalid token counts contribute zero.
