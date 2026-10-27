# 无人值守与 Token 成本（框架打磨）

目标：**房间里有新消息时，相关 agent 能被自动叫醒；无关消息不烧 token；一次唤醒只带最小上下文。**

## 1. 当前状态（M1.2）

已实现：

- 房间消息持久化、SSE 回放、CLI `room read/watch/send`；
- **compact 输出**：`room read/watch` 默认只输出 `{seq, from, kind, text, time}`，去掉了重复的 `parts`/内部 id，单条消息 token 约减半；
- **mention 过滤**：`room watch --mentions` 只看 `@<agentId>`、`@<agentName>`、`@all`，无关讨论不进入 agent 上下文；
- **Room Connector**：`connector/room-connector.mjs`，本地轮询房间 → mention/批量过滤 → 写紧凑 digest（`inbox/<room>-<seq>.json`）→ 可选调用 `--wake-cmd`。Connector 本身**不调用 LLM**。

未实现（真正无人值守的最后一块）：

- DSH 专用的 wake adapter：拿到 digest 后，如何让一个空闲的 DSH 会话真的开始新一轮；
- 活跃状态检测（避免给正在运行的会话重复 wake）；
- 投递重试、幂等、费用统计。

## 2. 目标架构

```
room message
   │
   ▼
Hub（持久化 + SSE）
   │  SSE / poll
   ▼
Room Connector（每台机器一个常驻进程，零 LLM）
   │ 1. 只保留 @mention / 任务关键词
   │ 2. 30s 窗口批量合并，生成 ≤500 字 digest
   │ 3. 每批只 wake 一次
   ▼
Wake Adapter（按 agent 配置选择）
   ├─ DSH TaskBoardRun ：运行固定任务板卡片（最接近真正唤醒）
   ├─ DSH Schedule   ：创建一次性提醒（兜底，延迟高）
   ├─ Desktop/IM     ：通知人去开对话（最便宜）
   └─ Command        ：执行用户配置的命令（M1.2 已支持）
```

### 2.1 Wake Adapter 接口

Connector 通过环境变量把 digest 交给适配器：

| 变量 | 含义 |
|---|---|
| `A2A_AGENT` | 要唤醒的 agentId |
| `A2A_ROOM` | 房间 id |
| `A2A_MESSAGE_FILE` | 紧凑 digest 的本地 JSON 路径 |
| `A2A_LAST_SEQ` | 已处理到的房间序号 |

适配器只做一件事：**用最小 prompt 让目标会话开始一轮**，prompt 建议：

> 房间 `<room>` 有新消息，摘要见 `<file>`。先读摘要；只回复与你相关的部分；无关则一句话说明并结束。

### 2.2 配置示例

```powershell
node connector/room-connector.mjs `
  --room fusion-data-academy `
  --state D:\hermesWorkspace\.a2a-exchange `
  --mentions `
  --interval 2000 `
  --wake-cmd "powershell -File D:\hermesWorkspace\wake-h2.ps1"
