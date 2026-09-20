---
title: Scoped Agent Provisioning
summary: Letting an agent create supervisor agents and their secrets inside a tight, board-defined blast radius
---

Some fleets run an "ansible" agent — a long-lived, non-interactive agent that stands up other agents
(for example, one supervisor per customer environment) without a human clicking through the UI each
time. Paperclip supports this with the `agents:provision` grant (PIX-19): a board user hands one agent
a narrow, revocable capability to create other agents, instead of giving it board access or the
company-wide `agents:create` permission.

This document covers the grant and the provisioning endpoint. Company secret provisioning
(`agents:provision`'s secret-creation half) is documented separately alongside
`server/src/routes/agent-provisioning-secrets.ts`.

## The grant

The grant lives on `principal_permission_grants` under the key `agents:provision`, scoped to a single
agent (the "provisioner"). Only a board user with access to the agent's company can set, read, or clear
it — an agent actor gets 403 even if that agent holds the CEO role. The grant applies to every API key
the provisioner holds; there is no heartbeat run requirement, so a plain long-lived agent API key with
no run id works.

The scope bounds the blast radius:

| Field | Meaning |
| --- | --- |
| `reportsTo` | Every agent the provisioner creates reports to this agent id, or `null` for no manager. The provisioner cannot choose a different manager per request. |

### Set the grant

```bash
curl -X PUT "$PAPERCLIP_URL/api/agents/$PROVISIONER_AGENT_ID/provision-grant" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "scope": {
      "reportsTo": "'"$COORDINATOR_AGENT_ID"'"
    }
  }'
```

If `reportsTo` is set, the server verifies that agent exists in the same company before saving the
grant (422 otherwise). Setting the grant requires board access to the provisioner's company; it is
logged as `agent.provision_grant_set` with the scope in the activity log details.

### Read the grant

```bash
curl "$PAPERCLIP_URL/api/agents/$PROVISIONER_AGENT_ID/provision-grant" \
  -H "Authorization: Bearer $BOARD_TOKEN"
```

```json
{
  "enabled": true,
  "scope": {
    "reportsTo": "…"
  },
  "grantedByUserId": "…",
  "updatedAt": "2026-09-20T12:00:00.000Z",
  "provisionedAgentCount": 3
}
```

`provisionedAgentCount` counts non-terminated agents whose `metadata.provisionedByAgentId` matches this
agent.

### Clear the grant

```bash
curl -X PUT "$PAPERCLIP_URL/api/agents/$PROVISIONER_AGENT_ID/provision-grant" \
  -H "Authorization: Bearer $BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

Logged as `agent.provision_grant_cleared`. A grant with a scope that fails to parse (corrupted or
hand-edited) is treated as no grant at read time — the provisioning endpoint fails closed with 403
rather than trusting a malformed scope.

## Provisioning an agent

```bash
curl -X POST "$PAPERCLIP_URL/api/companies/$COMPANY_ID/agents/provision" \
  -H "Authorization: Bearer $PROVISIONER_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "customer-42-supervisor",
    "adapterType": "claudeclaw_gateway",
    "adapterConfig": { "endpoint": "https://gateway.internal/customer-42" },
    "keyName": "provisioned"
  }'
