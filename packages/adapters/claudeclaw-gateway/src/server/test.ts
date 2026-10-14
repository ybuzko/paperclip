import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { apiUrl, normalizeBaseUrl } from "./execute.js";

const PROBE_TIMEOUT_MS = 3_000;

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;
  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const rawUrl = asString(ctx.config.url, "").trim();
  const apiToken = asString(ctx.config.apiToken, "").trim();

  if (!rawUrl) {
    checks.push({
      code: "claudeclaw_gateway_url_missing",
      level: "error",
      message: "Claudeclaw Gateway requires url.",
      hint: "Set adapterConfig.url to the daemon's HTTP base URL, for example http://10.0.0.41:4632.",
    });
  }
  const baseUrl = rawUrl ? normalizeBaseUrl(rawUrl) : null;
  if (rawUrl && !baseUrl) {
    checks.push({
      code: "claudeclaw_gateway_url_invalid",
      level: "error",
      message: `url must be an http:// or https:// URL (got ${rawUrl}).`,
    });
  }
  if (!apiToken) {
    checks.push({
      code: "claudeclaw_gateway_api_token_missing",
      level: "error",
      message: "Claudeclaw Gateway requires apiToken.",
      hint: "Copy settings.apiToken from the daemon into adapterConfig.apiToken.",
    });
  }

  if (baseUrl) {
    checks.push({
      code: "claudeclaw_gateway_url_valid",
      level: "info",
      message: `Configured claudeclaw URL: ${baseUrl.toString()}`,
    });
    if (baseUrl.protocol === "http:" && !isLoopbackHostname(baseUrl.hostname)) {
      checks.push({
        code: "claudeclaw_gateway_plaintext_remote_http",
        level: "info",
        message: "Plain HTTP to a non-loopback host; keep this on a private LAN or overlay network.",
      });
    }
  }

  if (!baseUrl || !apiToken) {
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  try {
    const response = await fetch(apiUrl(baseUrl, "/api/health"), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    checks.push({
      code: response.ok ? "claudeclaw_gateway_health_ok" : "claudeclaw_gateway_health_failed",
      level: response.ok ? "info" : "error",
      message: response.ok
        ? "claudeclaw /api/health is reachable."
        : `claudeclaw /api/health returned HTTP ${response.status}.`,
      hint: response.ok ? undefined : "Check the url and that the claudeclaw daemon is running and bound to a reachable interface.",
    });
  } catch (err) {
    checks.push({
      code: "claudeclaw_gateway_health_unreachable",
      level: "error",
      message: "Could not reach claudeclaw /api/health.",
      detail: errorDetail(err),
      hint: "Check the url, the daemon's bind address (default 127.0.0.1:4632 is not reachable over the LAN), and firewall rules.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // The daemon honours settings.apiToken only on POST /api/inject (every other /api route wants the
  // web UI token), so probe auth there with an empty body: the daemon validates the token first and
  // then rejects the missing message with HTTP 400 without touching any session.
  try {
    const response = await fetch(apiUrl(baseUrl, "/api/inject"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 400) {
      checks.push({
        code: "claudeclaw_gateway_auth_ok",
        level: "info",
        message: "claudeclaw accepted the API token on /api/inject (empty probe rejected as expected).",
      });
    } else if (response.status === 401 || response.status === 403) {
      checks.push({
        code: "claudeclaw_gateway_auth_failed",
        level: "error",
        message: `claudeclaw rejected the API token (HTTP ${response.status}).`,
        hint: "Make sure adapterConfig.apiToken matches settings.apiToken on the daemon.",
      });
    } else {
      checks.push({
        code: "claudeclaw_gateway_probe_unexpected",
        level: "warn",
        message: `claudeclaw answered the empty /api/inject probe with HTTP ${response.status} instead of 400.`,
        hint: "The daemon may be a different build; verify it runs the patched claudeclaw fork.",
      });
    }
  } catch (err) {
    checks.push({
      code: "claudeclaw_gateway_probe_unreachable",
      level: "error",
      message: "Could not reach claudeclaw /api/inject for the auth probe.",
      detail: errorDetail(err),
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
