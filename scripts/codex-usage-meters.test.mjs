import assert from "node:assert/strict";
import test from "node:test";
import { snapshotFromRateLimits } from "./codex-usage-meters.mjs";

const observedAt = "2026-09-27T00:00:00.000Z";
const window = (windowDurationMins, usedPercent, resetsAt = 1790553600) => ({
  windowDurationMins, usedPercent, resetsAt,
});

test("maps duration rather than primary or secondary slot", () => {
  assert.deepEqual(snapshotFromRateLimits({ rateLimits: {
    limitId: "codex", primary: window(10080, 19), secondary: window(300, 0.5),
  } }, observedAt), [
    { provider: "openai", window: "seven_day", usedPct: 19,
      resetsAt: "2026-09-28T00:00:00.000Z", source: "codex-app-server:codex", observedAt },
    { provider: "openai", window: "five_hour", usedPct: 0.5,
      resetsAt: "2026-09-28T00:00:00.000Z", source: "codex-app-server:codex", observedAt },
  ]);
});

test("deduplicates the backward compatible single bucket", () => {
  const bucket = { limitId: "codex", primary: window(10080, 19), secondary: null };
  assert.equal(snapshotFromRateLimits({ rateLimits: bucket,
    rateLimitsByLimitId: { codex: bucket },
  }, observedAt).length, 1);
});

test("omits absent five-hour data and unsupported durations", () => {
  assert.deepEqual(snapshotFromRateLimits({ rateLimitsByLimitId: {
    codex: { primary: window(10080, 19), secondary: null },
    other: { primary: window(15, 42) },
  } }, observedAt).map((row) => row.window), ["seven_day"]);
});

test("keeps distinct metered bucket IDs visible in source", () => {
  const rows = snapshotFromRateLimits({ rateLimitsByLimitId: {
    codex: { primary: window(300, 20) },
    codex_other: { primary: window(300, 42) },
  } }, observedAt);
  assert.deepEqual(rows.map((row) => row.source), [
    "codex-app-server:codex", "codex-app-server:codex_other",
  ]);
});

test("skips malformed percentages, timestamps, and buckets", () => {
  assert.deepEqual(snapshotFromRateLimits({ rateLimitsByLimitId: {
    codex: { primary: window(300, -1), secondary: window(10080, 50, "bad") },
    other: null,
  } }, observedAt), []);
});
