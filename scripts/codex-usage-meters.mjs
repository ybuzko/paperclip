#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import readline from "node:readline";

const DURATIONS = new Map([[300, "five_hour"], [10080, "seven_day"]]);

/** Convert documented app-server rate-limit buckets to governor snapshot rows. */
export function snapshotFromRateLimits(result, observedAt = new Date().toISOString()) {
  const buckets = result?.rateLimitsByLimitId;
  const byId = buckets && typeof buckets === "object" && !Array.isArray(buckets) ? { ...buckets } : {};
  const single = result?.rateLimits;
  if (single && typeof single === "object" && !Array.isArray(single)) {
    const id = typeof single.limitId === "string" && single.limitId ? single.limitId : "codex";
    if (!(id in byId)) byId[id] = single;
  }
  const rows = [];
  for (const [limitId, bucket] of Object.entries(byId)) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    for (const slot of ["primary", "secondary"]) {
      const entry = bucket[slot];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const window = DURATIONS.get(entry.windowDurationMins);
      const percent = entry.usedPercent;
      const reset = entry.resetsAt;
      if (!window || typeof percent !== "number" || !Number.isFinite(percent)
        || percent < 0 || percent > 100
        || typeof reset !== "number" || !Number.isFinite(reset)) continue;
      const resetsAt = new Date(reset * 1000);
      if (Number.isNaN(resetsAt.getTime())) continue;
      rows.push({
        provider: "openai",
        window,
        usedPct: percent,
        resetsAt: resetsAt.toISOString(),
        source: `codex-app-server:${limitId}`,
        observedAt,
      });
    }
  }
  return rows;
}

export async function readCodexRateLimits({ command = "codex", timeoutMs = 12000 } = {}) {
  const proc = spawn(command, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = readline.createInterface({ input: proc.stdout });
  let nextId = 1;
  let failure;
  const pending = new Map();
  const rejectAll = (error) => {
    failure = error;
    for (const [id, { reject }] of pending) {
      pending.delete(id);
      reject(error);
    }
  };
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message?.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`Codex app-server rejected ${request.method}`));
    else request.resolve(message.result);
  });
  proc.stdin.on("error", () => rejectAll(new Error("Could not write to Codex app-server")));
  proc.on("error", () => rejectAll(new Error("Could not start Codex app-server")));
  proc.on("exit", () => rejectAll(new Error("Codex app-server closed before replying")));
  const timer = setTimeout(() => rejectAll(new Error("Codex app-server timed out")), timeoutMs);
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  try {
    await request("initialize", { clientInfo: { name: "codex-usage-meters", version: "1.0.0" } });
    proc.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    return await request("account/rateLimits/read");
  } finally {
    clearTimeout(timer);
    lines.close();
    proc.kill("SIGTERM");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const observedAt = new Date().toISOString();
    const result = await readCodexRateLimits();
    process.stdout.write(`${JSON.stringify(snapshotFromRateLimits(result, observedAt), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Codex meter read failed"}\n`);
    process.exitCode = 1;
  }
}
