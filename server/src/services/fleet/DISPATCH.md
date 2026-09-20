# Fleet dispatch loop

The fleet dispatch loop nudges a project's remote supervisor (a `claudeclaw_gateway`
agent) awake when Jira says there is ready work assigned to it and the fleet
governor's throttle state (see `./README.md`) allows new work. It never
executes work itself, never talks to Jira on the agent's behalf, and — like
the governor — is pure sensing plus a wake in `enforce` mode; in `shadow`
mode it only polls and records what it *would* have done.

Three modules:

- `./jira-client.ts` — a minimal Jira Cloud REST v3 client (approximate
  counts + paginated key search). No policy, no persistence.
- `./dispatch-policy.ts` — pure functions: the JQL for "ready work", and
  `decideDispatch()`, the nudge/backoff decision. No I/O, mirrors
  `./policy.ts`'s purity contract.
- `./dispatch-service.ts` — the I/O layer: polls Jira, reads the governor's
  latest decision, calls `decideDispatch()`, persists `fleet_dispatch_state`,
  and (in `enforce` mode) creates/updates the project's standing dispatch
  issue and wakes the supervisor.

## Ready-work definition

For a project with Jira project key `P` and its supervisor's Jira
`accountId` `A` (from the lead agent's `adapter_config.jiraAccountId`):

| Count | JQL |
| --- | --- |
| `readyTasks` | `project = P AND issuetype != Epic AND status in (<ready statuses>) AND assignee = A` |
| `epicsToExplode` | `project = P AND issuetype = Epic AND status = "To Do" AND assignee = A` |
| `epicsToClose` candidates | `project = P AND issuetype = Epic AND status = "In Progress" AND assignee = A` |

`<ready statuses>` defaults to `To Do, In Progress`; a project can override it
via `JIRA_READY_STATUSES` (comma list) in its `env`.

An `epicsToClose` candidate is only actually ready to close once none of its
children are unfinished. The service fetches candidate keys, then queries
`project = P AND parent in (K1, K2, …) AND statusCategory != Done` for those
keys; a candidate is ready to close if it has zero matches (including epics
with no children at all — `dispatch-policy.ts`'s `computeEpicsToClose()`).
`epicKeysToClose` on the wake payload is capped at 20 keys; `epicsToClose`
itself is the full (uncapped) count.

## Project eligibility

A project participates in the loop when, every tick:

- it is not archived (`archived_at is null`) and not paused (`paused_at is null`);
- its `env.FLEET_DISPATCH` is not `"off"` (default: on);
- its `env.JIRA_PROJECT` is set (this is the Jira project key `P` above);
- it has a `lead_agent_id`, and that agent's `adapter_type` is
  `claudeclaw_gateway` and its `status` is not `paused`.

If all of the above hold but the lead agent's `adapter_config.jiraAccountId`
is unset, the project is skipped for that tick with a recorded reason
(`fleet_dispatch_state.last_error = "missing_jira_account_id: …"`) — Jira is
never queried for it.

`env.FLEET_CLASS` (`P0`/`P1`/`P2`, default `P2`) sets the project's priority
class for the AMBER rule below — same key and default as the governor's
per-run admission class (`./types.ts`'s `ProjectClass`).

## Decision rules (`decideDispatch()`, in order)

1. **No work** (`readyTasks + epicsToExplode + epicsToClose === 0`) → no nudge.
2. **Agent busy** (the supervisor already has a `heartbeat_runs` row in
   `queued` or `running` for this project's lead agent) → no nudge.
3. **Governor stale** (no fresh-enough throttle decision) → no nudge.
4. **Governor RED** → no nudge.
5. **5h utilization ≥ `floor_5h`** (independent of state, same floor as the
   governor's `FR-4.6`) → no nudge.
6. **Governor AMBER** → nudge only `P0`/`P1` projects.
7. **GREEN / ACCELERATE** → nudge (subject to the gaps below).
8. **`needs_human`**: once backoff is at `maxBackoffLevel` and the previous
   nudge got no ack while the ready-work counts stayed unchanged → no nudge,
   `reason: "needs_human"`. A human has to look, or the counts have to move,
   or an ack has to land.
9. **`min_nudge_gap`**: never nudge the same project twice within
   `minNudgeGapMs` (default 15 min) of the last nudge.
10. **`backoff`**: while `backoffLevel > 0`, also wait at least
    `backoffMs[backoffLevel - 1]` since the last nudge (default: 60 min at
    level 1, 360 min at level 2, `maxBackoffLevel = 2`).

Steps 1–10 are pure and unit-tested in `./dispatch-policy.test.ts`
independent of the DB/Jira/wakeup I/O in `./dispatch-service.test.ts`.

### Backoff

Backoff tracks "is anyone home". Every tick recomputes `nextBackoffLevel`
from the *previous* nudge, regardless of whether this tick itself nudges:

- an ack observed at/after the last nudge → level resets to 0;
- otherwise, if the ready-work counts fingerprint (`readyTasks:epicsToExplode:epicsToClose`)
  is unchanged since the last nudge → level increases by 1, capped at
  `maxBackoffLevel`.

An ack from *before* the last nudge (a stale ack left over from an earlier
cycle) does not reset backoff — only an ack timestamped at/after
`last_nudge_at` counts.

## Ack format

After working one ready item, the supervisor replies on the project's
standing dispatch issue with a single-line comment:

```
fleet-ack: worked=<KEY> kind=<task|epic_explode|epic_close> outcome=<done|declined|partial>
```

- `<KEY>` — the Jira issue key worked (e.g. `FT-123`).
- `kind` — `task` (a ready task), `epic_explode` (broke an epic into
  children), or `epic_close` (closed a finished epic).
- `outcome` — `done`, `declined` (skipped — blocked, out of scope, etc.), or
  `partial` (started, not finished).

The service scans `issue_comments` on the dispatch issue created strictly
after `last_nudge_at` for the most recent comment matching this format; a
match becomes `fleet_dispatch_state.last_ack` (`{at, worked, kind, outcome}`)
and feeds the backoff reset above.

## The standing dispatch issue

Each dispatched project gets one persistent issue, `Fleet dispatch: <JIRA_PROJECT>`,
assigned to the lead agent with `status = in_progress`. It is created lazily
(on the first `enforce`-mode nudge) via `issueService(db).create()`, reused
on every subsequent nudge (re-opened/re-assigned if someone changed it), and
its id is cached in `fleet_dispatch_state.dispatch_issue_id`. It is not a
task with an acceptance criterion of its own — it exists purely as a place
for nudges to describe themselves and for acks to land.

## The wake

In `enforce` mode, a nudge calls the heartbeat scheduler's `wakeup(agentId, …)`
with `reason: "fleet_dispatch"` and a `fleetDispatch` object on both `payload`
and `contextSnapshot`:

```ts
{
  jiraProject, readyTasks, epicsToExplode, epicsToClose, epicKeysToClose,
  throttleState, fiveHourPct, sevenDayPct, sevenDayResetsAt, ackFormat,
}
```

See `packages/adapters/claudeclaw-gateway/README.md`'s "Fleet dispatch
block" for how the adapter reads this off the execution context
(`ctx.context.fleetDispatch`) and renders it into the wake prompt.
`idempotencyKey` is `fleet_dispatch:<projectId>:<ISO minute of now>`, so a
retried or overlapping tick cannot double-wake the same project in the same
minute.

In `shadow` mode, every step through `decideDispatch()` still runs and
`fleet_dispatch_state` still records the decision — the loop just never
calls `wakeup()` or touches the dispatch issue. This lets an operator watch
`GET /api/fleet/dispatch` for a while before flipping `dispatch_mode` to
`enforce`.

## Settings (`fleet_settings`, same table/helpers as the governor's)

| Key | Shape | Notes |
| --- | --- | --- |
| `jira` | `{baseUrl, email, tokenSecretId}` | Jira Cloud site + the company secret holding the API token. No default — the loop no-ops (`jiraConfigured: false`) until this is set. |
| `dispatch_mode` | `{mode: "shadow" \| "enforce"}` | Default `shadow`. |
| `dispatch_params` | overrides for `DispatchServiceParams` (`minNudgeGapMs`, `backoffMs`, `maxBackoffLevel`, `pollIntervalMs`) | Deep-merged onto `DEFAULT_DISPATCH_SERVICE_PARAMS`; `pollIntervalMs` (default 10 min) is `start()`'s reschedule interval. |

The Jira API token is resolved per **project company** (each dispatched
project's `company_id`) via `secretService(db).resolveSecretValue(companyId,
tokenSecretId, "latest", { accessContext: { consumerType: "system",
consumerId: "fleet-dispatch", actorType: "system", actorId: null, configPath:
"jira.tokenSecretId" } })` — `accessContext` only (no `bindingContext`), the
same "system, audit-only, no binding enforcement" shape
`server/src/services/secrets.ts` documents for prospective/instance-wide
config (see its `ResolveAdapterConfigForRuntimeOptions.userSecretMediation`
doc comment). This is the least-privileged option that still records a
`secret_access_events` row: it does not require a `company_secret_bindings`
row to exist for `("system", "fleet-dispatch", "jira.tokenSecretId")`
(unlike the "declared" binding path routes/issues/routines use), because the
Jira credential is a single instance-wide setting, not something scoped to
one issue/routine/environment. The secret itself must still belong to the
company being dispatched (`companySecrets.companyId`) — on a single-company
instance this is a non-issue; a multi-company instance needs the same secret
(or a copy of it) present in every company that dispatches, or those
companies' projects are skipped with a `last_error`.

## Env vars

| Var | Default | Notes |
| --- | --- | --- |
| `PAPERCLIP_FLEET_DISPATCH_ENABLED` | on | Set to `0`/`false` to disable the startup scheduler (mirrors `PAPERCLIP_FLEET_GOVERNOR_ENABLED`). The service still exists and is reachable from the HTTP routes either way; this only gates the `start()` interval in `server/src/index.ts`. |

## Routes

`server/src/routes/fleet-dispatch.ts`, instance-admin only (same guard as
`/api/fleet/*`):

- `GET /api/fleet/dispatch` — `getStatus()`.
- `POST /api/fleet/dispatch/poll` — runs `tick()` once, on demand.
- `PATCH /api/fleet/dispatch/settings` — updates `dispatch_mode`,
  `dispatch_params`, and/or `jira` (validated by
  `packages/shared/src/validators/fleet-dispatch.ts`).
