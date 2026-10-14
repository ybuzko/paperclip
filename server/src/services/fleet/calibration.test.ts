import { describe, expect, it } from "vitest";
import { fitCalibration, ratioBetweenWindows, type CalibrationSnapshot,
  type CalibrationUsagePoint } from "./calibration.js";

const start = Date.parse("2026-09-01T00:00:00Z");
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();

function seededNoise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32 - 0.5;
  };
}

describe("fitCalibration", () => {
  it("uses the 95% Student t quantile with n-1 degrees of freedom", () => {
    const snapshots = [0, 1, 4].map((usedPct, i) => ({ observedAt: at(i * 5), usedPct }));
    const usage = [5, 10].map((minute) => ({ at: at(minute), weightedUnits: 1 }));
    const result = fitCalibration(snapshots, usage, 2);
    expect(result.fit!.pctPerWeightedUnit).toBe(2);
    expect(result.fit!.n).toBe(2);
    expect(result.fit!.ci95.lower).toBeCloseTo(2 - 12.706204736, 6);
    expect(result.fit!.ci95.upper).toBeCloseTo(2 + 12.706204736, 6);
  });

  it("fits a known slope with noisy observations and a Student t interval containing truth", () => {
    const noise = seededNoise(17);
    const snapshots: CalibrationSnapshot[] = [{ observedAt: at(0), usedPct: 0 }];
    const usage: CalibrationUsagePoint[] = [];
    const unitsByInterval = Array.from({ length: 50 }, (_, i) => 0.5 + ((i + 1) % 5) * 0.2);
    const noiseByInterval = unitsByInterval.map(() => noise());
    const noiseOffset = noiseByInterval.reduce((sum, value, i) =>
      sum + value * unitsByInterval[i]!, 0) / unitsByInterval.reduce((sum, value) => sum + value, 0);
    let pct = 0;
    for (let i = 1; i <= 50; i++) {
      const units = unitsByInterval[i - 1]!;
      pct += 0.3 * units + (noiseByInterval[i - 1]! - noiseOffset) * 0.12;
      snapshots.push({ observedAt: at(i * 10), usedPct: pct });
      usage.push({ at: at(i * 10), weightedUnits: units });
    }
    const result = fitCalibration(snapshots, usage);
    expect(result.fit).not.toBeNull();
    expect(result.fit!.n).toBe(50);
    expect(result.fit!.ci95.lower).toBeLessThan(0.3);
    expect(result.fit!.ci95.upper).toBeGreaterThan(0.3);
    expect(result.fit!.coverage).toBe(1);
    expect(result.fit!.r2).toBeGreaterThan(0.8);
  });

  it("excludes a large drop and a known reset boundary", () => {
    const snapshots: CalibrationSnapshot[] = [
      { observedAt: at(0), usedPct: 70, resetsAt: at(25) },
      { observedAt: at(10), usedPct: 72 },
      { observedAt: at(20), usedPct: 74 },
      { observedAt: at(30), usedPct: 1 }, // Crosses known reset and drops >50.
      { observedAt: at(40), usedPct: 3 },
      { observedAt: at(50), usedPct: 5 },
    ];
    const usage = [10, 20, 30, 40, 50].map((minute) => ({
      at: at(minute), weightedUnits: minute === 30 ? 100 : 2,
    }));
    const fit = fitCalibration(snapshots, usage);
    expect(fit.fit).toMatchObject({ n: 4, pctPerWeightedUnit: 1, coverage: 1 });
    expect(fit.fit!.ci95).toEqual({ lower: 1, upper: 1 });
  });

  it("recovers slope from 200 integer-rounded percentage pairs", () => {
    const snapshots: CalibrationSnapshot[] = [{ observedAt: at(0), usedPct: 0 }];
    const usage: CalibrationUsagePoint[] = [];
    let actual = 0;
    for (let i = 1; i <= 200; i++) {
      const units = 0.8 + (i % 7) * 0.1;
      actual += units * 0.36;
      snapshots.push({ observedAt: at(i * 5), usedPct: Math.round(actual) });
      usage.push({ at: at(i * 5), weightedUnits: units });
    }
    const fit = fitCalibration(snapshots, usage);
    expect(fit.fit!.n).toBe(200);
    expect(Math.abs(fit.fit!.pctPerWeightedUnit - 0.36) / 0.36).toBeLessThan(0.1);
  });

  it("returns a reason for insufficient pairs and excludes zero-unit intervals from coverage", () => {
    const snapshots = [0, 2, 4, 6].map((usedPct, i) => ({ observedAt: at(i * 5), usedPct }));
    const usage = [{ at: at(5), weightedUnits: 2 }, { at: at(15), weightedUnits: 2 }];
    expect(fitCalibration(snapshots, usage)).toEqual({ fit: null, reason: "insufficient_pairs" });
    const result = fitCalibration(snapshots, usage, 2);
    expect(result.fit).toMatchObject({ n: 2, coverage: 4 / 6 });
    expect(fitCalibration(snapshots, [])).toEqual({ fit: null, reason: "zero_units" });
  });

  it("excludes a known reset boundary even when observed percentages do not fall", () => {
    const snapshots = [
      { observedAt: at(0), usedPct: 1, resetsAt: at(12) },
      { observedAt: at(10), usedPct: 3 },
      { observedAt: at(20), usedPct: 5 },
      { observedAt: at(30), usedPct: 7 },
    ];
    const usage = [10, 20, 30].map((minute) => ({
      at: at(minute), weightedUnits: minute === 20 ? 100 : 2,
    }));
    expect(fitCalibration(snapshots, usage, 2).fit).toMatchObject({ n: 2, pctPerWeightedUnit: 1 });
  });

  it("skips malformed and negative intervals without bridging them", () => {
    const snapshots = [
      { observedAt: at(0), usedPct: 10 },
      { observedAt: at(5), usedPct: 12 },
      { observedAt: at(10), usedPct: Number.NaN },
      { observedAt: at(15), usedPct: 15 },
      { observedAt: at(20), usedPct: 14 },
      { observedAt: at(25), usedPct: 16 },
    ];
    const usage = [5, 10, 15, 20, 25].map((minute) => ({ at: at(minute), weightedUnits: 2 }));
    expect(fitCalibration(snapshots, usage, 2).fit).toMatchObject({ n: 2, pctPerWeightedUnit: 1 });
  });
});

