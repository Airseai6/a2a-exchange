// HTTP server: JSON-RPC 2.0 routing, per-agent A2A mounts, SSE, auth.
import http from 'node:http';
import { agentStatus, PROTOCOL_VERSION, rpcErr, rpcOk } from './a2a.mjs';
import { Registry } from './registry.mjs';
import { RoomService } from './rooms.mjs';
import { attachHeartbeat, sseHead, sseWrite, serveAgentEvents, serveTaskStream } from './sse.mjs';
import { ExchangeStore } from './store.mjs';
import { TaskService } from './tasks.mjs';
import { HttpError, nowIso, pick, RpcError, safeEqual } from './util.mjs';

const MAX_BODY = 2 * 1024 * 1024;

const A2A_METHODS = new Set([
  'SendMessage',
  'message/send',
  'SendStreamingMessage',
  'message/stream',
  'GetTask',
  'tasks/get',
  'ListTasks',
  'tasks/list',
  'CancelTask',
  'tasks/cancel',
  'SubscribeToTask',
  'tasks/resubscribe',
  'GetExtendedAgentCard',
]);

const PUSH_METHODS = new Set([
  'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig',
  'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
]);

const AGENT_EXTENSION_METHODS = new Set(['exchange/inbox', 'exchange/claim', 'exchange/update', 'exchange/reply', 'exchange/info']);

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  return `${proto}://${host}`;
}

