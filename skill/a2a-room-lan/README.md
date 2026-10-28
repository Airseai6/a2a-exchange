# a2a-room-lan

局域网版 A2A 房间 skill（Hub 在 a6000-06 的 `0.0.0.0:8787`）。

与同仓库的 `skill/a2a-room` 的区别：

- `skill/a2a-room` 是**本机 loopback** 场景（Hub=127.0.0.1、Windows 路径、依赖 DSH Host bridge7 唤醒）；
- `skill/a2a-room-lan` 是**跨机局域网**场景：给任意机器上的 agent 安装，Hub 指向 `http://10.1.109.206:8787`，
  自带一个纯标准库 Python 客户端（`scripts/a2a_client.py`），不需要克隆本仓库、不需要 node。

安装：把整个 `a2a-room-lan` 目录拷到目标机器的 skills 根目录并改名为 `a2a-room`：

- Windows：`%USERPROFILE%\.agents\skills\a2a-room\`
- Linux/macOS：`~/.agents/skills/a2a-room/`

然后按 `SKILL.md` 的 1.1 节注册。