```

```json
{
  "agent": {
    "id": "…",
    "name": "customer-42-supervisor",
    "role": "general",
    "reportsTo": "…",
    "status": "idle",
    "metadata": { "provisionedByAgentId": "…" },
    "permissions": { "canCreateAgents": false, "canCreateSkills": true },
    "…": "…"
  },
  "apiKey": {
    "id": "…",
    "name": "provisioned",
    "token": "pcak_…"
  }
}
```

`apiKey.token` is returned exactly once, the same as `POST /api/agents/:id/keys` — Paperclip stores
only its hash. Save it immediately.

### Caller

Only an agent actor holding the grant for the target company may call this endpoint — a board actor
gets 403 pointing at the normal `POST /api/companies/:companyId/agents` route instead. This keeps the
endpoint single-purpose: it is not a general-purpose agent-creation route with extra steps.

### What the server forces, regardless of the request body

- `role` is always `"general"`.
- `reportsTo` is always the grant's `scope.reportsTo` — the request cannot choose a different manager.
- `permissions.canCreateAgents` is always `false` — a provisioned agent can never itself hold
  `agents:create`, and no provision grant is ever copied onto it. Provisioning chains stop at one hop
  unless a board user explicitly grants further.
- `metadata.provisionedByAgentId` is always set to the calling agent's id (merged into any other
  metadata), which is how the idempotency check below works.
- `status` starts `"idle"`.
- `adapterConfig` goes through the same secret-reference normalization the board create-agent route
  uses, so a secret value for a known secret field is handled identically (promoted to a managed
  secret reference, never stored in the clear), and — because the caller is always an agent actor here
  — host-executed workspace commands in `adapterConfig` (`provisionCommand`, `teardownCommand`, etc.)
  are rejected the same way the agent-authenticated path of the create-agent route rejects them.

### Failure modes

| Condition | Response |
| --- | --- |
| Caller has no `agents:provision` grant (or the stored scope is malformed) | 403 |
| Caller is a board actor | 403, points at the normal create-agent route |
| `adapterType` not a known/registered adapter | 422 |
| Company has `requireBoardApprovalForNewAgents: true` | 409 |
| An agent with the same `name` exists in the company, provisioned by someone else (or not provisioned at all) | 409 |
| An agent with the same `name` exists, provisioned by this caller, and already has an API key | 409, body includes `agentId` of the existing agent — no second key is ever minted |

### Idempotency

A provisioning call can be retried safely. If an agent with the requested `name` already exists in the
company **and** was provisioned by this same caller (`metadata.provisionedByAgentId` matches) **and**
has no API key yet, the server does not create a second agent — it mints the one missing key for the
existing agent and returns the same `{ agent, apiKey }` shape. This covers a crash or timeout between
agent creation and key minting. Once a key exists, every further call with that name 409s instead of
minting a second key; recovering from that state requires a board user issuing a new key via
`POST /api/agents/:id/keys` (or clearing/re-granting).

## Security properties

- **Board-only grant.** Only a board user with company access can create, change, or revoke the grant.
  An agent — including one with the CEO role — cannot grant itself or another agent `agents:provision`.
- **No secret reads.** This endpoint never returns a secret value. `adapterConfig` secret fields are
  written the same way the normal create-agent route writes them: as references, resolved only at
  agent run time.
- **Provenance.** Every provisioned agent carries `metadata.provisionedByAgentId`, so ownership,
  and the idempotency check are all auditable from the row itself, not from a
  side table.
- **One key, minted once.** The endpoint never returns more than one live token for a given
  provisioned agent; a retry after a key exists fails closed instead of minting a second one.
- **No further delegation.** A provisioned agent is created with `canCreateAgents: false` and never
  inherits or is granted `agents:provision` — it cannot itself provision agents unless a board user
  separately decides to grant it that capability.
- **Activity log.** Grant changes (`agent.provision_grant_set` / `agent.provision_grant_cleared`) and
  successful provisioning (`agent.provisioned`, with `provisionedByAgentId`, `adapterType`,
  `reportsTo`, and the minted key's id — never the token) are all recorded in the company activity log.

## Scope is optional

The grant needs no scope. An agent holding `agents:provision` may provision agents of any known
adapter type and create secrets under any name. What bounds it is provenance, not configuration:
it can mint a key only for, and bind secrets only to, agents it provisioned itself; it can rotate
and bind only secrets it created itself; and it can never read a secret value or list secrets.
The one optional scope field is `reportsTo`: when set, every provisioned agent reports to that
agent and the caller cannot choose another manager; when absent the caller may pass `reportsTo`
in the provision request.
