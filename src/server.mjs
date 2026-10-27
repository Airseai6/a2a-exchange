// HTTP server: JSON-RPC 2.0 routing, per-agent A2A mounts, SSE, auth.
import http from 'node:http';
import { agentStatus, PROTOCOL_VERSION, rpcErr, rpcOk, TASK_STATES } from './a2a.mjs';
import { Registry } from './registry.mjs';
import { serveAgentEvents, serveTaskStream } from './sse.mjs';
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
