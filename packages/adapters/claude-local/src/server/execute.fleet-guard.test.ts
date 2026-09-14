import { describe, expect, it, vi } from "vitest";

// This isolates the one new branch added to `execute()` for the Claude
// CLI-only fleet policy (see `fleet-guard.ts` and `acp.ts`'s
// `resolveClaudeExecutionEngineForRun`): when engine resolution reports a
// `policyRejection`, `execute()` must return a failed `AdapterExecutionResult`
// carrying that `errorCode`/reason, without ever calling the ACP executor or
// spawning the CLI runtime. The real policy evaluation is covered by
// `fleet-guard.test.ts` and `acp.test.ts`; this file only exercises the
// `execute()` consumer wiring, so it mocks `./acp.js` directly rather than
// setting the real `PAPERCLIP_CLAUDE_CLI_ONLY` env var.
const { createClaudeAcpExecutor, resolveClaudeExecutionEngineForRun } = vi.hoisted(() => ({
  createClaudeAcpExecutor: vi.fn(() => vi.fn(async () => {
    throw new Error("executeClaudeAcp must not run when the run was rejected by fleet policy");
  })),
  resolveClaudeExecutionEngineForRun: vi.fn(async () => ({
    engine: "cli" as const,
    explicit: true,
    policyRejection: {
      reason:
        'Fleet policy PAPERCLIP_CLAUDE_CLI_ONLY requires the unmodified Claude CLI; this adapter config explicitly requests engine="acp".',
      errorCode: "claude_cli_only_policy",
    },
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor,
  formatClaudeAcpFallbackMessage: (reason: string) => `[paperclip] ${reason}\n`,
  resolveClaudeExecutionEngineForRun,
}));

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local execute() under the Claude CLI-only fleet policy", () => {
  it("returns a failed result with the policy errorCode and reason before spawning anything", async () => {
    const ctx = buildContext({ engine: "acp" });

    const result = await execute(ctx as never);

    expect(result).toEqual({
      exitCode: null,
      signal: null,
      timedOut: false,
      errorMessage:
        'Fleet policy PAPERCLIP_CLAUDE_CLI_ONLY requires the unmodified Claude CLI; this adapter config explicitly requests engine="acp".',
      errorCode: "claude_cli_only_policy",
    });
    // The ACP executor factory may be called eagerly at module load (see
    // execute.ts's `const executeClaudeAcp = createClaudeAcpExecutor()`), but
    // the returned executor itself must never be invoked for a rejected run.
    for (const executor of createClaudeAcpExecutor.mock.results) {
      if (executor.type === "return") {
        expect(executor.value).not.toHaveBeenCalled();
      }
    }
    expect(ctx.onLog).not.toHaveBeenCalled();
  });
});
