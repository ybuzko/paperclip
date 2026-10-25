# Fleet dispatch loop

The fleet dispatch loop nudges a project's remote supervisor (a `claudeclaw_gateway`
agent) awake when Jira says there is ready work assigned to it and the fleet
governor's throttle state (see `./README.md`) allows new work. The server
picks the ONE Jira item each nudge is about (see "Ticket selection"). It never
executes work itself; its only Jira writes are reassigning a *declined*
assignment to the configured human, with a comment (see "Decline"). Paperclip
issues already assigned to the supervisor take priority over Jira nudges (see
"Paperclip-issue priority"). In `shadow` mode it only polls and records what
it *would* have done.

Three modules:

- `./jira-client.ts` — a minimal Jira Cloud REST client (approximate
  counts, paginated issue search, `getIssue`, and the two writes
  `assignIssue` — `PUT /rest/api/3/issue/{key}/assignee` — and `addComment`
  — `POST /rest/api/2/issue/{key}/comment`, plain-text body). No policy, no
  persistence.
- `./dispatch-policy.ts` — pure functions: the JQL for "ready work",
  `selectAssignment()` (ticket selection), `parseFleetAck()`,
  `decideDeclineReassignment()`, and `decideDispatch()`, the nudge/backoff
  decision. No I/O, mirrors `./policy.ts`'s purity contract.
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

All three lists are fetched with `GET /rest/api/3/search/jql` and fields
`key,summary,status,issuetype,created,updated,parent`; the counts are the
list lengths.

## Ticket selection (`selectAssignment()`)

The server picks the ONE item a nudge is about, in this order:

1. tasks in **In Progress**, oldest `updated` first;
2. tasks in **To Do**, oldest `created` first;
3. tasks in any other configured ready status (`JIRA_READY_STATUSES`
   override), oldest `created` first;
4. **epics to close** (all children done), oldest `created` first;
5. **epics to explode**, oldest `created` first.

Ties break on the issue key; a missing timestamp sorts last. The selection is
recorded every tick in `fleet_dispatch_state.last_decision.assignment`, and
the item the last Jira nudge was actually about in
`last_decision.nudgedAssignment` (carried forward between nudges). No
migration: both live in the existing `last_decision` jsonb.

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

0. **Paperclip-issue priority** (in the service, before `decideDispatch()`
   runs for Jira; see below) → no Jira nudge this tick.
