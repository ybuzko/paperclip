# Claudeclaw Gateway Adapter

`@paperclipai/adapter-claudeclaw-gateway` wakes a remote [claudeclaw](https://github.com/moazbuilds/claudeclaw) daemon over its HTTP inject API. claudeclaw runs `claude -p --resume <session>` in a project directory on another host; Paperclip treats that daemon as an external agent and dispatches work to it by assigning issues.

## Transport

- `POST {url}/api/inject` with `Authorization: Bearer <apiToken>` and body `{"message": <wake text>, "forward": false}`.
- The call blocks until the turn finishes. The adapter aborts after `timeoutSec` (default 600) and marks the run as a transient failure so it retries later; the daemon serializes injects, so a late turn simply delays the next wake.
- `forward: false` requires the patched claudeclaw fork (see the PIX-4 patch): it suppresses the Telegram echo and adds `sessionId` to the response. A response without a `sessionId` key fails the run with `claudeclaw_gateway_fork_patch_missing` so an unpatched daemon is never used silently.

## Wake message

The message is built exactly like the OpenClaw gateway wake text: a structured Paperclip wake prompt (with the execution contract and the JSON payload) preceded by an env block with `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_TASK_ID`, and `PAPERCLIP_WAKE_REASON`. The Paperclip API key is never in the message; the agent loads it from `claimedApiKeyPath` (default `.claude/claudeclaw/paperclip.env`) in its project directory.

## Result mapping

| Daemon response | Adapter result |
| --- | --- |
| `{ok:true, exitCode:0, sessionId}` | exit 0, `result` becomes the run summary, `sessionId` stored as `sessionParams.claudeclawSessionId` |
| `{ok:true, exitCode!=0, sessionId}` | `claudeclaw_gateway_turn_failed` |
| `{ok:true}` without a `sessionId` key | `claudeclaw_gateway_fork_patch_missing` |
| `{ok:true, sessionId:null}` | `claudeclaw_gateway_session_missing` |
| `{ok:false, error}` | `claudeclaw_gateway_inject_failed`; timeout-shaped errors become `claudeclaw_gateway_turn_timeout` with `transient_upstream` |
| HTTP 401/403 | `claudeclaw_gateway_auth_failed` (no retry family) |
| HTTP 429 / 5xx, connection errors | `transient_upstream` |
| Adapter timeout | `claudeclaw_gateway_timeout`, `timedOut: true`, `transient_upstream` |

claudeclaw returns no token usage on inject, so runs carry no usage numbers.

## Config

| Key | Default | Notes |
| --- | --- | --- |
| `url` | required | `http://` or `https://` base URL of the daemon |
| `apiToken` | required | claudeclaw `settings.apiToken`; stored as a Paperclip secret reference |
| `timeoutSec` | `600` | blocking inject timeout |
| `paperclipApiUrl` | `http://10.0.0.34:3100` | Paperclip URL reachable from the daemon host |
| `claimedApiKeyPath` | `.claude/claudeclaw/paperclip.env` | where the agent keeps its claimed `PAPERCLIP_API_KEY` |

## Connection test

`GET {url}/api/health` (unauthenticated) followed by `GET {url}/api/state` with the bearer token. A 401 on state is reported as `claudeclaw_gateway_auth_failed`.

## Tests

```
pnpm --filter @paperclipai/adapter-claudeclaw-gateway test
```

The tests run against a stub claudeclaw HTTP server and cover success, missing `sessionId`, 401, adapter timeout, daemon `{ok:false}` errors, non-zero exit codes, and connection failures.
