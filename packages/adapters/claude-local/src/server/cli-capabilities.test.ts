import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
  };
});

import {
  claudeCommandSupportsEffortFlag,
  claudeCommandSupportsMaxBudgetFlag,
  resetClaudeCliCapabilitiesCacheForTests,
} from "./cli-capabilities.js";

function helpResult(stdout: string, overrides: Partial<RunProcessResult> = {}): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

const baseProbeInput = {
  runId: "run-1",
  command: "claude",
  target: null,
  cwd: "/tmp",
  env: {},
  timeoutSec: 10,
  graceSec: 5,
};

describe("claudeCommandSupportsMaxBudgetFlag", () => {
  afterEach(() => {
    resetClaudeCliCapabilitiesCacheForTests();
    vi.clearAllMocks();
  });

  it("returns true when --help advertises --max-budget-usd", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(
      helpResult("  --max-budget-usd <amount>   Maximum dollar amount to spend on API calls\n"),
    );

    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBe(true);
  });

  it("returns false when --help exits cleanly without mentioning --max-budget-usd", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(
      helpResult("  --effort <level>   Effort level for the current session\n"),
    );

    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBe(false);
  });

  it("returns null (unknown) when the probe times out", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(
      helpResult("", { timedOut: true }),
    );

    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBeNull();
  });

  it("returns null (unknown) when the probe throws, and does not poison the cache", async () => {
    runAdapterExecutionTargetProcess.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBeNull();

    // A thrown probe must not be cached, so the next lease retries it.
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(
      helpResult("  --max-budget-usd <amount>\n"),
    );
    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBe(true);
  });

  it("skips the probe entirely for a non-claude command", async () => {
    await expect(
      claudeCommandSupportsMaxBudgetFlag({ ...baseProbeInput, command: "node" }),
    ).resolves.toBeNull();
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("caches a resolved result for the same command/target key", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(
      helpResult("  --max-budget-usd <amount>\n"),
    );

    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBe(true);
    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBe(true);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);

    resetClaudeCliCapabilitiesCacheForTests();
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(
      helpResult("  --effort <level>\n"),
    );
    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBe(false);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
  });

  it("probes --max-budget-usd and --effort independently", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce(helpResult("  --effort <level>\n"));
    await expect(claudeCommandSupportsMaxBudgetFlag(baseProbeInput)).resolves.toBe(false);

    runAdapterExecutionTargetProcess.mockResolvedValueOnce(
      helpResult("  --effort <level>\n  --max-budget-usd <amount>\n"),
    );
    await expect(claudeCommandSupportsEffortFlag(baseProbeInput)).resolves.toBe(true);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
  });
});