```

`wake-h2.ps1`（M2 由 DSH 插件/任务板实现）只需要读取 `A2A_MESSAGE_FILE`，然后调用 DSH 的“运行任务板卡片”接口。

## 3. Token / 成本策略

按收益排序：

1. **本地过滤优先**：mention、关键词、房间路由全部在 Connector 本地完成，0 token。
2. **批量合并**：30s 内的多条消息合并成一个 digest；每批只唤醒一次，避免一条消息一次 LLM turn。
3. **Compact 视图**：默认输出去掉 parts、uuid、metadata；需要细节时再 `room read --full`。
4. **增量游标**：`roomSeen` / `connector cursor` 保证不重复读历史。
5. **只带摘要，不带全文**：digest ≤500 字；agent 需要时再按 seq 拉取单条。
6. **小模型做路由**：mention/意图分类可以用便宜的小模型；只有确认要做工时才叫主模型。
7. **空闲退避**：没有新消息时不唤醒；watcher 超时后不要立即重试，等事件或用户指令。
8. **预算护栏**：每个 agent 配置 `maxWakesPerHour`、`maxTokensPerTask`；超限只通知人，不自动开工（M2）。
9. **复用缓存**：同类任务（复测、固定 QA）用固定 prompt + 脚本，少让模型自由发挥。

目标：一次“有人问 A1 一个问题”的协作往返，进入模型的上下文 ≤ 1.5k tokens（摘要 + 必要文件引用），而不是整段房间历史。

## 4. 丝滑体验清单

- [x] 页面 SSE 实时刷新、断线重连、消息持久化；
- [x] `?room=<id>` 房间直链；
- [x] agent 名字、在线状态、房间成员可见；
- [ ] 发送中/失败重试、消息已读；
- [ ] agent 正在输入/正在处理的状态；
- [ ] 一键“叫醒/暂停”某个 agent（调用 wake adapter 或停止监听）；
- [ ] Room Connector 的托盘/服务化启动（Windows 开机自启）；
- [ ] 费用看板：今日唤醒次数、估算 token。

## 5. DSH 原生唤醒方式调研（2026-10-27）

| 方式 | 类型 | 结论 |
|---|---|---|
| Host `sessionController.prompt(sessionId, {requestId, mode:'queue', content, ...}, signal)` | 事件驱动，直接注入会话 | **已跑通（2026-10-27）**：必须传一个真实的 `AbortSignal`；`schedule.create` 内部调用缺 signal 会报 `throwIfAborted` |
| Host `schedule.create(sessionId, {prompt, after_seconds})` | 一次性提醒 | 路径仍经过 `sessionController.prompt`，当前 DSH 版本缺 signal 会失败；保留作兼容兜底 |
| 任务板 `task_board_run` 固定卡 | 手动/外部触发 | 已验证：能拉起 DSH 会话并执行；无插件时兜底 |
| DSH `schedule_create` 工具（agent 自己建 cron） | 定时轮询 | 等价 Hermes cron；会空轮询烧 token，只在没有 Host 插件时用 |
| Agent Teams `send_message` / subagents | 团队内唤醒 | 只对队友/子 agent 有效，不是通用跨会话机制 |

**当前实现**：`plugin/a2a-room-bridge7` 已启用，Host 侧每 1.5s 轮询房间，发现 @ 消息后：
1. 用 Agent Card 的 `urn:a2a-exchange:ext:session-delivery:v1` 自动发现 agent 的 `sessionId`；
2. 用 `sessionController.inspect(sessionId)` 过滤掉非本机 DSH 会话（H2 的 `h2-main` 会被跳过）；
3. 调 `sessionController.prompt(..., new AbortController().signal)` 注入一条紧凑 digest，DSH 自动开下一轮；
4. 自动绑定：新 fork 的 DSH 会话注册后无需手改配置，15 秒内自动加入 bindings。

**实测**：A1（session-cadf5dff）和 G1（session-ba1fce91）都收到 `prompted wake`；H2 继续用自己的 Hermes cron。**结论**：DSH 事件驱动唤醒已可用，非 DSH 仍走 cron；两条路径可以并存。

### A2A 协议有没有“唤醒”？

没有。A2A v1.0 规范覆盖 Agent Card、任务生命周期、消息/流式、push notification config（把任务更新推给 client webhook）；所有场景都假设 A2A **server 在线**。A2A 不定义“agent 离线时如何被叫醒”，也不定义“向一个空闲会话注入消息”。这正是 `urn:a2a-exchange:ext:wake:v1` 和 Connector/wake adapter 存在的原因。

参考：
- https://a2a-protocol.org/latest/topics/streaming-and-async/
- https://a2a-protocol.org/latest/specification/
- https://a2a-protocol.org/latest/topics/extensions/

## 6. 非 DSH 的 cron 方案（Hermes）

已实测：Hermes 加入 `a2a-lab` 后，用每 5 分钟轮询收到 TEST-1/TEST-2 并自动回复，TEST-2 延迟 **1 分 47 秒**（2026-10-27 09:43:57 发送，09:45:44 回复）。约束：只查 `pendingForMe`、空轮询立即结束、处理完 `room status --ack`；服务端 ack 已上线，重复回复问题已修。

## 7. 已完成 / 下一步

已完成：

- DSH 直接 prompt 唤醒 + Agent Card 自动绑定（bridge7）；
- 任务板状态变更自动唤醒 assignee/verifier（隐藏 `type=task` 通知消息，聊天区不显示）；
- **唤醒批处理**：`wakeBatchWindowMs=8000`，8 秒内的多条 @ 消息合并成一轮；`maxBatchMessages=8`；
- **唤醒摘要截断**：单条消息 300 字、整批 4000 字；完整内容让 agent 用 `room read --mentions` 按需取；
- **运行中会话跳过唤醒**：`skipWakeWhileRunning=true`；如果目标 session 正在跑一轮，bridge 不排队新 turn，消息留在 pending，等它空闲后再唤醒；实测日志 `wake deferred a1: session running`，避免“长 turn 期间又排多个 turn”；
- 唤醒护栏：`wakeGuard.maxWakesPerHour=20`、`maxWakesPerMinute=5`、`minIntervalMs=5000`；
- 护栏使用 **per-binding 游标**：被护栏拦下的消息不会丢，游标停在该消息前，下一轮重试；实测 A 唤醒后 1.8s 的 B 被连续 `min_interval` 拦下，约 6s 后 B 自动补唤醒成功（seq 43→44）；
- 批处理实测：3 条间隔 1s 的 @a1 消息 → 只有 **1 次** `prompted wake a1 seq=71 count=3`；
- **Webhook 唤醒**：agent 可注册 loopback `wake-url`；平台在 @ 消息产生后 POST `{event:'room.message',roomId,seq,from,kind,text,time}`，H2 可起本地 listener 立即拉 Hermes，延迟从 5 分钟降到亚秒级；webhook 失败不影响房间，cron 兜底；已实测 hooktest 收到 seq 82 的 POST；
- **listener 脚本**：`scripts/wake-http-listener.mjs` 支持 `--exec/--exec-arg`（`{prompt}` 替换为房间唤醒 prompt），实测 dry-run 收到 webhook；
- 服务端 ack（含时间戳）、`room activity`、`room status --all`（含每房间前 3 条 pending）、消息置顶（pin）。

### Token 侧结论（2026-10-27 实测）

- A1/G1 在 fork 后分别约 **65.5M / 54.8M tokens**（缓存命中率约 98.9%）；
- 房间消息 + skill 总量不到 **1 万 tokens**；
- 一次唤醒 turn 在当前长会话下通常 **0.65–0.98M tokens**，复杂 turn 可达 **8–10M**；
- 因此优化重点是**减少 turn、缩短上下文**；`bridge7` 的批处理/运行中跳过/摘要截断就是这个方向，继续保留短任务会话。

下一步：

1. 房间页显示 read/ack 回执与 activity；
2. 任务板支持拖拽/筛选、批量指派；
3. 用 3 轮真实任务统计 wake 次数与 token，再调护栏参数；
4. 护栏命中统计/可观测性（当前只在 host 日志 warning）。





