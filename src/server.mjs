// HTTP server: JSON-RPC 2.0 routing, per-agent A2A mounts, SSE, auth.
import http from 'node:http';
import { agentStatus, PROTOCOL_VERSION, rpcErr, rpcOk } from './a2a.mjs';
import { Registry } from './registry.mjs';
import { RoomService } from './rooms.mjs';
import { attachHeartbeat, sseHead, sseWrite, serveAgentEvents, serveTaskStream } from './sse.mjs';
import { ExchangeStore } from './store.mjs';
import { SqliteStore } from './sqlite-store.mjs';
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

async function dispatchRoomWebhooks(store, message) {
  const text = String(message?.text ?? '');
  if (!text) return;
  const lower = text.toLowerCase();
  const agents = store.listAgents().filter((agent) => agent?.wakeUrl);
  if (agents.length === 0) return;
  for (const agent of agents) {
    if (message.sender?.agentId === agent.agentId) continue;
    const name = agent.card?.name ?? '';
    if (!lower.includes('@all') && !lower.includes('@' + agent.agentId.toLowerCase()) && !(name && text.includes('@' + name))) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      await fetch(agent.wakeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'room.message',
          roomId: message.roomId,
          seq: message.seq,
          from: message.sender?.name ?? 'unknown',
          kind: message.sender?.kind ?? 'agent',
          text: text.slice(0, 4000),
          time: message.time,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    } catch {
      // Endpoint is best-effort; polling/cron remains the fallback.
    }
  }
}

