import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createJiraClient,
  JiraAuthError,
  JiraRequestError,
  JiraTransientError,
} from "./jira-client.js";

const EMAIL = "bot@example.com";
const API_TOKEN = "jira-secret-token";

type StubBehaviour = {
  approximateCount?: (req: IncomingMessage, body: unknown, res: ServerResponse) => void;
  searchJql?: (req: IncomingMessage, url: URL, res: ServerResponse) => void;
  /** Any other path (issue GET/assignee PUT/comment POST). */
  other?: (req: IncomingMessage, url: URL, body: unknown, res: ServerResponse) => void;
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

function expectedAuthHeader(): string {
  return `Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`, "utf8").toString("base64")}`;
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
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        authorization: req.headers.authorization,
        body: parsed,
      });

      if (url.pathname === "/rest/api/3/search/approximate-count" && req.method === "POST") {
        if (behaviour.approximateCount) return behaviour.approximateCount(req, parsed, res);
        return json(res, 200, { count: 3 });
      }
      if (url.pathname === "/rest/api/3/search/jql" && req.method === "GET") {
        if (behaviour.searchJql) return behaviour.searchJql(req, url, res);
        return json(res, 200, {
          issues: [
            { key: "FT-1", fields: { issuetype: { name: "Task" }, status: { name: "To Do", statusCategory: { key: "new" } }, parent: null } },
          ],
          isLast: true,
          nextPageToken: null,
        });
      }
      if (behaviour.other) return behaviour.other(req, url, parsed, res);
      json(res, 404, { errorMessages: ["not found"] });
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
        server.close(() => resolve());
      }),
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
});

describe("jira-client", () => {
  describe("approximateCount", () => {
    it("posts the JQL and returns the count", async () => {
      const stub = await startStub();
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      const count = await client.approximateCount('project = FT AND status = "To Do"');
      expect(count).toBe(3);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.method).toBe("POST");
      expect(stub.requests[0]?.path).toBe("/rest/api/3/search/approximate-count");
      expect(stub.requests[0]?.authorization).toBe(expectedAuthHeader());
      expect(stub.requests[0]?.body).toEqual({ jql: 'project = FT AND status = "To Do"' });
      await stub.close();
    });

    it("never sends the token in cleartext outside the Basic header", async () => {
      const stub = await startStub();
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await client.approximateCount("project = FT");
      const bodyText = JSON.stringify(stub.requests[0]?.body);
      expect(bodyText).not.toContain(API_TOKEN);
      await stub.close();
    });

    it("classifies HTTP 401 as JiraAuthError", async () => {
      const stub = await startStub({
        approximateCount: (_req, _body, res) => json(res, 401, { errorMessages: ["unauthorized"] }),
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await expect(client.approximateCount("project = FT")).rejects.toBeInstanceOf(JiraAuthError);
      await stub.close();
    });

    it("classifies HTTP 403 as JiraAuthError", async () => {
      const stub = await startStub({
        approximateCount: (_req, _body, res) => json(res, 403, { errorMessages: ["forbidden"] }),
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await expect(client.approximateCount("project = FT")).rejects.toBeInstanceOf(JiraAuthError);
      await stub.close();
    });

    it("classifies HTTP 429 as JiraTransientError", async () => {
      const stub = await startStub({
        approximateCount: (_req, _body, res) => json(res, 429, { errorMessages: ["rate limited"] }),
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await expect(client.approximateCount("project = FT")).rejects.toBeInstanceOf(JiraTransientError);
      await stub.close();
    });

    it("classifies HTTP 503 as JiraTransientError", async () => {
      const stub = await startStub({
        approximateCount: (_req, _body, res) => json(res, 503, { errorMessages: ["unavailable"] }),
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await expect(client.approximateCount("project = FT")).rejects.toBeInstanceOf(JiraTransientError);
      await stub.close();
    });

    it("classifies other non-2xx responses as JiraRequestError", async () => {
      const stub = await startStub({
        approximateCount: (_req, _body, res) => json(res, 400, { errorMessages: ["bad jql"] }),
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await expect(client.approximateCount("not jql")).rejects.toBeInstanceOf(JiraRequestError);
      await stub.close();
    });

    it("times out and raises a transient error when the server never responds", async () => {
      const server = createServer((_req, _res) => {
        // Never respond.
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      servers.push(server);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const client = createJiraClient({
        baseUrl: `http://127.0.0.1:${port}`,
        email: EMAIL,
        apiToken: API_TOKEN,
        timeoutMs: 50,
      });
      await expect(client.approximateCount("project = FT")).rejects.toBeInstanceOf(JiraTransientError);
    }, 10_000);
  });

  describe("searchKeys", () => {
    it("sends the JQL, maxResults and fields, and maps issue summaries", async () => {
      const stub = await startStub({
        searchJql: (_req, url, res) => {
          expect(url.searchParams.get("jql")).toBe("project = FT");
          expect(url.searchParams.get("maxResults")).toBe("100");
          expect(url.searchParams.get("fields")).toBe("key,issuetype,status,parent");
          json(res, 200, {
            issues: [
              {
                key: "FT-10",
                fields: {
                  issuetype: { name: "Epic" },
                  status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
                  parent: null,
                },
              },
              {
                key: "FT-11",
                fields: {
                  issuetype: { name: "Task" },
                  status: { name: "Done", statusCategory: { key: "done" } },
                  parent: { key: "FT-10" },
                },
              },
            ],
            isLast: true,
            nextPageToken: null,
          });
        },
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      const issues = await client.searchKeys("project = FT");
      expect(issues).toEqual([
        { key: "FT-10", issueTypeName: "Epic", statusName: "In Progress", statusCategoryKey: "indeterminate", parentKey: null },
        { key: "FT-11", issueTypeName: "Task", statusName: "Done", statusCategoryKey: "done", parentKey: "FT-10" },
      ]);
      await stub.close();
    });

    it("paginates via nextPageToken until isLast", async () => {
      let calls = 0;
      const stub = await startStub({
        searchJql: (_req, url, res) => {
          calls += 1;
          const token = url.searchParams.get("nextPageToken");
          if (!token) {
            return json(res, 200, {
              issues: [{ key: "FT-1", fields: { issuetype: { name: "Task" }, status: { name: "To Do", statusCategory: { key: "new" } } } }],
              isLast: false,
              nextPageToken: "page-2",
            });
          }
          expect(token).toBe("page-2");
          return json(res, 200, {
            issues: [{ key: "FT-2", fields: { issuetype: { name: "Task" }, status: { name: "To Do", statusCategory: { key: "new" } } } }],
            isLast: true,
            nextPageToken: null,
          });
        },
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      const issues = await client.searchKeys("project = FT");
      expect(calls).toBe(2);
      expect(issues.map((i) => i.key)).toEqual(["FT-1", "FT-2"]);
      await stub.close();
    });

    it("classifies HTTP 401 as JiraAuthError", async () => {
      const stub = await startStub({
        searchJql: (_req, _url, res) => json(res, 401, { errorMessages: ["unauthorized"] }),
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await expect(client.searchKeys("project = FT")).rejects.toBeInstanceOf(JiraAuthError);
      await stub.close();
    });
  });

  describe("searchIssues", () => {
    it("requests summary/created/updated by default and maps them", async () => {
      const stub = await startStub({
        searchJql: (_req, url, res) => {
          expect(url.searchParams.get("fields")).toBe("key,summary,status,issuetype,created,updated,parent");
          json(res, 200, {
            issues: [
              {
                key: "FT-1",
                fields: {
                  summary: "Do the thing",
                  created: "2026-01-01T00:00:00.000+0000",
                  updated: "2026-01-02T00:00:00.000+0000",
                  issuetype: { name: "Task" },
                  status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
                },
              },
            ],
            isLast: true,
          });
        },
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      expect(await client.searchIssues("project = FT")).toEqual([
        {
          key: "FT-1",
          summary: "Do the thing",
          created: "2026-01-01T00:00:00.000+0000",
          updated: "2026-01-02T00:00:00.000+0000",
          issueTypeName: "Task",
          statusName: "In Progress",
          statusCategoryKey: "indeterminate",
          parentKey: null,
        },
      ]);
      await stub.close();
    });
  });

  describe("issue writes", () => {
    it("getIssue fetches the requested fields", async () => {
      const stub = await startStub({
        other: (req, url, _body, res) => {
          expect(req.method).toBe("GET");
          expect(url.pathname).toBe("/rest/api/3/issue/FT-7");
          expect(url.searchParams.get("fields")).toBe("assignee");
          json(res, 200, { key: "FT-7", fields: { assignee: { accountId: "acc-1" } } });
        },
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      expect(await client.getIssue("FT-7", ["assignee"])).toEqual({ key: "FT-7", fields: { assignee: { accountId: "acc-1" } } });
      await stub.close();
    });

    it("assignIssue PUTs the accountId to the v3 assignee endpoint", async () => {
      const stub = await startStub({
        other: (_req, _url, _body, res) => {
          res.writeHead(204);
          res.end();
        },
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await client.assignIssue("FT-7", "human-acc");
      expect(stub.requests).toEqual([
        { method: "PUT", path: "/rest/api/3/issue/FT-7/assignee", authorization: expectedAuthHeader(), body: { accountId: "human-acc" } },
      ]);
      await stub.close();
    });

    it("addComment POSTs a plain-text body to the v2 comment endpoint", async () => {
      const stub = await startStub({
        other: (_req, _url, _body, res) => json(res, 201, { id: "1" }),
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await client.addComment("FT-7", "Declined by fleet supervisor X");
      expect(stub.requests[0]).toMatchObject({
        method: "POST",
        path: "/rest/api/2/issue/FT-7/comment",
        body: { body: "Declined by fleet supervisor X" },
      });
      await stub.close();
    });

    it("classifies a 403 on assign as JiraAuthError", async () => {
      const stub = await startStub({
        other: (_req, _url, _body, res) => json(res, 403, { errorMessages: ["no permission"] }),
      });
      const client = createJiraClient({ baseUrl: stub.url, email: EMAIL, apiToken: API_TOKEN });
      await expect(client.assignIssue("FT-7", "human-acc")).rejects.toBeInstanceOf(JiraAuthError);
      await stub.close();
    });
  });
});
