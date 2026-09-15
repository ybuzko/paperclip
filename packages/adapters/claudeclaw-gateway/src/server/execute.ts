import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_CLAIMED_API_KEY_PATH,
  DEFAULT_PAPERCLIP_API_URL,
  DEFAULT_TIMEOUT_SEC,
  LOG_PREFIX,
} from "../shared/constants.js";

type WakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

export type ClaudeclawInjectResponse = {
  ok: boolean;
  result?: unknown;
  exitCode?: unknown;
  sessionId?: unknown;
  error?: unknown;
};

const TRANSIENT_ERROR_TEXT_RE = /timed?\s*out|timeout|busy|queue|EAGAIN|ECONNRESET|temporarily/i;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeBaseUrl(value: unknown): URL | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function resolvePaperclipApiUrl(value: unknown): string {
  const parsed = normalizeBaseUrl(value);
  return (parsed ?? new URL(DEFAULT_PAPERCLIP_API_URL)).toString().replace(/\/+$/, "");
}

export function resolveClaimedApiKeyPath(value: unknown): string {
  return nonEmpty(value) ?? DEFAULT_CLAIMED_API_KEY_PATH;
}

/** Project env key holding the claudeclaw thread binding (PIX-4 plan §13.3 / §14.1). */
export const THREAD_ENV_KEY = "CLAUDECLAW_THREAD";
/** Project env key naming the daemon workspace for the project (informational, echoed in the wake). */
export const WORKSPACE_ENV_KEY = "CLAUDECLAW_WORKSPACE";
/** Project env key naming the Jira project (informational, echoed in the wake when set). */
export const JIRA_PROJECT_ENV_KEY = "JIRA_PROJECT";

export type ThreadBinding = {
  projectId: string;
  projectName: string | null;
  /** Full claudeclaw session key, e.g. `tg:-100123:42` or `paperclip:FT`. */
  thread: string;
  /** Raw value of CLAUDECLAW_THREAD on the project. */
  rawBinding: string;
  workspace: string | null;
  jiraProject: string | null;
};

export type ThreadResolution =
  | { ok: true; binding: ThreadBinding }
  | { ok: false; errorCode: "claudeclaw_gateway_thread_unmapped"; errorMessage: string; errorMeta: Record<string, unknown> };