1. **No work** (`readyTasks + epicsToExplode + epicsToClose === 0`) → no nudge.
2. **Agent busy** (the supervisor already has a `heartbeat_runs` row in
   `queued` or `running` for this project's lead agent) → no nudge.
3. **Governor stale** (no fresh-enough throttle decision, or state `STALE`) → no nudge.
4. **Governor RED** → no nudge.
5. **5h utilization ≥ `floor_5h`** (independent of state, same floor as the
   governor's `FR-4.6`) → no nudge.
6. **Governor AMBER** (legacy state name) → nudge only `P0`/`P1` projects.
7. **Governor CAPPED** (the weekly cap schedule is holding the fleet) → no
   nudge. The admission gate would hold the run anyway; not nudging keeps the
   supervisor from showing as busy with a queued run that cannot start.
8. **OPEN** (and the legacy GREEN / ACCELERATE) → nudge (subject to the gaps
   below). The governor state is passed through as `throttleState`; the
   adapter adds a budget line when models are excluded.
9. **`min_nudge_gap`**: never nudge the same project twice within
   `minNudgeGapMs` (default 15 min) of the last nudge.
10. **`backoff`**: if the last nudge is *stuck* (no ack since, counts
   unchanged since it was sent), wait `backoffMs[backoffLevel]` before the
   next nudge (default: 60 min at level 0, 360 min at level 1). Sending that
   next nudge raises the level by one.
11. **`needs_human`**: a stuck nudge at `maxBackoffLevel` (default 2) → no
    nudge, `reason: "needs_human"`, until the counts move or an ack lands.

Steps 1–10 are pure and unit-tested in `./dispatch-policy.test.ts`
independent of the DB/Jira/wakeup I/O in `./dispatch-service.test.ts`.

### Backoff

Backoff tracks "is anyone home". A nudge is *stuck* when no ack has landed
since it was sent and the ready-work counts fingerprint
(`readyTasks:epicsToExplode:epicsToClose`) equals the one recorded when it was
sent (`counts_fingerprint` is only rewritten on a nudge).

- an ack at/after the last nudge with outcome `done` or `partial`, or any
  change in the counts → level resets to 0;
- an ack with outcome `declined` does **not** reset the level by itself; the
  reassignment it triggers removes the item from the supervisor's ready
  work, and that change in the counts is what resets the level;
- the level rises only when a stuck nudge has waited out its delay and the
  next nudge goes out — once per nudge, never per poll, so the delays hold at
  any `pollIntervalMs`.

Default sequence with a silent supervisor: nudge → 60 min → nudge → 6 h →
nudge → `needs_human`.

An ack from *before* the last nudge (a stale ack left over from an earlier
cycle) does not reset backoff — only an ack timestamped at/after
`last_nudge_at` counts.

## Ack format

The supervisor ends its reply to the nudge with one line:

```
fleet-ack: worked=<KEY> outcome=<done|declined|partial>
```

- `<KEY>` — the Jira issue key the nudge named (e.g. `FT-123`).
- `outcome` — `done`, `partial` (started, not finished), or `declined`
  (cannot advance it; see "Decline").

The legacy form `fleet-ack: worked=<KEY> kind=<task|epic_explode|epic_close> outcome=<...>`
is still accepted everywhere. If several ack lines appear, the last one wins.

Where the ack is read from, each tick:

1. **Primary — the nudge's run result.** The nudge's heartbeat run id is
   `fleet_dispatch_state.last_nudge_wake_id`. Once that run has finished
   (`finished_at` set), the supervisor's reply — which the
   `claudeclaw_gateway` adapter returns as the run `summary` and heartbeat.ts
   persists as `heartbeat_runs.result_json.summary` (also echoed to stdout,
   so the tail of `stdout_excerpt`) — is scanned for the ack line
   (`result_json.summary`, then `result_json.result`, then `stdout_excerpt`).
2. **Fallback — a PIX comment.** A comment on the standing dispatch issue
   created strictly after `last_nudge_at` in either format.

A finished run with no ack in either place is an un-acked nudge (normal
backoff). A match becomes `fleet_dispatch_state.last_ack`
(`{id, source, at, worked, kind, outcome, decline?}`; `id` is
`run:<run id>` or `comment:<comment id>`, `kind` is null for the v2 form).

## Decline

When a **new** ack (an `id` different from the one already in `last_ack`) has
`outcome=declined`, before Jira is polled for ready work:

1. If `jira.humanAccountId`/`jira.humanEmail` are not both set → warn,
   record `decline.action = "skip_no_target"`, change nothing.
2. `GET` the Jira issue's `assignee`.
3. If the assignee is the supervisor (the lead agent's `jiraAccountId`) →
   `PUT` the assignee to `humanAccountId`, then add a comment:
   `Declined by fleet supervisor <agent name> at <ack time, America/Los_Angeles>; reassigned to <humanEmail> for investigation. Agent reply: <first 500 chars of the reply>`.
   Recorded as `decline.action = "reassigned"`. The key is dropped from this
   tick's ready lists even if Jira's search index still shows it.
4. If the issue is assigned to someone else or unassigned → leave Jira alone,
   log, and record `decline.action = "decline_mismatch"`.
5. In `shadow` mode, steps 3/4 only log and record
   `shadow_would_reassign` / `shadow_decline_mismatch` (the `GET` still runs;
   nothing is written to Jira).

The result is stored on `last_ack.decline`, so each ack is handled exactly once
across ticks and restarts. A transient Jira error (`429`/`5xx`/timeout) is
recorded with `retryable: true` and retried on the next tick; any other error
is recorded and not retried.

## Paperclip-issue priority

Before computing a Jira nudge, the service looks for Paperclip issues in the
project's company assigned to the lead agent with `status in (todo,
in_progress)`, `origin_kind != "fleet_dispatch"` (i.e. not the standing
dispatch issue) and not hidden (`hidden_at is null`). If there is one:

- The Jira nudge is skipped for this project this tick (Jira is still polled
  and the counts/selection recorded); `last_decision.reason` is
  `paperclip_issue_priority: <PIX-nn>`, with ` (held: <reason>)` appended
  when the wake below is held.
- The wake is gated exactly like a Jira nudge — agent busy, governor
  stale/RED/floor/AMBER-class, and `minNudgeGapMs` since the last wake of
  either kind — but without backoff.
- When allowed (in `enforce` mode), the supervisor is woken for the OLDEST
  such issue (by `created_at`) via the heartbeat `wakeup()` the way assignment
  wakes are (`source: "assignment"`, `payload/contextSnapshot.issueId`),
  with `reason: "fleet_pending_issue"`, so the adapter renders its generic
  wake for that issue rather than the short dispatch message. Recorded in
  `last_decision.pendingIssueWake` (`{issueId, identifier, at, runId}`).
  `last_nudge_at`, the counts fingerprint and the backoff level are not
  touched.

## The standing dispatch issue

Each dispatched project gets one persistent issue, `Fleet dispatch: <JIRA_PROJECT>`,
assigned to the lead agent with `status = in_progress`. It is created lazily
(on the first `enforce`-mode nudge) via `issueService(db).create()`, reused
on every subsequent nudge (re-opened/re-assigned if someone changed it), and
its id is cached in `fleet_dispatch_state.dispatch_issue_id`. It is not a
task with an acceptance criterion of its own — it anchors the nudge runs,
documents the ack format and rules in its description, and is where legacy
ack comments land. Its `origin_kind` (`fleet_dispatch`) excludes it from the
Paperclip-issue priority check.

## The wake

In `enforce` mode, a nudge calls the heartbeat scheduler's `wakeup(agentId, …)`
with `reason: "fleet_dispatch"` and a `fleetDispatch` object on both `payload`
and `contextSnapshot`:

```jsonc
{
  "version": 2,
  "jiraProject": "GAME",
  "assignment": { "key": "GAME-53", "summary": "…", "status": "In Progress", "kind": "task" | "epic_explode" | "epic_close" },
  "declineReassignTo": { "accountId": "…", "email": "…" },   // omitted unless jira.humanAccountId + humanEmail are set
  "throttleState": "OPEN" | "CAPPED" | "RED" | "STALE",       // the governor's latest state, passed through
  "fiveHourPct": 17, "sevenDayPct": 52, "sevenDayResetsAt": "…",  // may be null
  "modelExclusions": [],      // governor launch_parameters.excludedModels, lowercased
  "ackFormat": "fleet-ack: worked=<KEY> outcome=<done|declined|partial>",
  "readyTasks": 2, "epicsToExplode": 0, "epicsToClose": 0, "epicKeysToClose": []
}
```

`assignment` is null only when nothing is ready (which never nudges).

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
| `jira` | `{baseUrl, email, tokenSecretId, humanAccountId?, humanEmail?}` | Jira Cloud site + the company secret holding the API token. No default — the loop no-ops (`jiraConfigured: false`) until this is set. `humanAccountId`/`humanEmail` name the human a declined assignment is reassigned to (and become the nudge's `declineReassignTo`); both must be set, otherwise declines are logged and left alone. The PATCH replaces the whole `jira` object, so send all fields. |
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
