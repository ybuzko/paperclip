import { describe, expect, it } from "vitest";
import { buildAdapterProjectContext, readPlainProjectEnv } from "./heartbeat-project-context.js";

describe("heartbeat project context", () => {
  it("exposes plain project env values and drops secret-backed bindings", () => {
    const env = readPlainProjectEnv({
      CLAUDECLAW_THREAD: "1234",
      JIRA_PROJECT: { type: "plain", value: "FT" },
      FLEET_DISPATCH: "on",
      JIRA_API_TOKEN: { type: "secret_ref", secretId: "sec-1" },
      GH_TOKEN: { type: "user_secret_ref", key: "gh" },
      EMPTY: "   ",
      BROKEN: { type: "plain" },
      NUMERIC: 42,
    });
    expect(env).toEqual({ CLAUDECLAW_THREAD: "1234", JIRA_PROJECT: "FT", FLEET_DISPATCH: "on" });
  });

  it("returns an empty record for missing or malformed env", () => {
    expect(readPlainProjectEnv(null)).toEqual({});
    expect(readPlainProjectEnv(undefined)).toEqual({});
    expect(readPlainProjectEnv("nope")).toEqual({});
    expect(readPlainProjectEnv(["a"])).toEqual({});
  });

  it("builds the adapter-facing project context", () => {
    expect(
      buildAdapterProjectContext({
        id: "proj-1",
        name: "  Fleet Tools ",
        env: { CLAUDECLAW_THREAD: "paperclip:FT", TOKEN: { type: "secret_ref", secretId: "s" } },
      }),
    ).toEqual({
      projectId: "proj-1",
      projectName: "Fleet Tools",
      projectEnv: { CLAUDECLAW_THREAD: "paperclip:FT" },
    });
    expect(buildAdapterProjectContext({ id: "proj-2", name: "", env: null })).toEqual({
      projectId: "proj-2",
      projectName: null,
      projectEnv: {},
    });
    expect(buildAdapterProjectContext(null)).toBeNull();
    expect(buildAdapterProjectContext({ id: "" })).toBeNull();
  });
});
