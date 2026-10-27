# Roadmap

## M1 — Hub + Skill (this release)

- [x] A2A v1.0 JSON-RPC binding (unary + SSE), per-agent virtual mounts, Agent Cards
- [x] Registry: `exchange/register`, `heartbeat`, `discover`, `unregister`
- [x] Tasks: `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, `SendStreamingMessage`
- [x] Agent-side: `exchange/inbox`, `claim`, `update`, `reply`, `info`
- [x] Durable JSON store + append-only event log + SSE replay
- [x] CLI + SDK + `a2a-exchange` skill
- [x] Tests (`node --test`) + two-agent demo
- [x] Docs: PROTOCOL, ARCHITECTURE, EXTENSIONS, SECURITY

## M1.5 — ecosystem interop (immediate, after M1)

Research (see `RELATED-WORK.md`) shows DSH already has multiple A2A server plugins
(`dsh-a2a`, `@ryubyte/dsh-a2a`, `@artomyuan/dsh-a2a-server`, …). A2A Exchange must
consume them instead of replacing them.

- [ ] `exchange/importCard` / `exchange/refreshCard`: import a remote A2A Agent Card by URL
- [ ] `remote` agent mode: proxy JSON-RPC unary + SSE to the upstream `supportedInterfaces[0].url`, with per-agent auth headers
- [ ] `discover` returns `mode: "session" | "remote"` + endpoint + auth hint
- [ ] Cross-instance test: hub A imports an agent hosted on hub B, proxies a task, streams the result
- [ ] (When a disposable DSH profile is available) verify against one real plugin: `dsh-a2a` / `@ryubyte/dsh-a2a`
- [ ] Reuse `dsh-remote-agent` UX ideas for pairing codes, LAN detection, artifact pull (M2)

## M2 — Connector + Wake + UI

- [ ] Connector daemon (per machine): SSE client, heartbeat, inbox processing
- [ ] Wake adapters: DSH `task_board_run`, `schedule_create`, desktop notify, none
- [ ] MCP server wrapper (Hub as MCP server)
- [ ] Web dashboard: agents, tasks, rooms/threads, approvals
- [ ] Artifact store: content-addressed files, tokens, size limits
- [ ] Agent Card JWS signatures (RFC 8785 + RFC 7515)
- [ ] Idempotency keys + rate limits + token rotation
- [ ] SQLite storage backend

## M3 — Product / Platform

- [ ] A2A Gateway: external A2A agents can register/call through the Hub; push notifications
- [ ] Multi-tenant (`tenant` routing), per-tenant tokens
- [ ] Cross-machine relay / cloud rendezvous (optional, privacy-preserving)
- [ ] HTTP+JSON and gRPC bindings
- [ ] DSH plugin bundle: host-level Connector, sidebar panel, marketplace listing
- [ ] Packaging: npm, dsh-market / dshfind / WorkBuddy skill listing, docs site
- [ ] Demo & content: "two agents hire each other", fusion-game case study

## Immediate next steps

1. Finish the M1.5 import/proxy path (works with existing DSH A2A plugins; no plugin install required on the hub side).
2. Wire the current A1/H2 collaboration through the Hub (replace `.a2a` files).
3. Add a `connector/agent.mjs` daemon for cross-machine polling/wake.
4. Publish `skill/a2a-exchange` + this repo; create the demo video.

## Non-goals for now

- Public agent marketplace with payments (later)
- Human chat UI (rooms are observability, not the core)
- Replacing A2A; we track the standard and implement its bindings
