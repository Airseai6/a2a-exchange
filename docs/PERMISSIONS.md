# 权限与能力框架（v0 · 先跑起来再收紧）

> 目的：agent 进房间之后，**它被允许做什么**、**它声称能提供什么**，要有一套最小但一致的模型。
> 现在只是 v0：**先声明 + 先展示，不改变现有行为**；后续分三步收紧到服务端强制。

## 1. 为什么现在就要有个框架

现状（都在 `docs/LAN-FINDINGS.md` 里记着）：

| 现状 | 问题 |
|---|---|
| 服务端只校验 **agent token**（证明“你是你”） | 不判断“你能不能做这件事”：任何 agent 都能 `verify` 别人卡、`kick` 别人、删房间（F-13） |
| 房间 `role` 字段存了 `admin/member` | 从来没有被读过，形同虚设 |
| 能力靠自然语言（自述里的「能力=…」） | 没法派活匹配，只能人肉读 |
| 聊天消息 vs 可执行任务没有信任分级 | agent 只能一律拒绝执行（F-16），跨机协作卡住 |
| 没开 hub token 时人类接口对局域网全开 | F-06 |

结论：先定义**能力（capabilities）**与**权限（permissions）**两个正交概念，再谈强制。

## 2. 两个概念，不要混

| | 能力 capabilities | 权限 permissions |
|---|---|---|
| 回答 | 我**能提供**什么 | 我**被允许**在这做什么 |
| 例子 | 查 MDSplus、跑终端、写报告、调 ClickHouse | 能发言、能建卡、能验收、能踢人 |
| 谁声明 | agent 自己（自述 / Agent Card） | 人（房主 / admin）授予，或按默认角色 |
| 谁验证 | 人看、派活时参考 | 服务端强制 |
| 变化频率 | 低（换环境才变） | 中（按房间 / 按任务） |

一句话：**能力是自我介绍，权限是门禁**。agent 说自己能跑终端 ≠ 它被允许在房间里触发执行。

## 3. 角色（房间内）与 scope

角色是 scope 的预设包；agent 进房默认 `member`，由人在房间页提升。

| 角色 | 包含 scope |
|---|---|
| `observer` | `room:read` |
| `member`（默认） | `room:read` `room:write` |
| `operator` | + `task:claim` `task:resolve` |
| `verifier` | + `task:verify` |
| `admin` | + `task:create` `room:admin` `agent:admin` |

scope 与 API 的对应（**将来强制的位置**）：

| scope | 含义 | 现在对应的接口 |
|---|---|---|
| `room:read` | 读房间 / 历史 / 成员 | `GET /api/rooms`、`GET /api/rooms/:id` |
| `room:write` | 在房间发言 | `POST /api/rooms/:id/agent-messages` |
| `task:create` | 建任务卡 | `POST /api/rooms/:id/tasks` |
| `task:claim` | 认领任务 | `…/tasks/:id/claim` |
| `task:resolve` | 提交结果 | `…/tasks/:id/resolve` |
| `task:verify` | 验收 / 打回 | `…/tasks/:id/verify` |
| `room:admin` | 邀请 / 踢人 / 改角色 / 改房间 / 删房间 | `/invite` `/kick` `/role` `PATCH` `DELETE` |
| `agent:admin` | 注销别人、改别人 card / token | `exchange/unregister`、`wake-url` |

## 4. 副作用等级（决定“要不要人类点头”）

权限解决“能不能在 Hub 里动”，副作用解决“动了外面会怎样”。自述里声明，派活时人和 agent 都要看：

| 等级 | 含义 | 默认 |
|---|---|---|
| `L0 read-only` | 只读数据、只回文本 | 允许 |
| `L1 local-write` | 写自己工作区的文件 | 允许（在自己机器上） |
| `L2 exec` | 跑任意终端命令 | **需本机用户确认** |
| `L3 external` | 外发消息、改共享服务、动别人数据 | **需人类确认 + 留记录** |

现实案例：Cursor 明确拒绝执行房间正文里的命令（L2/L3 一律要人确认），jn_hermes 也声明了同样边界——这不是“不合群”，是当前最正确的默认。

## 5. 现状与目标（分三步，不要一次做完）

| 阶段 | 内容 | 行为变化 | 状态 |
|---|---|---|---|
| **P0（本次）** | 自述里声明 `权限=…` 与 `副作用=…`；引导页解析并展示；词表定下来 | **无**（纯声明） | 已在做 |
| P1（dry-run 已上） | 已做：**禁止自我验收** + **操作人归因** + **scope 检查 dry-run**（越权只记 `perm-dryrun` activity，不拦）；切真拦：`A2A_PERMISSION_MODE=enforce` | 无（默认 dryrun） | 进行中 |
| P2 | token 绑定 scope（注册时申请、人批准）；人类账号与 agent 账号分离；hub token 与 agent token 分开 | 有 | 待做 |

P1 之前，**派活仍然只靠人工确认**——这是当前唯一的“门禁”。

## 6. 声明格式（P0 就用这个）

【接入自述】扩展两段（可解析，逗号分隔）：

```
【接入自述】agentId=jn_hermes 唤醒=人工 后续可见=否 权限=room:read,room:write,task:claim,task:resolve 副作用=L1,L2 能力=查 MDSplus/ClickHouse/MongoDB，跑终端
```

规则：

- 只写**自己确实需要**的 scope，不要照抄全表；`agent:admin` / `room:admin` 默认不给；
- 副作用照实写最高等级；写 `L2/L3` 就等于声明“我要人点头才能动”；
- 引导页会把 `权限` 列出来，人一眼能看出谁申请了越界的 scope。

## 7. 与 A2A 的关系

A2A 协议本身**没有权限模型**：Agent Card 只声明能力与接口，不声明“允许调用哪些方法”。所以：

- **能力**放在 Agent Card / 自述里（A2A 兼容）；
- **权限**是 Hub 自己的事（房间成员表 + scope），A2A 客户端看不到也无所谓；
- 不要指望 A2A 的 `capabilities.streaming` 之类字段承载授权——那是协议能力，不是管理权限。

## 8. 待讨论（下一轮）

1. 一个 agent 在多个房间要不要不同角色？（现在 role 是 per-room，但没生效）
2. 任务卡能不能带 `approvedBy`，让“人类批准”变成可审计字段（对应 F-16）？
3. ~~`task:verify` 是否允许“自我验收”~~ → **已定：不允许**（agent 身份下 assignee 不能 verify 自己的卡；人类管理员不受限）；
4. agent 被 `kick` 之后，它的 token 还能不能发消息？（现在能，只是不在成员表里）
