# Architecture

## 1. Problem

DSH sessions are **intermittent**: a conversation only executes during a turn. A2A assumes remote agents are HTTP services that are always reachable. We need A2A compatibility *and*:

- registration at conversation level;
- durable inbox for offline sessions;
- SSE delivery to live sessions;
- a way to wake an idle session (schedule / task-board / human notification);
- discovery by skill;
- artifacts exchanged as file refs / URLs.

## 2. Topology

```
┌──────────────────────────── Machine A ────────────────────────────┐
│ DSH session A1 ── skill tools ──┐                                 │
│ DSH session A2 ── skill tools ──┤                                 │
│                                 ▼                                 │
│                       Connector (optional, M2) ── SSE ──┐         │
│                                                          │         │
│  Hub (this repo)  ◄── HTTP/JSON-RPC + SSE ───────────────┘         │
│    registry · tasks · messages · events · cards                    │
└───────────────────────────────┬────────────────────────────────────┘
                                │ HTTP(S) + bearer token
┌───────────────────────────────▼─────────────── Machine B ──────────┐
│  Connector (M2) ── SSE ── Hub                                      │
│      │                                                             │
│      ├── wake adapter: task-board run / schedule / desktop notice  │
│      └── DSH session H2 (registers agent card, answers tasks)      │
└────────────────────────────────────────────────────────────────────┘
```

M1 contains the **Hub + skill + CLI + SDK**; the Connector daemon and wake adapters are M2. M1 can already run on two machines on a LAN: each machine runs the skill CLI (or a tiny polling loop) against the Hub.

## 3. Components

| Component | Responsibility | Code |
|---|---|---|
| **Hub** | HTTP server, JSON-RPC, per-agent mount, Agent Cards, discovery, tasks, messages, events, auth | `src/server.mjs`, `src/registry.mjs`, `src/tasks.mjs`, `src/store.mjs` |
| **Store** | Durable JSON state + append-only event log + atomic writes | `src/store.mjs` |
| **A2A layer** | Card generation, JSON-RPC helpers, task/message validation, state machine | `src/a2a.mjs` |
| **Exchange extensions** | register/heartbeat/discover/inbox/claim/update/reply/info | `src/extensions.mjs` |
| **SSE** | Event replay (`Last-Event-ID`), heartbeats, per-agent subscriptions | `src/sse.mjs` |
| **SDK / CLI** | Thin client for skill tools and demos | `sdk/client.mjs`, `src/cli.mjs`, `bin/a2a-exchange.mjs` |
| **Skill** | Tells DSH agents how to register/ask/answer with the CLI | `skill/a2a-exchange/SKILL.md` |

## 4. Data model

Stored in a single JSON document plus an append-only event log (M1; SQLite in M2):

```
agents:   agentId -> { agentId, tokenHash, card, status, lastSeen, createdAt, wakePolicy, sessionId?, workspace?, heartbeatTtlSeconds }
tasks:    taskId  -> { task, agentId, createdAt, updatedAt, claimedBy?, terminal }
messages: messageId -> message (also embedded in task.history)
events:   seq -> { eventId, type, agentId, taskId?, payload, time }
```

`status` is derived from `lastSeen` + `heartbeatTtlSeconds`: `online` (fresh heartbeat), `idle` (known but no heartbeat yet / recent), `offline` (ttl exceeded).

## 5. Lifecycle

### 5.1 Registration

```
skill/tool → POST /a2a exchange/register
Hub → generate agentId + token (returned once), build Agent Card, store, issue card URL
Agent → writes token to local state file (0600)
```

### 5.2 Ask → answer

```
Client → POST /agents/{id}/a2a { SendMessage }
Hub → create Task (SUBMITTED), append history, emit task.created
Agent (live: SSE) → receives task.created
Agent (idle: M2 connector wake / M1 next turn) → exchange/inbox
Agent → exchange/claim (WORKING) → exchange/update (progress) → exchange/update (COMPLETED + artifacts)
Hub → emit task.updated; client polls GetTask or watches SubscribeToTask
```

### 5.3 Cancellation

Client `CancelTask` → if non-terminal, state `CANCELED`, agent message appended, event emitted.

## 6. Delivery vs processing (why SSE alone is not enough)

| Concern | Mechanism |
|---|---|
| Does the message survive if the agent is offline? | durable task store |
| Does the live session see it immediately? | SSE event feed + skill `inbox` |
| Is the message *processed*? | wake adapter (M2): task-board run, schedule reminder, human notification |
| Can events be missed? | replay by `Last-Event-ID` / `exchange/inbox` |

SSE is **delivery** only. A2A Exchange deliberately separates delivery from processing; the Connector owns the latter.

## 7. Wake adapters (M2, design)

```ts
interface WakeAdapter {
  canWake(agentId: string): boolean;
  wake(agentId: string, event: HubEvent): Promise<"woken" | "queued" | "notified" | "failed">;
}
```

| Adapter | Mechanism | Trade-off |
|---|---|---|
| `TaskBoardRun` | DSH task board card pinned to the agent workspace, `task_board_run` | true wake, needs DSH plugin/tool access |
| `ScheduleReminder` | create a DSH schedule reminder for the session | no plugin needed, latency bound by schedule |
| `HumanNotify` | desktop notification / IM / email | last resort |
| `None` | store only; skill checks `inbox` on each turn | zero cost, no realtime |

M1 agents set `wakePolicy` in registration; M2 Connector executes it.

## 8. Deployment modes

| Mode | Hub | Agents | Use |
|---|---|---|---|
| **Same machine** | `127.0.0.1:8787` | DSH sessions via CLI/skill | development, our A1↔H2 case |
| **LAN** | `0.0.0.0:8787` + TLS reverse proxy + tokens | sessions on multiple machines | office / lab |
| **Public** | behind reverse proxy, authenticated | external A2A agents | M3 gateway |
| **Embedded** | in-process in DSH plugin | sessions | M3 |

## 9. Failure modes

| Failure | Behavior |
|---|---|
| Hub down | CLI fails fast; tasks not accepted; retry with backoff |
| Agent offline | Tasks stay `SUBMITTED`; agent sees them on next `inbox` |
| SSE broken | reconnect with `Last-Event-ID`; if too old, use `inbox` |
| Duplicate `exchange/claim` | idempotent for same agent; other agent gets `TASK_FORBIDDEN` |
| Client retries `SendMessage` | M1 does not dedupe; clients use unique `messageId`; M2 adds idempotency keys via extension |
| Token leak | revoke via `exchange/unregister` + re-register; M2 scopes/rotation |
| Event log grows | M2 rotates/compacts; M1 keeps a bounded ring in memory + file |

## 10. Non-goals (M1)

- push notifications, extended cards, gRPC/HTTP+JSON bindings, multi-tenancy, signatures;
- artifact blob storage (M1 passes file refs/URLs only);
- UI (M2 web dashboard);
- direct agent-to-agent mode without Hub (M2 connector listener).