function readProjectEnv(context: Record<string, unknown>): Record<string, string> {
  const raw = asRecord(context.projectEnv);
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const trimmed = nonEmpty(value);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/**
 * Compose the claudeclaw session key for a project binding.
 * A value containing ":" is already a full session key and is used verbatim.
 * A bare value is a Telegram forum topic id and composes to `tg:<chatId>:<topicId>`.
 * Exported for tests.
 */
export function composeThreadKey(rawBinding: string, telegramChatId: string | null): string | null {
  const value = rawBinding.trim();
  if (!value) return null;
  if (value.includes(":")) return value;
  if (!telegramChatId) return null;
  return `tg:${telegramChatId}:${value}`;
}

/**
 * Resolve the thread a wake must be injected into from the project binding
 * on the execution context. Never falls back to the daemon's global session.
 * Exported for tests.
 */
export function resolveThreadBinding(ctx: AdapterExecutionContext): ThreadResolution {
  const context = ctx.context ?? {};
  const projectId = nonEmpty(context.projectId);
  const issueId = nonEmpty(context.taskId) ?? nonEmpty(context.issueId);
  const wakeReason = nonEmpty(context.wakeReason) ?? "unknown";
  const telegramChatId = nonEmpty(ctx.config.telegramChatId);

  if (!projectId) {
    return {
      ok: false,
      errorCode: "claudeclaw_gateway_thread_unmapped",
      errorMessage: issueId
        ? `Wake for issue ${issueId} (reason ${wakeReason}) carries no project, so no claudeclaw thread can be chosen. ` +
          "Move the issue into a project that binds CLAUDECLAW_THREAD in its env. Wakes are never injected into the global session."
        : `Wake with no issue and no project (reason ${wakeReason}) has no claudeclaw thread to target and was skipped. ` +
          "Timer heartbeats are not routed for claudeclaw_gateway agents; assign issues inside a project that binds CLAUDECLAW_THREAD.",
      errorMeta: { wakeReason, issueId, projectId: null },
    };
  }

  const projectName = nonEmpty(context.projectName);
  const projectLabel = projectName ? `${projectName} (${projectId})` : projectId;
  const env = readProjectEnv(context);
  const rawBinding = env[THREAD_ENV_KEY] ?? null;
  if (!rawBinding) {
    return {
      ok: false,
      errorCode: "claudeclaw_gateway_thread_unmapped",
      errorMessage:
        `Project ${projectLabel} has no ${THREAD_ENV_KEY} in its env, so this wake cannot be routed to a claudeclaw thread. ` +
        `Set ${THREAD_ENV_KEY} on the project to a Telegram topic id (with adapter telegramChatId configured) or a full session key such as paperclip:FT. ` +
        "Wakes are never injected into the global session.",
      errorMeta: { wakeReason, issueId, projectId, projectName, envKey: THREAD_ENV_KEY },
    };
  }

  const thread = composeThreadKey(rawBinding, telegramChatId);
  if (!thread) {
    return {
      ok: false,
      errorCode: "claudeclaw_gateway_thread_unmapped",
      errorMessage:
        `Project ${projectLabel} binds ${THREAD_ENV_KEY}=${rawBinding} as a bare topic id, but the adapter has no telegramChatId to compose tg:<chatId>:<topicId>. ` +
        "Set telegramChatId on the agent's adapter config or bind a full session key on the project.",
      errorMeta: { wakeReason, issueId, projectId, projectName, envKey: THREAD_ENV_KEY, rawBinding },
    };
  }

  return {
    ok: true,
    binding: {
      projectId,
      projectName,
      thread,
      rawBinding,
      workspace: env[WORKSPACE_ENV_KEY] ?? null,
      jiraProject: env[JIRA_PROJECT_ENV_KEY] ?? null,
    },
  };
}

/** First line of the wake: the turn states its own project/thread/workspace context. */
export function buildContextPrefix(binding: ThreadBinding): string {
  const parts = [
    `Project: ${binding.projectName ?? binding.projectId}`,
    `thread ${binding.thread}`,
    `workspace ${binding.workspace ?? "<unset>"}`,
  ];
  if (binding.jiraProject) parts.push(`Jira ${binding.jiraProject}`);
  return parts.join(" · ");
}

function buildWakePayload(ctx: AdapterExecutionContext): WakePayload {
  const { runId, agent, context } = ctx;
  return {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : [],
  };
}

function buildPaperclipEnvForWake(
  ctx: AdapterExecutionContext,
  wakePayload: WakePayload,
  paperclipApiUrl: string,
): Record<string, string> {
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
    PAPERCLIP_API_URL: paperclipApiUrl,
  };
  if (wakePayload.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wakePayload.taskId;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  if (issueWorkMode) paperclipEnv.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakePayload.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakePayload.wakeReason;
  if (wakePayload.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakePayload.wakeCommentId;
  if (wakePayload.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wakePayload.approvalId;
  if (wakePayload.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wakePayload.approvalStatus;
  if (wakePayload.issueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wakePayload.issueIds.join(",");
  }
  // The key never travels in the wake message; the agent loads it from its own env file.
  delete paperclipEnv.PAPERCLIP_API_KEY;
  return paperclipEnv;
}

function buildWakeText(
  payload: WakePayload,
  paperclipEnv: Record<string, string>,
  structuredWakePrompt: string,
  claimedApiKeyPath: string,
): string {
  const orderedKeys = [
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_ISSUE_WORK_MODE",
    "PAPERCLIP_WAKE_REASON",
    "PAPERCLIP_WAKE_COMMENT_ID",
    "PAPERCLIP_APPROVAL_ID",
    "PAPERCLIP_APPROVAL_STATUS",
    "PAPERCLIP_LINKED_ISSUE_IDS",
  ];

  const envLines: string[] = [];
  for (const key of orderedKeys) {
    const value = paperclipEnv[key];
    if (!value) continue;
    envLines.push(`${key}=${value}`);
  }

  const issueIdHint = payload.taskId ?? payload.issueId ?? "";
  const apiBaseHint = paperclipEnv.PAPERCLIP_API_URL;

  const lines = [
    "Paperclip wake event for a claudeclaw gateway agent.",
    "",
    "Run this procedure now. Do not guess undocumented endpoints and do not ask for additional heartbeat docs.",
    "",
    "Set these values in your run context:",
    ...envLines,
    `PAPERCLIP_API_KEY=<token from ${claimedApiKeyPath}>`,
    "",
    `Load PAPERCLIP_API_KEY from ${claimedApiKeyPath} in your project directory (the env file you saved after claim-api-key), for example: source ${claimedApiKeyPath}.`,
    "The key is never included in this message. Never print it, paste it into comments, or write it anywhere else.",
    "",
    `api_base=${apiBaseHint}`,
    `task_id=${payload.taskId ?? ""}`,
    `issue_id=${payload.issueId ?? ""}`,
    `wake_reason=${payload.wakeReason ?? ""}`,
    `wake_comment_id=${payload.wakeCommentId ?? ""}`,
    `approval_id=${payload.approvalId ?? ""}`,
    `approval_status=${payload.approvalStatus ?? ""}`,
    `linked_issue_ids=${payload.issueIds.join(",")}`,
    "",
    "HTTP rules:",
    "- Use Authorization: Bearer $PAPERCLIP_API_KEY on every API call.",
    "- Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every mutating API call.",
    "- Use only /api endpoints listed below.",
    "- Do NOT call guessed endpoints like /api/cloud-adapter/*, /api/cloud-adapters/*, /api/adapters/cloud/*, or /api/heartbeat.",
    "",
    "Workflow:",
    "1) GET /api/agents/me",
    `2) Determine issueId: PAPERCLIP_TASK_ID if present, otherwise issue_id (${issueIdHint}).`,
    '   Replace {issueId} in every endpoint below with that determined id. Never send the literal text "{issueId}" in a URL.',
    "3) If issueId exists:",
    "   - POST /api/issues/{issueId}/checkout with {\"agentId\":\"$PAPERCLIP_AGENT_ID\",\"expectedStatuses\":[\"todo\",\"backlog\",\"blocked\",\"in_review\"]}",
    "   - GET /api/issues/{issueId}",
    "   - GET /api/issues/{issueId}/comments",
    "   - Execute the issue instructions exactly. If the issue is actionable, take concrete action in this run; do not stop at a plan unless planning was requested.",
    "   - Leave durable progress with a clear next action. Use child issues for long or parallel delegated work instead of polling agents, sessions, or processes.",
    "   - Create child issues directly when you know what needs to be done; use POST /api/issues/{issueId}/interactions with kind suggest_tasks, ask_user_questions, or request_confirmation when the board/user must choose, answer, or confirm before you can continue.",
    "   - For plan approval, update the plan document first, then create request_confirmation targeting the latest plan revision with idempotencyKey confirmation:{issueId}:plan:{revisionId}; wait for acceptance before creating implementation subtasks.",
    "   - If blocked, PATCH /api/issues/{issueId} with {\"status\":\"blocked\",\"comment\":\"what is blocked, who owns the unblock, and the next action\"}.",
    "   - If instructions require a comment, POST /api/issues/{issueId}/comments with {\"body\":\"...\"}.",
    "   - PATCH /api/issues/{issueId} with {\"status\":\"done\",\"comment\":\"what changed and why\"}.",
    "4) If issueId does not exist:",
    "   - GET /api/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID&status=todo,in_progress,in_review,blocked",
    "   - Pick in_progress first, then in_review when you were woken by a comment, then todo, then blocked, then execute step 3.",
    "",
    "Useful endpoints for issue work:",
    "- POST /api/issues/{issueId}/comments",
    "- PATCH /api/issues/{issueId}",
    "- POST /api/companies/{companyId}/issues (when asked to create a new issue)",
    ...(structuredWakePrompt ? ["", structuredWakePrompt] : []),
    "",
    "Complete the workflow in this run.",
  ];
  return lines.join("\n");
}

function joinWakePayloadSections(structuredWakePrompt: string, structuredWakeJson: string): string {
  const sections = [
    structuredWakePrompt.trim(),
    "Structured wake payload JSON:",
    "```json",
    structuredWakeJson,
    "```",
  ].filter((entry) => entry.trim().length > 0);
  return sections.join("\n");
}

export function buildWakeMessage(ctx: AdapterExecutionContext, binding?: ThreadBinding | null): string {
  const wakePayload = buildWakePayload(ctx);
  const paperclipApiUrl = resolvePaperclipApiUrl(ctx.config.paperclipApiUrl);
  const paperclipEnv = buildPaperclipEnvForWake(ctx, wakePayload, paperclipApiUrl);
  // No heartbeat prompt template reaches the daemon, so the wake prompt must
  // carry the execution contract itself.
  const structuredWakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    includeExecutionContract: true,
  });
  const structuredWakeJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  const text = buildWakeText(
    wakePayload,
    paperclipEnv,
    structuredWakeJson
      ? joinWakePayloadSections(structuredWakePrompt, structuredWakeJson)
      : structuredWakePrompt,
    resolveClaimedApiKeyPath(ctx.config.claimedApiKeyPath),
  );
  return binding ? `${buildContextPrefix(binding)}\n\n${text}` : text;
}

function redactToken(text: string, token: string): string {
  return token ? text.split(token).join("***REDACTED***") : text;
}

function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;
  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError";
}

function failure(input: {
  errorCode: string;
  errorMessage: string;
  errorFamily?: AdapterExecutionResult["errorFamily"];
  timedOut?: boolean;
  errorMeta?: Record<string, unknown>;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
}): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: input.timedOut ?? false,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    errorFamily: input.errorFamily ?? null,
    provider: ADAPTER_TYPE,
    ...(input.errorMeta ? { errorMeta: input.errorMeta } : {}),
    ...(input.sessionParams ? { sessionParams: input.sessionParams } : {}),
    ...(input.sessionDisplayId ? { sessionDisplayId: input.sessionDisplayId } : {}),
  };
}

