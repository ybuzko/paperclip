/**
 * The fleet coordinator's "governor" sensing + evaluation service.
 *
 * This is the I/O layer around the pure policy in `./policy.ts`: it fetches
 * quota windows, records them into `fleet_limit_snapshots`, loads the
 * previous throttle state and effective settings, calls `decideThrottle`,
 * and persists a new `fleet_throttle_states` row when the decision changed
 * (or on a 60-minute heartbeat). See
 * /home/buzz/spec/fleet-coordinator-spec.md §5 FR-1/FR-4, FR-11.6 (shadow
 * mode — this module never dispatches, holds, gates, or interrupts; it only
 * senses and logs/persists decisions).
 */

import { and, desc, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  fleetLimitSnapshots,
  fleetSettings,
  fleetThrottleStates,
  projects,
  type Db,
} from "@paperclipai/db";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { fetchAllQuotaWindows } from "../quota-windows.js";
import { decideThrottle, latestSnapshotByWindow, nextSenseDueAt } from "./policy.js";
import {
  DEFAULT_GOVERNOR_PARAMS,
  type FleetAdmission,
  type FleetWindow,
  type GovernorDecision,
  type GovernorParams,
  type LimitSnapshot,
  type ProjectClass,
  type ThrottleState,
  isModelScopedWindow,
  modelScopeForWindow,
} from "./types.js";

/** Minimal logger shape this module needs — satisfied by the app's pino logger or a test fake. */
export interface FleetGovernorLogger {
  info: (payload: Record<string, unknown> | string, msg?: string) => void;
  warn: (payload: Record<string, unknown> | string, msg?: string) => void;
  debug: (payload: Record<string, unknown> | string, msg?: string) => void;
  error: (payload: Record<string, unknown> | string, msg?: string) => void;
}

export type GovernorMode = "shadow" | "enforce";

export const GOVERNOR_PARAMS_SETTINGS_KEY = "governor_params";
export const GOVERNOR_MODE_SETTINGS_KEY = "governor_mode";

/** How far back `evaluate()`/`getStatus()` look for the latest ok snapshot per window. */
const SNAPSHOT_LOOKBACK_MS = 48 * 60 * 60 * 1000;
/** A throttle-state row older than this is refreshed even with no change (heartbeat). */
const THROTTLE_STATE_HEARTBEAT_MS = 60 * 60 * 1000;

type FleetLimitSnapshotRow = typeof fleetLimitSnapshots.$inferSelect;
type FleetThrottleStateRow = typeof fleetThrottleStates.$inferSelect;

type SenseWindowKey = string;

/** Fallback label -> key map, for providers/paths that don't (yet) set `QuotaWindow.key`. */
const LABEL_TO_SENSE_WINDOW_KEY: Record<string, SenseWindowKey> = {
  "Current session": "five_hour",
  "Current week (all models)": "seven_day",
  "Current week (Sonnet only)": "seven_day_sonnet",
  "Current week (Opus only)": "seven_day_opus",
  "Extra usage": "extra_usage",
};

function resolveSenseWindowKey(window: QuotaWindow): SenseWindowKey | null {
  // Persist every stable key from the quota source so status can expose new
  // provider windows without requiring a governor release.
  if (typeof window.key === "string" && window.key.length > 0) return window.key;
  return LABEL_TO_SENSE_WINDOW_KEY[window.label] ?? null;
}

/** Stable windows consumed by the governor policy, plus scoped model windows. */
const FLEET_POLICY_WINDOWS = new Set<FleetWindow>([
  "five_hour",
  "seven_day",
  "seven_day_sonnet",
  "seven_day_opus",
]);

function isFleetPolicyWindow(value: string): value is FleetWindow {
  return FLEET_POLICY_WINDOWS.has(value as FleetWindow)
    || isModelScopedWindow(value)
    || modelScopeForWindow(value) != null;
}

