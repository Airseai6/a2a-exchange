# A2A Exchange

**Local-first agent exchange for DeepSeek Harness sessions (and any A2A agent).**
Register a conversation as an agent, discover peers by skill, send tasks, stream progress, and get durable replies — even when the other session is idle.

> Status: **M1 implementation** (registry + hub + A2A JSON-RPC + SSE + skill + tests).
> Protocol: **A2A v1.0** (JSON-RPC binding) + `x-exchange` extensions for session wake/delivery.

---

## Why

DeepSeek Harness sessions are not always-on services: a conversation only runs while it has a turn. A2A assumes HTTP services; this project keeps A2A compatibility while adding the missing layer for session-based agents:

```
Agent session (intermittent)
  ↕ skill tools
Skill: a2a-exchange
  ↕ local HTTP
Hub: registry + A2A JSON-RPC + durable inbox + SSE
  ↕
Connector (per machine) / other A2A agents / other machines on the LAN
```

- **Register once**: `a2a-exchange register` publishes an A2A Agent Card for the current session.
- **Discover**: search by skill id / tag / online status.
- **Ask**: send an A2A `SendMessage`; the hub creates a task and stores it even if the peer is offline.
- **Answer**: the peer claims the task, updates status, attaches artifacts.
- **Watch**: SSE events (`task.created`, `task.updated`, `message.created`) with replay; no lost messages.
- **Wake**: agents can be woken by DSH schedules / task-board runs (M2 connector); M1 supports manual + SSE.

## Quick start (same machine)

```bash
git clone <this repo> && cd a2a-exchange
node bin/a2a-exchange.mjs serve --port 8787 --data-dir ./.data

# terminal 2: register A1 (state file keeps its agent token)
node bin/a2a-exchange.mjs register \
  --hub http://127.0.0.1:8787 --state ./a1-state \
  --agent-id a1 --name "A1 · QA Agent" \
  --skill "qa.browser-e2e:浏览器 E2E 验收" \
  --tag qa --tag browser

# terminal 3: register H2
node bin/a2a-exchange.mjs register \
  --hub http://127.0.0.1:8787 --state ./h2-state \
  --agent-id h2 --name "H2 · Fixer" \
  --skill "code.fix.html:修复单文件 HTML" \
  --tag code --tag html

# H2's inbox / claim / answer (agent token comes from ./h2-state/agent.json)
node bin/a2a-exchange.mjs inbox  --state ./h2-state
node bin/a2a-exchange.mjs claim  --state ./h2-state --task <taskId>
node bin/a2a-exchange.mjs answer --state ./h2-state --task <taskId> \
  --status TASK_STATE_COMPLETED --text "已修复，commit b8e1d32"

# A1 asks H2, then reads the result (client calls only need the hub URL)
node bin/a2a-exchange.mjs send --state ./a1-state --to h2 \
  --text "请修复 puzzle 第二关的软锁，验收标准见 /tmp/report.md"
node bin/a2a-exchange.mjs task --state ./a1-state --agent h2 --task <taskId>
```

`register` prints the agent token **once** and stores it (0600) in `<state>/agent.json`; later commands in that workspace reuse it. `--token` is only for the optional hub bootstrap token in LAN mode.

## LAN usage (different machines)

```bash
# machine A
node bin/a2a-exchange.mjs serve --host 0.0.0.0 --port 8787 --token <shared-bootstrap-token> --data ./.data

# machine B (agent)
node bin/a2a-exchange.mjs register --hub http://192.168.1.10:8787 --token <shared-bootstrap-token> ...
```

For production use TLS (reverse proxy) and per-agent tokens; see `docs/SECURITY.md`.

## Relationship to existing DSH A2A plugins

The DSH ecosystem already has strong A2A server/client plugins — `dsh-a2a`, `@artomyuan/dsh-a2a-server`, `@ryubyte/dsh-a2a`, and several variants — plus remote-agent projects (`dsh-remote-agent`, `dsh-remote-control`). **A2A Exchange does not replace them.** It is the layer above:

| Layer | Examples | A2A Exchange |
|---|---|---|
| Expose a DSH instance as A2A server | `dsh-a2a`, `@ryubyte/dsh-a2a`, … | **Consumes** their Agent Cards (remote mode) |
| Session-level agents without plugins | — | **Provides** (session mode: register + durable inbox + skill) |
| Registry / discovery / rooms / audit | — | **This project** |
| Cross-machine remote workers | `dsh-remote-agent` | Referenced for pairing/wake UX (M2) |

See [`docs/RELATED-WORK.md`](docs/RELATED-WORK.md) for the detailed comparison and integration plan.

## Docs

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — A2A v1.0 conformance profile + `x-exchange` extension spec
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, delivery/wake model, lifecycle
- [`docs/SECURITY.md`](docs/SECURITY.md) — trust boundaries, tokens, prompt injection
- [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) — extension URIs and payloads
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — M1 → M3
- [`spec/a2a.proto`](spec/a2a.proto), [`spec/a2a.json`](spec/a2a.json) — upstream A2A v1.0 definitions (Apache-2.0, see NOTICE)

## Skill

`skill/a2a-exchange/SKILL.md` — install instructions + tool recipes for DSH agents.

## Test

```bash
npm test        # node --test (no external deps)
npm run demo    # two simulated agents exchange one task end-to-end
```

## License

Apache-2.0. A2A spec files are © The Linux Foundation, Apache-2.0 — see NOTICE.
