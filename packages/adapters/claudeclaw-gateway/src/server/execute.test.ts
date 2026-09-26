import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AdapterExecutionContext, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import {
  buildFleetDispatchBlock,
  buildWakeMessage,
  composeThreadKey,
  execute,
  mapInjectResponse,
  readFleetDispatch,
  resolveThreadBinding,
} from "./execute.js";
import { testEnvironment } from "./test.js";
import { sessionCodec } from "./index.js";

const API_TOKEN = "claw-secret-token";
const CHAT_ID = "-1001234567890";
const PROJECT_ENV = { CLAUDECLAW_THREAD: "42", CLAUDECLAW_WORKSPACE: "/home/galileo/ft", JIRA_PROJECT: "FT" };

type StubBehaviour = {
  inject?: (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>;
  state?: (req: IncomingMessage, res: ServerResponse) => void;
  health?: (req: IncomingMessage, res: ServerResponse) => void;
};

type StubServer = {
  url: string;
  requests: Array<{ method: string; path: string; authorization: string | undefined; body: unknown }>;
  close: () => Promise<void>;
};

const servers: Server[] = [];

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function bearerOk(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${API_TOKEN}`;
}

async function startStub(behaviour: StubBehaviour = {}): Promise<StubServer> {
  const requests: StubServer["requests"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization,
        body: parsed,
      });

      if (req.url === "/api/health") {
        if (behaviour.health) return behaviour.health(req, res);
        return json(res, 200, { ok: true });
      }
      if (req.url === "/api/state") {
        if (behaviour.state) return behaviour.state(req, res);
        if (!bearerOk(req)) return json(res, 401, { ok: false, error: "unauthorized" });
        return json(res, 200, { ok: true, state: { running: false } });
      }
      if (req.url === "/api/inject" && req.method === "POST") {
        if (behaviour.inject) return void behaviour.inject(req, raw, res);
        if (!bearerOk(req)) return json(res, 401, { ok: false, error: "unauthorized" });
        // Like the daemon: token first, then body validation.
        const message = parsed && typeof parsed === "object" ? (parsed as { message?: unknown }).message : undefined;
        if (typeof message !== "string" || !message.trim()) return json(res, 400, { ok: false, error: "message is required" });
        return json(res, 200, { ok: true, result: "Turn complete.\n", exitCode: 0, sessionId: "sess-123" });
      }
      json(res, 404, { ok: false, error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  }
});

function makeCtx(rawConfig: Record<string, unknown>, overrides?: Partial<AdapterExecutionContext>): AdapterExecutionContext {
  const logs: Array<{ stream: string; chunk: string }> = [];
  const config = { telegramChatId: CHAT_ID, ...rawConfig };
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Supervisor",
      adapterType: "claudeclaw_gateway",
      adapterConfig: config,
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {
      taskId: "issue-1",
      issueId: "issue-1",
      wakeReason: "issue_assigned",
      issueIds: ["issue-1"],
      projectId: "proj-ft",
      projectName: "Fleet Tools",
      projectEnv: PROJECT_ENV,
      paperclipWake: {
        reason: "issue_assigned",
        issue: { id: "issue-1", identifier: "PIX-9", title: "Do the thing", status: "todo", priority: "medium" },
      },
    },
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    onMeta: async () => undefined,
    ...overrides,
  };
}

describe("buildWakeMessage", () => {
  it("carries the env block and key-file pointer but never the API key or token", () => {
    const ctx = makeCtx({
      url: "http://127.0.0.1:1",
      apiToken: API_TOKEN,
      paperclipApiUrl: "http://10.0.0.34:3100/",
      claimedApiKeyPath: ".claude/claudeclaw/paperclip.env",
    });
    const message = buildWakeMessage(ctx);
    expect(message).toContain("PAPERCLIP_API_URL=http://10.0.0.34:3100");
    expect(message).toContain("PAPERCLIP_RUN_ID=run-1");
    expect(message).toContain("PAPERCLIP_TASK_ID=issue-1");
    expect(message).toContain("PAPERCLIP_WAKE_REASON=issue_assigned");
    expect(message).toContain("PAPERCLIP_AGENT_ID=agent-1");
    expect(message).toContain("source .claude/claudeclaw/paperclip.env");
    expect(message).toContain("PIX-9");
    expect(message).not.toContain(API_TOKEN);
    expect(message).not.toMatch(/PAPERCLIP_API_KEY=(?!<token from)/);
  });

  it("applies the default Paperclip API URL and key path", () => {
    const message = buildWakeMessage(makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN }));
    expect(message).toContain("PAPERCLIP_API_URL=http://10.0.0.34:3100");
    expect(message).toContain("<token from .claude/claudeclaw/paperclip.env>");
  });
});

describe("buildWakeMessage / fleet_dispatch", () => {
  const FLEET_DISPATCH = {
    jiraProject: "FT",
    readyTasks: 3,
    epicsToExplode: 1,
    epicsToClose: 2,
    epicKeysToClose: ["FT-10", "FT-11"],
    throttleState: "GREEN",
    fiveHourPct: 31.4,
    sevenDayPct: 48.9,
    sevenDayResetsAt: "2026-09-27T00:00:00.000Z",
    ackFormat: "FLEET_ACK run-1",
  };

  it("renders n/a and unknown when window numbers or the reset time are missing", () => {
    const block = buildFleetDispatchBlock(
      readFleetDispatch({
        ...makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN }),
        context: { wakeReason: "fleet_dispatch", fleetDispatch: { ...FLEET_DISPATCH, fiveHourPct: null, sevenDayPct: undefined, sevenDayResetsAt: null } },
      })!,
    );
    expect(block).toContain("5h window n/a, 7-day window n/a, resets unknown");
    expect(block).toContain("3 ready tasks");
  });

  it("renders the fleet dispatch block with counts and the ack line, after the context prefix and before the structured prompt, and still routes to the right thread", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    ctx.context.wakeReason = "fleet_dispatch";
    ctx.context.fleetDispatch = FLEET_DISPATCH;

    const resolution = resolveThreadBinding(ctx);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    const message = buildWakeMessage(ctx, resolution.binding);
    const lines = message.split("\n\n");
    expect(lines[0]).toBe(`Project: Fleet Tools · thread tg:${CHAT_ID}:42 · workspace /home/galileo/ft · Jira FT`);
    expect(lines[1]).toContain("Fleet dispatch");

    expect(message).toContain(
      "Fleet dispatch — the governor allows work (state GREEN, 5h window 31%, 7-day window 49%, resets 2026-09-27).",
    );
    expect(message).toContain(
      "Jira FT currently has assigned to you: 3 ready tasks (To Do / In Progress), 1 epics in To Do to review and break down, 2 epics in In Progress whose children are all complete (FT-10, FT-11).",
    );
    expect(message).toContain("Pick ONE item and work it to completion in this turn");
    expect(message).toContain("End this turn by posting exactly one comment on this dispatch issue that contains the line: FLEET_ACK run-1.");
    expect(message).not.toContain("Budget is tight");
    expect(message).not.toContain(API_TOKEN);

    // The structured wake prompt still follows the fleet dispatch block.
    const fleetIdx = message.indexOf("Fleet dispatch —");
    const promptIdx = message.indexOf("Paperclip wake event for a claudeclaw gateway agent.");
    expect(fleetIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(fleetIdx);
  });

  it("adds the AMBER budget hint when throttleState is AMBER", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    ctx.context.wakeReason = "fleet_dispatch";
    ctx.context.fleetDispatch = { ...FLEET_DISPATCH, throttleState: "AMBER" };
    const message = buildWakeMessage(ctx);
    expect(message).toContain("Budget is tight: prefer the smallest ready item.");
  });

  it("renders no fleet dispatch block when there is no fleetDispatch data", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    ctx.context.wakeReason = "fleet_dispatch";
    const message = buildWakeMessage(ctx);
    expect(message).not.toContain("Fleet dispatch");
  });

  it("leaves a non-dispatch wake unchanged even when fleetDispatch is (implausibly) present", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    ctx.context.fleetDispatch = FLEET_DISPATCH;
    const message = buildWakeMessage(ctx);
    expect(message).not.toContain("Fleet dispatch");
  });
});

describe("buildFleetDispatchBlock", () => {
  it("renders deterministic, decimal-free prose with no keys parenthetical when the close list is empty", () => {
    const block = buildFleetDispatchBlock({
      jiraProject: "FT",
      readyTasks: 0,
      epicsToExplode: 0,
      epicsToClose: 0,
      epicKeysToClose: [],
      throttleState: "ACCELERATE",
      fiveHourPct: 0.4,
      sevenDayPct: 99.6,
      sevenDayResetsAt: "not-a-date",
      ackFormat: "ACK",
    });
    expect(block).toContain("state ACCELERATE, 5h window 0%, 7-day window 100%, resets not-a-date");
    expect(block).toContain("0 epics in In Progress whose children are all complete.");
    expect(block).not.toContain("Budget is tight");
  });
});

describe("readFleetDispatch", () => {
  it("reads a direct fleetDispatch key on the context (the real server path)", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    ctx.context.fleetDispatch = {
      jiraProject: "FT",
      readyTasks: 1,
      epicsToExplode: 0,
      epicsToClose: 0,
      epicKeysToClose: [],
      throttleState: "RED",
      fiveHourPct: 90,
      sevenDayPct: 95,
      sevenDayResetsAt: "2026-10-01T00:00:00.000Z",
      ackFormat: "ACK",
    };
    expect(readFleetDispatch(ctx)?.throttleState).toBe("RED");
  });

  it("falls back to paperclipWake.payload.fleetDispatch", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    ctx.context.paperclipWake = {
      ...(ctx.context.paperclipWake as Record<string, unknown>),
      payload: { fleetDispatch: { ...({} as Record<string, unknown>), jiraProject: "FT", readyTasks: 1, epicsToExplode: 0, epicsToClose: 0, epicKeysToClose: [], throttleState: "GREEN", fiveHourPct: 1, sevenDayPct: 1, sevenDayResetsAt: "2026-10-01T00:00:00.000Z", ackFormat: "ACK" } },
    };
    expect(readFleetDispatch(ctx)?.jiraProject).toBe("FT");
  });

  it("falls back to paperclipWake.fleetDispatch", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    ctx.context.paperclipWake = {
      ...(ctx.context.paperclipWake as Record<string, unknown>),
      fleetDispatch: { jiraProject: "FT", readyTasks: 1, epicsToExplode: 0, epicsToClose: 0, epicKeysToClose: [], throttleState: "GREEN", fiveHourPct: 1, sevenDayPct: 1, sevenDayResetsAt: "2026-10-01T00:00:00.000Z", ackFormat: "ACK" },
    };
    expect(readFleetDispatch(ctx)?.jiraProject).toBe("FT");
  });

  it("returns null on missing or malformed data", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    expect(readFleetDispatch(ctx)).toBeNull();
    ctx.context.fleetDispatch = { jiraProject: "FT" };
    expect(readFleetDispatch(ctx)).toBeNull();
    ctx.context.fleetDispatch = { ...({} as Record<string, unknown>), jiraProject: "FT", readyTasks: 1, epicsToExplode: 0, epicsToClose: 0, epicKeysToClose: [], throttleState: "PURPLE", fiveHourPct: 1, sevenDayPct: 1, sevenDayResetsAt: "2026-10-01T00:00:00.000Z", ackFormat: "ACK" };
    expect(readFleetDispatch(ctx)).toBeNull();
  });
});

describe("execute", () => {
  it("posts the wake message with forward:false and maps a patched success response", async () => {
    const stub = await startStub();
    const result = await execute(makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 }));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Turn complete.");
    expect(result.sessionParams).toEqual({ claudeclawSessionId: "sess-123" });
    expect(result.sessionDisplayId).toBe("sess-123");
    expect(result.usage).toBeUndefined();

    const inject = stub.requests.find((entry) => entry.path === "/api/inject");
    expect(inject).toBeTruthy();
    expect(inject?.authorization).toBe(`Bearer ${API_TOKEN}`);
    const body = inject?.body as Record<string, unknown>;
    expect(body.forward).toBe(false);
    expect(typeof body.message).toBe("string");
    expect(String(body.message)).toContain("Paperclip wake event for a claudeclaw gateway agent.");
    expect(String(body.message)).not.toContain(API_TOKEN);
    expect(body.thread).toBe(`tg:${CHAT_ID}:42`);
    expect(Object.keys(body).sort()).toEqual(["forward", "message", "thread"]);
    expect(String(body.message).split("\n")[0]).toBe(
      `Project: Fleet Tools · thread tg:${CHAT_ID}:42 · workspace /home/galileo/ft · Jira FT`,
    );
  });

  it("passes a full session key from CLAUDECLAW_THREAD through to the inject body verbatim", async () => {
    const stub = await startStub();
    const ctx = makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 });
    ctx.context.projectEnv = { CLAUDECLAW_THREAD: "paperclip:FT" };
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toEqual({ claudeclawSessionId: "sess-123" });
    const body = stub.requests.find((entry) => entry.path === "/api/inject")?.body as Record<string, unknown>;
    expect(body.thread).toBe("paperclip:FT");
    expect(String(body.message).split("\n")[0]).toBe("Project: Fleet Tools · thread paperclip:FT · workspace <unset>");
  });

  it("fails as thread_unmapped without contacting the daemon when the project has no binding", async () => {
    const stub = await startStub();
    const ctx = makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 });
    ctx.context.projectEnv = { JIRA_PROJECT: "FT" };
    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claudeclaw_gateway_thread_unmapped");
    expect(result.errorFamily ?? null).toBeNull();
    expect(result.errorMessage).toContain("Fleet Tools (proj-ft)");
    expect(result.errorMessage).toContain("CLAUDECLAW_THREAD");
    expect(stub.requests).toHaveLength(0);
  });

  it("fails as thread_unmapped for a bare topic id when telegramChatId is not configured", async () => {
    const stub = await startStub();
    const ctx = makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 5, telegramChatId: "" });
    const result = await execute(ctx);
    expect(result.errorCode).toBe("claudeclaw_gateway_thread_unmapped");
    expect(result.errorMessage).toContain("telegramChatId");
    expect(stub.requests).toHaveLength(0);
  });

  it("skips a timer wake with no issue and no project instead of hitting the global session", async () => {
    const stub = await startStub();
    const ctx = makeCtx(
      { url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 },
      { context: { wakeReason: "timer", issueIds: [] } },
    );
    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claudeclaw_gateway_thread_unmapped");
    expect(result.errorMessage).toContain("no issue and no project");
    expect(stub.requests).toHaveLength(0);
  });

  it("fails with a clear fork-patch error when the response has no sessionId", async () => {
    const stub = await startStub({
      inject: (_req, _body, res) => json(res, 200, { ok: true, result: "done", exitCode: 0 }),
    });
    const result = await execute(makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claudeclaw_gateway_fork_patch_missing");
    expect(result.errorMessage).toContain("claudeclaw fork patch missing");
    expect(result.errorFamily ?? null).toBeNull();
  });

  it("surfaces 401 as an auth failure without a retry family", async () => {
    const stub = await startStub();
    const result = await execute(makeCtx({ url: stub.url, apiToken: "wrong-token", timeoutSec: 5 }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claudeclaw_gateway_auth_failed");
    expect(result.errorFamily ?? null).toBeNull();
    expect(result.errorMessage).not.toContain("wrong-token");
  });

  it("marks an adapter-side timeout as timedOut with no retry family (the daemon is still running the turn)", async () => {
    const stub = await startStub({
      inject: (_req, _body, res) => {
        setTimeout(() => json(res, 200, { ok: true, result: "late", exitCode: 0, sessionId: "s" }), 1500);
      },
    });
    const result = await execute(makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 1 }));
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("claudeclaw_gateway_timeout");
    expect(result.errorFamily).toBeNull();
    expect(result.errorMessage).toContain("not retried");
  });

  it("waits for a slow turn when timeoutSec is 0 (the default)", async () => {
    const stub = await startStub({
      inject: (_req, _body, res) => {
        setTimeout(() => json(res, 200, { ok: true, result: "late but fine", exitCode: 0, sessionId: "slow-1" }), 1500);
      },
    });
    const result = await execute(makeCtx({ url: stub.url, apiToken: API_TOKEN }));
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeFalsy();
    expect(result.sessionDisplayId).toBe("slow-1");
  });

  it("maps {ok:false} daemon errors and treats timeout-shaped ones as transient", async () => {
    const stub = await startStub({
      inject: (_req, _body, res) => json(res, 500, { ok: false, error: "Error: claude turn timed out after 300s" }),
    });
    const result = await execute(makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claudeclaw_gateway_turn_timeout");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("treats a non-zero claude exit code as a failed turn even when ok:true", async () => {
    const stub = await startStub({
      inject: (_req, _body, res) => json(res, 200, { ok: true, result: "boom", exitCode: 2, sessionId: "sess-9" }),
    });
    const result = await execute(makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claudeclaw_gateway_turn_failed");
    expect(result.sessionParams).toEqual({ claudeclawSessionId: "sess-9" });
  });

  it("treats connection refusal as transient", async () => {
    const stub = await startStub();
    const url = stub.url;
    await stub.close();
    const result = await execute(makeCtx({ url, apiToken: API_TOKEN, timeoutSec: 5 }));
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claudeclaw_gateway_connect_failed");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("rejects missing url or token before contacting the daemon", async () => {
    expect((await execute(makeCtx({ apiToken: API_TOKEN }))).errorCode).toBe("claudeclaw_gateway_url_missing");
    expect((await execute(makeCtx({ url: "ws://x" , apiToken: API_TOKEN }))).errorCode).toBe("claudeclaw_gateway_url_invalid");
    expect((await execute(makeCtx({ url: "http://127.0.0.1:1" }))).errorCode).toBe("claudeclaw_gateway_api_token_missing");
  });
});

describe("resolveThreadBinding", () => {
  it("composes a bare topic id with the adapter's telegramChatId", () => {
    expect(composeThreadKey("42", CHAT_ID)).toBe(`tg:${CHAT_ID}:42`);
    expect(composeThreadKey(" 42 ", CHAT_ID)).toBe(`tg:${CHAT_ID}:42`);
    expect(composeThreadKey("42", null)).toBeNull();
    expect(composeThreadKey("", CHAT_ID)).toBeNull();
  });

  it("uses a value containing ':' as the full session key regardless of telegramChatId", () => {
    expect(composeThreadKey("paperclip:FT", null)).toBe("paperclip:FT");
    expect(composeThreadKey("tg:-100999:7", CHAT_ID)).toBe("tg:-100999:7");
  });

  it("reads the binding from the project env on the execution context", () => {
    const resolution = resolveThreadBinding(makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN }));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.binding).toEqual({
      projectId: "proj-ft",
      projectName: "Fleet Tools",
      thread: `tg:${CHAT_ID}:42`,
      rawBinding: "42",
      workspace: "/home/galileo/ft",
      jiraProject: "FT",
    });
  });

  it("fails when an issue wake carries no project", () => {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    delete ctx.context.projectId;
    const resolution = resolveThreadBinding(ctx);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.errorCode).toBe("claudeclaw_gateway_thread_unmapped");
    expect(resolution.errorMessage).toContain("issue-1");
    expect(resolution.errorMeta).toEqual({ wakeReason: "issue_assigned", issueId: "issue-1", projectId: null });
  });
});

describe("mapInjectResponse", () => {
  it("classifies non-JSON 5xx responses as transient upstream errors", () => {
    const result = mapInjectResponse({ status: 502, body: null, rawText: "bad gateway", apiToken: API_TOKEN });
    expect(result.errorCode).toBe("claudeclaw_gateway_upstream_error");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("fails when a patched daemon reports sessionId=null", () => {
    const result = mapInjectResponse({
      status: 200,
      body: { ok: true, result: "x", exitCode: 0, sessionId: null },
      rawText: "",
      apiToken: API_TOKEN,
    });
    expect(result.errorCode).toBe("claudeclaw_gateway_session_missing");
  });
});

describe("sessionCodec", () => {
  it("round-trips the claudeclaw session id", () => {
    expect(sessionCodec.deserialize({ claudeclawSessionId: "abc" })).toEqual({ claudeclawSessionId: "abc" });
    expect(sessionCodec.serialize({ sessionId: "abc" })).toEqual({ claudeclawSessionId: "abc" });
    expect(sessionCodec.getDisplayId?.({ claudeclawSessionId: "abc" })).toBe("abc");
    expect(sessionCodec.deserialize({})).toBeNull();
  });
});

describe("testEnvironment", () => {
  function envCtx(config: Record<string, unknown>): AdapterEnvironmentTestContext {
    return { adapterType: "claudeclaw_gateway", config } as AdapterEnvironmentTestContext;
  }

  it("passes when health succeeds and the empty inject probe is rejected with 400 (token accepted)", async () => {
    const stub = await startStub();
    const result = await testEnvironment(envCtx({ url: stub.url, apiToken: API_TOKEN }));
    expect(result.status).toBe("pass");
    expect(result.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining(["claudeclaw_gateway_health_ok", "claudeclaw_gateway_auth_ok"]),
    );
    expect(stub.requests.map((entry) => entry.path)).toEqual(["/api/health", "/api/inject"]);
    expect(stub.requests[0]?.authorization).toBeUndefined();
    expect(stub.requests[1]?.authorization).toBe(`Bearer ${API_TOKEN}`);
    expect(stub.requests[1]?.body).toEqual({});
  });

  it("fails on a bad token", async () => {
    const stub = await startStub();
    const result = await testEnvironment(envCtx({ url: stub.url, apiToken: "nope" }));
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "claudeclaw_gateway_auth_failed")).toBe(true);
  });

  it("fails when the daemon is unreachable", async () => {
    const stub = await startStub();
    const url = stub.url;
    await stub.close();
    const result = await testEnvironment(envCtx({ url, apiToken: API_TOKEN }));
    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "claudeclaw_gateway_health_unreachable")).toBe(true);
  });

  it("fails on missing config without making requests", async () => {
    const result = await testEnvironment(envCtx({}));
    expect(result.status).toBe("fail");
    expect(result.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining(["claudeclaw_gateway_url_missing", "claudeclaw_gateway_api_token_missing"]),
    );
  });
});
