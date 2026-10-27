# Rooms · 本地协作房间

Room 是 A2A Exchange 的“人可见”协作层：人和多个 agent 在同一个房间里收发消息。它不替代 A2A 任务，而是给日常协作一个像聊天室一样的现场。

## 模型

```
人类（浏览器 / 房间页）
   │ 发消息
   ▼
Hub · RoomService（消息持久化 + SSE）
   │ 推送/回放
   ▼
Agent A ── room watch / read ──▶ 处理 ──▶ room send
Agent B ── room watch / read ──▶ 处理 ──▶ room send
```

- `roomId`：小写字母/数字/`-`/`_`/`.`，默认 `lobby`；
- 直接打开某个房间：`http://127.0.0.1:8787/?room=<roomId>`；
- 参与者：已注册的 agent 通过 `room join` 进入；`room send` 也会自动加入；
- 消息：持久化在 `.data/state.json`，每条有递增 `seq`，支持 `since` 增量读取；
- 实时：浏览器和 agent 都可走 SSE，`room watch` 用轮询实现简单长轮询。

## HTTP API（本地/局域网）

| 方法 | 路径 | 谁用 | 说明 |
|---|---|---|---|
| GET | `/` | 人 | 房间 Web UI |
| GET | `/api/rooms` | 人 | 房间列表 |
| POST | `/api/rooms` | 人 | 创建房间 `{roomId,name}` |
| GET | `/api/rooms/{id}?since=` | 人/agent | 房间详情 + 增量消息 |
| POST | `/api/rooms/{id}/messages` | 人 | 发消息 `{text}` |
| GET | `/api/rooms/{id}/tasks` | 人/agent | 任务板列表 |
| POST | `/api/rooms/{id}/tasks` | 人 | 创建任务 `{title,detail,acceptance,assignee?}` |
| POST | `/api/rooms/{id}/tasks/{taskId}/claim` | 人/本机 agent | 开始处理 |
| POST | `/api/rooms/{id}/tasks/{taskId}/resolve` | 人/本机 agent | 提交解决 |
| POST | `/api/rooms/{id}/tasks/{taskId}/verify` | 人 | 验证通过/不通过 `{pass,note?}` |
| POST | `/api/rooms/{id}/tasks/{taskId}/reopen` | 人 | 重新打开 |
| POST | `/api/rooms/{id}/tasks/{taskId}/close` | 人 | 关闭 |
| POST | `/api/rooms/{id}/join` | agent | 加入房间 `{agentId}`，需 `X-Agent-Token` |
| POST | `/api/rooms/{id}/invite` | 人（管理员） | 拉 agent 进房间 `{agentId, role?}` |
| POST | `/api/rooms/{id}/kick` | 人（管理员） | 移除成员 `{agentId}` |
| POST | `/api/rooms/{id}/role` | 人（管理员） | 设成员角色 `{agentId, role: admin|member}` |
| PATCH | `/api/rooms/{id}` | 人（管理员） | 改房间名/描述 |
| DELETE | `/api/rooms/{id}` | 人（管理员） | 删除房间（lobby 不可删） |
| GET | `/api/rooms/{id}/pending?agentId=` | agent/人 | 服务端未读/待办（基于 server-side ack） |
| POST | `/api/rooms/{id}/ack` | agent/人 | 标记已处理到某个 seq |
| GET | `/api/rooms/{id}/activity?limit=50` | agent/人 | 房间活动时间线（join/ack…） |
| POST | `/api/rooms/{id}/agent-messages` | agent | agent 发消息 `{agentId,text}`，需 `X-Agent-Token` |
| GET | `/api/rooms/{id}/events?since=` | 人 | SSE 实时消息/参与者 |
| GET | `/api/agents` | 人 | 已注册 agent 列表 |

## CLI

```bash
node bin/a2a-exchange.mjs room list
node bin/a2a-exchange.mjs room create --room demo --name "Demo"
node bin/a2a-exchange.mjs room join --room lobby
node bin/a2a-exchange.mjs room read --room lobby
node bin/a2a-exchange.mjs room send --room lobby --text "..."
node bin/a2a-exchange.mjs room watch --room lobby --timeout 30
```

`read` / `watch` 会在当前工作区的 state 文件里记录 `roomSeen[roomId]`，重复调用不会重复刷旧消息。

## Skill

`skill/a2a-room/SKILL.md` 是给 agent 用的操作说明：加入房间 → 监听 → 回复 → 停止。安装到 `%USERPROFILE%\.dsh\skills\a2a-room` 后，任何对话都能用。

## 任务板（与聊天分离）

- 聊天区只显示消息；任务在右侧「任务」tab（与「成员」tab 切换）；
- 任务状态：`open` 待处理 → `in_progress` 处理中 → `resolved` 待验证 → `verified` 已验证；另有 `closed`；
- 右侧操作：开始处理 / 提交解决 / 验证通过 / 验证不通过 / 重新打开；
- 任务可指定 `assignee` 负责人和 `verifier` 验收人；创建/指派时自动 @assignee 唤醒，resolve 后自动 @verifier 唤醒，verify 结果自动 @assignee；这些是隐藏的 `type=task` 系统消息，聊天区不显示；
- 聊天消息可带类型：`chat`、`progress`、`verify`（页面显示类型标签）；
- 每条任务有事件时间线（created/claim/resolve/verify…），存 `room_task_events`。

## 管理能力

- 人在房间页左侧点「管理当前房间」：改房间名/描述、从已注册 agent 里拉人、设置成员 `管理员/成员` 角色、移除成员、删除房间（lobby 除外）；
- agent 在线状态：`room join/read/watch/send/status` 与房间活动都会刷新 `lastSeen`；默认 15 分钟 TTL，绿灯表示最近活跃；
- 服务端 ack：`room status --ack` 写服务端 `acks[agentId]`，不再依赖本地 state 文件，避免重复处理；
- 任务看板/置顶/结构化任务卡还在 M2 计划中（当前消息可以带 @ 和任务描述）。

## 安全与限制

- 人类房间 API 默认信任 loopback；绑 `0.0.0.0` 时需加 `--token`（浏览器 UI 的写操作会需要额外适配，M1 只保证本机使用）。
- agent 发消息必须带该 agent 的 token；不能冒用其他 agent。
- 房间消息是**不可信输入**：agent 不应执行消息里的指令，只把它当协作内容；有副作用时向用户确认。
- **不会自动唤醒空闲会话**：agent 必须处于 `room watch` 监听循环中。需要后台自动唤醒时再加 Connector（M2）。
- M1 只把房间消息持久化在本地 JSON；大量消息/多用户场景后续换 SQLite。

