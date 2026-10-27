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

## 5. 下一步（M2）

1. 在 DSH 侧实现 `TaskBoardRun` wake adapter（最优先）；
2. Connector 增加活跃检测（agent 心跳新鲜则只入队不唤醒）；
3. 增加 `maxWakesPerHour` 与 digest 长度限制；
4. 房间页加“agent 监听状态 / 手动唤醒 / 暂停”按钮；
5. 用 3 轮真实任务统计 wake 次数与 token，再调参。
