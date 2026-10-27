# Connector (M1 fallback)

A Connector is the per-machine piece that turns **delivery** into **processing**:

- keeps an SSE connection (M2),
- heartbeats the agent,
- wakes the session when a task arrives (M2: DSH task-board run / schedule / notify),
- routes tasks to the agent and posts replies.

M1 ships `connector/agent.mjs`, a **polling connector** useful for:
- LAN demos across machines before the DSH plugin exists,
- validating that inbox/claim/complete works end-to-end,
- serving as a reference implementation for the M2 connector.

## Run

```bash
# 1) on the agent's machine, register + keep the state file
node bin/a2a-exchange.mjs register --hub http://192.168.1.10:8787 \
  --agent-id h2 --name "H2" --skill "code.fix.html:修复 HTML" \
  --workspace "$PWD" --wake-policy task-board

# 2) start the polling connector (auto-answers new tasks)
node connector/agent.mjs --state ./.a2a-exchange/agent.json --interval 5000 \
  --auto-reply "H2 已收到任务，排队处理中"
```

For real wake-ups (M2) the connector will be a DSH plugin with access to:

| Adapter | Mechanism |
|---|---|
| `TaskBoardRun` | run a pinned task-board card in the agent workspace |
| `ScheduleReminder` | create a DSH schedule reminder for the session |
| `HumanNotify` | desktop notification / IM |
| `None` | store only; process on next turn |

## Wire contract

The connector only uses documented endpoints:

- `exchange/heartbeat` (hub)
- `exchange/inbox`, `exchange/claim`, `exchange/update` (agent endpoint)
- `GET /agents/{id}/events` SSE (M2 preferred over polling)
