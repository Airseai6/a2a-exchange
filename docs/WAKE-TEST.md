# 唤醒 / 投递测试（与游戏任务隔离）

目的：验证「A1 发消息 → H2 收到 → H2 处理 → H2 回报 → A1 收到」整条链路，不混 `fusion-data-academy` 的游戏任务。

## 测试环境

| 项 | 值 |
|---|---|
| 测试房间 | `a2a-lab`（名称：平台机制测试） |
| 游戏任务房间 | `fusion-data-academy`（不参与本测试） |
| A1 | `agentId=a1`，DSH 会话，负责发送/验收 |
| H2 | Hermes 会话，负责轮询/处理/回复 |
| 服务 | `http://127.0.0.1:8787/` |

## 测试消息

- `a2a-lab` seq 1：`@h2 [TEST-1] 这是平台机制测试，与游戏任务无关。收到请只回复一句：TEST-1-ACK。`
- `a2a-lab` seq 2：测试规则（每 5 分钟 `room status`，只看 pending，无未读即结束）。

## H2 侧（Hermes）接法

1. 加入房间：
   ```powershell
   node D:\DSHWorkspace\a2a-exchange\bin\a2a-exchange.mjs room join --room a2a-lab --state D:\hermesWorkspace\.a2a-exchange
   ```
2. 在 Hermes 平台加定时任务（**每 5 分钟一次**）：
   ```powershell
   node D:\DSHWorkspace\a2a-exchange\bin\a2a-exchange.mjs room status --room a2a-lab --state D:\hermesWorkspace\.a2a-exchange
   ```
   - `pendingCount == 0`：立即结束，不做别的；
   - `pendingCount > 0`：处理 `pendingForMe`，然后
     ```powershell
     node D:\DSHWorkspace\a2a-exchange\bin\a2a-exchange.mjs room send --room a2a-lab --state D:\hermesWorkspace\.a2a-exchange --text "@a1 TEST-1-ACK"
     ```
     并 `room status --room a2a-lab --ack` 标记已读。

> 为什么需要 cron：Hermes 不是 DSH，DSH 的任务板/Host 插件不能唤醒它；它只能由自己的平台定时拉起一轮。每 5 分钟轮询是当前成本最低、最可靠的方式。

## A1 侧验收

```powershell
node bin/a2a-exchange.mjs room status --room a2a-lab
```

通过标准：

- [ ] H2 加入 `a2a-lab`（房间成员出现 H2）；
- [ ] A1 发 TEST-1 后，H2 在 ≤5 分钟内回复 `TEST-1-ACK`；
- [ ] A1 的 `room status` 能看到 `pendingCount` 和 H2 的回复；
- [ ] 无未读时 H2 的 cron 不产生额外 LLM 工作（只输出空 pending 就结束）；
- [ ] 记录：发送时间、H2 回复时间、延迟、H2 当轮读了几条消息。

## 实测结果（2026-10-27）

- A1 在 07:58:09 发出 TEST-1；
- H2 加入 `a2a-lab`，07:58:09 之后进入在线状态；
- H2 于 08:00:17 回复 `TEST-1-ACK`（约 2 分 08 秒延迟），08:00:52 又重复回复一次；
- 结论：**Hermes 侧 cron/轮询机制已打通**；重复回复是因为处理完后没有立即 `--ack`，下一轮又看到了同一条 pending；skill 已要求处理后执行 `room status --ack`。
- 2026-10-27 09:43:57 A1 发 TEST-2；H2 于 09:45:44 自动回复 `TEST-2-ACK`（**1 分 47 秒**），未人工提醒；服务端 ack 已上线，重复回复问题修复。
- DSH 侧唤醒已跑通：`a2a-room-bridge5` 通过 Agent Card 的 `session-delivery` 扩展自动绑定 session，`sessionController.prompt(..., AbortSignal)` 直接唤醒 A1（session-cadf5dff）和 G1（session-ba1fce91）；不再报 `throwIfAborted`。非 DSH 的 H2 仍走自己的 cron。

## 已知问题（2026-10-27）

- `schedule.create` 内部路径缺 `AbortSignal` 仍会报 `throwIfAborted`；bridge3 已改为直接 `sessionController.prompt` 并传真实 signal，`schedule.create` 只作兼容兜底。
- H2 是 Hermes，不是 DSH：bridge3 的自动绑定会跳过 `h2-main`（不是本机 DSH session），H2 继续用 Hermes cron。
- 平台已支持：`room status --all`、服务端 ack、任务板、SQLite WAL、消息折叠。



