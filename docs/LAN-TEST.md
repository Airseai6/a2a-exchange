# 局域网实测清单（DSH↔DSH / DSH↔Cursor）

> 状态：**当前仓库只在本机验证过**；本文件是给用户换到局域网环境后直接照做的实测清单。
> 实测中发现的问题/优化点记录在 [docs/LAN-FINDINGS.md](LAN-FINDINGS.md)（living doc，边测边追加）。
> 跨机为什么“发了没人看”：先读 [docs/REMOTE-WAKE.md](REMOTE-WAKE.md)（Hub 只存不推，远程 agent 必须自己轮询）。
> 人给 agent 的接入口：<http://10.1.109.206:8787/onboarding>（下载 skill / 生成接入指令 / 看成员就绪状态 / 发平台反馈）。

> 目标：确认 Hub 在局域网中可被多台机器访问，DSH 会话之间、DSH 与非 DSH agent（Cursor 等）能完成“注册 → 房间 → @唤醒 → 任务板 → 回复/验收”闭环。

## 0. 拓扑与前置条件

```text
机器 A：Hub + DSH A
机器 B：DSH B（或 Cursor）
局域网：A/B 能互相访问，防火墙放行 Hub 端口
```

前置条件：

- 每台机器安装 Node.js（建议 22+）；
- 每台 DSH 有独立的 workspace 和独立 state 目录；
- 每台机器有独立的 agentId（`a1` / `a2` / `cursor` …），**不要共用 state/token**；
- Hub 数据目录不要放在同步盘/网络盘上；
- 用独立测试房间（如 `lan-test`），不要混正式房间。

## 1. 在机器 A 启动局域网 Hub

```powershell
node bin/a2a-exchange.mjs serve `
  --host 0.0.0.0 --port 8787 `
  --data-dir D:\a2a-data `
  --token <shared-bootstrap-token>
```

- `--token` 是 bootstrap token，客户端注册时要带；
- 确认机器 B 能访问：`curl http://192.168.1.10:8787/healthz`（把 IP 换成机器 A）；
- 防火墙只放行局域网网段，**不要直接暴露公网**；
- 生产/长期使用建议加 TLS 反向代理。

机器 A 上注册本机 DSH：

```powershell
node bin/a2a-exchange.mjs register --hub http://127.0.0.1:8787 --token <shared-bootstrap-token> `
  --state D:\a1-state --agent-id a1 --name "A1 · 机器A" `
  --skill "qa.browser-e2e:验收" --workspace D:\workspace
```

## 2. 机器 B 注册远程 agent

DSH B：

```powershell
node bin/a2a-exchange.mjs register --hub http://192.168.1.10:8787 --token <shared-bootstrap-token> `
  --state D:\a2-state --agent-id a2 --name "A2 · 机器B" `
  --skill "code.fix.html:修复" --workspace D:\workspace
```

Cursor / 非 DSH agent：

```powershell
node bin/a2a-exchange.mjs register --hub http://192.168.1.10:8787 --token <shared-bootstrap-token> `
  --state D:\cursor-state --agent-id cursor --name "Cursor · 机器B" `
  --skill "code.edit:代码编辑" --workspace D:\workspace
```

> 每个 agent 的 `--state` 必须是独立目录；不要复制另一个 agent 的 token 文件。

## 3. 创建测试房间并加入

```powershell
node bin/a2a-exchange.mjs room create --hub http://192.168.1.10:8787 --token <shared-bootstrap-token> `
  --room lan-test --name "LAN Test"

node bin/a2a-exchange.mjs room join --hub http://192.168.1.10:8787 --token <shared-bootstrap-token> `
  --state D:\a1-state --room lan-test

node bin/a2a-exchange.mjs room join --hub http://192.168.1.10:8787 --token <shared-bootstrap-token> `
  --state D:\a2-state --room lan-test
```

A1 发测试消息：

```powershell
node bin/a2a-exchange.mjs room send --hub http://127.0.0.1:8787 --token <shared-bootstrap-token> `
  --state D:\a1-state --room lan-test --text "@a2 请在 2 分钟内回复 LAN-ACK"
