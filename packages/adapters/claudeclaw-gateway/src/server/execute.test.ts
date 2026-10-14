import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AdapterExecutionContext, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import {
  buildFleetDispatchBlock,
  buildShortFleetDispatchMessage,
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
      version: null,
      jiraProject: "FT",
      assignment: null,
      declineReassignTo: null,
      modelExclusions: [],
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

describe("fleet dispatch v2", () => {
  const V1 = {
    jiraProject: "GAME",
    readyTasks: 2,
    epicsToExplode: 0,
    epicsToClose: 0,
    epicKeysToClose: [],
    throttleState: "OPEN",
    fiveHourPct: 17,
    sevenDayPct: 52,
    sevenDayResetsAt: "2026-10-18T13:00:00.896Z",
    ackFormat: "fleet-ack: worked=<KEY> outcome=<done|declined|partial>",
  };
  const V2 = {
    ...V1,
    version: 2,
    assignment: {
      key: "GAME-53",
      summary: "Emulation enablement — GOG collection (DOS slice)",
      status: "In Progress",
      kind: "task",
    },
    declineReassignTo: { accountId: "712020:074bdf3b-c75b-4363-90bd-0e17ac4cfeb2", email: "yaroslav@buzko.com" },
    modelExclusions: [],
  };

  function dispatchCtx(fleetDispatch: unknown, wakeReason = "fleet_dispatch"): AdapterExecutionContext {
    const ctx = makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN });
    ctx.context.wakeReason = wakeReason;
    ctx.context.fleetDispatch = fleetDispatch;
    return ctx;
  }

  it.each(["OPEN", "CAPPED", "RED", "STALE", "GREEN", "AMBER", "ACCELERATE"])(
    "validates throttleState %s",
    (state) => {
      expect(readFleetDispatch(dispatchCtx({ ...V1, throttleState: state }))?.throttleState).toBe(state);
    },
  );

  it("validates a v1 payload with the v2 fields defaulted", () => {
    const dispatch = readFleetDispatch(dispatchCtx({ ...V1, throttleState: "GREEN" }));
    expect(dispatch).not.toBeNull();
    expect(dispatch?.version).toBeNull();
    expect(dispatch?.assignment).toBeNull();
    expect(dispatch?.declineReassignTo).toBeNull();
    expect(dispatch?.modelExclusions).toEqual([]);
  });

  it("reads the v2 fields", () => {
    const dispatch = readFleetDispatch(dispatchCtx({ ...V2, modelExclusions: ["fable", " ", 3] }));
    expect(dispatch?.version).toBe(2);
    expect(dispatch?.assignment).toEqual(V2.assignment);
    expect(dispatch?.declineReassignTo).toEqual(V2.declineReassignTo);
    expect(dispatch?.modelExclusions).toEqual(["fable"]);
  });

  it("drops a malformed assignment without invalidating the payload", () => {
    const dispatch = readFleetDispatch(dispatchCtx({ ...V2, assignment: { key: "GAME-1", kind: "bogus" } }));
    expect(dispatch).not.toBeNull();
    expect(dispatch?.assignment).toBeNull();
  });

  it("sends exactly the short message for a v2 task", () => {
    const ctx = dispatchCtx(V2);
    const resolution = resolveThreadBinding(ctx);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(buildWakeMessage(ctx, resolution.binding)).toBe(
      [
        'Fleet dispatch, Jira GAME: work GAME-53 (In Progress, "Emulation enablement — GOG collection (DOS slice)").',
        "If you cannot advance it, reassign it in Jira to yaroslav@buzko.com with a comment saying why.",
        "End your reply with one line: fleet-ack: worked=GAME-53 outcome=done|declined|partial",
      ].join("\n"),
    );
  });

  it("renders the epic_explode line", () => {
    const message = buildWakeMessage(
      dispatchCtx({ ...V2, assignment: { key: "GAME-9", summary: "Retro hub", status: "To Do", kind: "epic_explode" } }),
    );
    expect(message).toBe(
      [
        'Fleet dispatch, Jira GAME: break epic GAME-9 ("Retro hub") into tasks assigned to yourself, then move the epic to In Progress.',
        "If you cannot advance it, reassign it in Jira to yaroslav@buzko.com with a comment saying why.",
        "End your reply with one line: fleet-ack: worked=GAME-9 outcome=done|declined|partial",
      ].join("\n"),
    );
  });

  it("renders the epic_close line", () => {
    const message = buildWakeMessage(
      dispatchCtx({ ...V2, assignment: { key: "GAME-9", summary: "Retro hub", status: "In Progress", kind: "epic_close" } }),
    );
    expect(message).toBe(
      [
        'Fleet dispatch, Jira GAME: epic GAME-9 ("Retro hub") has all children complete; review the outcome and close it, or reopen work.',
        "If you cannot advance it, reassign it in Jira to yaroslav@buzko.com with a comment saying why.",
        "End your reply with one line: fleet-ack: worked=GAME-9 outcome=done|declined|partial",
      ].join("\n"),
    );
  });

  it("adds the budget line before the ack line when CAPPED", () => {
    const lines = buildWakeMessage(dispatchCtx({ ...V2, throttleState: "CAPPED" })).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe("Budget is tight: keep this turn small.");
    expect(lines[3]).toBe("End your reply with one line: fleet-ack: worked=GAME-53 outcome=done|declined|partial");
  });

  it("adds the budget line with exclusions even when OPEN", () => {
    const lines = buildWakeMessage(dispatchCtx({ ...V2, modelExclusions: ["fable"] })).split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe("Budget is tight: keep this turn small. Do not use: fable.");
  });

  it("omits the budget line for RED and STALE without exclusions", () => {
    for (const state of ["RED", "STALE"]) {
      expect(buildWakeMessage(dispatchCtx({ ...V2, throttleState: state }))).not.toContain("Budget is tight");
    }
  });

  it("falls back to the reassign target's accountId, then to the human", () => {
    const dispatch = readFleetDispatch(dispatchCtx({ ...V2, declineReassignTo: { accountId: "acc-1" } }))!;
    expect(buildShortFleetDispatchMessage(dispatch, dispatch.assignment!)).toContain("reassign it in Jira to acc-1 with");
    const none = readFleetDispatch(dispatchCtx({ ...V2, declineReassignTo: null }))!;
    expect(buildShortFleetDispatchMessage(none, none.assignment!)).toContain("reassign it in Jira to the human with");
  });

  it("leaves out missing status or summary in the task line", () => {
    const dispatch = readFleetDispatch(dispatchCtx({ ...V2, assignment: { key: "GAME-53", kind: "task" } }))!;
    expect(buildShortFleetDispatchMessage(dispatch, dispatch.assignment!).split("\n")[0]).toBe(
      "Fleet dispatch, Jira GAME: work GAME-53.",
    );
  });

  it("renders the legacy block inside the generic wake for a v1 payload", () => {
    const ctx = dispatchCtx(V1);
    const resolution = resolveThreadBinding(ctx);
    if (!resolution.ok) throw new Error("binding failed");
    const message = buildWakeMessage(ctx, resolution.binding);
    expect(message.startsWith("Project: Fleet Tools")).toBe(true);
    expect(message).toContain("Fleet dispatch — the governor allows work (state OPEN, 5h window 17%, 7-day window 52%, resets 2026-10-18).");
    expect(message).toContain("PAPERCLIP_WAKE_REASON=fleet_dispatch");
    expect(message).not.toContain("Budget is tight");
  });

  it("renders the legacy block for v2 with a null assignment, and CAPPED gets the AMBER budget sentence", () => {
    const message = buildWakeMessage(dispatchCtx({ ...V2, assignment: null, throttleState: "CAPPED" }));
    expect(message).toContain("Fleet dispatch — the governor allows work (state CAPPED");
    expect(message).toContain("Budget is tight: prefer the smallest ready item.");
    expect(message).toContain("PAPERCLIP_RUN_ID=run-1");
  });

  it("renders the legacy block when the version is not 2", () => {
    const message = buildWakeMessage(dispatchCtx({ ...V2, version: 3 }));
    expect(message).toContain("Fleet dispatch — the governor allows work");
    expect(message).not.toContain("Fleet dispatch, Jira GAME:");
  });

  it("leaves a non-dispatch wake unchanged even with a v2 payload present", () => {
    const withPayload = buildWakeMessage(dispatchCtx(V2, "issue_assigned"));
    const without = buildWakeMessage(makeCtx({ url: "http://127.0.0.1:1", apiToken: API_TOKEN }));
    expect(withPayload).toBe(without);
    expect(withPayload).not.toContain("Fleet dispatch");
  });

  it("execute injects the short message and logs a fallback once", async () => {
    const daemon = await startStub();
    const logs: string[] = [];
    const run = async (fleetDispatch: unknown) => {
      const ctx = makeCtx(
        { url: daemon.url, apiToken: API_TOKEN },
        { onLog: async (_stream, chunk) => void logs.push(chunk) },
      );
      ctx.context.wakeReason = "fleet_dispatch";
      ctx.context.fleetDispatch = fleetDispatch;
      return execute(ctx);
    };

    await run(V2);
    const shortBody = daemon.requests.at(-1)?.body as Record<string, unknown>;
    expect(String(shortBody.message).startsWith("Fleet dispatch, Jira GAME: work GAME-53")).toBe(true);
    expect(logs.some((line) => line.includes("sending the generic wake"))).toBe(false);

    await run(V1);
    const fallbackLogs = logs.filter((line) => line.includes("sending the generic wake"));
    expect(fallbackLogs).toEqual([
      "[claudeclaw-gateway] fleet dispatch payload version none is not 2; sending the generic wake with the legacy Fleet dispatch block\n",
    ]);
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

const DAEMON_USAGE = {
  inputTokens: 9,
  outputTokens: 34,
  cacheReadInputTokens: 13689,
  cacheCreationInputTokens: 8369,
  costUsd: 0.0182859,
  durationMs: 1264,
  durationApiMs: 993,
  numTurns: 1,
  model: "claude-haiku-4-5-20251001",
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 9,
      outputTokens: 34,
      cacheReadInputTokens: 13689,
      cacheCreationInputTokens: 8369,
      costUsd: 0.0182859,
    },
  },
};

const USAGE_FIELDS = ["usage", "usageBasis", "costUsd", "model", "billingType", "biller"] as const;

describe("inject usage", () => {
  it("maps a full daemon usage object onto the result and logs it", async () => {
    const stub = await startStub({
      inject: (_req, _body, res) =>
        json(res, 200, {
          ok: true,
          sessionId: "sess-u",
          exitCode: 0,
          result: "Done.",
          status: "succeeded",
          runId: "daemon-run-1",
          durationMs: 1264,
          usage: DAEMON_USAGE,
        }),
    });
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(
      makeCtx(
        { url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 },
        { onLog: async (stream, chunk) => void logs.push({ stream, chunk }) },
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Done.");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 34, cachedInputTokens: 22058 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBe(0.0182859);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.billingType).toBe("subscription_included");
    expect(result.biller).toBe("anthropic");
    expect(result.provider).toBe("claudeclaw_gateway");
    expect(result.resultJson).toEqual({
      ok: true,
      exitCode: 0,
      sessionId: "sess-u",
      resultChars: 5,
      usage: {
        modelUsage: DAEMON_USAGE.modelUsage,
        durationMs: 1264,
        durationApiMs: 993,
        numTurns: 1,
        cacheReadInputTokens: 13689,
        cacheCreationInputTokens: 8369,
      },
      daemonStatus: "succeeded",
      daemonRunId: "daemon-run-1",
    });
    expect(logs).toContainEqual({
      stream: "stdout",
      chunk: "[claudeclaw-gateway] usage in=9 out=34 cached=22058 cost=$0.0182859 model=claude-haiku-4-5-20251001\n",
    });
  });

  it("leaves every usage field unset when the daemon sends usage:null", () => {
    const result = mapInjectResponse({
      status: 200,
      body: { ok: true, result: "Turn complete.\n", exitCode: 0, sessionId: "sess-123", usage: null },
      rawText: "",
      apiToken: API_TOKEN,
    });
    for (const key of USAGE_FIELDS) expect(result).not.toHaveProperty(key);
    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "claudeclaw_gateway",
      summary: "Turn complete.",
      sessionParams: { claudeclawSessionId: "sess-123" },
      sessionDisplayId: "sess-123",
      resultJson: { ok: true, exitCode: 0, sessionId: "sess-123", resultChars: 15 },
    });
  });

  it("leaves every usage field unset for an older daemon without the usage key, and logs that", async () => {
    const stub = await startStub();
    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute(
      makeCtx(
        { url: stub.url, apiToken: API_TOKEN, timeoutSec: 5 },
        { onLog: async (stream, chunk) => void logs.push({ stream, chunk }) },
      ),
    );
    for (const key of USAGE_FIELDS) expect(result).not.toHaveProperty(key);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Turn complete.");
    expect(result.resultJson).toEqual({ ok: true, exitCode: 0, sessionId: "sess-123", resultChars: 15 });
    expect(logs).toContainEqual({
      stream: "stdout",
      chunk: "[claudeclaw-gateway] no usage in inject response (unpatched daemon)\n",
    });
  });

  it("carries usage and cost on a failed turn (exitCode 2)", () => {
    const result = mapInjectResponse({
      status: 200,
      body: { ok: true, result: "boom", exitCode: 2, sessionId: "sess-9", status: "failed", usage: DAEMON_USAGE },
      rawText: "",
      apiToken: API_TOKEN,
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("claudeclaw_gateway_turn_failed");
    expect(result.sessionParams).toEqual({ claudeclawSessionId: "sess-9" });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 34, cachedInputTokens: 22058 });
    expect(result.usageBasis).toBe("per_run");
    expect(result.costUsd).toBe(0.0182859);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.billingType).toBe("subscription_included");
    expect(result.biller).toBe("anthropic");
    expect(result.resultJson).toMatchObject({ exitCode: 2, sessionId: "sess-9", daemonStatus: "failed" });
  });

  it("coerces malformed usage numbers to 0 without throwing", () => {
    const result = mapInjectResponse({
      status: 200,
      body: {
        ok: true,
        result: "ok",
        exitCode: 0,
        sessionId: "sess-m",
        usage: {
          inputTokens: "9",
          outputTokens: "34",
          cacheReadInputTokens: "x",
          cacheCreationInputTokens: Number.NaN,
          costUsd: "0.01",
          model: "",
          numTurns: "1",
          modelUsage: "nope",
        },
      },
      rawText: "",
      apiToken: API_TOKEN,
    });
    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(result.usageBasis).toBe("per_run");
    expect(result).not.toHaveProperty("costUsd");
    expect(result).not.toHaveProperty("model");
    expect((result.resultJson as Record<string, unknown>).usage).toEqual({
      modelUsage: null,
      durationMs: null,
      durationApiMs: null,
      numTurns: null,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
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
