import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AdapterExecutionContext, AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { buildWakeMessage, execute, mapInjectResponse } from "./execute.js";
import { testEnvironment } from "./test.js";
import { sessionCodec } from "./index.js";

const API_TOKEN = "claw-secret-token";

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

function makeCtx(config: Record<string, unknown>, overrides?: Partial<AdapterExecutionContext>): AdapterExecutionContext {
  const logs: Array<{ stream: string; chunk: string }> = [];
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
    expect(Object.keys(body).sort()).toEqual(["forward", "message"]);
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

  it("marks an adapter-side timeout as transient and timedOut", async () => {
    const stub = await startStub({
      inject: (_req, _body, res) => {
        setTimeout(() => json(res, 200, { ok: true, result: "late", exitCode: 0, sessionId: "s" }), 1500);
      },
    });
    const result = await execute(makeCtx({ url: stub.url, apiToken: API_TOKEN, timeoutSec: 1 }));
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("claudeclaw_gateway_timeout");
    expect(result.errorFamily).toBe("transient_upstream");
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

  it("passes when health and authenticated state both succeed", async () => {
    const stub = await startStub();
    const result = await testEnvironment(envCtx({ url: stub.url, apiToken: API_TOKEN }));
    expect(result.status).toBe("pass");
    expect(result.checks.map((check) => check.code)).toEqual(
      expect.arrayContaining(["claudeclaw_gateway_health_ok", "claudeclaw_gateway_state_ok"]),
    );
    expect(stub.requests.map((entry) => entry.path)).toEqual(["/api/health", "/api/state"]);
    expect(stub.requests[0]?.authorization).toBeUndefined();
    expect(stub.requests[1]?.authorization).toBe(`Bearer ${API_TOKEN}`);
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