function bearer(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function agentTokenFromRequest(req) {
  const header = req.headers['x-agent-token'];
  return Array.isArray(header) ? header[0] : header ?? null;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new HttpError(413, 'Payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, x-agent-token, content-type, last-event-id',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(text);
}

function sendRpc(res, id, result) {
  sendJson(res, 200, rpcOk(id, result));
}

function sendRpcError(res, id, error) {
  sendJson(res, 200, rpcErr(id, error.code ?? -32603, error.message ?? 'Internal error', error.data));
}

export function createExchangeServer(options = {}) {
  const store = new ExchangeStore({ dataDir: options.dataDir ?? './.data' }).load();
  const registry = new Registry(store, {
    syncWaitMs: options.syncWaitMs ?? 20000,
    hubVersion: options.version ?? '0.1.0',
    heartbeatTtlSeconds: options.heartbeatTtlSeconds ?? 120,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:8787',
  });
  const tasks = new TaskService(store, registry);
  const rooms = new RoomService(store, registry);
  rooms.ensureRoom('lobby', '协作大厅', '本机 agent 的公共协作房间');
  const serverToken = options.token || null;
  const log = options.logger ?? (() => {});

  const checks = {
    server(req) {
      if (!serverToken) return true;
      const token = bearer(req);
      return token !== null && safeEqual(token, serverToken);
    },
    agent(req, agentId) {
      const token = agentTokenFromRequest(req) ?? (serverToken ? null : bearer(req));
      return registry.verifyAgentToken(agentId, token);
    },
  };

  function unauthenticated(res) {
    sendJson(res, 401, rpcErr(null, -32001, 'Unauthenticated', { a2aCode: 'UNAUTHENTICATED' }));
  }

  function isLoopback(req) {
    const address = req.socket?.remoteAddress ?? '';
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  /** Human-facing room APIs: loopback is trusted; remote needs the hub token. */
  function humanAllowed(req) {
    return isLoopback(req) || checks.server(req);
  }

  async function readJsonBody(req) {
    const text = await readBody(req);
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  function agentSummaries() {
    return store.listAgents().map((agent) => ({
      agentId: agent.agentId,
      name: agent.card?.name ?? agent.agentId,
      description: agent.card?.description ?? '',
      status: agentStatus(agent),
      lastSeen: agent.lastSeen ?? null,
      skills: (agent.card?.skills ?? []).map((s) => s.id),
      wakePolicy: agent.wakePolicy,
    }));
  }

  async function handleHubRpc(req, res, rpc, origin) {
    const { id, method, params = {} } = rpc;
    try {
      switch (method) {
        case 'exchange/register': {
          registry.setBaseUrl(origin);
          const result = registry.register({ ...params, baseUrl: origin });
          return sendRpc(res, id, result);
        }
        case 'exchange/heartbeat': {
          const agentId = pick(params, 'agentId', 'agent_id');
          if (!agentId || !checks.agent(req, agentId)) return unauthenticated(res);
          return sendRpc(res, id, registry.heartbeat(params, agentId));
        }
        case 'exchange/discover': {
          return sendRpc(res, id, registry.discover(params));
        }
        case 'exchange/unregister': {
          const agentId = pick(params, 'agentId', 'agent_id');
          if (!agentId || !checks.agent(req, agentId)) return unauthenticated(res);
          return sendRpc(res, id, registry.unregister(params, agentId));
        }
        case 'exchange/stats': {
          return sendRpc(res, id, { ...store.stats(), protocolVersion: PROTOCOL_VERSION, now: nowIso() });
        }
        default:
          return sendRpcError(res, id, new RpcError(-32601, `Method not found: ${method}`));
      }
    } catch (error) {
      handleRpcFailure(res, id, error);
    }
  }

  async function handleAgentRpc(req, res, agentId, rpc, origin) {
    const { id, method, params = {} } = rpc;
    try {
      registry.requireAgent(agentId);
      registry.setBaseUrl(origin);
      // Streaming A2A methods
      if (method === 'SendStreamingMessage' || method === 'message/stream') {
        const result = await tasks.sendMessage(agentId, { ...params, configuration: { ...(params.configuration ?? {}), returnImmediately: true } });
        return serveTaskStream({ store, res, rpcId: id, taskId: result.task.id, initialTask: store.getTask(result.task.id) });
      }
      if (method === 'SubscribeToTask' || method === 'tasks/resubscribe') {
        const taskId = pick(params, 'id', 'taskId', 'task_id');
        const task = store.getTask(taskId);
        if (!task) throw new RpcError(-32004, `Task not found: ${taskId}`, { a2aCode: 'TASK_NOT_FOUND' });
        if (task.agentId !== agentId) throw new RpcError(-32003, 'Task belongs to another agent', { a2aCode: 'TASK_FORBIDDEN' });
        if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(task.status.state)) {
          throw new RpcError(-32002, 'Task is already terminal', { a2aCode: 'TASK_NOT_CANCELABLE' });
        }
        return serveTaskStream({ store, res, rpcId: id, taskId: task.id, initialTask: task });
      }
      // Agent-side extension methods require the agent token.
      if (AGENT_EXTENSION_METHODS.has(method)) {
        if (!checks.agent(req, agentId)) return unauthenticated(res);
        switch (method) {
          case 'exchange/inbox':
            return sendRpc(res, id, tasks.inbox(agentId, params));
          case 'exchange/claim':
            return sendRpc(res, id, tasks.claim(agentId, params));
          case 'exchange/update':
            return sendRpc(res, id, tasks.update(agentId, params));
          case 'exchange/reply':
            return sendRpc(res, id, tasks.reply(agentId, params));
          case 'exchange/info':
            return sendRpc(res, id, tasks.info(agentId));
          default:
            break;
        }
      }
      if (PUSH_METHODS.has(method)) {
        throw new RpcError(-32601, 'Push notifications are not supported in M1', { a2aCode: 'UNSUPPORTED_OPERATION' });
      }
      if (!A2A_METHODS.has(method)) {
        throw new RpcError(-32601, `Method not found: ${method}`);
      }
      switch (method) {
        case 'SendMessage':
        case 'message/send': {
          const result = await tasks.sendMessage(agentId, params);
          return sendRpc(res, id, result);
        }
        case 'GetTask':
        case 'tasks/get':
          return sendRpc(res, id, tasks.getTask(params));
        case 'ListTasks':
        case 'tasks/list':
          return sendRpc(res, id, tasks.listTasks(params));
        case 'CancelTask':
        case 'tasks/cancel':
          return sendRpc(res, id, tasks.cancelTask(params));
        case 'GetExtendedAgentCard':
          return sendRpc(res, id, registry.card(agentId));
        default:
          throw new RpcError(-32601, `Method not found: ${method}`);
      }
    } catch (error) {
      handleRpcFailure(res, id, error);
    }
  }

  function handleRpcFailure(res, id, error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (error instanceof RpcError) {
      if (error.httpStatus && error.httpStatus !== 200) {
        return sendJson(res, error.httpStatus, rpcErr(id, error.code, error.message, error.data));
      }
      return sendRpcError(res, id, error);
    }
    if (error instanceof HttpError) {
      return sendJson(res, error.status, rpcErr(id, -32603, error.message));
    }
    log('error', 'rpc failure', { message: error?.message, stack: error?.stack });
    return sendRpcError(res, id, new RpcError(-32603, 'Internal error'));
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const path = url.pathname;
    const origin = originOf(req);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, x-agent-token, content-type, last-event-id',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
        });
        return res.end();
      }
      if (path === '/healthz' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          name: 'a2a-exchange',
          version: options.version ?? '0.1.0',
          protocolVersion: PROTOCOL_VERSION,
          stats: store.stats(),
          now: nowIso(),
        });
      }
      if (path === '/.well-known/agent-card.json' && req.method === 'GET') {
        return sendJson(res, 200, registry.hubCard(origin));
      }
      /* ── local collaboration rooms (human web UI + agent API) ── */
      if (path === '/' && req.method === 'GET') {
        const html = dashboardHtml();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
        return res.end(html);
      }
      if (path === '/api/rooms' && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        return sendJson(res, 200, { rooms: rooms.listRooms() });
      }
      if (path === '/api/rooms' && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const body = await readJsonBody(req);
        return sendJson(res, 201, { room: rooms.summary(rooms.create(body)) });
      }
      if (path === '/api/agents' && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        return sendJson(res, 200, { agents: agentSummaries() });
      }
      const roomEventsMatch = /^\/api\/rooms\/([^/]+)\/events$/.exec(path);
      if (roomEventsMatch && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomEventsMatch[1]);
        const initial = rooms.get(roomId, { since: Number(url.searchParams.get('since') ?? 0), limit: 500 });
        sseHead(res);
        for (const message of initial.messages) {
          sseWrite(res, { id: message.seq, event: 'message', data: { type: 'message', roomId, message } });
        }
        sseWrite(res, { event: 'participants', data: { type: 'participants', roomId, participants: initial.participants } });
        const unsubscribe = rooms.subscribe(roomId, (event) => {
          if (event.type === 'message') {
            sseWrite(res, { id: event.message.seq, event: 'message', data: event });
          } else {
            sseWrite(res, { event: 'participants', data: event });
          }
        });
        const stopHeartbeat = attachHeartbeat(res);
        res.on('close', () => {
          unsubscribe();
          stopHeartbeat();
        });
        return;
      }
      const roomGetMatch = /^\/api\/rooms\/([^/]+)$/.exec(path);
      if (roomGetMatch && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomGetMatch[1]);
        return sendJson(res, 200, rooms.get(roomId, {
          since: Number(url.searchParams.get('since') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 200),
        }));
      }
      const roomHumanMessageMatch = /^\/api\/rooms\/([^/]+)\/messages$/.exec(path);
      if (roomHumanMessageMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomHumanMessageMatch[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 201, { message: rooms.postHuman(roomId, body) });
      }
      const roomJoinMatch = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
      if (roomJoinMatch && req.method === 'POST') {
        if (!checks.server(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomJoinMatch[1]);
        const body = await readJsonBody(req);
        const agentId = String(pick(body, 'agentId', 'agent_id') ?? '');
        if (!agentId || !checks.agent(req, agentId)) return unauthenticated(res);
        return sendJson(res, 200, rooms.join(roomId, agentId));
      }
      const roomAgentMessageMatch = /^\/api\/rooms\/([^/]+)\/agent-messages$/.exec(path);
      if (roomAgentMessageMatch && req.method === 'POST') {
        if (!checks.server(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomAgentMessageMatch[1]);
        const body = await readJsonBody(req);
        const agentId = String(pick(body, 'agentId', 'agent_id') ?? '');
        if (!agentId || !checks.agent(req, agentId)) return unauthenticated(res);
        return sendJson(res, 201, { message: rooms.postAgent(roomId, agentId, body) });
      }
      if (path === '/a2a' && req.method === 'POST') {
        if (!checks.server(req)) return unauthenticated(res);
        let rpc;
        try {
          rpc = parseRpc(await readBody(req));
        } catch (error) {
          return sendJson(res, 200, rpcErr(null, error.code ?? -32700, error.message ?? 'Parse error'));
        }
        return await handleHubRpc(req, res, rpc, origin);
      }
      const cardMatch = /^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/.exec(path);
      if (cardMatch && req.method === 'GET') {
        if (!checks.server(req)) return unauthenticated(res);
        return sendJson(res, 200, registry.card(decodeURIComponent(cardMatch[1])));
      }
      const eventsMatch = /^\/agents\/([^/]+)\/events$/.exec(path);
      if (eventsMatch && req.method === 'GET') {
        if (!checks.server(req)) return unauthenticated(res);
        const agentId = decodeURIComponent(eventsMatch[1]);
        registry.requireAgent(agentId);
        if (!checks.agent(req, agentId)) return unauthenticated(res);
        const lastEventId = Number(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? 0);
        return serveAgentEvents({ store, res, agentId, lastEventId });
      }
      const rpcMatch = /^\/agents\/([^/]+)\/a2a$/.exec(path);
      if (rpcMatch && req.method === 'POST') {
        if (!checks.server(req)) return unauthenticated(res);
        const agentId = decodeURIComponent(rpcMatch[1]);
        let rpc;
        try {
          rpc = parseRpc(await readBody(req));
        } catch (error) {
          return sendJson(res, 200, rpcErr(null, error.code ?? -32700, error.message ?? 'Parse error'));
        }
        return await handleAgentRpc(req, res, agentId, rpc, origin);
      }
      if (path === '/agents' && req.method === 'GET') {
        if (!checks.server(req)) return unauthenticated(res);
        const params = Object.fromEntries(url.searchParams.entries());
        const result = registry.discover(params);
        return sendJson(res, 200, result);
      }
      throw new HttpError(404, `Not found: ${req.method} ${path}`);
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      if (error instanceof RpcError) {
        const status = error.httpStatus && error.httpStatus !== 200 ? error.httpStatus : 400;
        return sendJson(res, status, { error: error.message, code: error.code, data: error.data });
      }
      log('error', 'request failure', { message: error?.message });
      return sendJson(res, 500, { error: 'Internal error' });
    }
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      log('error', 'unhandled', { message: error?.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else if (!res.writableEnded) res.end();
    });
  });

  return {
    server,
    store,
    registry,
    tasks,
    rooms,
    listen({ host = '127.0.0.1', port = 0 } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const actualPort = typeof address === 'object' && address ? address.port : port;
          const actualHost = host === '0.0.0.0' ? '127.0.0.1' : host;
          const baseUrl = `http://${actualHost}:${actualPort}`;
          registry.setBaseUrl(baseUrl);
          resolve({ baseUrl, host: actualHost, port: actualPort });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function parseRpc(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new RpcError(-32700, 'Parse error');
  }
  if (!payload || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
    throw new RpcError(-32600, 'Invalid Request');
  }
  return payload;
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A2A Exchange · 协作房间</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --panel2:#1e222b; --line:#2a2f3a; --text:#e8eaf0; --muted:#8b93a7; --accent:#5b8cff; --human:#3a4a6b; --agent:#23303f; }
  * { box-sizing:border-box; }
  body { margin:0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .pill { font-size:12px; color:#7ee2a8; border:1px solid #245c3a; background:#0f2418; border-radius:999px; padding:2px 10px; }
  header .hint { color:var(--muted); font-size:12px; margin-left:auto; }
  .app { flex:1; display:grid; grid-template-columns:240px minmax(0,1fr) 280px; min-height:0; }
  aside { border-right:1px solid var(--line); padding:14px; overflow:auto; }
  aside.right { border-right:0; border-left:1px solid var(--line); }
  .label { font-size:11px; letter-spacing:.08em; color:var(--muted); text-transform:uppercase; margin:4px 0 8px; }
  .room { width:100%; text-align:left; background:transparent; color:var(--text); border:1px solid transparent; border-radius:10px; padding:9px 10px; cursor:pointer; display:flex; flex-direction:column; gap:2px; margin-bottom:6px; }
  .room:hover { background:var(--panel); }
  .room.active { background:var(--panel2); border-color:var(--line); }
  .room strong { font-size:13px; }
  .room span { color:var(--muted); font-size:11px; }
  button.new { width:100%; background:var(--panel); color:var(--text); border:1px dashed var(--line); border-radius:9px; padding:8px; cursor:pointer; font-size:12px; }
  button.new:hover { border-color:var(--accent); }
  main { min-width:0; display:flex; flex-direction:column; }
  .roomhead { padding:14px 20px; border-bottom:1px solid var(--line); }
  .roomhead h2 { margin:0 0 4px; font-size:17px; }
  .roomhead p { margin:0; color:var(--muted); font-size:12px; }
  #messages { flex:1; overflow:auto; padding:18px 20px; display:flex; flex-direction:column; gap:12px; }
  .msg { max-width:78%; display:flex; flex-direction:column; gap:4px; }
  .msg.human { align-self:flex-end; align-items:flex-end; }
  .msg.agent { align-self:flex-start; align-items:flex-start; }
  .meta { font-size:11px; color:var(--muted); }
  .bubble { padding:10px 13px; border-radius:12px; line-height:1.55; font-size:14px; white-space:pre-wrap; word-break:break-word; border:1px solid var(--line); }
  .bubble.collapsed { max-height:120px; overflow:hidden; }
  button.expand { align-self:flex-start; margin-top:4px; background:transparent; color:var(--accent); border:0; font-size:12px; cursor:pointer; padding:0; }
  .msg.human .bubble { background:var(--human); border-color:#4a5f8d; }
  .msg.agent .bubble { background:var(--agent); }
  .composer { border-top:1px solid var(--line); padding:12px 20px; display:flex; gap:10px; align-items:flex-end; }
  textarea { flex:1; resize:none; height:52px; background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-family:inherit; font-size:14px; outline:none; }
  textarea:focus { border-color:var(--accent); }
  button.send { background:var(--accent); color:#fff; border:0; border-radius:10px; padding:12px 20px; cursor:pointer; font-size:14px; font-weight:600; }
  button.send:disabled { opacity:.5; cursor:default; }
  .agent-row { display:flex; gap:9px; align-items:flex-start; padding:8px 0; border-bottom:1px solid var(--line); }
  .dot { width:8px; height:8px; border-radius:50%; margin-top:5px; background:#555; flex:none; }
  .dot.online { background:#48d18a; }
  .dot.idle { background:#e0b64a; }
  .dot.offline { background:#666; }
  .agent-row .name { font-size:13px; }
  .agent-row .skills { color:var(--muted); font-size:11px; margin-top:2px; }
  .member { font-size:12px; color:var(--muted); padding:4px 0; }
  .error { color:#ff8a8a; font-size:12px; padding:8px 20px; }
  @media (max-width: 900px) { .app { grid-template-columns:1fr; } aside { display:none; } }
</style>
</head>
<body>
<header>
  <h1>A2A Exchange · 协作房间</h1>
  <span class="pill">本地服务运行中</span>
  <span class="hint">在 agent 对话里使用 a2a-room skill 加入房间；这里的消息所有成员可见</span>
</header>
<div class="app">
  <aside>
    <div class="label">房间</div>
    <div id="rooms"></div>
    <button class="new" id="newRoom">＋ 新建房间</button>
  </aside>
  <main>
    <div class="roomhead"><h2 id="roomTitle">协作大厅</h2><p id="roomDesc">正在加载…</p></div>
    <div id="messages"></div>
    <div class="error" id="error"></div>
    <div class="composer">
      <textarea id="input" placeholder="输入消息，Enter 发送（Shift+Enter 换行）"></textarea>
      <button class="send" id="send">发送</button>
    </div>
  </main>
  <aside class="right">
    <div class="label">已注册 agent</div>
    <div id="agents"></div>
    <div class="label" style="margin-top:18px">房间成员</div>
    <div id="members"></div>
  </aside>
</div>
<script>
const state = { rooms: [], room: 'lobby', since: 0, es: null };
const $ = (id) => document.getElementById(id);
function showError(message) { $('error').textContent = message || ''; }
async function api(path, options) {
  const response = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, options || {}));
  if (!response.ok) { throw new Error(await response.text()); }
  return response.json();
}
function renderRooms() {
  const box = $('rooms'); box.innerHTML = '';
  for (const room of state.rooms) {
    const button = document.createElement('button');
    button.className = 'room' + (room.id === state.room ? ' active' : '');
    const strong = document.createElement('strong'); strong.textContent = room.name;
    const span = document.createElement('span'); span.textContent = room.messageCount + ' 条消息 · ' + room.participantCount + ' 个 agent';
    button.append(strong, span);
    button.onclick = () => selectRoom(room.id);
    box.appendChild(button);
  }
}
async function refreshRooms() {
  try { const data = await api('/api/rooms'); state.rooms = data.rooms || []; renderRooms(); } catch (error) { showError(error.message); }
}
async function refreshAgents() {
  try {
    const data = await api('/api/agents');
    const box = $('agents'); box.innerHTML = '';
    for (const agent of data.agents || []) {
      const row = document.createElement('div'); row.className = 'agent-row';
      const dot = document.createElement('span'); dot.className = 'dot ' + agent.status;
      const info = document.createElement('div');
      const name = document.createElement('div'); name.className = 'name'; name.textContent = agent.name + ' · ' + agent.agentId;
      const skills = document.createElement('div'); skills.className = 'skills'; skills.textContent = (agent.skills || []).join(', ') || '无技能';
      info.append(name, skills); row.append(dot, info); box.appendChild(row);
    }
  } catch (error) { showError(error.message); }
}
function renderParticipants(list) {
  const box = $('members'); box.innerHTML = '';
  for (const member of list || []) {
    const row = document.createElement('div'); row.className = 'member';
    row.textContent = member.name + ' · ' + member.status;
    box.appendChild(row);
  }
}
function renderMessage(message) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (message.sender.kind === 'human' ? 'human' : 'agent');
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = message.sender.name + ' · ' + new Date(message.time).toLocaleTimeString();
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.text;
  wrap.append(meta, bubble);
  if (message.text.length > 240) {
    bubble.classList.add('collapsed');
    const expand = document.createElement('button'); expand.className = 'expand'; expand.textContent = '展开全文';
    expand.onclick = () => {
      const collapsed = bubble.classList.toggle('collapsed');
      expand.textContent = collapsed ? '展开全文' : '收起';
    };
    wrap.appendChild(expand);
  }
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;
}
function connect() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/rooms/' + encodeURIComponent(state.room) + '/events?since=' + state.since);
  state.es = es;
  es.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    const message = data.message;
    if (!message || message.seq <= state.since) return;
    state.since = message.seq; renderMessage(message); refreshRooms();
  });
  es.addEventListener('participants', (event) => {
    const data = JSON.parse(event.data); renderParticipants(data.participants);
  });
}
async function selectRoom(roomId) {
  state.room = roomId; state.since = 0;
  try { history.replaceState(null, '', '?room=' + encodeURIComponent(roomId)); } catch {}
  $('messages').innerHTML = ''; showError('');
  try {
    const data = await api('/api/rooms/' + encodeURIComponent(roomId));
    $('roomTitle').textContent = data.room.name;
    $('roomDesc').textContent = data.room.description || '本地协作房间';
    for (const message of data.messages || []) renderMessage(message);
    state.since = data.lastSeq || 0;
    renderParticipants(data.participants);
    connect();
  } catch (error) { showError(error.message); }
}
async function sendMessage() {
  const text = $('input').value.trim(); if (!text) return;
  $('send').disabled = true; showError('');
  try {
    await api('/api/rooms/' + encodeURIComponent(state.room) + '/messages', { method: 'POST', body: JSON.stringify({ text }) });
    $('input').value = '';
  } catch (error) { showError(error.message); } finally { $('send').disabled = false; }
}
$('send').onclick = sendMessage;
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});
$('newRoom').onclick = async () => {
  const id = (prompt('房间 id（小写字母/数字/-）') || '').trim();
  if (!id) return;
  const name = (prompt('房间名称', id) || id).trim();
  try { await api('/api/rooms', { method: 'POST', body: JSON.stringify({ roomId: id, name }) }); await refreshRooms(); await selectRoom(id); } catch (error) { showError(error.message); }
};
(async () => {
  await refreshRooms(); await refreshAgents();
  const initialRoom = new URLSearchParams(location.search).get('room') || state.room;
  await selectRoom(initialRoom);
  setInterval(refreshAgents, 5000);
  setInterval(refreshRooms, 10000);
})().catch((error) => showError(error.message));
</script>
</body>
</html>`;
}