export function classifyHttpStatus(status: number): {
  code: string;
  family: AdapterExecutionResult["errorFamily"];
} {
  if (status === 401 || status === 403) return { code: "claudeclaw_gateway_auth_failed", family: null };
  if (status === 404) return { code: "claudeclaw_gateway_inject_unsupported", family: null };
  if (status === 429) return { code: "claudeclaw_gateway_rate_limited", family: "transient_upstream" };
  if (status >= 500) return { code: "claudeclaw_gateway_upstream_error", family: "transient_upstream" };
  return { code: "claudeclaw_gateway_protocol_error", family: null };
}

/**
 * Map a parsed inject response (any HTTP status) to an adapter result.
 * Exported for tests.
 */
export function mapInjectResponse(input: {
  status: number;
  body: unknown;
  rawText: string;
  apiToken: string;
}): AdapterExecutionResult {
  const record = asRecord(input.body);
  const redact = (text: string) => redactToken(text, input.apiToken);

  if (record && record.ok === false) {
    const errorText = nonEmpty(record.error) ?? `claudeclaw inject failed (HTTP ${input.status})`;
    const transient = TRANSIENT_ERROR_TEXT_RE.test(errorText) || input.status === 429 || input.status === 503;
    const authFailed = input.status === 401 || input.status === 403;
    return failure({
      errorCode: authFailed
        ? "claudeclaw_gateway_auth_failed"
        : TRANSIENT_ERROR_TEXT_RE.test(errorText)
          ? "claudeclaw_gateway_turn_timeout"
          : "claudeclaw_gateway_inject_failed",
      errorMessage: authFailed
        ? `claudeclaw rejected the API token (HTTP ${input.status}). Check adapterConfig.apiToken matches settings.apiToken on the daemon.`
        : `claudeclaw inject failed: ${redact(errorText)}`,
      errorFamily: authFailed ? null : transient ? "transient_upstream" : null,
      errorMeta: { status: input.status, error: redact(errorText) },
    });
  }

  if (input.status < 200 || input.status >= 300) {
    const classified = classifyHttpStatus(input.status);
    const detail = redact(input.rawText.slice(0, 500));
    return failure({
      errorCode: classified.code,
      errorMessage:
        classified.code === "claudeclaw_gateway_auth_failed"
          ? `claudeclaw rejected the API token (HTTP ${input.status}). Check adapterConfig.apiToken matches settings.apiToken on the daemon.`
          : `claudeclaw inject returned HTTP ${input.status}${detail ? `: ${detail}` : ""}`,
      errorFamily: classified.family,
      errorMeta: { status: input.status },
    });
  }

  if (!record || record.ok !== true) {
    return failure({
      errorCode: "claudeclaw_gateway_protocol_error",
      errorMessage: `claudeclaw inject returned an unexpected body: ${redact(input.rawText.slice(0, 300)) || "<empty>"}`,
      errorMeta: { status: input.status },
    });
  }

  if (!Object.prototype.hasOwnProperty.call(record, "sessionId")) {
    return failure({
      errorCode: "claudeclaw_gateway_fork_patch_missing",
      errorMessage:
        "claudeclaw fork patch missing: /api/inject responded without sessionId, so this daemon is unpatched " +
        "(it ignores forward:false and echoes wake turns to Telegram). Deploy the patched claudeclaw fork on this host before assigning work.",
      errorMeta: { status: input.status, responseKeys: Object.keys(record).sort() },
    });
  }

  const sessionId = nonEmpty(record.sessionId);
  const resultText = typeof record.result === "string" ? record.result : "";
  const exitCode = typeof record.exitCode === "number" && Number.isFinite(record.exitCode) ? record.exitCode : 0;
  const sessionParams = sessionId ? { claudeclawSessionId: sessionId } : null;

  if (exitCode !== 0) {
    return failure({
      errorCode: "claudeclaw_gateway_turn_failed",
      errorMessage: `claudeclaw turn exited with code ${exitCode}${resultText.trim() ? `: ${redact(resultText.trim().slice(0, 500))}` : ""}`,
      errorMeta: { status: input.status, exitCode },
      sessionParams,
      sessionDisplayId: sessionId,
    });
  }

  if (!sessionId) {
    return failure({
      errorCode: "claudeclaw_gateway_session_missing",
      errorMessage:
        "claudeclaw reported sessionId=null after the turn, so no session file exists on the daemon host. Check the daemon's project directory and session.json.",
      errorMeta: { status: input.status },
    });
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: ADAPTER_TYPE,
    summary: redact(resultText.trim()) || null,
    sessionParams,
    sessionDisplayId: sessionId,
    resultJson: {
      ok: true,
      exitCode,
      sessionId,
      resultChars: resultText.length,
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const rawUrl = asString(ctx.config.url, "").trim();
  if (!rawUrl) {
    return failure({
      errorCode: "claudeclaw_gateway_url_missing",
      errorMessage: "claudeclaw gateway adapter requires url.",
    });
  }
  const baseUrl = normalizeBaseUrl(rawUrl);
  if (!baseUrl) {
    return failure({
      errorCode: "claudeclaw_gateway_url_invalid",
      errorMessage: `Invalid claudeclaw url: ${rawUrl} (expected http:// or https://).`,
    });
  }

  const apiToken = nonEmpty(ctx.config.apiToken);
  if (!apiToken) {
    return failure({
      errorCode: "claudeclaw_gateway_api_token_missing",
      errorMessage: "claudeclaw gateway adapter requires apiToken.",
    });
  }

  const resolution = resolveThreadBinding(ctx);
  if (!resolution.ok) {
    await ctx.onLog("stderr", `${LOG_PREFIX} ${resolution.errorCode}: ${resolution.errorMessage}\n`);
    return failure({
      errorCode: resolution.errorCode,
      errorMessage: resolution.errorMessage,
      errorMeta: resolution.errorMeta,
    });
  }
  const { binding } = resolution;

  const timeoutSec = Math.max(0, Math.floor(asNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC)));
  const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
  const injectUrl = apiUrl(baseUrl, "/api/inject");
  const message = buildWakeMessage(ctx, binding);

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: ADAPTER_TYPE,
      command: "claudeclaw",
      commandArgs: ["inject", injectUrl, "--thread", binding.thread],
      prompt: message,
      context: { ...ctx.context, claudeclawThread: binding.thread },
    });
  }

  await ctx.onLog(
    "stdout",
    `${LOG_PREFIX} POST ${injectUrl} (thread=${binding.thread}, project=${binding.projectName ?? binding.projectId}, forward=false, timeout=${timeoutSec > 0 ? `${timeoutSec}s` : "none"}, message=${message.length} chars)\n`,
  );

  let response: Response;
  try {
    response = await fetch(injectUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ message, forward: false, thread: binding.thread }),
      ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (err) {
    if (isAbortLike(err)) {
      await ctx.onLog("stderr", `${LOG_PREFIX} inject timed out after ${timeoutSec}s\n`);
      return failure({
        errorCode: "claudeclaw_gateway_timeout",
        errorMessage: `claudeclaw inject timed out after ${timeoutSec}s. The daemon may still be running the turn in thread ${binding.thread}; wakes for the same thread queue behind it.`,
        errorFamily: "transient_upstream",
        timedOut: true,
      });
    }
    const detail = redactToken(fetchFailureMessage(err), apiToken);
    await ctx.onLog("stderr", `${LOG_PREFIX} inject request failed: ${detail}\n`);
    return failure({
      errorCode: "claudeclaw_gateway_connect_failed",
      errorMessage: `claudeclaw request failed: ${detail}`,
      errorFamily: "transient_upstream",
    });
  }

  const rawText = await response.text();
  let body: unknown = null;
  if (rawText.trim()) {
    try {
      body = JSON.parse(rawText);
    } catch {
      body = null;
    }
  }

  const result = mapInjectResponse({ status: response.status, body, rawText, apiToken });
  if (result.exitCode === 0) {
    await ctx.onLog(
      "stdout",
      `${LOG_PREFIX} inject ok sessionId=${result.sessionDisplayId ?? ""} summary=${(result.summary ?? "").length} chars\n`,
    );
    if (result.summary) {
      await ctx.onLog("stdout", `${result.summary}\n`);
    }
  } else {
    await ctx.onLog("stderr", `${LOG_PREFIX} ${result.errorCode}: ${result.errorMessage ?? ""}\n`);
  }
  return result;
}
