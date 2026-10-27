# Related work · DSH A2A / remote-agent ecosystem

> Research date: 2026-10-27. The DSH plugin ecosystem already contains several A2A and remote-agent projects. **A2A Exchange should not rebuild them**; it should sit *above* them as the discovery/coordination layer and reuse their A2A endpoints. This document records what exists, what to reuse, and where the gap is.

## 1. A2A server/client plugins for DSH

| Package | Version | What it does | What to reuse | Notes / risks |
|---|---|---|---|---|
| **`dsh-a2a`** (TtTRz) | 0.7.2 | One plugin, two halves: **server** (A2A v1.0 JSON-RPC + REST + SSE; multi-agent endpoint `/agents/<id>`; Agent Card per agent; contextId → persistent DSH session; bearer auth; settings tab) and **client** (`a2a_call` / `a2a_list` tools, per-agent headers). | Best reference for "DSH as a proper A2A server" and for **card shape / auth / per-agent skills / contextId session mapping**. Our hub can import its Agent Card and proxy calls to it. | Pinned to specific DSH releases (README targets dsh 0.1.7-rc.2); plugins must match the host version. |
| **`@artomyuan/dsh-a2a-server`** | 0.5.1 | A2A server bundle exposing DSH sessions, with rich streaming events (tool_call/tool_result/thinking) and a companion `hermes-a2a-bridge` for Hermes-style clients (Feishu/QQ progress push). | Reference for **streaming event granularity** and Hermes ↔ DSH interop. | Companion bridge is separate; server-specific config. |
| **`@ryubyte/dsh-a2a`** | 0.3.1 | Dual-end plugin: outbound AgentCard → DSH tools (`a2a__<name>__<skill>`), inbound A2A server, and a full **settings dashboard** with `a2a.json` config (add/edit agents, public service card, auth, peers list). | Reference for **skill→tool mapping**, UI/config ergonomics, and inbound peer observability. | Version-coupled; config file lives per profile. |
| **`@amaster.ai/dsh-a2a`**, **`@hanphone/dsh-a2a`**, **`dsh-a2a-server`**, **`@celumin/dsh-a2a`**, **`@zyfgood/dsh-a2a`** … | various | Multiple independent variants of the same idea (A2A server/client for DSH). | Confirms the demand and the wire contract; our hub should interop via Agent Cards instead of depending on one. | Ecosystem fragmentation: no shared discovery, no cross-variant registry. |

**Gap they leave**: each plugin configures remote peers per profile / per deployment. There is no cross-machine/cross-profile **registry + discovery + rooms + task history** layer; cards are fetched per URL, not searchable by capability. That is exactly A2A Exchange's product slot.

## 2. Remote control / remote execution

| Package | Version | What it does | What to reuse | Notes |
|---|---|---|---|---|
| **`dsh-remote-agent`** (zbzbhs) | 0.9.12 | Turns another machine into a remote agent co-worker: pairing code, LAN/Tailscale detection, hub/worker roles, persistent remote agent loop, task dispatch, handoff summary + artifact manifest pull, Web panel, relay option. | Reference for **LAN pairing / firewall guidance / pairing codes / artifact transfer / wake semantics**. Our M2 wake + cross-machine story should copy these UX patterns instead of inventing them. | Custom protocol (not A2A); plugin version coupling. |
| **`dsh-remote-control`** | 0.5.3 | Pair a DSH host with a relay; a WeChat mini-program can send commands, watch streaming output, answer approval prompts; payload-level E2E encryption. | Reference for **human-in-the-loop approvals** and mobile control of sessions. | Different product direction (remote human control, not agent-to-agent). |
| **`dsh-cross-collaboration`** | n/a (not found on npm) | Mentioned by the user; possibly a GitHub/market project rather than npm. | Keep as a reference pointer; verify before integrating. | — |

## 3. What this means for A2A Exchange

### 3.1 Do not build another A2A server plugin
Existing plugins already expose DSH as an A2A v1.0 server with SSE, auth, session mapping, and UIs. A2A Exchange should **consume** those endpoints.

### 3.2 Keep two agent modes
1. **`remote` mode** (primary for plugin users): import an Agent Card URL from `dsh-a2a` / `@ryubyte/dsh-a2a` / any A2A agent; store it in the registry; proxy `SendMessage`/SSE to its real endpoint. The hub adds discovery, tokens, audit, rooms.
2. **`session` mode** (our current implementation, skill-only): a DSH conversation registers via the `a2a-exchange` skill; the hub hosts a virtual A2A endpoint with a durable inbox; the session claims/answers with CLI tools. This works **without installing a DSH plugin**, which matters when the installed plugin does not match the host DSH version — a real advantage of the skill-only design.

### 3.3 Product differentiation (what remains ours)
- **Cross-machine, cross-plugin registry + capability discovery** (search by skill/tag/status; no manual per-profile peer config).
- **Conversation-level agents** (ad-hoc registration from a chat; not only preconfigured presets).
- **Rooms / task history / audit / approval surface** for humans watching multiple agents.
- **Version-independent fallback** (skill + local hub) when A2A plugins are incompatible with the current DSH build.
- **One skill + one endpoint** to join multiple existing implementations (aggregator).

## 4. Concrete plan adaptation

### M1.5 (next)
- [ ] `exchange/importCard` / `exchange/refreshCard`: import a remote Agent Card (from `dsh-a2a`, `@ryubyte/dsh-a2a`, or any A2A agent).
- [ ] Hub proxy for `remote` agents: forward JSON-RPC unary + SSE streaming to the upstream `supportedInterfaces[0].url` (header/token per agent), optionally mirror task state for history.
- [ ] `discover` returns `mode: "session" | "remote"` and the endpoint + auth hint.
- [ ] Test: hub A imports an agent card from hub B (our own hosted mode), then A calls through the proxy → B. This proves cross-instance interop without installing plugins.
- [ ] Compare with `dsh-a2a` in a disposable DSH profile when a compatible host is available.

### M2
- [ ] Prefer `remote` mode for users who already run `dsh-a2a`; document the one-line config.
- [ ] Wake adapter: if the imported agent's card exposes our `wake` extension, use task-board/schedule/human notify; otherwise rely on the upstream plugin's native session wake.
- [ ] Web UI: agents table (mode, status, skills, card URL), tasks/rooms, audit.

### M3
- [ ] A2A registry federation: hub-to-hub card exchange / discovery.
- [ ] Cross-machine pairing UX borrowed from `dsh-remote-agent` (pairing code, LAN IP detection, firewall prompts).

## 5. Compatibility notes

- Existing DSH A2A plugins pin DSH/Cordis versions; **do not install them into the user's active profile without a disposable profile test**.
- Our skill-only mode has no host plugin dependency (Node ≥ 22 + Chrome optional); it is the safe fallback.
- When integrating, prefer `supportedInterfaces[0].url` + card `securitySchemes`/`security` over hardcoding vendor fields.
