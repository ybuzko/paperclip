/** A provider/window reading. `resetsAt` is an optional known reset boundary. */
export interface CalibrationSnapshot {
  observedAt: string;
  usedPct: number;
  resetsAt?: string | null;
}

/** Weighted usage attributed to the instant `at`. */
export interface CalibrationUsagePoint {
  at: string;
  weightedUnits: number;
}

export interface CalibrationFit {
  /** Percentage points consumed per weighted usage unit. */
  pctPerWeightedUnit: number;
  ci95: { lower: number; upper: number };
  n: number;
  /** Uncentered R²: 1 - SSE / sum(deltaPct²), appropriate for a fit through zero. */
  r2: number;
  /** Positive movement with measured units / all positive movement in valid, non-reset pairs. */
  coverage: number;
}

export type CalibrationResult =
  | { fit: CalibrationFit; reason: null }
  | { fit: null; reason: "insufficient_pairs" | "zero_units" };

export interface WindowRatioResult {
  ratio: number | null;
  pairs: number;
  reason: "no_common_pairs" | "zero_denominator" | null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validSnapshot(value: CalibrationSnapshot): { at: number; pct: number } | null {
  const at = timestamp(value?.observedAt);
  const pct = value?.usedPct;
  return at !== null && typeof pct === "number" && Number.isFinite(pct)
    && pct >= 0 && pct <= 100 ? { at, pct } : null;
}

function resetBoundaries(snapshots: readonly CalibrationSnapshot[]): number[] {
  return snapshots.map((point) => timestamp(point?.resetsAt)).filter((at): at is number => at !== null);
}

function crossesReset(from: number, to: number, boundaries: readonly number[]): boolean {
  return boundaries.some((reset) => from < reset && reset <= to);
}

function intervalDelta(
  first: CalibrationSnapshot,
  second: CalibrationSnapshot,
  boundaries: readonly number[],
): { from: number; to: number; delta: number } | null {
  const a = validSnapshot(first);
  const b = validSnapshot(second);
  if (!a || !b || b.at <= a.at || a.pct - b.pct > 50
    || crossesReset(a.at, b.at, boundaries)) return null;
  const delta = b.pct - a.pct;
  return delta >= 0 ? { from: a.at, to: b.at, delta } : null;
}

// Lanczos log-gamma and a continued-fraction regularized beta give a Student t
// quantile without runtime dependencies. The CI uses df = n - 1.
function logGamma(z: number): number {
  const p = [0.9999999999998099, 676.5203681218851, -1259.1392167224028,
    771.3234287776531, -176.6150291621406, 12.5073432786869,
    -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = p[0]!;
  for (let i = 1; i < p.length; i++) x += p[i]! / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-30;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let term = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + term * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + term / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    result *= d * c;
    term = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + term * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + term / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    result *= step;
    if (Math.abs(step - 1) < 1e-12) break;
  }
  return result;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const scale = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2)
    ? scale * betaFraction(a, b, x) / a
    : 1 - scale * betaFraction(b, a, 1 - x) / b;
}

function studentT975(df: number): number {
  let low = 0;
  let high = 1;
  const cdf = (t: number) => 1 - regularizedBeta(df / (df + t * t), df / 2, 0.5) / 2;
  while (cdf(high) < 0.975) high *= 2;
  for (let i = 0; i < 70; i++) {
    const mid = (low + high) / 2;
    if (cdf(mid) < 0.975) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Fit percentage-point movement to measured weighted units through the origin.
 * All valid, non-reset consecutive pairs contribute to the coverage denominator;
 * only pairs with positive measured units enter the regression. */
export function fitCalibration(
  snapshots: readonly CalibrationSnapshot[],
  usage: readonly CalibrationUsagePoint[],
  minPairs = 3,
): CalibrationResult {
  const boundaries = resetBoundaries(snapshots);
  const points = usage.map((point) => ({ at: timestamp(point?.at), units: point?.weightedUnits }))
    .filter((point): point is { at: number; units: number } => point.at !== null
      && typeof point.units === "number" && Number.isFinite(point.units) && point.units >= 0);
  const pairs: { units: number; delta: number }[] = [];
  let totalMovement = 0;
  let coveredMovement = 0;
  for (let i = 1; i < snapshots.length; i++) {
    const interval = intervalDelta(snapshots[i - 1]!, snapshots[i]!, boundaries);
    if (!interval) continue;
    const units = points.reduce((sum, point) => sum + (
      interval.from < point.at && point.at <= interval.to ? point.units : 0), 0);
    totalMovement += interval.delta;
    if (units <= 0) continue;
    coveredMovement += interval.delta;
    pairs.push({ units, delta: interval.delta });
  }
  if (pairs.length === 0 && totalMovement > 0) return { fit: null, reason: "zero_units" };
  const requiredPairs = Number.isInteger(minPairs) ? Math.max(2, minPairs) : 3;
  if (pairs.length < requiredPairs) return { fit: null, reason: "insufficient_pairs" };
  const sumXX = pairs.reduce((sum, pair) => sum + pair.units ** 2, 0);
  if (sumXX <= 0 || !Number.isFinite(sumXX)) return { fit: null, reason: "zero_units" };
  const slope = pairs.reduce((sum, pair) => sum + pair.units * pair.delta, 0) / sumXX;
  const sse = pairs.reduce((sum, pair) => sum + (pair.delta - slope * pair.units) ** 2, 0);
  const sumYY = pairs.reduce((sum, pair) => sum + pair.delta ** 2, 0);
  const standardError = Math.sqrt(sse / (pairs.length - 1) / sumXX);
  const margin = studentT975(pairs.length - 1) * standardError;
  return { fit: {
    pctPerWeightedUnit: slope,
    ci95: { lower: slope - margin, upper: slope + margin },
    n: pairs.length,
    r2: sumYY === 0 ? 1 : 1 - sse / sumYY,
    coverage: totalMovement === 0 ? 0 : coveredMovement / totalMovement,
  }, reason: null };
}

/** Ratio of non-negative percentage movement on common, strictly sub-15-minute intervals. */
export function ratioBetweenWindows(
  a: readonly CalibrationSnapshot[],
  b: readonly CalibrationSnapshot[],
): WindowRatioResult {
  const bByTime = new Map(b.map((point) => [timestamp(point?.observedAt), point]));
  const shared = a.filter((point) => {
    const time = timestamp(point?.observedAt);
    return time !== null && bByTime.has(time);
  });
  const aBoundaries = resetBoundaries(a);
  const bBoundaries = resetBoundaries(b);
  let numerator = 0;
  let denominator = 0;
  let pairs = 0;
  for (let i = 1; i < shared.length; i++) {
    const first = shared[i - 1]!;
    const second = shared[i]!;
    const x = intervalDelta(first, second, aBoundaries);
    const y = intervalDelta(bByTime.get(timestamp(first.observedAt))!,
      bByTime.get(timestamp(second.observedAt))!, bBoundaries);
    if (!x || !y || x.to - x.from >= 15 * 60 * 1000) continue;
    numerator += x.delta;
    denominator += y.delta;
    pairs++;
  }
  if (pairs === 0) return { ratio: null, pairs, reason: "no_common_pairs" };
  if (denominator === 0) return { ratio: null, pairs, reason: "zero_denominator" };
  return { ratio: numerator / denominator, pairs, reason: null };
}
