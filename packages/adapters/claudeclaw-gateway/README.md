# Claudeclaw Gateway Adapter

`@paperclipai/adapter-claudeclaw-gateway` wakes a remote [claudeclaw](https://github.com/moazbuilds/claudeclaw) daemon over its HTTP inject API. claudeclaw runs `claude -p --resume <session>` in a project directory on another host; Paperclip treats that daemon as an external agent and dispatches work to it by assigning issues.

## Transport

- `POST {url}/api/inject` with `Authorization: Bearer <apiToken>` and body `{"message": <wake text>, "forward": false, "thread": <session key>}`.
- The call blocks until the turn finishes. The request goes over `node:http`, not `fetch`, because undici fails any response whose headers take longer than 300 s (`UND_ERR_HEADERS_TIMEOUT`) regardless of the caller's timeout. With `timeoutSec` at 0 (default) the run stays open until the daemon answers. A configured timeout ends the run as `claudeclaw_gateway_timeout` with **no retry family**: the daemon is still running the turn, and a retry would inject a duplicate wake into the same thread (the daemon queues wakes per thread behind each other).
- `forward: false` requires the patched claudeclaw fork (see the PIX-4 patch): it suppresses the Telegram echo and adds `sessionId` to the response. A response without a `sessionId` key fails the run with `claudeclaw_gateway_fork_patch_missing` so an unpatched daemon is never used silently.

## Thread routing

One agent serves every project on a daemon; the Paperclip **project** decides the claudeclaw thread (PIX-4 plan §13.3 / §14.1). The heartbeat passes `projectId`, `projectName` and the project's plain (non-secret) `env` values to the adapter in the execution context. The adapter reads these project env keys:

| Project env key | Meaning |
| --- | --- |
| `CLAUDECLAW_THREAD` | required. A bare Telegram topic id (e.g. `42`) composes to `tg:<telegramChatId>:<topicId>` using the adapter's `telegramChatId`; a value containing `:` (e.g. `paperclip:FT`, `tg:-100…:42`) is used verbatim as the session key |
| `CLAUDECLAW_WORKSPACE` | optional, echoed in the wake prefix |
| `JIRA_PROJECT` | optional, echoed in the wake prefix when set |

A wake whose project has no `CLAUDECLAW_THREAD`, a bare id with no `telegramChatId`, or a wake with no issue and no project (timer heartbeat) fails the run with `claudeclaw_gateway_thread_unmapped` before contacting the daemon. Wakes are never injected into the daemon's global session.

## Wake message

The first line states the turn's own context: `Project: <name> · thread <key> · workspace <CLAUDECLAW_WORKSPACE>` (plus `· Jira <JIRA_PROJECT>` when set).

The message is built exactly like the OpenClaw gateway wake text: a structured Paperclip wake prompt (with the execution contract and the JSON payload) preceded by an env block with `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_TASK_ID`, and `PAPERCLIP_WAKE_REASON`. The Paperclip API key is never in the message; the agent loads it from `claimedApiKeyPath` (default `.claude/claudeclaw/paperclip.env`) in its project directory.

## Result mapping

| Daemon response | Adapter result |
| --- | --- |
| `{ok:true, exitCode:0, sessionId}` | exit 0, `result` becomes the run summary, `sessionId` stored as `sessionParams.claudeclawSessionId` |
| `{ok:true, exitCode!=0, sessionId}` | `claudeclaw_gateway_turn_failed` |
| `{ok:true}` without a `sessionId` key | `claudeclaw_gateway_fork_patch_missing` |
| (before the request) no routable thread | `claudeclaw_gateway_thread_unmapped` |
| `{ok:true, sessionId:null}` | `claudeclaw_gateway_session_missing` |
| `{ok:false, error}` | `claudeclaw_gateway_inject_failed`; timeout-shaped errors become `claudeclaw_gateway_turn_timeout` with `transient_upstream` |
| HTTP 401/403 | `claudeclaw_gateway_auth_failed` (no retry family) |
| HTTP 429 / 5xx, connection errors | `transient_upstream` |
| Adapter timeout | `claudeclaw_gateway_timeout`, `timedOut: true`, no retry family (daemon still running the turn) |

claudeclaw returns no token usage on inject, so runs carry no usage numbers.

## Config

| Key | Default | Notes |
| --- | --- | --- |
| `url` | required | `http://` or `https://` base URL of the daemon |
| `apiToken` | required | claudeclaw `settings.apiToken`; stored as a Paperclip secret reference |
| `telegramChatId` | none | forum chat id (e.g. `-1001234567890`) used to compose `tg:<chatId>:<topicId>` from a bare `CLAUDECLAW_THREAD`; nothing per project lives here |
| `timeoutSec` | `0` | blocking inject timeout in seconds; 0 waits for the turn to finish. A timeout is not retried |
| `paperclipApiUrl` | `http://10.0.0.34:3100` | Paperclip URL reachable from the daemon host |
| `claimedApiKeyPath` | `.claude/claudeclaw/paperclip.env` | where the agent keeps its claimed `PAPERCLIP_API_KEY` |

## Connection test

`GET {url}/api/health` (unauthenticated) followed by `POST {url}/api/inject` with the bearer token and an empty `{}` body. The daemon honours `settings.apiToken` only on `/api/inject` (other `/api/*` routes want the web UI token), and it checks the token before the body, so HTTP 400 "message is required" proves auth without touching a session (`claudeclaw_gateway_auth_ok`); 401/403 is `claudeclaw_gateway_auth_failed`.

## Tests

```
pnpm --filter @paperclipai/adapter-claudeclaw-gateway test
```

The tests run against a stub claudeclaw HTTP server and cover success, missing `sessionId`, 401, adapter timeout, daemon `{ok:false}` errors, non-zero exit codes, connection failures, and thread routing (bare id composition, full key passthrough, unmapped project, timer-wake skip, `thread` in the inject body).
