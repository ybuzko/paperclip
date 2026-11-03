# Codex usage meters: source and probe

The supported read path is the Codex app-server's `account/rateLimits/read` method over local JSONL stdio. It returns ChatGPT rate-limit buckets with `usedPercent`, `windowDurationMins`, and Unix-second `resetsAt`. This is the account rate-limit view, not a response header or a local cache file. The [official app-server documentation](https://learn.chatgpt.com/docs/app-server) defines the method, fields, and connection handshake.

Run `node scripts/codex-usage-meters.mjs` as the OS user whose Codex login should be measured. The script has no third-party dependencies and prints only the provider-neutral snapshot array. It starts `codex app-server`, writes these JSONL messages, reads the matching responses, then terminates the child process:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex-usage-meters","version":"1.0.0"}}}
{"method":"initialized","params":{}}
{"id":2,"method":"account/rateLimits/read","params":{}}
```

The script accepts only exact 300-minute (`five_hour`) and 10,080-minute (`seven_day`) durations. Either may appear in `primary` or `secondary`; the slot name does not identify the duration. An absent bucket produces no row. It preserves the reported percentage without treating sub-1 values as fractions, converts the reset from Unix seconds to ISO 8601, and places the metered `limitId` in `source` so separate buckets remain distinguishable. `rateLimits` is a backward-compatible single-bucket view; when `rateLimitsByLimitId` contains the same bucket, the script emits it once. It does not infer a model from `limitId` or `limitName`. These field meanings and the multi-bucket structure are specified in the [app-server rate-limit section](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

## Live read on 2026-09-27

With Codex CLI 0.157.1 and a ChatGPT login on the test host, the script printed this redacted output. The output schema contains no account ID, email, or token; no values were altered. Only a weekly window was reported. In this account's response it occupied `primary` with `windowDurationMins: 10080`; `secondary` was null.

```json
[
  {
    "provider": "openai",
    "window": "seven_day",
    "usedPct": 19,
    "resetsAt": "2026-10-03T23:26:33.000Z",
    "source": "codex-app-server:codex",
    "observedAt": "2026-09-27T00:45:21.688Z"
  }
]
```

This observation does not prove that every account has only a weekly limit. The [documented example](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt) includes another metered `limitId`, `codex_other`. Each bucket may include `limitName` and `planType`; the protocol does not define `limitId` as a model identifier. The test account showed no separate model-scoped or plan-scoped bucket, so no model or plan mapping is claimed here. If an operator later sees other IDs, inspect their durations and names before deciding which ones govern a particular workload.

## Credentials and headless operation

The app-server uses the active Codex CLI authentication for the OS user running it. In ChatGPT-managed mode, Codex automatically refreshes OAuth tokens. Credential storage is configurable: file storage uses `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`); keyring and ephemeral modes need not have that file. The probe never reads or prints the credential. Verify the intended login with `codex login status` under the same user and `CODEX_HOME`; use `codex login --device-auth` on a headless host if login is needed. A securely copied file-backed credential can work, but it contains live secrets and refreshes need to persist back to the same store. See [authentication](https://learn.chatgpt.com/docs/auth), [configuration locations](https://learn.chatgpt.com/docs/config-file/config-advanced), and [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

`account/read` offers an explicit `refreshToken` flag, but this script does not force a refresh. It relies on Codex's managed authentication behavior. For externally managed ChatGPT tokens, the host application must handle refresh itself; this script is intended for a normal local Codex login. The [app-server auth section](https://learn.chatgpt.com/docs/app-server#auth-endpoints) describes these modes.

## Polling and integration limits

The published app-server documentation does not state a safe polling interval or a request quota for `account/rateLimits/read`. A five-minute schedule would make twelve reads per hour per account; that is an operational proposal, not an OpenAI guarantee. Start with one poller per account, avoid overlapping reads, honor errors or throttling with backoff, and cache the last successful observation with its `observedAt`. Do not treat missing windows or a failed read as zero usage. The script emits only verified 5-hour and weekly windows; it intentionally omits credits and any other duration. No governor wiring is part of this spike.

The repository's existing Codex adapter has a related mapping risk: its RPC quota mapper currently labels `primary` as a 5-hour limit and `secondary` as a weekly limit without checking `windowDurationMins`. The observed account would thus be mislabeled if that path were used directly. That follow-up should use duration-based labels before feeding a governor.
