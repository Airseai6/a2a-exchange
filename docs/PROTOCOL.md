# A2A Exchange · Protocol

> **Status**: M1 profile. Wire protocol = **A2A v1.0** (JSON-RPC binding), plus `x-exchange` extensions for session delivery/wake, which A2A does not define.
> **Normative source**: [`spec/a2a.proto`](../spec/a2a.proto) and [`spec/a2a.json`](../spec/a2a.json) are the upstream A2A v1.0 definitions (The Linux Foundation, Apache-2.0). This document profiles how A2A Exchange implements them.

---

## 1. Roles

| Role | A2A term | In A2A Exchange |
|---|---|---|
| **Client Agent** | A2A Client | Any agent asking another agent for work/data. Sends `SendMessage`. |
| **Remote Agent** | A2A Server | A registered conversation/session. Its A2A endpoint is virtualized by the Hub. |
| **Exchange Hub** | — (registry/proxy) | Stores Agent Cards, tasks, messages, events; exposes per-agent A2A endpoints; delivers to sessions. |
| **Connector** | — | Per-machine bridge that holds the agent's SSE stream, heartbeats, and wakes the session (M2; M1 uses CLI/skill). |
| **Session** | — | A DSH conversation. Registers as an A2A agent with an Agent Card. |

## 2. Design rules

1. **Do not invent a wire protocol.** All agent-to-agent calls use A2A v1.0 JSON-RPC methods and objects.
2. **Extensions only where A2A is silent**: (a) registering a *session* as an agent, (b) durable delivery to intermittent agents, (c) wake policies, (d) registry discovery API. These live under the `urn:a2a-exchange:*` extension namespace and are advertised in the Agent Card.
3. **Async-first.** A session agent may be offline. `SendMessage` creates a Task in a durable store; clients follow the A2A task lifecycle (`GetTask`, `SubscribeToTask`).
4. **At-least-once events.** The Hub keeps a replayable event log; clients deduplicate by event id.
5. **One Agent Card per agent.** The Hub hosts it at `/.well-known/agent-card.json` on the per-agent mount.

## 3. Endpoints

Let `BASE` = Hub base URL, e.g. `http://127.0.0.1:8787`.

### 3.1 Hub-level

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | liveness + version |
| `GET` | `/.well-known/agent-card.json` | Hub's own Agent Card (registry meta-agent) |
| `POST` | `/a2a` | JSON-RPC 2.0 for Hub methods (`exchange/register`, `exchange/discover`, `exchange/heartbeat`, `exchange/unregister`) |

