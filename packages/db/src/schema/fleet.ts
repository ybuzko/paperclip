import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  real,
  integer,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

// Phase 0 "fleet governor" ledger tables (see /spec/fleet-coordinator-spec.md
// §2, §5 FR-1/FR-4, §7, §9 NFR-2). Instance-wide: no company_id — the fleet
// governor coordinates across companies/projects, not within one.

export const fleetLimitSnapshots = pgTable(
  "fleet_limit_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    window: text("window").notNull(),
    usedPct: real("used_pct"),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    source: text("source").notNull(),
    ok: boolean("ok").notNull().default(true),
    error: text("error"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    windowObservedIdx: index("fleet_limit_snapshots_window_observed_idx").on(
      table.window,
      table.observedAt.desc(),
    ),
  }),
);

export const fleetThrottleStates = pgTable(
  "fleet_throttle_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    mode: text("mode").notNull(),
    state: text("state").notNull(),
    stale: boolean("stale").notNull().default(false),
    pace: real("pace"),
    fiveHourPct: real("five_hour_pct"),
    sevenDayPct: real("seven_day_pct"),
    floorActive: boolean("floor_active").notNull().default(false),
    reason: text("reason").notNull(),
    paramsVersion: text("params_version").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>(),
    launchParameters: jsonb("launch_parameters").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tsIdx: index("fleet_throttle_states_ts_idx").on(table.ts.desc()),
  }),
);

export const fleetCalibration = pgTable(
  "fleet_calibration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    window: text("window").notNull(),
    wUsd: real("w_usd").notNull(),
    ciLow: real("ci_low"),
    ciHigh: real("ci_high"),
    sampleCount: integer("sample_count").notNull().default(0),
    method: text("method").notNull().default("least_squares"),
    fittedAt: timestamp("fitted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    windowFittedIdx: index("fleet_calibration_window_fitted_idx").on(
      table.window,
      table.fittedAt.desc(),
    ),
  }),
);

export const fleetSettings = pgTable("fleet_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  version: text("version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

// Fleet dispatch loop (task 2/3 of the dispatch-loop build): one row per
// dispatched project, tracking the latest Jira poll, the decideDispatch()
// verdict, the standing dispatch issue, and ack/backoff state across ticks.
// Company-scoped (unlike the instance-wide governor tables above) because
// dispatch operates per Paperclip project/company. See ./DISPATCH.md.
export const fleetDispatchState = pgTable(
  "fleet_dispatch_state",
  {
    projectId: uuid("project_id").primaryKey().references(() => projects.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    jiraProject: text("jira_project").notNull(),
    leadAgentId: uuid("lead_agent_id").notNull().references(() => agents.id),
    dispatchIssueId: uuid("dispatch_issue_id").references(() => issues.id, { onDelete: "set null" }),
    lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
    readyTasks: integer("ready_tasks").notNull().default(0),
    epicsToExplode: integer("epics_to_explode").notNull().default(0),
    epicsToClose: integer("epics_to_close").notNull().default(0),
    epicKeysToClose: jsonb("epic_keys_to_close").$type<string[]>(),
    countsFingerprint: text("counts_fingerprint"),
    lastDecision: jsonb("last_decision").$type<Record<string, unknown>>(),
    lastNudgeAt: timestamp("last_nudge_at", { withTimezone: true }),
    lastNudgeWakeId: text("last_nudge_wake_id"),
    backoffLevel: integer("backoff_level").notNull().default(0),
    lastAck: jsonb("last_ack").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("fleet_dispatch_state_company_idx").on(table.companyId),
  }),
);