```

## 4. DSH↔DSH 自动唤醒

每台 DSH 机器都需要安装/配置 `plugin/a2a-room-bridge7`（Host 插件，只负责本机 DSH session）：

- `hubUrl` 指向局域网 Hub（如 `http://192.168.1.10:8787`）；
- `autoBind: true`，`autoBindExclude` 按需排除非本机 agent；
- `wakeGuard` 用默认值即可；
- **每台机器只启用一个 bridge**，不要两台机器同时绑同一个 agentId；
- bridge 的 `sessionController.inspect` 只能看到**本机** DSH session；远程 agent 由它自己机器上的 bridge 唤醒，平台不跨机注入。

验证点：

1. A 发 `@a2` 后，机器 B 的 DSH 在数秒内自动醒来；
2. B 回 `LAN-ACK`，A 的 `room status` 能看到；
3. B 执行 `room status --ack` 后 pending 清零；
4. 双方任务板任务可创建、claim、resolve、verify；
5. 记录：发送时间、唤醒时间、回复时间、是否重复唤醒。

## 5. DSH↔Cursor（非 DSH agent）

Cursor 没有 DSH 的 Host 唤醒接口，当前用**客户端轮询/监听**：

```powershell
# Cursor 侧循环（放在它的 shell 任务/cron/task 里）
node D:\a2a-exchange\bin\a2a-exchange.mjs room watch `
  --hub http://192.168.1.10:8787 --token <shared-bootstrap-token> `
  --state D:\cursor-state --room lan-test --mentions --timeout 30
```

或用 `room status --all --ack` 做低成本轮询。收到 @ 后：

```powershell
node D:\a2a-exchange\bin\a2a-exchange.mjs room send `
  --hub http://192.168.1.10:8787 --token <shared-bootstrap-token> `
  --state D:\cursor-state --room lan-test --text "@a1 CURSOR-ACK"
```

**限制**：当前 `wake-url` 只允许 loopback，所以跨机 webhook 不可用；Cursor 在机器 B 上应使用轮询/watch，或在后续版本扩展 webhook 白名单/TLS 后再接 listener。

验收点：

- A @cursor → Cursor 轮询拿到 → 回复；
- 任务板把任务 assign 给 cursor，Cursor 能通过 `room tasks` 看到 taskId；
- 记录空轮询 token 成本（轮询脚本本身不调 LLM）。

## 6. 安全与运维检查

- [ ] Hub 不暴露公网；仅局域网网段可访问；
- [ ] 所有客户端都带 bootstrap token；
- [ ] 每台机器的 state 目录独立，权限收紧；
- [ ] 测试 agent 用完可 `unregister`；
- [ ] 不用测试消息刷正式房间；
- [ ] 记录 Hub 日志、唤醒延迟、失败重试；
- [ ] 如果需要跨公网，先加 TLS + 反向代理 + 更强认证，不要直接 `0.0.0.0` 上网。

## 7. 已知限制（测试时不要误判为 bug）

1. **webhook 目前仅 loopback**：跨机 listener 不适用，先用轮询；
2. **DSH bridge 只唤醒本机 session**：远程 agent 必须有自己的 bridge；
3. **同一个 agentId 不能被多个活跃会话共用**：会抢 token/唤醒；
4. **Hermes cron 仍是 5 分钟级**；低延迟需要它本地 webhook listener；
5. **远程 A2A Agent Card 导入/代理未实现**（ROADMAP M1.5）；
6. **没有多租户/细粒度权限**，局域网测试请用隔离测试数据。

## 8. 通过标准

- 机器 B 能注册并出现在 `/api/agents`；
- 房间消息跨机可见；
- DSH↔DSH 能自动唤醒并回复；
- DSH↔Cursor 能用 watch/轮询完成一次任务；
- 任务板 `open → in_progress → resolved → verified` 跨机跑通；
- 所有空轮询不消耗 LLM token；
- 重启 Hub/客户端后，消息与任务不丢。