function toPolicySnapshots(rows: FleetLimitSnapshotRow[]): LimitSnapshot[] {
  const snapshots: LimitSnapshot[] = [];
  for (const row of rows) {
    if (row.provider !== "anthropic" || !isFleetPolicyWindow(row.window)) continue;
    snapshots.push({
      window: row.window,
      provider: row.provider,
      modelScope: row.modelScope,
      usedPct: row.usedPct,
      resetsAt: row.resetsAt,
      observedAt: row.observedAt,
      source: row.source,
    });
  }
  return snapshots;
}

function mergeGovernorParams(overrides: Partial<GovernorParams> | null | undefined): GovernorParams {
  if (!overrides || typeof overrides !== "object") return DEFAULT_GOVERNOR_PARAMS;
  const capSchedules = { ...DEFAULT_GOVERNOR_PARAMS.capSchedules };
  for (const [provider, schedules] of Object.entries(overrides.capSchedules ?? {})) {
    capSchedules[provider] = { ...(capSchedules[provider] ?? {}), ...schedules };
  }
  return {
    ...DEFAULT_GOVERNOR_PARAMS,
    capSchedules,
    floor5h: overrides.floor5h ?? DEFAULT_GOVERNOR_PARAMS.floor5h,
    red5h: overrides.red5h ?? DEFAULT_GOVERNOR_PARAMS.red5h,
    hysteresisPp: overrides.hysteresisPp ?? DEFAULT_GOVERNOR_PARAMS.hysteresisPp,
    bucketHoldPct: overrides.bucketHoldPct ?? DEFAULT_GOVERNOR_PARAMS.bucketHoldPct,
    staleAfterMs: overrides.staleAfterMs ?? DEFAULT_GOVERNOR_PARAMS.staleAfterMs,
    senseIntervalMs: overrides.senseIntervalMs ?? DEFAULT_GOVERNOR_PARAMS.senseIntervalMs,
    maxConcurrency: overrides.maxConcurrency ?? DEFAULT_GOVERNOR_PARAMS.maxConcurrency,
    paramsVersion: overrides.paramsVersion ?? DEFAULT_GOVERNOR_PARAMS.paramsVersion,
  };
}

