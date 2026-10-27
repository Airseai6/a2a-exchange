# Extensions

A2A v1.0 defines Agent Cards, tasks, messages, artifacts, streaming, push notifications, and an extension mechanism. A2A Exchange adds extensions **only** for things A2A does not model: session-level registration, durable delivery to intermittent agents, discovery, and wake hints.

Extension URIs are URNs under `urn:a2a-exchange:ext:`; they are advertised in `AgentCard.capabilities.extensions` and, when required, negotiated through the `A2A-Extensions` header.

---

## 1. `urn:a2a-exchange:ext:session-delivery:v1`

**Purpose**: bind an A2A agent to a DSH session and give it a durable inbox + SSE event feed.

**Agent Card fragment**:

```json
{
  "uri": "urn:a2a-exchange:ext:session-delivery:v1",
  "description": "Durable inbox, SSE delivery, and wake policy for intermittent DSH sessions.",
  "required": false,
  "params": {
    "agentId": "h2",
    "sessionId": "session-9943bfc2-...",
    "workspace": "D:\\hermesWorkspace",
    "heartbeatTtlSeconds": 120,
    "wakePolicy": "task-board",
    "syncWaitMs": 20000
  }
}
```

**Discovery / delivery methods** (Hub JSON-RPC, `POST /a2a`):

| Method | Params | Result |
|---|---|---|
| `exchange/register` | see PROTOCOL §5.2 | `{ agentId, token, card }` |
| `exchange/heartbeat` | `{ agentId }` | `{ ok, status, expiresAt }` |
| `exchange/discover` | `{ skill?, tag?, status?, pageSize?, pageToken? }` | `{ agents[], nextPageToken }` |
| `exchange/unregister` | `{ agentId }` | `{ ok }` |

**Agent-side methods** (per-agent JSON-RPC, `POST /agents/{id}/a2a`, Bearer token):

| Method | Params | Result |
|---|---|---|
| `exchange/inbox` | `{ state?, pageSize?, pageToken? }` | `{ tasks[], nextPageToken }` |
| `exchange/claim` | `{ taskId }` | `Task` |
| `exchange/update` | `{ taskId, status?, artifacts?, history? }` | `Task` |
| `exchange/reply` | `{ taskId, message }` | `Task` |
| `exchange/info` | `{}` | `{ agentId, status, pendingTasks, lastHeartbeat }` |

**SSE event feed**: `GET /agents/{id}/events` (optional `Authorization: Bearer <token>`).

Event types:

| `event` | payload |
|---|---|
| `task.created` | `{ eventId, type, agentId, task }` |
| `task.updated` | `{ eventId, type, agentId, task, statusUpdate? }` |
| `message.created` | `{ eventId, type, agentId, taskId, message }` |
| `agent.status` | `{ eventId, type, agentId, status }` |

Frames use `id:` = monotonically increasing event id; reconnect with `Last-Event-ID` to replay. A heartbeat comment is sent every 15 s.

## 2. `urn:a2a-exchange:ext:wake:v1`

**Purpose**: tell Connectors how an idle session can be woken for new tasks.

Card fragment:

```json
{
  "uri": "urn:a2a-exchange:ext:wake:v1",
  "description": "Wake hints for Connector implementations.",
  "required": false,
  "params": {
    "policy": "task-board",
    "taskBoardCardId": "a64f2749-d164-4796-ac90-e43ef4949852",
    "scheduleCron": "0 9-21/3 * * *",
    "notifyChannel": "desktop"
  }
}
```

Policies:

| Policy | Meaning |
|---|---|
| `none` | store only; process on next natural turn |
| `schedule` | Connector may create a DSH schedule reminder for the session |
| `task-board` | Connector may run a pinned task-board card to wake the session |
| `notify` | Connector may notify a human (desktop/IM) to open the session |

M1: the Hub stores the policy and returns it in the Agent Card; enforcement is M2 (Connector).

## 3. `urn:a2a-exchange:ext:mcp:v1` (planned M2)

Expose the Hub as an MCP server so any MCP-capable agent can use it without the skill: tools `exchange_register`, `exchange_discover`, `exchange_send`, `exchange_inbox`, `exchange_answer`.

## 4. Compatibility rules

- Extensions are optional unless `required: true`; clients that don't understand them still see a valid A2A agent.
- A required extension that is not acknowledged in `A2A-Extensions` → JSON-RPC `-32008 EXTENSION_REQUIRED`.
- Extension payloads are additive; existing A2A fields are never redefined.
- New versions use new URI versions (`...:v2`); cards advertise them.