describe("ratioBetweenWindows", () => {
  it("recovers the measured 5h-to-weekly fixture ratio on shared timestamps", () => {
    const a = [0, 1.96, 3.92, 5.88].map((usedPct, i) => ({ observedAt: at(i * 10), usedPct }));
    const b = [0, 10, 20, 30].map((usedPct, i) => ({ observedAt: at(i * 10), usedPct }));
    expect(ratioBetweenWindows(a, b)).toMatchObject({ ratio: 0.196, pairs: 3, reason: null });
  });

  it("excludes resets and gaps of exactly 15 minutes", () => {
    const a = [
      { observedAt: at(0), usedPct: 70, resetsAt: at(12) },
      { observedAt: at(10), usedPct: 72 },
      { observedAt: at(20), usedPct: 1 },
      { observedAt: at(35), usedPct: 2 },
    ];
    const b = [
      { observedAt: at(0), usedPct: 10 },
      { observedAt: at(10), usedPct: 20 },
      { observedAt: at(20), usedPct: 30 },
      { observedAt: at(35), usedPct: 40 },
    ];
    expect(ratioBetweenWindows(a, b)).toEqual({ ratio: 0.2, pairs: 1, reason: null });
  });

  it("reports zero denominator and no common eligible pairs", () => {
    const a = [0, 2].map((usedPct, i) => ({ observedAt: at(i * 5), usedPct }));
    const b = [0, 0].map((usedPct, i) => ({ observedAt: at(i * 5), usedPct }));
    expect(ratioBetweenWindows(a, b)).toEqual({ ratio: null, pairs: 1, reason: "zero_denominator" });
    expect(ratioBetweenWindows(a, [{ observedAt: at(50), usedPct: 1 }]))
      .toEqual({ ratio: null, pairs: 0, reason: "no_common_pairs" });
  });
});
