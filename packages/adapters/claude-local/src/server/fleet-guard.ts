import { asStringArray, parseObject } from "@paperclipai/adapter-utils/server-utils";

// The Claude CLI-only fleet guard. Some deployments run a fleet of agents on
// ONE Claude Max subscription, under a hard operating rule: only the
// unmodified `claude` CLI binary, running under the operator's own login, may
// ever consume that subscription. No Agent SDK / ACP lane, no API keys, no
// OAuth token extraction or relaying, and no injected
// `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`.
//
// `claude_local` normally defaults to the ACP engine and accepts several
// alternate auth paths (managed AI connections, configured env credentials,
// `claude setup-token` minting). This module gives operators a single env
// switch, `PAPERCLIP_CLAUDE_CLI_ONLY`, that turns those paths off. It is pure
// policy evaluation: it never spawns a process and never reads or writes
// credentials. Callers (`acp.ts`'s engine resolution, `setup-token-runner.ts`)
// gate their own behavior on {@link isClaudeCliOnlyPolicy} and
// {@link evaluateClaudeCliOnlyPolicy}.

/** The fixed error code every Claude CLI-only fleet-policy rejection reports.
 * A caller (the run's `AdapterExecutionResult`, the user interface) reads this
 * single code to recognize a policy rejection; only the human-readable
 * `reason` differs between the specific rules below. */
export const CLAUDE_CLI_ONLY_POLICY_ERROR_CODE = "claude_cli_only_policy";

/** The case-insensitive truthy spellings accepted for `PAPERCLIP_CLAUDE_CLI_ONLY`. */
const TRUE_VALUES = new Set(["1", "true", "yes"]);

/**
 * Returns true when this Paperclip instance's fleet policy allows only the
 * unmodified `claude` CLI binary, under the operator's own login, to run
 * against the shared subscription. Reads `PAPERCLIP_CLAUDE_CLI_ONLY` from
 * `env` (defaults to `process.env`); true for `1`, `true`, or `yes`,
 * case-insensitively, and false for anything else including unset.
 */
export function isClaudeCliOnlyPolicy(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PAPERCLIP_CLAUDE_CLI_ONLY;
  if (typeof raw !== "string") return false;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

export type ClaudeCliOnlyPolicyEvaluation =
  | { ok: true }
  | { ok: false; reason: string; errorCode: string };

/**
 * The auth env keys the policy forbids a Claude adapter config from injecting.
 * Each one lets Claude authenticate outside the operator's own `claude` CLI
 * login: an OAuth token (subscription or setup-token-minted), an Anthropic API
 * key, or a bearer auth token.
 */
const BANNED_AUTH_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

/**
 * The Claude CLI flags the policy forbids. Each one can steer the CLI away
 * from the operator's own interactive login: `--bare` skips the normal
 * config/session lookup, `--api-key`/`--auth-token` supply credentials
 * directly on the command line.
 */
const BANNED_CLI_FLAGS = ["--bare", "--api-key", "--auth-token"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeEngineValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function argMatchesBannedFlag(arg: string, flag: string): boolean {
  return arg === flag || arg.startsWith(`${flag}=`);
}

function reject(reason: string): { ok: false; reason: string; errorCode: string } {
  return { ok: false, reason, errorCode: CLAUDE_CLI_ONLY_POLICY_ERROR_CODE };
}

/**
 * Evaluate one Claude adapter run config against the fleet's Claude CLI-only
 * policy. Pure and side-effect free — it never spawns a process, and it does
 * not itself check {@link isClaudeCliOnlyPolicy}; callers gate the call on
 * that first, so this function's rejections apply only when the policy is on.
 *
 * Rejects a config that would:
 *  - explicitly request the ACP engine (`config.engine === "acp"`);
 *  - inject `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or
 *    `ANTHROPIC_AUTH_TOKEN` through the adapter config's `env`, or through a
 *    configured `managedAiConnection` (a managed connection's whole purpose is
 *    injecting one of these, so its mere presence is rejected without
 *    inspecting its shape);
 *  - pass `--bare`, `--api-key`, or `--auth-token` through `extraArgs` or
 *    `args`.
 *
 * Every rejection reports the same fixed
 * {@link CLAUDE_CLI_ONLY_POLICY_ERROR_CODE}; only `reason` differs.
 */
export function evaluateClaudeCliOnlyPolicy(input: {
  config: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): ClaudeCliOnlyPolicyEvaluation {
  const config = parseObject(input.config);

  if (normalizeEngineValue(config.engine) === "acp") {
    return reject(
      'Fleet policy PAPERCLIP_CLAUDE_CLI_ONLY requires the unmodified Claude CLI; this adapter config explicitly requests engine="acp".',
    );
  }

  if (config.managedAiConnection) {
    return reject(
      "Fleet policy PAPERCLIP_CLAUDE_CLI_ONLY forbids managed AI connections for this adapter: a managed connection injects an OAuth token or API key, and only the operator's own `claude` CLI login may consume the shared subscription.",
    );
  }

  const envConfig = parseObject(config.env);
  for (const key of BANNED_AUTH_ENV_KEYS) {
    if (isNonEmptyString(envConfig[key])) {
      return reject(
        `Fleet policy PAPERCLIP_CLAUDE_CLI_ONLY forbids injecting ${key}: only the operator's own \`claude\` CLI login may consume the shared subscription.`,
      );
    }
  }

  const configuredArgs = asStringArray(config.extraArgs);
  const extraArgs = configuredArgs.length > 0 ? configuredArgs : asStringArray(config.args);
  for (const flag of BANNED_CLI_FLAGS) {
    if (extraArgs.some((arg) => argMatchesBannedFlag(arg, flag))) {
      return reject(
        `Fleet policy PAPERCLIP_CLAUDE_CLI_ONLY forbids the ${flag} flag: it can bypass the operator's own Claude CLI login.`,
      );
    }
  }

  return { ok: true };
}
