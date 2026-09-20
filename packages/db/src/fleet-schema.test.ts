import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  fleetCalibration,
  fleetDispatchState,
  fleetLimitSnapshots,
  fleetSettings,
  fleetThrottleStates,
} from "./schema/fleet.js";

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

function indexColumns(table: Parameters<typeof getTableConfig>[0], indexName: string): string[] {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === indexName);
  if (!index) return [];
  return index.config.columns.map((column) => (column as { name: string }).name);
}

describe("fleet governor ledger schema", () => {
  it("names fleet_limit_snapshots and its columns per the sensing data model", () => {
    const config = getTableConfig(fleetLimitSnapshots);
    expect(config.name).toBe("fleet_limit_snapshots");
    expect(columnNames(fleetLimitSnapshots)).toEqual([
      "id",
      "window",
      "used_pct",
      "resets_at",
      "source",
      "ok",
      "error",
      "raw",
      "observed_at",
      "created_at",
    ]);
    expect(indexColumns(fleetLimitSnapshots, "fleet_limit_snapshots_window_observed_idx")).toEqual([
      "window",
      "observed_at",
    ]);
  });

  it("names fleet_throttle_states and its columns per the throttle policy data model", () => {
    const config = getTableConfig(fleetThrottleStates);
    expect(config.name).toBe("fleet_throttle_states");
    expect(columnNames(fleetThrottleStates)).toEqual([
      "id",
      "ts",
      "mode",
      "state",
      "stale",
      "pace",
      "five_hour_pct",
      "seven_day_pct",
      "floor_active",
      "reason",
      "params_version",
      "inputs",
      "launch_parameters",
      "created_at",
    ]);
    expect(indexColumns(fleetThrottleStates, "fleet_throttle_states_ts_idx")).toEqual(["ts"]);
  });

  it("names fleet_calibration and its columns per the calibration data model", () => {
    const config = getTableConfig(fleetCalibration);
    expect(config.name).toBe("fleet_calibration");
    expect(columnNames(fleetCalibration)).toEqual([
      "id",
      "window",
      "w_usd",
      "ci_low",
      "ci_high",
      "sample_count",
      "method",
      "fitted_at",
      "created_at",
    ]);
    expect(indexColumns(fleetCalibration, "fleet_calibration_window_fitted_idx")).toEqual([
      "window",
      "fitted_at",
    ]);
  });

  it("names fleet_settings as a key/value store with no company scoping", () => {
    const config = getTableConfig(fleetSettings);
    expect(config.name).toBe("fleet_settings");
    expect(columnNames(fleetSettings)).toEqual([
      "key",
      "value",
      "version",
      "updated_at",
      "updated_by",
    ]);
  });

  it("keeps the fleet governor tables instance-wide, with no company_id column", () => {
    for (const table of [fleetLimitSnapshots, fleetThrottleStates, fleetCalibration, fleetSettings]) {
      expect(columnNames(table)).not.toContain("company_id");
    }
  });

  it("names fleet_dispatch_state and its columns per the dispatch-loop data model", () => {
    const config = getTableConfig(fleetDispatchState);
    expect(config.name).toBe("fleet_dispatch_state");
    expect(columnNames(fleetDispatchState)).toEqual([
      "project_id",
      "company_id",
      "jira_project",
      "lead_agent_id",
      "dispatch_issue_id",
      "last_poll_at",
      "ready_tasks",
      "epics_to_explode",
      "epics_to_close",
      "epic_keys_to_close",
      "counts_fingerprint",
      "last_decision",
      "last_nudge_at",
      "last_nudge_wake_id",
      "backoff_level",
      "last_ack",
      "last_error",
      "updated_at",
    ]);
    expect(indexColumns(fleetDispatchState, "fleet_dispatch_state_company_idx")).toEqual(["company_id"]);
  });

  it("scopes fleet_dispatch_state to a company, unlike the instance-wide governor tables", () => {
    expect(columnNames(fleetDispatchState)).toContain("company_id");
  });
});
