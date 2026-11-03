import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexRateLimits, snapshotFromRateLimits } from "./codex-usage-meters.mjs";

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

test("keeps a bucket whose ID matches an inherited object key", () => {
  assert.deepEqual(snapshotFromRateLimits({ rateLimits: {
    limitId: "toString", primary: window(300, 3),
  } }, observedAt).map((row) => row.source), ["codex-app-server:toString"]);
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

async function fakeCodex(mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-meter-test-"));
  const command = path.join(dir, "fake-codex.mjs");
  const trace = path.join(dir, "trace.json");
  const pidFile = path.join(dir, "pid");
  const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const mode = ${JSON.stringify(mode)};
const trace = ${JSON.stringify(trace)};
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const seen = [];
if (mode === "timeout") process.on("SIGTERM", () => {});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  seen.push(message);
  writeFileSync(trace, JSON.stringify(seen));
  if (mode === "early-exit") process.exit(0);
  if (mode === "timeout") return;
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  } else if (message.method === "account/rateLimits/read") {
    const response = mode === "rpc-error"
      ? { id: message.id, error: { code: -32000, message: "private upstream detail" } }
      : { id: message.id, result: { rateLimits: { limitId: "codex", primary:
        { windowDurationMins: 10080, usedPercent: 19, resetsAt: 1791070000 } } } };
    process.stdout.write(JSON.stringify(response) + "\\n");
  }
});
`;
  await writeFile(command, script, { mode: 0o755 });
  return { command, trace, pidFile, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("transport sends initialize, initialized, then the rate-limit read", async () => {
  const fixture = await fakeCodex("success");
  try {
    const result = await readCodexRateLimits({ command: fixture.command, timeoutMs: 2000 });
    assert.equal(result.rateLimits.primary.windowDurationMins, 10080);
    const seen = JSON.parse(await readFile(fixture.trace, "utf8"));
    assert.deepEqual(seen.map((message) => message.method), [
      "initialize", "initialized", "account/rateLimits/read",
    ]);
    assert.equal(seen[0].params.clientInfo.name, "codex-usage-meters");
    assert.equal(seen[2].id, 2);
  } finally { await fixture.cleanup(); }
});

test("transport rejects RPC errors without exposing upstream details", async () => {
  const fixture = await fakeCodex("rpc-error");
  try {
    await assert.rejects(readCodexRateLimits({ command: fixture.command, timeoutMs: 2000 }),
      { message: "Codex app-server rejected account/rateLimits/read" });
  } finally { await fixture.cleanup(); }
});

test("transport rejects early exit and a missing executable", async () => {
  const fixture = await fakeCodex("early-exit");
  try {
    await assert.rejects(readCodexRateLimits({ command: fixture.command, timeoutMs: 2000 }),
      { message: "Codex app-server closed before replying" });
    await assert.rejects(readCodexRateLimits({ command: `${fixture.command}-missing`, timeoutMs: 2000 }),
      { message: "Could not start Codex app-server" });
  } finally { await fixture.cleanup(); }
});

test("timeout kills a child that ignores SIGTERM", async () => {
  const fixture = await fakeCodex("timeout");
  try {
    await assert.rejects(readCodexRateLimits({ command: fixture.command, timeoutMs: 150 }),
      { message: "Codex app-server timed out" });
    const pid = Number(await readFile(fixture.pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await fixture.cleanup(); }
});
