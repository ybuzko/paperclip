/**
 * A minimal Jira Cloud REST v3 client for the fleet dispatch loop
 * (see ./DISPATCH.md). Only the two read-only endpoints the dispatch loop
 * needs: an approximate issue count for a JQL query, and a paginated list of
 * issue keys (with a few fields) matching a JQL query.
 *
 * Auth is HTTP Basic with the account email and an API token (Jira Cloud's
 * documented auth scheme for REST v3 -- https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/).
 * The token is never logged: errors carry only the HTTP status and Jira's
 * error payload (if any), never the Authorization header or the token value.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const SEARCH_PAGE_SIZE = 100;

export interface JiraClientConfig {
  /** Jira Cloud site base URL, e.g. `https://acme.atlassian.net`. No trailing slash required. */
  baseUrl: string;
  email: string;
  apiToken: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface JiraIssueSummary {
  key: string;
  issueTypeName: string | null;
  statusName: string | null;
  /** Jira's `status.statusCategory.key`, e.g. `"new"`, `"indeterminate"`, `"done"`. */
  statusCategoryKey: string | null;
  parentKey: string | null;
}

export interface JiraClient {
  /** `POST /rest/api/3/search/approximate-count` -> the approximate result count for `jql`. */
  approximateCount(jql: string): Promise<number>;
  /**
   * `GET /rest/api/3/search/jql`, paginated via `nextPageToken` until
   * `isLast`. Returns every matching issue's key plus the requested fields
   * (default: `key,issuetype,status,parent`).
   */
  searchKeys(jql: string, fields?: readonly string[]): Promise<JiraIssueSummary[]>;
}

export type JiraClientFactory = (config: JiraClientConfig) => JiraClient;

/** Thrown for HTTP 401/403 (bad/expired credentials) -- never retried by the caller. */
export class JiraAuthError extends Error {
  readonly status: number;
  constructor(status: number, message = "Jira authentication failed") {
    super(message);
    this.name = "JiraAuthError";
    this.status = status;
  }
}

/** Thrown for HTTP 429/5xx and network/timeout failures -- safe to retry on the next poll. */
export class JiraTransientError extends Error {
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "JiraTransientError";
    this.status = status;
  }
}

/** Thrown for any other non-2xx response (e.g. a malformed JQL query -- HTTP 400). */
export class JiraRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "JiraRequestError";
    this.status = status;
  }
}

const DEFAULT_SEARCH_FIELDS = ["key", "issuetype", "status", "parent"] as const;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function basicAuthHeader(email: string, apiToken: string): string {
  // Never log this value; callers must not pass it to a logger.
  return `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
}

/** True for errors node:fetch/undici raise on abort or connection failure -- treated as transient. */
function isNetworkOrTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) return true;
  }
  return false;
}

/**
 * Extracts a safe-to-surface error message from a Jira REST error body,
 * without ever including request headers or the raw response body verbatim
 * (Jira error payloads do not carry the token, but we still cap length and
 * avoid dumping arbitrary upstream content into logs).
 */
async function readErrorSummary(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) return response.statusText || `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown };
      const messages: string[] = [];
      if (Array.isArray(parsed.errorMessages)) {
        for (const m of parsed.errorMessages) if (typeof m === "string") messages.push(m);
      }
      if (parsed.errors && typeof parsed.errors === "object") {
        for (const v of Object.values(parsed.errors as Record<string, unknown>)) {
          if (typeof v === "string") messages.push(v);
        }
      }
      if (messages.length > 0) return messages.join("; ").slice(0, 500);
    } catch {
      // fall through to raw text below
    }
    return text.slice(0, 500);
  } catch {
    return response.statusText || `HTTP ${response.status}`;
  }
}

async function classifyAndThrow(response: Response): Promise<never> {
  const status = response.status;
  const summary = await readErrorSummary(response);
  if (status === 401 || status === 403) {
    throw new JiraAuthError(status, `Jira authentication failed (HTTP ${status}): ${summary}`);
  }
  if (status === 429 || status >= 500) {
    throw new JiraTransientError(status, `Jira request failed transiently (HTTP ${status}): ${summary}`);
  }
  throw new JiraRequestError(status, `Jira request failed (HTTP ${status}): ${summary}`);
}

export function createJiraClient(config: JiraClientConfig): JiraClient {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authHeader = basicAuthHeader(config.email, config.apiToken);

  async function request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(joinUrl(config.baseUrl, path), {
        ...init,
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isNetworkOrTimeoutError(err)) {
        throw new JiraTransientError(null, `Jira request timed out or failed to connect: ${(err as Error).message}`);
      }
      throw err;
    }
  }

  async function approximateCount(jql: string): Promise<number> {
    const response = await request("/rest/api/3/search/approximate-count", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jql }),
    });
    if (!response.ok) await classifyAndThrow(response);
    const body = (await response.json()) as { count?: unknown };
    const count = Number(body.count);
    if (!Number.isFinite(count) || count < 0) {
      throw new JiraRequestError(response.status, "Jira approximate-count response had no numeric count");
    }
    return count;
  }

  async function searchKeys(jql: string, fields: readonly string[] = DEFAULT_SEARCH_FIELDS): Promise<JiraIssueSummary[]> {
    const results: JiraIssueSummary[] = [];
    let nextPageToken: string | undefined;

    for (;;) {
      const params = new URLSearchParams({
        jql,
        maxResults: String(SEARCH_PAGE_SIZE),
        fields: fields.join(","),
      });
      if (nextPageToken) params.set("nextPageToken", nextPageToken);

      const response = await request(`/rest/api/3/search/jql?${params.toString()}`, { method: "GET" });
      if (!response.ok) await classifyAndThrow(response);

      const body = (await response.json()) as {
        issues?: Array<{
          key: string;
          fields?: {
            issuetype?: { name?: string | null } | null;
            status?: { name?: string | null; statusCategory?: { key?: string | null } | null } | null;
            parent?: { key?: string | null } | null;
          } | null;
        }>;
        isLast?: boolean;
        nextPageToken?: string | null;
      };

      for (const issue of body.issues ?? []) {
        results.push({
          key: issue.key,
          issueTypeName: issue.fields?.issuetype?.name ?? null,
          statusName: issue.fields?.status?.name ?? null,
          statusCategoryKey: issue.fields?.status?.statusCategory?.key ?? null,
          parentKey: issue.fields?.parent?.key ?? null,
        });
      }

      if (body.isLast !== false && !body.nextPageToken) break;
      if (body.isLast === true) break;
      if (!body.nextPageToken) break;
      nextPageToken = body.nextPageToken;
    }

    return results;
  }

  return { approximateCount, searchKeys };
}