function resolveGovernorMode(value: unknown): GovernorMode {
  if (value && typeof value === "object" && (value as { mode?: unknown }).mode === "enforce") {
    return "enforce";
  }
  return "shadow";
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/** `bucketHolds` has no dedicated column, so it round-trips through `inputs` jsonb. */
function extractBucketHolds(row: Pick<FleetThrottleStateRow, "inputs"> | null | undefined): string[] {
  const inputs = row?.inputs as { bucketHolds?: unknown } | null | undefined;
  const raw = inputs?.bucketHolds;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

function serializeSnapshotsForAudit(snapshots: LimitSnapshot[]): Record<string, unknown>[] {
  return snapshots.map((snapshot) => ({
    window: snapshot.window,
    provider: snapshot.provider,
    modelScope: snapshot.modelScope,
    usedPct: snapshot.usedPct,
    resetsAt: snapshot.resetsAt ? snapshot.resetsAt.toISOString() : null,
    observedAt: snapshot.observedAt.toISOString(),
    source: snapshot.source,
  }));
}

export interface SenseResult {
  /** false when the provider failed and only the failure row was written. */
  ok: boolean;
  snapshots: FleetLimitSnapshotRow[];
}

export interface EvaluateResult {
  decision: GovernorDecision;
  persisted: boolean;
  mode: GovernorMode;
  params: GovernorParams;
}

export interface TickResult {
  ok: boolean;
  sense?: SenseResult;
  evaluation?: EvaluateResult;
  error?: string;
}

export interface FleetGovernorStatusSnapshot {
  provider: string;
  window: string;
  modelScope: string | null;
  usedPct: number | null;
  resetsAt: Date | null;
  resetsAtPacific: string | null;
  observedAt: Date;
  source: string;
  ok: boolean;
  stale: boolean;
}

function formatPacificReset(resetsAt: Date | null): string | null {
  if (!resetsAt) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(resetsAt);
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute} ${fields.timeZoneName}`;
}

/** Last blocked (`allowed: false`) admission verdict, for operator visibility. */
export interface FleetAdmissionLastBlock {
  at: Date;
  agentId: string;
  reason: string;
}

export interface FleetGovernorStatus {
  mode: GovernorMode;
  params: GovernorParams;
  snapshots: FleetGovernorStatusSnapshot[];
  providers: Record<string, { snapshots: FleetGovernorStatusSnapshot[] }>;
  latestDecision: FleetThrottleStateRow | null;
  nextDueAt: Date;
  /** Cumulative count of getAdmission() calls that returned allowed:true. */
  admissionsAllowed: number;
  /** Cumulative count of getAdmission() calls that returned allowed:false (enforce mode only). */
  admissionsBlocked: number;
  /** Cumulative count of getAdmission() calls where the admission rules evaluated to "block" (shadow mode). */
  admissionsWouldBlock: number;
  lastBlock: FleetAdmissionLastBlock | null;
}

export interface FleetGovernorServiceDeps {
  db: Db;
  logger: FleetGovernorLogger;
  /** Defaults to `fetchAllQuotaWindows` (aggregates every registered adapter's quota). */
  fetchQuota?: () => Promise<ProviderQuotaResult[]>;
  /** Defaults to `() => new Date()`. Inject for deterministic tests. */
  now?: () => Date;
}

export interface GetAdmissionInput {
  companyId: string;
  agentId: string;
  projectId?: string | null;
}

export interface FleetGovernorService {
  senseOnce(): Promise<SenseResult>;
  evaluate(): Promise<EvaluateResult>;
  tick(): Promise<TickResult>;
  start(): () => void;
  getStatus(): Promise<FleetGovernorStatus>;
  getAdmission(input: GetAdmissionInput): Promise<FleetAdmission>;
}

/** Minimal shape of the latest decision, cached in-memory by evaluate() for getAdmission(). */
interface CachedDecision {
  ts: Date;
  state: ThrottleState;
  reason: string;
  fiveHourPct: number | null;
}

export function createFleetGovernorService(deps: FleetGovernorServiceDeps): FleetGovernorService {
  const fetchQuota = deps.fetchQuota ?? fetchAllQuotaWindows;
  const now = () => deps.now?.() ?? new Date();

  // In-memory cache of the latest decision, refreshed on every evaluate()
  // (i.e. every tick()). getAdmission() reads this first and only falls back
  // to the database when this process has not ticked yet (e.g. right after
  // startup, or in a process that only serves getAdmission()).
  let lastDecisionCache: CachedDecision | null = null;

  const admissionCounters: {
    allowed: number;
    blocked: number;
    wouldBlock: number;
    lastBlock: FleetAdmissionLastBlock | null;
  } = { allowed: 0, blocked: 0, wouldBlock: 0, lastBlock: null };

  async function loadSettingsValue(key: string): Promise<Record<string, unknown> | null> {
    const rows = await deps.db.select().from(fleetSettings).where(eq(fleetSettings.key, key)).limit(1);
    return (rows[0]?.value as Record<string, unknown> | undefined) ?? null;
  }

  async function loadEffectiveParams(): Promise<GovernorParams> {
    const value = await loadSettingsValue(GOVERNOR_PARAMS_SETTINGS_KEY);
    return mergeGovernorParams(value as Partial<GovernorParams> | null);
  }

  async function loadEffectiveMode(): Promise<GovernorMode> {
    const value = await loadSettingsValue(GOVERNOR_MODE_SETTINGS_KEY);
    return resolveGovernorMode(value);
  }

  async function loadLatestOkSnapshots(asOf: Date): Promise<FleetLimitSnapshotRow[]> {
    const cutoff = new Date(asOf.getTime() - SNAPSHOT_LOOKBACK_MS);
    const rows = await deps.db
      .select()
      .from(fleetLimitSnapshots)
      .where(and(eq(fleetLimitSnapshots.ok, true), gte(fleetLimitSnapshots.observedAt, cutoff)))
      .orderBy(desc(fleetLimitSnapshots.observedAt));
    const byProviderWindow = new Map<string, FleetLimitSnapshotRow>();
    for (const row of rows) {
      const key = `${row.provider}\u0000${row.window}`;
      if (!byProviderWindow.has(key)) byProviderWindow.set(key, row);
    }
    return [...byProviderWindow.values()];
  }

  async function loadLatestThrottleStateRow(): Promise<FleetThrottleStateRow | null> {
    const rows = await deps.db
      .select()
      .from(fleetThrottleStates)
      .where(eq(fleetThrottleStates.provider, "anthropic"))
      .orderBy(desc(fleetThrottleStates.ts))
      .limit(1);
    return rows[0] ?? null;
  }

  async function recordProviderFailure(asOf: Date, err: unknown): Promise<SenseResult> {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger.warn({ err: message }, "fleet governor: quota sensing failed");
    const inserted = await deps.db
      .insert(fleetLimitSnapshots)
      .values({
        provider: "anthropic",
        window: "seven_day",
        modelScope: null,
        usedPct: null,
        resetsAt: null,
        source: "anthropic",
        ok: false,
        error: message,
        raw: null,
        observedAt: asOf,
      })
      .returning();
    return { ok: false, snapshots: inserted };
  }

  async function senseOnce(): Promise<SenseResult> {
    const asOf = now();
    let results: ProviderQuotaResult[];
    try {
      results = await fetchQuota();
    } catch (err) {
      return recordProviderFailure(asOf, err);
    }

    const anthropic = results.find((result) => result.provider === "anthropic");
    if (!anthropic) {
      return recordProviderFailure(asOf, "no anthropic provider quota result");
    }
    if (anthropic.ok !== true) {
      return recordProviderFailure(asOf, anthropic.error ?? "anthropic quota provider reported failure");
    }

    const values: (typeof fleetLimitSnapshots.$inferInsert)[] = [];
    for (const window of anthropic.windows) {
      const key = resolveSenseWindowKey(window);
      if (!key) continue;
      values.push({
        provider: anthropic.provider,
        window: key,
        modelScope: modelScopeForWindow(key),
        usedPct: window.usedPercent,
        resetsAt: window.resetsAt ? new Date(window.resetsAt) : null,
        source: anthropic.source ?? "anthropic",
        ok: true,
        error: null,
        raw: window as unknown as Record<string, unknown>,
        observedAt: asOf,
      });
    }

    if (values.length === 0) {
      deps.logger.warn(
        { windowLabels: anthropic.windows.map((window) => window.label) },
        "fleet governor: quota provider returned no mappable windows",
      );
      return { ok: true, snapshots: [] };
    }

    const inserted = await deps.db.insert(fleetLimitSnapshots).values(values).returning();
    deps.logger.debug({ count: inserted.length }, "fleet governor: recorded quota snapshots");
    return { ok: true, snapshots: inserted };
  }

  async function evaluate(): Promise<EvaluateResult> {
    const asOf = now();
    const [params, mode, latestRows, previousRow] = await Promise.all([
      loadEffectiveParams(),
      loadEffectiveMode(),
      loadLatestOkSnapshots(asOf),
      loadLatestThrottleStateRow(),
    ]);

    const policySnapshots = toPolicySnapshots(latestRows);
    const previousState: ThrottleState | null = (previousRow?.state as ThrottleState | undefined) ?? null;
    const priorInputs = previousRow?.inputs as { capPct?: unknown } | null | undefined;
    const previousCapPct = typeof priorInputs?.capPct === "number" ? priorInputs.capPct : null;
    const decision = decideThrottle({ snapshots: policySnapshots, previousState, previousCapPct, params, now: asOf });

    // Refresh the in-memory admission cache on every evaluate(), whether or
    // not the decision changed enough to persist — getAdmission() needs the
    // freshest decision timestamp to judge staleness correctly.
    lastDecisionCache = {
      ts: asOf,
      state: decision.state,
      reason: decision.reason,
      fiveHourPct: decision.fiveHourPct,
    };

    const changed =
      !previousRow ||
      previousRow.state !== decision.state ||
      previousRow.stale !== decision.stale ||
      previousRow.floorActive !== decision.floorActive ||
      previousRow.reason !== decision.reason ||
      previousRow.paramsVersion !== decision.paramsVersion ||
      !sameStringArray(extractBucketHolds(previousRow), decision.bucketHolds);

    const heartbeatDue =
      previousRow != null && asOf.getTime() - previousRow.ts.getTime() > THROTTLE_STATE_HEARTBEAT_MS;

    const persisted = changed || heartbeatDue;

    if (persisted) {
      await deps.db.insert(fleetThrottleStates).values({
        provider: "anthropic",
        ts: asOf,
        mode,
        state: decision.state,
        stale: decision.stale,
        pace: decision.pace,
        fiveHourPct: decision.fiveHourPct,
        sevenDayPct: decision.sevenDayPct,
        floorActive: decision.floorActive,
        reason: decision.reason,
        paramsVersion: decision.paramsVersion,
        inputs: {
          snapshots: serializeSnapshotsForAudit(policySnapshots),
          params,
          bucketHolds: decision.bucketHolds,
          capPct: decision.capPct,
        },
        launchParameters: decision.launchParameters as unknown as Record<string, unknown>,
      });
    }

    if (changed) {
      deps.logger.info(
        { state: decision.state, reason: decision.reason, mode, persisted },
        "fleet governor: throttle decision changed",
      );
    } else {
      deps.logger.debug(
        { state: decision.state, persisted },
        "fleet governor: throttle decision unchanged",
      );
    }

    return { decision, persisted, mode, params };
  }

  let tickInFlight: Promise<TickResult> | null = null;

  async function runTick(): Promise<TickResult> {
    try {
      const sense = await senseOnce();
      const evaluation = await evaluate();
      return { ok: true, sense, evaluation };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error({ err: message }, "fleet governor: tick failed");
      return { ok: false, error: message };
    }
  }

  /** senseOnce() then evaluate(); never throws. Concurrent calls share one in-flight tick. */
  async function tick(): Promise<TickResult> {
    if (tickInFlight) return tickInFlight;
    tickInFlight = runTick();
    try {
      return await tickInFlight;
    } finally {
      tickInFlight = null;
    }
  }

  function start(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = async () => {
      if (stopped) return;
      const asOf = now();
      let params = DEFAULT_GOVERNOR_PARAMS;
      let latestMap: Map<FleetWindow, LimitSnapshot> = new Map();
      try {
        params = await loadEffectiveParams();
        const rows = await loadLatestOkSnapshots(asOf);
        latestMap = latestSnapshotByWindow(toPolicySnapshots(rows));
      } catch (err) {
        deps.logger.error({ err }, "fleet governor: failed to load state while scheduling next sense; using defaults");
      }
      if (stopped) return;
      const nextDue = nextSenseDueAt(latestMap, asOf, params);
      const delayMs = Math.max(0, nextDue.getTime() - asOf.getTime());
      timer = setTimeout(() => {
        void runAndReschedule();
      }, delayMs);
      timer.unref?.();
    };

    const runAndReschedule = async () => {
      if (stopped) return;
      await tick();
      await scheduleNext();
    };

    void runAndReschedule();

    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }

  async function getStatus(): Promise<FleetGovernorStatus> {
    const asOf = now();
    const [params, mode, latestRows, latestDecision] = await Promise.all([
      loadEffectiveParams(),
      loadEffectiveMode(),
      loadLatestOkSnapshots(asOf),
      loadLatestThrottleStateRow(),
    ]);

    const snapshots: FleetGovernorStatusSnapshot[] = latestRows.map((row) => ({
      provider: row.provider,
      window: row.window,
      modelScope: row.modelScope ?? modelScopeForWindow(row.window),
      usedPct: row.usedPct,
      resetsAt: row.resetsAt,
      resetsAtPacific: formatPacificReset(row.resetsAt),
      observedAt: row.observedAt,
      source: row.source,
      ok: row.ok,
      // Mirrors policy.isStale's rule (FR-1.3), applied per-window for display.
      stale: asOf.getTime() - row.observedAt.getTime() > params.staleAfterMs,
    }));
    const providers = Object.create(null) as FleetGovernorStatus["providers"];
    for (const snapshot of snapshots) {
      const provider = providers[snapshot.provider] ??= { snapshots: [] };
      provider.snapshots.push(snapshot);
    }

    const latestMap = latestSnapshotByWindow(toPolicySnapshots(latestRows));
    const nextDueAt = nextSenseDueAt(latestMap, asOf, params);

    return {
      mode,
      params,
      snapshots,
      providers,
      latestDecision,
      nextDueAt,
      admissionsAllowed: admissionCounters.allowed,
      admissionsBlocked: admissionCounters.blocked,
      admissionsWouldBlock: admissionCounters.wouldBlock,
      lastBlock: admissionCounters.lastBlock,
    };
  }

  /** FLEET_CLASS from a project's env jsonb (task 2), defaulting to P2. */
  async function resolveProjectClass(
    projectId: string | null | undefined,
    companyId: string,
  ): Promise<ProjectClass> {
    if (!projectId) return "P2";
    const rows = await deps.db
      .select({ env: projects.env })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    const env = rows[0]?.env as Record<string, unknown> | null | undefined;
    const raw = env?.FLEET_CLASS;
    let value: unknown = raw;
    if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "plain") {
      value = (raw as { value?: unknown }).value;
    }
    return value === "P0" || value === "P1" ? value : "P2";
  }

  /**
   * Run admission (task 2): a read of the governor's latest decision, not a
   * new policy computation. Never dispatches, cancels, or mutates anything —
   * callers (heartbeat.ts) decide what "not allowed" means for a run.
   */
  async function getAdmission(input: GetAdmissionInput): Promise<FleetAdmission> {
    const asOf = now();
    const [params, mode, projectClass] = await Promise.all([
      loadEffectiveParams(),
      loadEffectiveMode(),
      resolveProjectClass(input.projectId, input.companyId),
    ]);

    let decisionTs: Date | null = null;
    let state: ThrottleState | null = null;
    let decisionReason = "";
    let fiveHourPct: number | null = null;

    if (lastDecisionCache) {
      decisionTs = lastDecisionCache.ts;
      state = lastDecisionCache.state;
      decisionReason = lastDecisionCache.reason;
      fiveHourPct = lastDecisionCache.fiveHourPct;
    } else {
      const row = await loadLatestThrottleStateRow();
      if (row) {
        decisionTs = row.ts;
        state = row.state as ThrottleState;
        decisionReason = row.reason;
        fiveHourPct = row.fiveHourPct;
      }
    }

    const stale = decisionTs == null || asOf.getTime() - decisionTs.getTime() > params.staleAfterMs;
    const floorActive = fiveHourPct != null && fiveHourPct >= params.floor5h;

    let blocked: boolean;
    let ruleReason: string;
    if (stale) {
      blocked = true;
      ruleReason =
        state != null
          ? `stale: last governor decision (${state}) is older than staleAfterMs (${Math.round(
              params.staleAfterMs / 60000,
            )} min); holding new work until sensing resumes.`
          : `stale: no governor decision recorded yet; holding new work until sensing resumes.`;
    } else if (state === "STALE") {
      blocked = true;
      ruleReason = `STALE: ${decisionReason}`;
    } else if (state === "RED") {
      blocked = true;
      ruleReason = `RED: ${decisionReason}`;
    } else if (floorActive) {
      blocked = true;
      ruleReason = `floor: 5h utilization ${fiveHourPct}% >= floor_5h (${params.floor5h}%).`;
    } else if (state === "CAPPED") {
      blocked = true;
      ruleReason = `CAPPED blocks new work: ${decisionReason}`;
    } else {
      blocked = false;
      ruleReason = `${state ?? "OPEN"}: admitted (project class ${projectClass}).`;
    }

    const allowed = mode === "shadow" ? true : !blocked;
    const reason =
      mode === "shadow" && blocked ? `shadow: would block — ${ruleReason}` : ruleReason;

    if (allowed) {
      admissionCounters.allowed += 1;
    } else {
      admissionCounters.blocked += 1;
      admissionCounters.lastBlock = { at: asOf, agentId: input.agentId, reason };
    }
    if (mode === "shadow" && blocked) {
      admissionCounters.wouldBlock += 1;
    }

    return { allowed, mode, state, stale, reason, projectClass, wouldBlock: blocked };
  }

  return { senseOnce, evaluate, tick, start, getStatus, getAdmission };
}

/** Upserts a `fleet_settings` row. Shared by the settings PATCH route. */
/**
 * One governor per database handle. Startup wiring and the HTTP routes must
 * share the same instance so the in-flight tick guard actually prevents a
 * manual `/api/fleet/sense` from overlapping the scheduler's tick and writing
 * duplicate snapshot/throttle rows.
 */
const sharedGovernorInstances = new WeakMap<object, FleetGovernorService>();

export function getSharedFleetGovernorService(deps: FleetGovernorServiceDeps): FleetGovernorService {
  const key = deps.db as unknown as object;
  const existing = sharedGovernorInstances.get(key);
  if (existing) return existing;
  const created = createFleetGovernorService(deps);
  sharedGovernorInstances.set(key, created);
  return created;
}

export async function upsertFleetSetting(
  db: Db,
  key: string,
  value: Record<string, unknown>,
  updatedBy: string | null,
): Promise<void> {
  await db
    .insert(fleetSettings)
    .values({ key, value, version: randomUUID(), updatedAt: new Date(), updatedBy })
    .onConflictDoUpdate({
      target: fleetSettings.key,
      set: { value, version: randomUUID(), updatedAt: new Date(), updatedBy },
    });
}

/** Raw (un-merged-with-defaults) stored value for a `fleet_settings` key, or null. */
export async function getRawFleetSettingValue(
  db: Db,
  key: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db.select().from(fleetSettings).where(eq(fleetSettings.key, key)).limit(1);
  return (rows[0]?.value as Record<string, unknown> | undefined) ?? null;
}

/** Snapshot rows observed within the last `hours` (all sources, ok and failure), newest first. */
export async function listFleetLimitSnapshots(
  db: Db,
  opts: { hours: number },
): Promise<FleetLimitSnapshotRow[]> {
  const cutoff = new Date(Date.now() - opts.hours * 60 * 60 * 1000);
  return db
    .select()
    .from(fleetLimitSnapshots)
    .where(gte(fleetLimitSnapshots.observedAt, cutoff))
    .orderBy(desc(fleetLimitSnapshots.observedAt));
}

/** Throttle-state rows, newest first, capped at `limit`. */
export async function listFleetThrottleStates(
  db: Db,
  opts: { limit: number },
): Promise<FleetThrottleStateRow[]> {
  return db.select().from(fleetThrottleStates).orderBy(desc(fleetThrottleStates.ts)).limit(opts.limit);
}
