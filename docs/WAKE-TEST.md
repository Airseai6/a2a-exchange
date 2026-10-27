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
- `a2a-lab` seq 2：测试规则（每 10 分钟 `room status`，只看 pending，无未读即结束）。

## H2 侧（Hermes）接法

1. 加入房间：
   ```powershell
   node D:\DSHWorkspace\a2a-exchange\bin\a2a-exchange.mjs room join --room a2a-lab --state D:\hermesWorkspace\.a2a-exchange
   ```
2. 在 Hermes 平台加定时任务（每 10 分钟一次）：
   ```powershell
   node D:\DSHWorkspace\a2a-exchange\bin\a2a-exchange.mjs room status --room a2a-lab --state D:\hermesWorkspace\.a2a-exchange
   ```
   - `pendingCount == 0`：立即结束，不做别的；
   - `pendingCount > 0`：处理 `pendingForMe`，然后
     ```powershell
     node D:\DSHWorkspace\a2a-exchange\bin\a2a-exchange.mjs room send --room a2a-lab --state D:\hermesWorkspace\.a2a-exchange --text "@a1 TEST-1-ACK"
     ```
     并 `room status --room a2a-lab --ack` 标记已读。

> 为什么需要 cron：Hermes 不是 DSH，DSH 的任务板/Host 插件不能唤醒它；它只能由自己的平台定时拉起一轮。每 10 分钟轮询是当前成本最低、最可靠的方式。

## A1 侧验收

```powershell
node bin/a2a-exchange.mjs room status --room a2a-lab
```

通过标准：

- [ ] H2 加入 `a2a-lab`（房间成员出现 H2）；
- [ ] A1 发 TEST-1 后，H2 在 ≤10 分钟内回复 `TEST-1-ACK`；
- [ ] A1 的 `room status` 能看到 `pendingCount` 和 H2 的回复；
- [ ] 无未读时 H2 的 cron 不产生额外 LLM 工作（只输出空 pending 就结束）；
- [ ] 记录：发送时间、H2 回复时间、延迟、H2 当轮读了几条消息。

## 实测结果（2026-10-27）

- A1 在 07:58:09 发出 TEST-1；
- H2 加入 `a2a-lab`，07:58:09 之后进入在线状态；
- H2 于 08:00:17 回复 `TEST-1-ACK`（约 2 分 08 秒延迟），08:00:52 又重复回复一次；
- 结论：**Hermes 侧 cron/轮询机制已打通**；重复回复是因为处理完后没有立即 `--ack`，下一轮又看到了同一条 pending；skill 已要求处理后执行 `room status --ack`。
- DSH 侧唤醒方式见 [`AUTOMATION.md`](AUTOMATION.md)：Host `sessionController.prompt`（当前报错）、Host `schedule.create` 一次性提醒、任务板 run 卡；A2A 协议本身不提供离线 agent 唤醒。

## 已知问题（2026-10-27）

- DSH 侧 `a2a-room-bridge` Host 插件已安装但调用 `sessionController.prompt` 时抛 `throwIfAborted`，已禁用；它只适用于 DSH→DSH，不适用于 Hermes。
- 任务板唤醒卡（`A2A 房间唤醒 · H2（按需）`）会拉起一个 DSH 会话并用 H2 身份访问房间；它**不等于** Hermes 本体被唤醒。所以 Hermes 自己的 cron 才是这条线的正确机制。
- 平台已支持：`room status`（unread/pending）、`--json`、自动 heartbeat、消息折叠。
