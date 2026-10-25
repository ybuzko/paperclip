import { ADAPTER_LABEL, ADAPTER_TYPE, DEFAULT_CLAIMED_API_KEY_PATH, DEFAULT_PAPERCLIP_API_URL, DEFAULT_TIMEOUT_SEC } from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# claudeclaw_gateway agent configuration

Adapter: claudeclaw_gateway

Use when:
- The agent is a claudeclaw daemon (github.com/moazbuilds/claudeclaw) running on another host, driving
  \`claude -p --resume <session>\` inside a project directory.
- Paperclip should wake that daemon over HTTP and let it act as an external Paperclip agent using an API
  key it claimed itself.

Don't use when:
- Claude Code should run as a local child process on the Paperclip host; use claude_local instead.
- The daemon is not reachable from the Paperclip server over the LAN or a private overlay.

Required fields:
- url (string): claudeclaw HTTP base URL reachable from Paperclip, for example http://10.0.0.41:4632.
- apiToken (string): claudeclaw settings.apiToken. Sent as Authorization: Bearer <apiToken>. Stored as a
  Paperclip secret reference; never included in the wake message.

Optional fields:
- timeoutSec (number): blocking inject timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}).
- paperclipApiUrl (string): Paperclip API URL the daemon host can reach (default ${DEFAULT_PAPERCLIP_API_URL}).
  This is not a credential.
- claimedApiKeyPath (string): where the daemon host keeps its claimed PAPERCLIP_API_KEY, relative to the
  project directory (default ${DEFAULT_CLAIMED_API_KEY_PATH}). The wake message points the agent at this
  file; the key itself never travels in the message.
- jiraAccountId (string): the Jira Cloud accountId this supervisor works as. Not read by this adapter;
  used only as an assignee filter by the server-side fleet dispatch loop.

Runtime mapping:
- POST {url}/api/inject with {"message": <wake text>, "forward": false}. The call blocks until the turn ends.
- Requires the patched claudeclaw fork: forward:false suppresses the Telegram echo and the response carries
  sessionId. A response without sessionId fails the run with "claudeclaw fork patch missing".
- {ok:true, exitCode:0} -> exit 0, result text as the run summary, sessionId recorded as the session.
- {ok:true, exitCode!=0} -> claudeclaw_gateway_turn_failed (the underlying claude -p run failed).
- {ok:false} -> claudeclaw_gateway_inject_failed; timeout-shaped errors are marked transient so they retry.
- HTTP 401/403 -> claudeclaw_gateway_auth_failed (surfaces, no retry). 429/5xx and connection errors are
  transient. An adapter-side timeout (timeoutSec > 0) ends the run without a retry family: the daemon is
  still running the turn and a retry would inject a duplicate wake. timeoutSec 0 (default) waits.
- claudeclaw reports no token usage on inject, so runs carry no usage numbers.
- A wake with wakeReason "fleet_dispatch" carrying a valid version-2 fleet dispatch payload with an
  assignment (see readFleetDispatch in server/execute.ts) is sent as a short message and nothing else (no
  context prefix, env block, HTTP procedure or structured wake payload): one line naming the Jira item and
  what to do with it (work a task, break down an epic, or close an epic), one line saying to reassign it in
  Jira to the declineReassignTo person with a comment when it cannot be advanced, an optional "Budget is
  tight" line when the governor is CAPPED or excludes models ("Do not use: <models>."), and a final line
  asking the reply to end with "fleet-ack: worked=<KEY> outcome=done|declined|partial". The reply text
  becomes the run summary, where the server reads the ack.
- Fallback: when the payload is missing or invalid, is not version 2, or has no assignment, the generic
  wake is sent (and one stderr log line says why). When the payload itself is valid (a v1 payload, or v2
  with no assignment), a "Fleet dispatch" prose block (throttle state, 5h/7-day budget usage, ready task and epic counts, a fixed
  one-item-per-turn instruction and the ack line) is inserted between the Project: context prefix and the
  structured wake prompt. Throttle states OPEN, CAPPED, RED, STALE and legacy GREEN, AMBER, ACCELERATE
  are accepted. Neither form includes the API token or key file contents.

Connection test:
- GET {url}/api/health (unauthenticated), then POST {url}/api/inject with the bearer token and an empty
  body: HTTP 400 proves the token (the daemon honours settings.apiToken only on /api/inject).
`;
