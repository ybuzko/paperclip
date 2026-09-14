import { describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_ONLY_POLICY_ERROR_CODE,
  evaluateClaudeCliOnlyPolicy,
  isClaudeCliOnlyPolicy,
} from "./fleet-guard.js";

describe("isClaudeCliOnlyPolicy", () => {
  it("is false when the env var is unset", () => {
    expect(isClaudeCliOnlyPolicy({})).toBe(false);
  });

  it.each(["1", "true", "yes", "TRUE", "Yes", " 1 "])(
    "is true for the truthy spelling %j",
    (value) => {
      expect(isClaudeCliOnlyPolicy({ PAPERCLIP_CLAUDE_CLI_ONLY: value })).toBe(true);
    },
  );

  it.each(["0", "false", "no", "", "on", "enabled"])(
    "is false for the non-truthy spelling %j",
    (value) => {
      expect(isClaudeCliOnlyPolicy({ PAPERCLIP_CLAUDE_CLI_ONLY: value })).toBe(false);
    },
  );

  it("defaults to reading process.env", () => {
    const original = process.env.PAPERCLIP_CLAUDE_CLI_ONLY;
    try {
      process.env.PAPERCLIP_CLAUDE_CLI_ONLY = "true";
      expect(isClaudeCliOnlyPolicy()).toBe(true);
      delete process.env.PAPERCLIP_CLAUDE_CLI_ONLY;
      expect(isClaudeCliOnlyPolicy()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.PAPERCLIP_CLAUDE_CLI_ONLY;
      else process.env.PAPERCLIP_CLAUDE_CLI_ONLY = original;
    }
  });
});

describe("evaluateClaudeCliOnlyPolicy", () => {
  it("passes a plain CLI-lane config with no auth overrides", () => {
    expect(evaluateClaudeCliOnlyPolicy({ config: {} })).toEqual({ ok: true });
    expect(evaluateClaudeCliOnlyPolicy({ config: { engine: "cli" } })).toEqual({ ok: true });
    expect(evaluateClaudeCliOnlyPolicy({ config: { engine: "auto" } })).toEqual({ ok: true });
  });

  it("rejects an explicit ACP engine request", () => {
    const result = evaluateClaudeCliOnlyPolicy({ config: { engine: "acp" } });
    expect(result).toMatchObject({
      ok: false,
      errorCode: CLAUDE_CLI_ONLY_POLICY_ERROR_CODE,
    });
    if (!result.ok) {
      expect(result.reason).toContain("acp");
      expect(result.reason).toContain("PAPERCLIP_CLAUDE_CLI_ONLY");
    }
  });

  it("rejects an ACP engine request regardless of case or surrounding whitespace", () => {
    const result = evaluateClaudeCliOnlyPolicy({ config: { engine: " ACP " } });
    expect(result.ok).toBe(false);
  });

  it("rejects a configured managedAiConnection", () => {
    const result = evaluateClaudeCliOnlyPolicy({
      config: { managedAiConnection: { id: "conn-1" } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: CLAUDE_CLI_ONLY_POLICY_ERROR_CODE });
    if (!result.ok) expect(result.reason).toContain("managed AI connection");
  });

  it.each(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])(
    "rejects an injected %s in config.env",
    (key) => {
      const result = evaluateClaudeCliOnlyPolicy({
        config: { env: { [key]: "secret-value" } },
      });
      expect(result).toMatchObject({ ok: false, errorCode: CLAUDE_CLI_ONLY_POLICY_ERROR_CODE });
      if (!result.ok) expect(result.reason).toContain(key);
    },
  );

  it("ignores a blank or whitespace-only banned env value", () => {
    expect(
      evaluateClaudeCliOnlyPolicy({ config: { env: { ANTHROPIC_API_KEY: "   " } } }),
    ).toEqual({ ok: true });
  });

  it.each(["--bare", "--api-key", "--auth-token"])(
    "rejects the %s flag in extraArgs",
    (flag) => {
      const result = evaluateClaudeCliOnlyPolicy({ config: { extraArgs: [flag] } });
      expect(result).toMatchObject({ ok: false, errorCode: CLAUDE_CLI_ONLY_POLICY_ERROR_CODE });
      if (!result.ok) expect(result.reason).toContain(flag);
    },
  );

  it("rejects a banned flag passed with an inline value", () => {
    const result = evaluateClaudeCliOnlyPolicy({
      config: { extraArgs: ["--api-key=sk-ant-fake"] },
    });
    expect(result.ok).toBe(false);
  });

  it("checks args when extraArgs is empty", () => {
    const result = evaluateClaudeCliOnlyPolicy({ config: { args: ["--bare"] } });
    expect(result.ok).toBe(false);
  });

  it("prefers extraArgs over args when both are set", () => {
    // extraArgs has no banned flag, so a banned flag hiding only in args (which
    // is superseded once extraArgs is non-empty, mirroring execute.ts) must not
    // trip the guard.
    const result = evaluateClaudeCliOnlyPolicy({
      config: { extraArgs: ["--verbose"], args: ["--bare"] },
    });
    expect(result).toEqual({ ok: true });
  });

  it("does not reject an unrelated flag or env key", () => {
    expect(
      evaluateClaudeCliOnlyPolicy({
        config: { extraArgs: ["--verbose"], env: { SOME_OTHER_VAR: "x" } },
      }),
    ).toEqual({ ok: true });
  });
});