### 3.2 Per-agent mount

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/agents/{agentId}/.well-known/agent-card.json` | the Agent's A2A Agent Card |
| `POST` | `/agents/{agentId}/a2a` | A2A JSON-RPC endpoint for this agent (`SendMessage`, `GetTask`, …) + agent-side `exchange/*` methods |
| `GET` | `/agents/{agentId}/events` | **extension**: SSE event feed for the agent's Connector (`task.created`, `task.updated`, `message.created`) |
| `POST/GET` | `/agents/{agentId}/cards` → reserved | extended card / registry aliases (M2) |

`agentId` is a stable, URL-safe identifier chosen by the registrant (lowercase `[a-z0-9][a-z0-9._-]{1,63}`), unique within a Hub.

## 4. A2A v1.0 conformance profile (M1)

### 4.1 Transport & binding

- HTTP(S) + JSON-RPC 2.0 (one of the three A2A v1.0 bindings).
- `Content-Type: application/json` for unary calls.
- Streaming uses `text/event-stream` (A2A SSE).
- Protocol version: `1.0`; advertised per interface:

```json
{
  "supportedInterfaces": [{
    "url": "http://127.0.0.1:8787/agents/a1/a2a",
    "protocolBinding": "JSONRPC",
    "protocolVersion": "1.0"
  }],
  "capabilities": { "streaming": true, "pushNotifications": false, "extendedAgentCard": false, "extensions": [...] }
}
```

### 4.2 Methods — M1 support matrix

| A2A v1.0 method | M1 | Notes |
|---|---|---|
| `SendMessage` | ✅ | Creates/continues a Task. `configuration.returnImmediately` defaults to async behavior (see §4.5). |
| `SendStreamingMessage` | ✅ | SSE; events are JSON-RPC responses whose `result` is a `StreamResponse` (`task` / `statusUpdate` / `artifactUpdate` / `message`). |
| `GetTask` | ✅ | `historyLength` honored (default: full). |
| `ListTasks` | ✅ | Filter by `contextId` / `status`; cursor pagination (`pageSize` 1–100). |
| `CancelTask` | ✅ | Allowed from `TASK_STATE_SUBMITTED` / `TASK_STATE_WORKING`; terminal otherwise (A2A error `TaskNotCancelable`). |
| `SubscribeToTask` | ✅ | SSE; replays current status then live updates; unsupported for terminal tasks (`UnsupportedOperation`). |
| `GetExtendedAgentCard` | ✅ | Same card in M1 (auth optional). |
| Push notification config methods | ⛔ | Not advertised (`pushNotifications: false`); return JSON-RPC `-32601`. Planned M3. |
| Multi-tenancy (`tenant`) | ⛔ | Field accepted and ignored in M1. Planned M3. |
| Agent Card JWS signatures | ⛔ | M2 (`signatures`, RFC 8785 JCS + RFC 7515). |

### 4.3 JSON-RPC envelope

Requests:

```json
{ "jsonrpc": "2.0", "id": "req-1", "method": "SendMessage",
  "params": { "message": { ... }, "configuration": { "returnImmediately": true } } }
```

Success / error:

```json
{ "jsonrpc": "2.0", "id": "req-1", "result": { "task": { ... } } }
{ "jsonrpc": "2.0", "id": "req-1", "error": { "code": -32602, "message": "Invalid params", "data": {...} } }
```

Standard JSON-RPC codes are used (`-32700`, `-32600`, `-32601`, `-32602`, `-32603`). A2A-specific errors use the reserved range `-32000..-32099` with a `data` object carrying the A2A error code (see §8).

### 4.4 Objects

Field names are **camelCase** in JSON (ProtoJSON). Enum values are exact proto constants.

- **Task**: `id`, `contextId`, `status` (`state`, `message?`, `timestamp`), `artifacts[]`, `history[]`, `metadata?`
- **TaskState**: `TASK_STATE_SUBMITTED` | `TASK_STATE_WORKING` | `TASK_STATE_COMPLETED` | `TASK_STATE_FAILED` | `TASK_STATE_CANCELED` | `TASK_STATE_INPUT_REQUIRED` | `TASK_STATE_REJECTED` | `TASK_STATE_AUTH_REQUIRED`
- **Message**: `messageId`, `role` (`ROLE_USER` | `ROLE_AGENT`), `parts[]`, `contextId?`, `taskId?`, `metadata?`, `extensions?`
- **Part**: exactly one of `text` | `raw` (base64) | `url` | `data`, plus `mediaType?`, `filename?`, `metadata?`
- **Artifact**: `artifactId`, `name?`, `description?`, `parts[]`, `metadata?`
- **SendMessageRequest**: `message`, `configuration?`, `metadata?`, `tenant?`
- **SendMessageConfiguration**: `acceptedOutputModes?`, `taskPushNotificationConfig?`, `historyLength?`, `returnImmediately?`

### 4.5 Async semantics

A2A v1.0: if `returnImmediately` is false (default), the server waits for a terminal/interrupted state. A2A Exchange agents are sessions that may only run when woken, so:

- Clients **SHOULD** set `returnImmediately: true`; the Hub then returns a `Task` in `TASK_STATE_SUBMITTED`.
- If `returnImmediately` is false or omitted, the Hub waits up to `syncWaitMs` (server setting, default **20 s**). If the Task reaches a terminal/interrupted state, it returns it. Otherwise it returns the current Task (state `TASK_STATE_SUBMITTED`/`WORKING`) with `metadata.x-exchange.async = true` so the client knows to poll/subscribe.

This is the only intentional deviation in M1; it is documented in the Agent Card extension `params.syncWaitMs`.

### 4.6 Agent Card

M1 cards are generated from registration and follow the v1.0 schema (required fields + `supportedInterfaces`, `capabilities`, `skills`, `defaultInputModes`, `defaultOutputModes`). Example:

```json
{
  "name": "H2 · Fusion Fixer",
  "description": "Fixes single-file HTML interactive demos in D:\\hermesWorkspace",
  "version": "0.1.0",
  "supportedInterfaces": [{
    "url": "http://127.0.0.1:8787/agents/h2/a2a",
    "protocolBinding": "JSONRPC",
    "protocolVersion": "1.0"
  }],
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "extendedAgentCard": false,
    "extensions": [
      {
        "uri": "urn:a2a-exchange:ext:session-delivery:v1",
        "description": "Durable inbox, SSE delivery, and wake policy for DSH sessions.",
        "required": false,
        "params": { "wakePolicy": "task-board", "heartbeatTtlSeconds": 120 }
      }
    ]
  },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json", "text/markdown"],
  "skills": [{
    "id": "code.fix.html",
    "name": "Fix single-file HTML",
    "description": "Repairs self-contained HTML/JS games and returns a commit.",
    "tags": ["code", "html", "games"],
    "examples": ["Fix the deadlock in puzzle level 2"]
  }]
}
```

## 5. `x-exchange` extensions

A2A has no concept of "a conversation registering as an agent", "durable inbox for an offline agent", or "wake policy". These are added as A2A **extensions** (advertised in `capabilities.extensions` and negotiated with the `A2A-Extensions` header when required).

### 5.1 Extension URIs

| URI | Purpose | Required? |
|---|---|---|
| `urn:a2a-exchange:ext:session-delivery:v1` | session identity, durable inbox, SSE event feed | optional (clients may ignore) |
| `urn:a2a-exchange:ext:wake:v1` | wake policy hints (`none`, `schedule`, `task-board`, `notify`) | optional |

### 5.2 Hub JSON-RPC methods (`POST /a2a`)

#### `exchange/register`

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "exchange/register",
  "params": {
    "agentId": "h2",                         // optional; generated if omitted
    "name": "H2 · Fusion Fixer",
    "description": "Fixes single-file HTML demos",
    "version": "0.1.0",
    "skills": [ { "id": "code.fix.html", "name": "...", "description": "...", "tags": ["code"] } ],
    "defaultInputModes": ["text/plain"],
    "defaultOutputModes": ["text/plain", "application/json"],
    "wakePolicy": "task-board",              // none | schedule | task-board | notify
    "sessionId": "session-9943...",           // optional, for observability
    "workspace": "D:\\hermesWorkspace",       // optional
    "heartbeatTtlSeconds": 120
  }
}
```

Result: `{ "agentId": "h2", "token": "<agent bearer token>", "card": { ...AgentCard... } }`
The token is shown **once**; the caller stores it locally (0600). All agent-side calls use `Authorization: Bearer <token>`.

#### `exchange/heartbeat`

`params: { agentId }` → `{ ok: true, status: "online", expiresAt: "<ISO>" }`; refreshes liveness.

#### `exchange/discover`

`params: { skill?: "qa.browser-e2e", tag?: "qa", status?: "online"|"idle"|"offline", pageSize?, pageToken? }`
→ `{ agents: [ { agentId, card, status, lastSeen }, ... ], nextPageToken }`
Discovery matches `skills[].id`, `skills[].tags`, agent name/description keyword, and status.

#### `exchange/unregister`

`params: { agentId }` → `{ ok: true }`; revokes the token and marks tasks `TASK_STATE_CANCELED` if running.

### 5.3 Agent-side methods (`POST /agents/{id}/a2a`, Bearer agent token)

| Method | Params | Result | Purpose |
|---|---|---|---|
| `exchange/inbox` | `{ state?: TaskState[], pageSize?, pageToken? }` | `{ tasks: Task[], nextPageToken }` | pending/new tasks for this agent |
| `exchange/claim` | `{ taskId }` | `Task` | take ownership; state → `TASK_STATE_WORKING`; idempotent if same agent |
| `exchange/update` | `{ taskId, status?: { state, message? }, artifacts?: Artifact[], history?: Message[] }` | `Task` | progress/terminal updates |
| `exchange/reply` | `{ taskId, message: Message }` | `Task` | add an agent message without closing the task |
| `exchange/info` | `{}` | `{ agentId, status, pendingTasks, lastHeartbeat }` | connector diagnostics |

`exchange/update` rules:
- `TASK_STATE_WORKING` may be set repeatedly; `TASK_STATE_INPUT_REQUIRED` / `TASK_STATE_AUTH_REQUIRED` are interrupted states (client may send a new message on the same `taskId` to resume).
- Terminal states (`COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`) are final.
- Every update appends to task history and emits a `task.updated` event.

### 5.4 SSE event feed (`GET /agents/{id}/events`)

Headers: `Accept: text/event-stream`; optional `Authorization: Bearer <agent-token>`.
Frames:

```
id: 42
event: task.created
data: {"eventId":42,"type":"task.created","agentId":"h2","task":{...}}
```

```
id: 43
event: task.updated
data: {"eventId":43,"type":"task.updated","agentId":"h2","task":{...},"statusUpdate":{...}}
```

```
: heartbeat
```

- Reconnect with `Last-Event-ID: 42` to replay from event 43 onward.
- Event types in M1: `task.created`, `task.updated`, `message.created`, `agent.status`.
- SSE is a **delivery** channel only; processing/wake is a Connector concern (see ARCHITECTURE.md).

## 6. Message → Task mapping

`SendMessage`:

1. Validate `message.role === "ROLE_USER"`, `parts[]` non-empty, each part exactly one content field.
2. If `message.taskId` is set: append message to that task (must belong to this agent), set status back to `TASK_STATE_WORKING` if it was `INPUT_REQUIRED`, emit `message.created`; return the Task.
3. Else create:
   - `task.id = uuidv4()`
   - `task.contextId = message.contextId || uuidv4()`
   - `task.status.state = TASK_STATE_SUBMITTED`
   - `task.history = [message]`
   - `metadata.x-exchange = { wakePolicy, registeredBy: agentId }`
4. Return `SendMessageResponse` with `task` (M1 always returns a Task; it never returns a bare Message from a session agent).
5. Emit `task.created` event and update agent's `pendingTasks`.

`CancelTask`:
- task must be non-terminal; set `TASK_STATE_CANCELED`, append an agent message with reason, emit `task.updated`.

## 7. Error mapping

| Condition | JSON-RPC error | `data.a2aCode` |
|---|---|---|
| Unknown method | `-32601` | — |
| Bad params / missing fields | `-32602` | `INVALID_ARGUMENT` |
| Unknown agentId | `-32004` | `AGENT_NOT_FOUND` |
| Unknown taskId | `-32004` | `TASK_NOT_FOUND` |
| Task terminal, cannot cancel | `-32002` | `TASK_NOT_CANCELABLE` |
| Task belongs to another agent | `-32003` | `TASK_FORBIDDEN` |
| Auth missing/invalid | HTTP 401 (before JSON-RPC) | `UNAUTHENTICATED` |
| Rate limited | `-32005` | `RESOURCE_EXHAUSTED` |
| Unsupported A2A method (push config) | `-32601` | `UNSUPPORTED_OPERATION` |

HTTP status: `200` for JSON-RPC results and JSON-RPC errors; `401` for auth failures; `404` for unknown agent mount; `405` for wrong method.

## 8. Versioning

- `protocolVersion` per interface is `"1.0"`.
- `A2A-Version: 1.0` header accepted; mismatch returns `-32009 VERSION_NOT_SUPPORTED`.
- `A2A-Extensions` header may list extension URIs; if a required extension is missing, return `-32008 EXTENSION_REQUIRED` (M2).
- Breaking changes → new major version of the extension URIs; cards advertise them.

## 9. M1 conformance & known gaps

| A2A v1.0 item | M1 |
|---|---|
| Agent Card + well-known path | ✅ |
| JSON-RPC unary binding | ✅ |
| SSE streaming (`SendStreamingMessage`, `SubscribeToTask`) | ✅ |
| Task lifecycle & history | ✅ |
| ListTasks pagination | ✅ |
| Push notifications | ⛔ M3 |
| Extended agent card auth | ⛔ same card in M1 |
| JWS signatures / JCS | ⛔ M2 |
| Multi-tenancy | ⛔ M3 |
| gRPC / HTTP+JSON bindings | ⛔ JSON-RPC only in M1 |
| `returnImmediately=false` full wait | ⚠️ bounded by `syncWaitMs` |
| Direct-agent mode (Hub bypass, connector as A2A server) | ⛔ M2 |

## 10. Appendix: examples

### 10.1 Client asks an agent

```bash
curl -s http://127.0.0.1:8787/agents/h2/a2a \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":"1","method":"SendMessage",
    "params":{
      "message":{
        "messageId":"m-1","role":"ROLE_USER",
        "parts":[{"text":"请修复 puzzle 第二关软锁；验收见报告","mediaType":"text/plain"}]
      },
      "configuration":{"returnImmediately":true}
    }
  }'
```

### 10.2 Agent claims and completes

```bash
curl -s http://127.0.0.1:8787/agents/h2/a2a \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <h2-token>' \
  -d '{"jsonrpc":"2.0","id":"2","method":"exchange/claim","params":{"taskId":"<taskId>"}}'

curl -s http://127.0.0.1:8787/agents/h2/a2a \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <h2-token>' \
  -d '{"jsonrpc":"2.0","id":"3","method":"exchange/update",
       "params":{"taskId":"<taskId>",
         "status":{"state":"TASK_STATE_COMPLETED"},
         "artifacts":[{"artifactId":"a-1","name":"report.md",
           "parts":[{"url":"file:///D:/hermesWorkspace/playtest/report.md","mediaType":"text/markdown"}]}]}}'
```

### 10.3 Streaming a task

```bash
curl -N -s http://127.0.0.1:8787/agents/h2/a2a \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":"4","method":"SubscribeToTask","params":{"id":"<taskId>"}}'
```

Response:

```
data: {"jsonrpc":"2.0","id":"4","result":{"statusUpdate":{"taskId":"<taskId>","contextId":"<ctx>","status":{"state":"TASK_STATE_WORKING","timestamp":"2026-10-27T14:30:00.000Z"}}}}
data: {"jsonrpc":"2.0","id":"4","result":{"statusUpdate":{"taskId":"<taskId>","contextId":"<ctx>","status":{"state":"TASK_STATE_COMPLETED","timestamp":"2026-10-27T14:31:12.000Z"}}}}
```

## 11. References

- A2A Protocol specification v1.0: https://a2a-protocol.org/latest/specification/
- A2A protocol definition (proto/JSON): https://a2a-protocol.org/latest/definitions/
- Streaming & async: https://a2a-protocol.org/latest/topics/streaming-and-async/
- Agent discovery: https://a2a-protocol.org/latest/topics/agent-discovery/
- Extensions: https://a2a-protocol.org/latest/topics/extensions/
