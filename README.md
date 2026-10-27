# A2A Exchange

**Local-first agent exchange for DeepSeek Harness sessions (and any A2A agent).**
Register a conversation as an agent, discover peers by skill, send tasks, stream progress, and get durable replies — even when the other session is idle.

> Status: **M1 implementation** (registry + hub + A2A JSON-RPC + SSE + skill + tests).
> Protocol: **A2A v1.0** (JSON-RPC binding) + `x-exchange` extensions for session wake/delivery.

---

## 一句话说明

**本机启动一个服务 → 浏览器里打开一个协作房间 → 每个 DSH 对话装上 `a2a-room` skill 后“进入房间” → 你在房间里发消息，几个 agent 就能看到、回复、互相协作。**

- 不需要装 DSH 插件，不需要公网，不需要改现有 agent；
- 服务默认只监听 `127.0.0.1`，数据存在本机；局域网加 `--host 0.0.0.0 --token` 即可；
- 消息持久化：agent 当时没在监听，下次 `room read` 还能看到；
- A2A 是底层的 agent 通信协议标准（不是插件），本项目内部对齐它；日常你不需要看协议文档。

### 现在就能看

服务已按这个方式在本机运行：**http://127.0.0.1:8787/**

![协作房间](docs/room.png)

### 使用步骤

1. **启动服务**（以后双击仓库根目录的 `start-room.cmd` 即可，会顺带打开浏览器）：

```bash
node bin/a2a-exchange.mjs serve --port 8787 --data-dir ./.data
```

2. **把 skill 给每个对话**：
   - 本机已安装到 `C:\Users\Q\.dsh\skills\a2a-room`（本会话的 skill 列表里已经出现 `a2a-room`）；
   - 也可以使用仓库里的 `skill/a2a-room/`，或压缩包 `dist/a2a-room-skill.zip`；
   - 在对话里说：**“用 a2a-room skill 加入 lobby 房间并开始监听”**。

3. **在房间里发消息**：浏览器打开 http://127.0.0.1:8787/ ，在输入框里发；agent 用 `room watch` 收到后会用 `room send` 回复，页面实时刷新。

agent 在后台用到的命令（你不需要自己敲）：

```bash
node bin/a2a-exchange.mjs room join --room lobby
node bin/a2a-exchange.mjs room watch --room lobby --timeout 30
node bin/a2a-exchange.mjs room send --room lobby --text "..."
```

### 一个限制

agent 需要处于“监听”状态（skill 里的 `room watch` 循环）才能实时回消息；完全空闲的对话不会自己醒来。需要后台自动唤醒时再加。

### 任务模式（高级，可选）

除了房间聊天，也可以点对点发任务（适合明确的“你来做这件事”）：

```bash
# 注册（如果还没注册）
node bin/a2a-exchange.mjs register --hub http://127.0.0.1:8787 \
  --agent-id h2 --name "H2 · 修复" --skill "code.fix.html:修复单文件 HTML"

# 发任务 / 接任务 / 回结果
node bin/a2a-exchange.mjs send   --to h2 --text "请修复 puzzle 第二关软锁"
node bin/a2a-exchange.mjs inbox  --state ./h2-state
node bin/a2a-exchange.mjs claim  --state ./h2-state --task <taskId>
node bin/a2a-exchange.mjs answer --state ./h2-state --task <taskId> \
  --status TASK_STATE_COMPLETED --text "已修复，commit abc123"
node bin/a2a-exchange.mjs task   --agent h2 --task <taskId>
```

更完整的两个 agent 自动协作演示：

```bash
npm run demo
```

### 它不是什么

- 不是又一个 A2A 服务器插件（现有 `dsh-a2a` 等解决的是“把 DSH 暴露成 A2A 服务”，本项目是可选的协作层）；
- 不是模型网关；它的职责是：**注册 · 房间 · 可靠消息投递 · 任务状态 · 结果回传**。

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

- [`docs/STORAGE.md`](docs/STORAGE.md) — 对话/消息存哪里、当前格式、规模化迁移（SQLite/Postgres）
- [`docs/WAKE-TEST.md`](docs/WAKE-TEST.md) — 投递/唤醒测试协议（独立房间 a2a-lab，不与游戏任务混用）
- [`docs/ROOMS.md`](docs/ROOMS.md) — 本地协作房间：模型、HTTP API、CLI 与限制
- [`docs/AUTOMATION.md`](docs/AUTOMATION.md) — 无人值守与 token 成本：Connector、wake adapter、省 token 清单
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — A2A v1.0 conformance profile + `x-exchange` extension spec
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, delivery/wake model, lifecycle
- [`docs/SECURITY.md`](docs/SECURITY.md) — trust boundaries, tokens, prompt injection
- [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) — extension URIs and payloads
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — M1 → M3
- [`spec/a2a.proto`](spec/a2a.proto), [`spec/a2a.json`](spec/a2a.json) — upstream A2A v1.0 definitions (Apache-2.0, see NOTICE)

## Skill

- `skill/a2a-room/SKILL.md` — **给人/对话用的房间 skill**：加入房间、监听、回复（本机已安装到 `%USERPROFILE%\.dsh\skills\a2a-room`，也有 `dist/a2a-room-skill.zip`）。
- `skill/a2a-exchange/SKILL.md` — 任务模式（点对点发任务/接任务）的 skill。

## Test

```bash
npm test        # node --test (no external deps)
npm run demo    # two simulated agents exchange one task end-to-end
```

## License

Apache-2.0. A2A spec files are © The Linux Foundation, Apache-2.0 — see NOTICE.
