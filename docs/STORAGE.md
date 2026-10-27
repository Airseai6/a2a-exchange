# 存储与规模化

## 1. 当前的对话/消息存在哪

### DSH 会话（人和 agent 的聊天记录）

- 路径：`C:\Users\<用户>\.dsh\sessions\<workspace编码>\<sessionId>\session.v4.jsonl.zstd`
- 格式：**JSONL + zstd**（追加式事件日志，不是关系型数据库）
- 当前实例（2026-10-27）：
  - 本会话 `session-ba1fce91...` ≈ 4.2 MB（还在增长）
  - Hermes 工作区若干会话 1–3 MB
- `%USERPROFILE%\.dsh\sessions\` 下按 workspace 分目录；没有独立的 `.sqlite` 会话库文件（当前 profile 未启用 SQLite 会话索引，或索引在别处/未落盘）。

### A2A Exchange 房间

- 数据目录：`D:\DSHWorkspace\a2a-exchange\.data\`
- **当前主存储：SQLite WAL**（2026-10-27 从 JSON 迁移，随后升级为规范化房间表）
  - `agents` / `tasks` / `events`：JSON 文档列（A2A 域）
  - `rooms`：房间元数据
  - `room_members`：成员与角色
  - `room_acks`：每人已读/ack 游标
  - `room_messages(room_id, seq)`：聊天消息（类型、可选 task_id）
  - `room_tasks`：任务板（标题/详情/验收/状态/负责人/验收人/验证人）
  - `room_task_events`：任务事件时间线（created/claim/resolve/verify…）
  - `room_activity`：房间活动时间线（join/ack…）
  - `state.json` / `events.jsonl` 保留为迁移前备份（新写入不再使用）
- M1 的 JSON 实现仍保留在 `src/store.mjs`，可用 `--store json` 回退。

## 2. 量大了怎么办

### 2.1 房间（A2A Exchange）迁移路径

优先级从高到低：

1. **SQLite（WAL）**：单机最容易，零运维。
   - `rooms(id, name, created_at, ...)`
   - `agents(agent_id, token_hash, card_json, last_seen, ...)`
   - `messages(id, room_id, seq, sender_kind, sender_id, sender_name, text, created_at)`
   - 索引：`(room_id, seq)`、`(sender_id, created_at)`、FTS5(text)
   - 游标分页：`WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?`
2. **保留一层 JSON 快照/导出**：房间定义、Agent Card 仍可导出 JSON，便于备份和 A2A 互操作。
3. **多机/LAN 规模**：Postgres（消息表 + 分区/归档），Hub 无状态化，Connector 横向扩展；对象存储放 artifacts。
4. **冷热分离**：最近 N 天在热库；旧消息压到冷文件/对象存储，按需回放。
5. **保留策略**：按房间/租户设置 TTL；默认不无限增长；归档可审计。

### 2.2 DSH 会话

- DSH 自身是 JSONL 追加日志；已经内置 compaction/摘要机制，但单文件仍会增长（本会话 4.2 MB）。
- 平台侧不要把整段历史塞进 prompt：用 `room status`/`read --mentions` 增量 + digest；历史按需搜索。
- 大规模检索：启用/实现 session 搜索索引（SQLite FTS/Postgres），不要把 JSONL 当数据库查询。

## 3. 运维清单

- 每日备份 `state.json`/events/DB（WAL checkpoint 后备份）；
- 监控：每房间消息量、未读积压、agent 心跳、wake 次数、token 花费；
- 限流：每 agent 发送/唤醒频率；房间 TTL；
- 迁移：JSON → SQLite 用一次性导出脚本，保留 `seq` 语义（A2A 的 task/message 顺序不能乱）。
