// HTTP server: JSON-RPC 2.0 routing, per-agent A2A mounts, SSE, auth.
import http from 'node:http';
import fs from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentStatus, PROTOCOL_VERSION, rpcErr, rpcOk } from './a2a.mjs';
import { Registry } from './registry.mjs';
import { RoomService } from './rooms.mjs';
import { attachHeartbeat, sseHead, sseWrite, serveAgentEvents, serveTaskStream } from './sse.mjs';
import { CapabilityService } from './capabilities.mjs';
import { DutyService } from './duties.mjs';
import { ExchangeStore } from './store.mjs';
import { SqliteStore } from './sqlite-store.mjs';
import { TaskService } from './tasks.mjs';
import { HttpError, nowIso, pick, RpcError, safeEqual } from './util.mjs';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = joinPath(SRC_DIR, 'web');
const SKILL_ZIP = process.env.A2A_SKILL_ZIP || joinPath(SRC_DIR, '..', 'skill', 'a2a-room-lan', 'a2a-room-skill.zip');
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
  const dataDir = options.dataDir ?? './.data';
  const store = new StoreCtor({ dataDir }).load();
  const registry = new Registry(store, {
    syncWaitMs: options.syncWaitMs ?? 20000,
    hubVersion: options.version ?? '0.1.0',
    heartbeatTtlSeconds: options.heartbeatTtlSeconds ?? 900,
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:8787',
  });
  const tasks = new TaskService(store, registry);
  const rooms = new RoomService(store, registry);
  const duties = new DutyService({ store, dataDir });
  const capabilities = new CapabilityService({ store });
  try {
    for (const agent of store.listAgents()) capabilities.syncFromCard(agent);
  } catch (error) {
    log('error', 'capability backfill failed', { message: error?.message });
  }
  rooms.setMessageHook((message) => dispatchRoomWebhooks(store, message));
  rooms.ensureRoom('lobby', '协作大厅', '本机 agent 的公共协作房间');
  rooms.ensureRoom('platform-feedback', '平台问题反馈', '把平台的问题和建议发到这里，供人和 agent 一起改进');
  const PERMISSION_MODE = process.env.A2A_PERMISSION_MODE ?? 'dryrun'; // off | dryrun | enforce
  const ROLE_SCOPES = {
    observer: ['room:read'],
    member: ['room:read', 'room:write'],
    operator: ['room:read', 'room:write', 'task:claim', 'task:resolve'],
    verifier: ['room:read', 'room:write', 'task:claim', 'task:resolve', 'task:verify'],
    admin: ['room:read', 'room:write', 'task:create', 'task:claim', 'task:resolve', 'task:verify', 'room:admin', 'agent:admin'],
  };

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

  /** 只读动作也刷新 lastSeen：读/盯房间说明进程是活的。 */
  function touchAgent(agentId) {
    try {
      registry.heartbeat({}, agentId);
    } catch {
      // 未注册/已删除的 agent 忽略
    }
  }

  /**
   * 作用域检查（当前默认 dryrun）：算“本应拒绝”的越权，记 activity 但不拦。
   * A2A_PERMISSION_MODE=off 关闭；=enforce 时真返回 403。
   */
  function scopeCheck(roomId, agentId, scope, detail = {}) {
    if (PERMISSION_MODE === 'off' || !agentId || agentId === 'human') return true;
    let role = 'member';
    try {
      const data = rooms.get(roomId, { limit: 1 });
      const participant = (data.participants || []).find((p) => p.agentId === agentId);
      role = participant?.role ?? 'member';
    } catch {
      // 房间不存在等情况：按默认成员判断
    }
    const allowed = (ROLE_SCOPES[role] ?? ROLE_SCOPES.member).includes(scope);
    if (allowed) return true;
    try {
      store.appendRoomActivity?.({
        roomId,
        agentId,
        type: 'perm-dryrun',
        seq: 0,
        detail: scope + ' would be denied (role=' + role + ')' + (detail.taskId ? ' task=' + detail.taskId : ''),
      });
    } catch {
      // 记录失败不影响主流程
    }
    if (PERMISSION_MODE === 'enforce') {
      throw new HttpError(403, 'Forbidden: ' + scope + ' (role=' + role + ')');
    }
    return true;
  }

  /** 带有效 agent token 的请求记为该 agent；否则视为人类操作。 */
  function resolveActor(req, body) {
    const agentId = String(pick(body ?? {}, 'agentId', 'agent_id') ?? '');
    if (agentId && checks.agent(req, agentId)) return agentId;
    return 'human';
  }

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
          try {
            capabilities.syncFromCard(store.getAgent(result.agentId));
          } catch (error) {
            log('error', 'capability sync failed', { message: error?.message });
          }
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
        return serveWebPage(res, 'dashboard.html');
      }
      if ((path === '/onboarding' || path === '/join') && req.method === 'GET') {
        return serveWebPage(res, 'onboarding.html');
      }
      if (path === '/agents' && req.method === 'GET') {
        const accept = String(req.headers.accept ?? '');
        if (accept.includes('text/html')) return serveWebPage(res, 'agents.html');
      }
      if (path === '/download/a2a-room-skill.zip' && req.method === 'GET') {
        let stat = null;
        try { stat = fs.statSync(SKILL_ZIP); } catch { stat = null; }
        if (!stat) return sendJson(res, 404, { error: 'skill zip not found', path: SKILL_ZIP });
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': stat.size,
          'content-disposition': 'attachment; filename="a2a-room-skill.zip"',
        });
        return fs.createReadStream(SKILL_ZIP).pipe(res);
      }
      if (path === '/api/capabilities' && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const agentId = url.searchParams.get('agentId') ?? undefined;
        const name = url.searchParams.get('capability') ?? undefined;
        let rows = capabilities.list(agentId);
        if (name) rows = rows.filter((row) => row.capability === name || row.capability.startsWith(name + '.'));
        return sendJson(res, 200, { capabilities: rows });
      }
      if (path === '/api/capabilities/index' && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const index = {};
        for (const row of capabilities.list()) {
          if (!index[row.capability]) index[row.capability] = [];
          index[row.capability].push(row.agentId);
        }
        return sendJson(res, 200, { index });
      }
      const capMatch = /^\/api\/agents\/([^/]+)\/capabilities$/.exec(path);
      if (capMatch && req.method === 'POST') {
        if (!checks.server(req)) return unauthenticated(res);
        const body = await readJsonBody(req);
        const agentId = decodeURIComponent(capMatch[1]);
        const claimed = String(pick(body, 'agentId', 'agent_id') ?? agentId);
        if (claimed !== agentId || !checks.agent(req, agentId)) return unauthenticated(res);
        return sendJson(res, 201, { capability: capabilities.declare(agentId, body, 'self') });
      }
      if (path === '/api/duties' && req.method === 'GET') {
        if (!humanAllowed(req)) return unauthenticated(res);
        return sendJson(res, 200, { duties: duties.list(Object.fromEntries(new URL(req.url, 'http://x').searchParams)) });
      }
      if (path === '/api/duties' && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const body = await readJsonBody(req);
        return sendJson(res, 201, { duty: duties.create(body, 'human') });
      }
      const dutyActionMatch = /^\/api\/duties\/([^/]+)\/(claim|release)$/.exec(path);
      if (dutyActionMatch && req.method === 'POST') {
        if (!checks.server(req)) return unauthenticated(res);
        const body = await readJsonBody(req);
        const agentId = String(pick(body, 'agentId', 'agent_id') ?? '');
        if (!agentId || !checks.agent(req, agentId)) return unauthenticated(res);
        const dutyId = decodeURIComponent(dutyActionMatch[1]);
        const action = dutyActionMatch[2];
        return sendJson(res, 200, { duty: action === 'claim' ? duties.claim(dutyId, agentId) : duties.release(dutyId, agentId) });
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
        if (checks.agent(req, agentId)) touchAgent(agentId);
        return sendJson(res, 200, rooms.pending(roomId, agentId));
      }
      const roomAckMatch = /^\/api\/rooms\/([^/]+)\/ack$/.exec(path);
      if (roomAckMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const roomId = decodeURIComponent(roomAckMatch[1]);
        const body = await readJsonBody(req);
        const agentId = String(pick(body, 'agentId', 'agent_id') ?? '');
        if (!agentId) throw new HttpError(400, 'agentId is required');
        if (checks.agent(req, agentId)) touchAgent(agentId);
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
        const actor = resolveActor(req, body);
        scopeCheck(decodeURIComponent(roomTasksMatch[1]), actor, 'task:create');
        return sendJson(res, 201, { task: rooms.createTask(decodeURIComponent(roomTasksMatch[1]), body, actor) });
      }
      const roomTaskActionMatch = /^\/api\/rooms\/([^/]+)\/tasks\/([^/]+)\/([^/]+)$/.exec(path);
      if (roomTaskActionMatch && req.method === 'POST') {
        if (!humanAllowed(req)) return unauthenticated(res);
        const body = await readJsonBody(req);
        const actActor = resolveActor(req, body);
        const actRoom = decodeURIComponent(roomTaskActionMatch[1]);
        const actName = decodeURIComponent(roomTaskActionMatch[3]);
        const actScope = actName === 'claim' ? 'task:claim' : (actName === 'verify' ? 'task:verify' : 'task:resolve');
        scopeCheck(actRoom, actActor, actScope, { taskId: decodeURIComponent(roomTaskActionMatch[2]) });
        return sendJson(res, 200, {
          task: rooms.taskAction(
            decodeURIComponent(roomTaskActionMatch[1]),
            decodeURIComponent(roomTaskActionMatch[2]),
            decodeURIComponent(roomTaskActionMatch[3]),
            body,
            actActor,
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
        const readerId = String(url.searchParams.get('agentId') ?? '');
        if (readerId && checks.agent(req, readerId)) touchAgent(readerId);
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
        scopeCheck(roomId, agentId, 'room:write');
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

function serveWebPage(res, name) {
  let html;
  try {
    html = fs.readFileSync(joinPath(WEB_DIR, name), 'utf8');
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(name + ' missing: ' + error.message);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}