export function createExchangeServer(options = {}) {
  const StoreCtor = options.store === 'json' ? ExchangeStore : SqliteStore;
  const store = new StoreCtor({ dataDir: options.dataDir ?? './.data' }).load();
  const registry = new Registry(store, {
    syncWaitMs: options.syncWaitMs ?? 20000,
    hubVersion: options.version ?? '0.1.0',
    heartbeatTtlSeconds: options.heartbeatTtlSeconds ?? 900,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:8787',
  });
  const tasks = new TaskService(store, registry);
  const rooms = new RoomService(store, registry);
  rooms.setMessageHook((message) => dispatchRoomWebhooks(store, message));
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
      const wakeUrlMatch = /^\/api\/agents\/([^/]+)\/wake-url$/.exec(path);
      if (wakeUrlMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const body = await readJsonBody(req);
        const agentId = decodeURIComponent(wakeUrlMatch[1]);
        return sendJson(res, 200, registry.setWakeUrl(agentId, pick(body, 'url', 'wakeUrl')));
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
          } else if (event.type === 'tasks') {
            sseWrite(res, { event: 'tasks', data: event });
          } else if (event.type === 'pinned') {
            sseWrite(res, { event: 'pinned', data: event });
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
      const roomPendingMatch = /^\/api\/rooms\/([^/]+)\/pending$/.exec(path);
      if (roomPendingMatch && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomPendingMatch[1]);
        const agentId = String(url.searchParams.get('agentId') ?? url.searchParams.get('agent') ?? '');
        if (!agentId) throw new HttpError(400, 'agentId is required');
        return sendJson(res, 200, rooms.pending(roomId, agentId));
      }
      const roomAckMatch = /^\/api\/rooms\/([^/]+)\/ack$/.exec(path);
      if (roomAckMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomAckMatch[1]);
        const body = await readJsonBody(req);
        const agentId = String(pick(body, 'agentId', 'agent_id') ?? '');
        if (!agentId) throw new HttpError(400, 'agentId is required');
        return sendJson(res, 200, rooms.ack(roomId, agentId, pick(body, 'seq', 'lastSeq', 'last_seq')));
      }
      const roomTasksMatch = /^\/api\/rooms\/([^/]+)\/tasks$/.exec(path);
      if (roomTasksMatch && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        return sendJson(res, 200, { tasks: rooms.listTasks(decodeURIComponent(roomTasksMatch[1])) });
      }
      if (roomTasksMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const body = await readJsonBody(req);
        return sendJson(res, 201, { task: rooms.createTask(decodeURIComponent(roomTasksMatch[1]), body, 'human') });
      }
      const roomTaskActionMatch = /^\/api\/rooms\/([^/]+)\/tasks\/([^/]+)\/([^/]+)$/.exec(path);
      if (roomTaskActionMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const body = await readJsonBody(req);
        return sendJson(res, 200, {
          task: rooms.taskAction(
            decodeURIComponent(roomTaskActionMatch[1]),
            decodeURIComponent(roomTaskActionMatch[2]),
            decodeURIComponent(roomTaskActionMatch[3]),
            body,
            'human',
          ),
        });
      }
      const roomActivityMatch = /^\/api\/rooms\/([^/]+)\/activity$/.exec(path);
      if (roomActivityMatch && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return sendJson(res, 200, { activity: rooms.activity(decodeURIComponent(roomActivityMatch[1]), limit) });
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
      const roomPinMatch = /^\/api\/rooms\/([^/]+)\/messages\/([0-9]+)\/pin$/.exec(path);
      if (roomPinMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomPinMatch[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, rooms.pin(roomId, Number(roomPinMatch[2]), body.pinned !== false));
      }
      const roomJoinMatch = /^\/api\/rooms\/([^/]+)\/join$/.exec(path);
      if (roomJoinMatch && req.method === 'POST') {
        if (!checks.server(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomJoinMatch[1]);
        const body = await readJsonBody(req);
        const agentId = String(pick(body, 'agentId', 'agent_id') ?? '');
        if (!agentId || !checks.agent(req, agentId)) return unauthenticated(res);
        return sendJson(res, 200, rooms.join(roomId, agentId, body));
      }
      const roomInviteMatch = /^\/api\/rooms\/([^/]+)\/invite$/.exec(path);
      if (roomInviteMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomInviteMatch[1]);
        const body = await readJsonBody(req);
        const agentId = String(pick(body, 'agentId', 'agent_id') ?? '');
        return sendJson(res, 200, rooms.join(roomId, agentId, { role: body.role }));
      }
      const roomKickMatch = /^\/api\/rooms\/([^/]+)\/kick$/.exec(path);
      if (roomKickMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomKickMatch[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, rooms.leave(roomId, String(pick(body, 'agentId', 'agent_id') ?? '')));
      }
      const roomRoleMatch = /^\/api\/rooms\/([^/]+)\/role$/.exec(path);
      if (roomRoleMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomRoleMatch[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, rooms.setRole(roomId, String(pick(body, 'agentId', 'agent_id') ?? ''), String(pick(body, 'role') ?? 'member')));
      }
      if (roomGetMatch && req.method === 'PATCH') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomGetMatch[1]);
        const body = await readJsonBody(req);
        return sendJson(res, 200, rooms.update(roomId, body));
      }
      if (roomGetMatch && req.method === 'DELETE') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomGetMatch[1]);
        if (roomId === 'lobby') throw new HttpError(400, 'Cannot delete the lobby room');
        return sendJson(res, 200, rooms.destroy(roomId));
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
        server.close(() => {
          try { store.close?.(); } catch {}
          resolve();
        });
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
  html, body { height:100%; }
  body { margin:0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; overflow:hidden; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; flex:none; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .pill { font-size:12px; color:#7ee2a8; border:1px solid #245c3a; background:#0f2418; border-radius:999px; padding:2px 10px; }
  header .hint { color:var(--muted); font-size:12px; margin-left:auto; }
  .app { flex:1; display:grid; grid-template-columns:240px minmax(0,1fr) 280px; min-height:0; overflow:hidden; }
  aside { border-right:1px solid var(--line); padding:14px; overflow:auto; min-height:0; }
  aside.right { border-right:0; border-left:1px solid var(--line); }
  .label { font-size:11px; letter-spacing:.08em; color:var(--muted); text-transform:uppercase; margin:4px 0 8px; }
  .room { width:100%; text-align:left; background:transparent; color:var(--text); border:1px solid transparent; border-radius:10px; padding:8px 6px 8px 10px; cursor:pointer; display:flex; align-items:center; gap:6px; margin-bottom:6px; }
  .room:hover { background:var(--panel); }
  .room.active { background:var(--panel2); border-color:var(--line); }
  .room-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
  .room strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .room span { color:var(--muted); font-size:11px; }
  .room-gear { flex:none; background:transparent; color:var(--muted); border:0; font-size:14px; cursor:pointer; padding:6px; border-radius:7px; opacity:0; transition:opacity .12s, background .12s; }
  .room:hover .room-gear, .room.active .room-gear { opacity:1; }
  .room-gear:hover { background:var(--panel); color:var(--text); }
  button.new { width:100%; background:var(--panel); color:var(--text); border:1px dashed var(--line); border-radius:9px; padding:8px; cursor:pointer; font-size:12px; }
  button.new:hover { border-color:var(--accent); }
  button.manage { width:100%; margin-top:6px; background:transparent; color:var(--text); border:1px solid var(--line); border-radius:9px; padding:8px; cursor:pointer; font-size:12px; }
  button.manage:hover { border-color:var(--accent); }
  .modal { position:fixed; inset:0; background:rgba(0,0,0,.62); display:flex; align-items:center; justify-content:center; z-index:50; }
  .modal.hidden { display:none; }
  .modal-card { width:560px; max-width:94vw; max-height:86vh; overflow:auto; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:18px; }
  .modal-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
  .modal-head h3 { margin:0; font-size:16px; }
  .modal-card label { display:block; font-size:12px; color:var(--muted); margin:8px 0 4px; }
  .modal-card input, .modal-card select { width:100%; background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-family:inherit; font-size:13px; }
  .modal-card button { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 12px; cursor:pointer; font-size:13px; }
  .modal-card button:hover { border-color:var(--accent); }
  .modal-card button.danger { border-color:#7a3434; color:#ff9b9b; }
  .m-row { display:flex; gap:8px; align-items:center; padding:6px 0; border-bottom:1px solid var(--line); }
  .m-row .m-name { flex:1; font-size:13px; }
  .m-row select { width:100px; }
  .invite-row { display:flex; gap:8px; align-items:center; }
  .invite-row select { flex:1; }
  main { min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
  .roomhead { padding:14px 20px; border-bottom:1px solid var(--line); }
  .roomhead h2 { margin:0 0 4px; font-size:17px; }
  .roomhead p { margin:0; color:var(--muted); font-size:12px; }
  #messages { flex:1; min-height:0; overflow:auto; padding:18px 20px; display:flex; flex-direction:column; gap:12px; scrollbar-width:thin; scrollbar-color:transparent transparent; }
  .pinned-bar { margin:8px 20px 0; border:1px solid #35435f; background:#152238; border-radius:9px; padding:7px 10px; display:flex; flex-direction:column; gap:4px; max-height:110px; overflow:auto; }
  .pinned-bar.hidden { display:none; }
  .pinned-item { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); cursor:pointer; }
  .pinned-item .pin-text { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pinned-item .pin-unpin { background:transparent; border:0; color:var(--muted); cursor:pointer; font-size:11px; }
  .msg.pinned .bubble { border-color:#4a638f; box-shadow:0 0 0 1px #2d4266 inset; }
  .pin-btn { background:transparent; border:0; color:var(--muted); cursor:pointer; font-size:11px; padding:0 2px; visibility:hidden; }
  .msg:hover .pin-btn { visibility:visible; }
  #messages::-webkit-scrollbar { width:8px; }
  #messages::-webkit-scrollbar-track { background:transparent; }
  #messages::-webkit-scrollbar-thumb { background:transparent; border-radius:8px; }
  #messages.scrolling { scrollbar-color:#3a4150 transparent; }
  #messages.scrolling::-webkit-scrollbar-thumb { background:#3a4150; }
  #messages.scrolling::-webkit-scrollbar-thumb:hover { background:#4a5263; }
  .msg { max-width:78%; display:flex; flex-direction:column; gap:4px; }
  .msg.human { align-self:flex-end; align-items:flex-end; }
  .msg.agent { align-self:flex-start; align-items:flex-start; }
  .meta { font-size:11px; color:var(--muted); }
  .bubble { padding:10px 13px; border-radius:12px; line-height:1.55; font-size:14px; white-space:pre-wrap; word-break:break-word; border:1px solid var(--line); }
  .bubble.collapsed { max-height:120px; overflow:hidden; }
  button.expand { align-self:flex-start; margin-top:4px; background:transparent; color:var(--accent); border:0; font-size:12px; cursor:pointer; padding:0; }
  .msg.human .bubble { background:var(--human); border-color:#4a5f8d; }
  .msg.agent .bubble { background:var(--agent); }
  .bubble.task-bubble { background:#1b2432; border-color:#35435f; }
  .task-head { display:flex; align-items:center; gap:8px; font-weight:600; font-size:14px; }
  .task-tag { font-size:10px; font-weight:500; color:#9fc0ff; border:1px solid #3b527a; background:#152238; border-radius:999px; padding:1px 7px; }
  .task-kv { font-size:12px; color:var(--muted); margin-top:6px; white-space:pre-wrap; }
  .task-kv b { color:var(--text); font-weight:500; }
  .tabs { display:flex; gap:6px; margin-bottom:10px; border-bottom:1px solid var(--line); }
  .tab { flex:1; background:transparent; color:var(--muted); border:0; padding:7px 0; font-size:12px; cursor:pointer; border-bottom:2px solid transparent; }
  .tab.active { color:var(--text); border-bottom-color:var(--accent); }
  .hidden { display:none !important; }
  .task-toolbar { display:flex; align-items:center; justify-content:space-between; margin:4px 0 8px; }
  .task-toolbar .label { margin:0; }
  .task-toolbar button.small, #taskCreate { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:7px; padding:4px 8px; font-size:11px; cursor:pointer; }
  #taskCreate.primary { background:var(--accent); border-color:var(--accent); color:#fff; width:100%; margin-top:6px; }
  .task-form { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:8px; margin-bottom:10px; display:flex; flex-direction:column; gap:6px; }
  .task-form input, .task-form textarea { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:7px; padding:7px 8px; font-family:inherit; font-size:12px; width:100%; }
  .task-form textarea { height:56px; resize:vertical; }
  .board-task { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; margin-bottom:8px; }
  .board-task .bt-title { font-size:13px; font-weight:600; line-height:1.35; }
  .board-task .bt-meta { font-size:11px; color:var(--muted); margin-top:4px; }
  .board-task .bt-accept { font-size:11px; color:#9fc0ff; margin-top:4px; }
  .board-task .bt-actions { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
  .board-task .bt-actions button { background:var(--panel2); color:var(--text); border:1px solid var(--line); border-radius:6px; padding:3px 8px; font-size:11px; cursor:pointer; }
  .board-task .bt-actions button:hover { border-color:var(--accent); }
  .badge { display:inline-block; font-size:10px; border-radius:999px; padding:1px 7px; border:1px solid var(--line); color:var(--muted); margin-left:6px; }
  .badge.open { color:#e0b64a; border-color:#5a4a20; background:#241f10; }
  .badge.in_progress { color:#7fb2ff; border-color:#2d4266; background:#121c2c; }
  .badge.resolved { color:#c79bff; border-color:#453260; background:#1d1529; }
  .badge.verified { color:#7ee2a8; border-color:#245c3a; background:#0f2418; }
  .msg-type { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:0 8px; height:52px; font-size:12px; }
  .type-badge { display:inline-block; font-size:10px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:0 6px; margin-left:6px; }
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
    <div id="pinnedBar" class="pinned-bar hidden"></div>
    <div id="messages"></div>
    <div class="error" id="error"></div>
    <div class="composer">
      <select id="msgType" class="msg-type" title="消息类型">
        <option value="chat">对话</option>
        <option value="progress">进展</option>
        <option value="verify">验证</option>
      </select>
      <textarea id="input" placeholder="输入消息，Enter 发送（Shift+Enter 换行）"></textarea>
      <button class="send" id="send">发送</button>
    </div>
  </main>
  <aside class="right">
    <div class="tabs">
      <button id="tabTasks" class="tab active">任务</button>
      <button id="tabMembers" class="tab">成员</button>
    </div>
    <div id="tasksPanel">
      <div class="task-toolbar"><span id="taskCounts" class="label">任务板</span><button id="newTask" class="small">＋ 新任务</button></div>
      <div class="task-form hidden" id="taskForm">
        <input id="taskTitle" placeholder="任务标题" />
        <textarea id="taskDetail" placeholder="详情（可选）"></textarea>
        <input id="taskAcceptance" placeholder="验收标准（可选）" />
        <input id="taskAssignee" placeholder="负责人 agentId（可选）" />
        <input id="taskVerifier" placeholder="验收 agentId（可选）" />
        <input id="taskBranch" placeholder="分支（可选，如 feat/g2-nim）" />
        <input id="taskCommit" placeholder="commit（可选）" />
        <input id="taskSummary" placeholder="上下文摘要（可选，减少重复读历史）" />
        <button id="taskCreate" class="small primary">创建任务</button>
      </div>
      <div id="tasks"></div>
    </div>
    <div id="membersPanel" class="hidden">
      <div class="label">已注册 agent</div>
      <div id="agents"></div>
      <div class="label" style="margin-top:18px">房间成员</div>
      <div id="members"></div>
    </div>
  </aside>
</div>
<div class="modal hidden" id="manageModal">
  <div class="modal-card">
    <div class="modal-head"><h3 id="mTitle">管理房间</h3><button id="mClose">×</button></div>
    <label>房间名</label>
    <input id="mName" />
    <label>描述</label>
    <input id="mDesc" />
    <div style="margin-top:10px"><button id="mSave">保存房间信息</button></div>
    <div class="label" style="margin-top:16px">邀请 agent 进房间</div>
    <div class="invite-row"><select id="mAgentSelect"></select><button id="mInvite">拉入</button></div>
    <div class="label" style="margin-top:16px">成员与角色</div>
    <div id="mMembers"></div>
    <div style="margin-top:18px"><button class="danger" id="mDelete">删除房间</button></div>
  </div>
</div>
<script>
const state = { rooms: [], room: 'lobby', since: 0, es: null, roomData: null, agents: [], tasks: [], messages: [] };
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
    const row = document.createElement('div');
    row.className = 'room' + (room.id === state.room ? ' active' : '');
    row.onclick = () => selectRoom(room.id);
    const info = document.createElement('div'); info.className = 'room-info';
    const strong = document.createElement('strong'); strong.textContent = room.name;
    const span = document.createElement('span'); span.textContent = room.messageCount + ' 条消息 · ' + room.participantCount + ' 个 agent';
    info.append(strong, span);
    const gear = document.createElement('button'); gear.className = 'room-gear'; gear.textContent = '⚙'; gear.title = '管理房间';
    gear.onclick = (event) => {
      event.stopPropagation();
      selectRoom(room.id).then(() => openManage()).catch((error) => showError(error.message));
    };
    row.append(info, gear);
    box.appendChild(row);
  }
}
async function refreshRooms() {
  try { const data = await api('/api/rooms'); state.rooms = data.rooms || []; renderRooms(); } catch (error) { showError(error.message); }
}
async function refreshAgents() {
  try {
    const data = await api('/api/agents');
    state.agents = data.agents || [];
    const box = $('agents'); box.innerHTML = '';
    for (const agent of state.agents) {
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
function taskStatusLabel(status) {
  return { open: '待处理', in_progress: '处理中', resolved: '待验证', verified: '已验证', closed: '已关闭' }[status] || status;
}

async function taskAction(taskId, action, extra) {
  try {
    await api('/api/rooms/' + encodeURIComponent(state.room) + '/tasks/' + encodeURIComponent(taskId) + '/' + action, { method: 'POST', body: JSON.stringify(extra || {}) });
    await selectRoom(state.room);
  } catch (error) { showError(error.message); }
}

function renderTasks() {
  const box = $('tasks'); box.innerHTML = '';
  const tasks = state.tasks || [];
  const count = (status) => tasks.filter((t) => t.status === status).length;
  $('taskCounts').textContent = '任务 ' + tasks.length + ' · 待处理 ' + count('open') + ' · 处理中 ' + count('in_progress') + ' · 待验证 ' + count('resolved') + ' · 已验证 ' + count('verified');
  for (const status of ['open', 'in_progress', 'resolved', 'verified', 'closed']) {
    const list = tasks.filter((t) => t.status === status);
    if (list.length === 0) continue;
    const head = document.createElement('div'); head.className = 'label'; head.style.marginTop = '10px';
    head.textContent = taskStatusLabel(status) + ' · ' + list.length;
    box.appendChild(head);
    for (const task of list) {
      const card = document.createElement('div'); card.className = 'board-task';
      const title = document.createElement('div'); title.className = 'bt-title';
      title.textContent = task.title;
      const badge = document.createElement('span'); badge.className = 'badge ' + task.status; badge.textContent = taskStatusLabel(task.status);
      title.appendChild(badge); card.appendChild(title);
      const meta = document.createElement('div'); meta.className = 'bt-meta';
      meta.textContent = (task.assignee ? '负责人 ' + task.assignee : '未分配') + (task.verifier ? ' · 验收 ' + task.verifier : '') + (task.branch ? ' · ' + task.branch : '') + (task.commit ? ' @' + task.commit : '') + (task.createdBy ? ' · 由 ' + task.createdBy + ' 创建' : '');
      card.appendChild(meta);
      if (task.summary) { const s = document.createElement('div'); s.className = 'bt-meta'; s.textContent = '摘要：' + task.summary; card.appendChild(s); }
      if (task.acceptance) { const a = document.createElement('div'); a.className = 'bt-accept'; a.textContent = '验收：' + task.acceptance; card.appendChild(a); }
      if (task.detail) { const d = document.createElement('div'); d.className = 'bt-meta'; d.textContent = task.detail; card.appendChild(d); }
      const actions = document.createElement('div'); actions.className = 'bt-actions';
      if (task.status === 'open') {
        const b = document.createElement('button'); b.textContent = '开始处理'; b.onclick = () => taskAction(task.taskId, 'claim'); actions.appendChild(b);
      } else if (task.status === 'in_progress') {
        const b = document.createElement('button'); b.textContent = '提交解决'; b.onclick = () => taskAction(task.taskId, 'resolve'); actions.appendChild(b);
      } else if (task.status === 'resolved') {
        const ok = document.createElement('button'); ok.textContent = '验证通过'; ok.onclick = () => taskAction(task.taskId, 'verify', { pass: true }); actions.appendChild(ok);
        const no = document.createElement('button'); no.textContent = '验证不通过'; no.onclick = () => taskAction(task.taskId, 'verify', { pass: false, note: '验收未通过' }); actions.appendChild(no);
      } else if (task.status === 'verified' && task.verifiedBy) {
        const v = document.createElement('span'); v.className = 'bt-meta'; v.textContent = '验证人 ' + task.verifiedBy; actions.appendChild(v);
      }
      if (actions.childNodes.length) card.appendChild(actions);
      box.appendChild(card);
    }
  }
  if (tasks.length === 0) { const empty = document.createElement('div'); empty.className = 'bt-meta'; empty.textContent = '当前房间还没有任务，点「＋ 新任务」创建。'; box.appendChild(empty); }
}

function renderMessage(message) {
  if (message.type === 'task') return;
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (message.sender.kind === 'human' ? 'human' : 'agent') + (message.pinned ? ' pinned' : '');
  wrap.dataset.seq = message.seq;
  const meta = document.createElement('div'); meta.className = 'meta';
  meta.textContent = message.sender.name + ' · ' + new Date(message.time).toLocaleTimeString();
  if (message.type) {
    const typeLabels = { progress: '进展', verify: '验证' };
    const badge = document.createElement('span'); badge.className = 'type-badge';
    badge.textContent = typeLabels[message.type] || message.type;
    meta.appendChild(badge);
  }
  const pinBtn = document.createElement('button');
  pinBtn.className = 'pin-btn';
  pinBtn.textContent = message.pinned ? '📌' : '📍';
  pinBtn.title = message.pinned ? '取消置顶' : '置顶消息';
  pinBtn.onclick = (event) => { event.stopPropagation(); togglePin(message.seq, !message.pinned); };
  meta.appendChild(pinBtn);
  const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.text;
  wrap.append(meta, bubble);
  if (message.text.length > 500) {
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

async function togglePin(seq, pinned) {
  try {
    await api('/api/rooms/' + encodeURIComponent(state.room) + '/messages/' + encodeURIComponent(seq) + '/pin', {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    });
    await selectRoom(state.room);
  } catch (error) { showError(error.message); }
}

function renderPinned() {
  const bar = $('pinnedBar');
  const pinned = (state.messages || []).filter((m) => m.pinned && m.type !== 'task');
  bar.innerHTML = '';
  bar.classList.toggle('hidden', pinned.length === 0);
  for (const message of pinned.slice(0, 5)) {
    const item = document.createElement('div'); item.className = 'pinned-item';
    const text = document.createElement('span'); text.className = 'pin-text';
    text.textContent = '📌 ' + message.sender.name + '：' + message.text.replace(/\s+/g, ' ');
    text.onclick = () => {
      const target = document.querySelector('#messages .msg[data-seq="' + message.seq + '"]');
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    const unpin = document.createElement('button'); unpin.className = 'pin-unpin'; unpin.textContent = '取消';
    unpin.onclick = () => togglePin(message.seq, false);
    item.append(text, unpin); bar.appendChild(item);
  }
}
function connect() {
  if (state.es) state.es.close();
  const es = new EventSource('/api/rooms/' + encodeURIComponent(state.room) + '/events?since=' + state.since);
  state.es = es;
  es.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    const message = data.message;
    if (!message || message.seq <= state.since) return;
    state.since = message.seq; state.messages.push(message); renderMessage(message); renderPinned(); refreshRooms();
  });
  es.addEventListener('participants', (event) => {
    const data = JSON.parse(event.data); renderParticipants(data.participants);
  });
  es.addEventListener('tasks', (event) => {
    const data = JSON.parse(event.data);
    if (data.roomId !== state.room) return;
    state.tasks = data.tasks || [];
    renderTasks();
  });
  es.addEventListener('pinned', () => {
    selectRoom(state.room);
  });
}
async function selectRoom(roomId) {
  state.room = roomId; state.since = 0;
  try { history.replaceState(null, '', '?room=' + encodeURIComponent(roomId)); } catch {}
  $('messages').innerHTML = ''; showError('');
  try {
    const data = await api('/api/rooms/' + encodeURIComponent(roomId));
    state.roomData = data;
    state.messages = data.messages || [];
    $('roomTitle').textContent = data.room.name;
    $('roomDesc').textContent = data.room.description || '本地协作房间';
    for (const message of state.messages) renderMessage(message);
    state.since = data.lastSeq || 0;
    state.tasks = data.tasks || [];
    renderParticipants(data.participants);
    renderTasks();
    renderPinned();
    connect();
  } catch (error) { showError(error.message); }
}
async function sendMessage() {
  const text = $('input').value.trim(); if (!text) return;
  $('send').disabled = true; showError('');
  try {
    await api('/api/rooms/' + encodeURIComponent(state.room) + '/messages', { method: 'POST', body: JSON.stringify({ text, type: $('msgType').value }) });
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

function renderManageMembers(participants) {
  const box = $('mMembers'); box.innerHTML = '';
  for (const p of participants || []) {
    const row = document.createElement('div'); row.className = 'm-row';
    const name = document.createElement('div'); name.className = 'm-name'; name.textContent = p.name + ' · ' + p.agentId;
    const role = document.createElement('select');
    for (const r of ['admin', 'member']) {
      const opt = document.createElement('option'); opt.value = r; opt.textContent = r === 'admin' ? '管理员' : '成员'; role.appendChild(opt);
    }
    role.value = p.role || 'member';
    role.onchange = async () => {
      try { await api('/api/rooms/' + encodeURIComponent(state.room) + '/role', { method: 'POST', body: JSON.stringify({ agentId: p.agentId, role: role.value }) }); await selectRoom(state.room); openManage(); }
      catch (error) { showError(error.message); }
    };
    const kick = document.createElement('button'); kick.className = 'danger'; kick.textContent = '移除';
    kick.onclick = async () => {
      if (!confirm('从房间移除 ' + p.name + '？')) return;
      try { await api('/api/rooms/' + encodeURIComponent(state.room) + '/kick', { method: 'POST', body: JSON.stringify({ agentId: p.agentId }) }); await selectRoom(state.room); openManage(); }
      catch (error) { showError(error.message); }
    };
    row.append(name, role, kick); box.appendChild(row);
  }
}

function openManage() {
  const data = state.roomData; if (!data) return;
  $('mTitle').textContent = '管理房间 · ' + data.room.name;
  $('mName').value = data.room.name;
  $('mDesc').value = data.room.description || '';
  const select = $('mAgentSelect'); select.innerHTML = '';
  const members = new Set((data.participants || []).map((p) => p.agentId));
  const available = (state.agents || []).filter((a) => !members.has(a.agentId));
  if (available.length === 0) {
    const opt = document.createElement('option'); opt.textContent = '（没有可邀请的已注册 agent）'; opt.disabled = true; select.appendChild(opt);
  }
  for (const agent of available) {
    const opt = document.createElement('option'); opt.value = agent.agentId; opt.textContent = agent.name + ' · ' + agent.agentId; select.appendChild(opt);
  }
  renderManageMembers(data.participants);
  $('mDelete').style.display = data.room.id === 'lobby' ? 'none' : 'inline-block';
  $('manageModal').classList.remove('hidden');
}

$('mClose').onclick = () => $('manageModal').classList.add('hidden');
$('mSave').onclick = async () => {
  try {
    await api('/api/rooms/' + encodeURIComponent(state.room), { method: 'PATCH', body: JSON.stringify({ name: $('mName').value, description: $('mDesc').value }) });
    await refreshRooms(); await selectRoom(state.room); openManage();
  } catch (error) { showError(error.message); }
};
$('mInvite').onclick = async () => {
  const agentId = $('mAgentSelect').value;
  if (!agentId) return;
  try {
    await api('/api/rooms/' + encodeURIComponent(state.room) + '/invite', { method: 'POST', body: JSON.stringify({ agentId }) });
    await refreshRooms(); await selectRoom(state.room); openManage();
  } catch (error) { showError(error.message); }
};
$('mDelete').onclick = async () => {
  if (!confirm('删除房间 ' + state.room + '？消息会一起删除。')) return;
  try {
    await api('/api/rooms/' + encodeURIComponent(state.room), { method: 'DELETE' });
    $('manageModal').classList.add('hidden');
    await refreshRooms(); await selectRoom('lobby');
  } catch (error) { showError(error.message); }
};

$('tabTasks').onclick = () => { $('tabTasks').classList.add('active'); $('tabMembers').classList.remove('active'); $('tasksPanel').classList.remove('hidden'); $('membersPanel').classList.add('hidden'); };
$('tabMembers').onclick = () => { $('tabMembers').classList.add('active'); $('tabTasks').classList.remove('active'); $('membersPanel').classList.remove('hidden'); $('tasksPanel').classList.add('hidden'); };
$('newTask').onclick = () => $('taskForm').classList.toggle('hidden');
$('taskCreate').onclick = async () => {
  const title = $('taskTitle').value.trim();
  if (!title) { showError('任务标题不能为空'); return; }
  try {
    await api('/api/rooms/' + encodeURIComponent(state.room) + '/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title,
        detail: $('taskDetail').value,
        acceptance: $('taskAcceptance').value,
        assignee: $('taskAssignee').value.trim() || undefined,
        verifier: $('taskVerifier').value.trim() || undefined,
        branch: $('taskBranch').value.trim() || undefined,
        commit: $('taskCommit').value.trim() || undefined,
        summary: $('taskSummary').value.trim() || undefined,
      }),
    });
    $('taskTitle').value = ''; $('taskDetail').value = ''; $('taskAcceptance').value = ''; $('taskAssignee').value = ''; $('taskVerifier').value = ''; $('taskBranch').value = ''; $('taskCommit').value = ''; $('taskSummary').value = '';
    $('taskForm').classList.add('hidden');
    await selectRoom(state.room);
  } catch (error) { showError(error.message); }
};

let messagesScrollTimer = null;
$('messages').addEventListener('scroll', () => {
  const box = $('messages');
  box.classList.add('scrolling');
  if (messagesScrollTimer) clearTimeout(messagesScrollTimer);
  messagesScrollTimer = setTimeout(() => box.classList.remove('scrolling'), 900);
});

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

