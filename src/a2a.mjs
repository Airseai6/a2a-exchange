// A2A v1.0 model helpers: enums, JSON-RPC errors, validation, cards, tasks, messages.
import { compact, isPlainObject, nowIso, pick, RpcError, uuid } from './util.mjs';

export const PROTOCOL_VERSION = '1.0';
export const EXT_SESSION_DELIVERY = 'urn:a2a-exchange:ext:session-delivery:v1';
export const EXT_WAKE = 'urn:a2a-exchange:ext:wake:v1';

export const TASK_STATES = Object.freeze([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
]);
export const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
export const INTERRUPTED_STATES = new Set(['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);

export const ROLES = new Set(['ROLE_USER', 'ROLE_AGENT']);

export function normalizeState(value) {
  if (typeof value === 'number') return TASK_STATES[value - 1] ?? 'TASK_STATE_SUBMITTED';
  if (typeof value !== 'string') return value;
  const v = value.trim();
  if (TASK_STATES.includes(v)) return v;
  const upper = v.replace(/[-.\s]+/g, '_').toUpperCase();
  if (TASK_STATES.includes(`TASK_STATE_${upper}`)) return `TASK_STATE_${upper}`;
  return v;
}

export function normalizeRole(value) {
  if (typeof value !== 'string') return value;
  const upper = value.trim().toUpperCase();
  if (ROLES.has(upper)) return upper;
  if (upper === 'USER') return 'ROLE_USER';
  if (upper === 'AGENT' || upper === 'ASSISTANT') return 'ROLE_AGENT';
  return value;
}

export function rpcOk(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result: compact(result) };
}

export function rpcErr(id, code, message, data = undefined) {
  return { jsonrpc: '2.0', id: id ?? null, error: compact({ code, message, data }) };
}

export function a2aError(id, code, message, a2aCode) {
  return rpcErr(id, code, message, { a2aCode });
}

export function requireObject(value, name) {
  if (!isPlainObject(value)) {
    throw new RpcError(-32602, `Invalid params: ${name} must be an object`, { a2aCode: 'INVALID_ARGUMENT' });
  }
  return value;
}

export function requireString(value, name, { max = 20000 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RpcError(-32602, `Invalid params: ${name} is required`, { a2aCode: 'INVALID_ARGUMENT' });
  }
  if (value.length > max) {
    throw new RpcError(-32602, `Invalid params: ${name} too long`, { a2aCode: 'INVALID_ARGUMENT' });
  }
  return value;
}

export function normalizePart(part) {
  if (!isPlainObject(part)) throw new RpcError(-32602, 'Invalid Part', { a2aCode: 'INVALID_ARGUMENT' });
  const contentKeys = ['text', 'raw', 'url', 'data'];
  const present = contentKeys.filter((k) => part[k] !== undefined);
  if (present.length !== 1) {
    throw new RpcError(-32602, 'Part must contain exactly one of text/raw/url/data', { a2aCode: 'INVALID_ARGUMENT' });
  }
  const out = { [present[0]]: part[present[0]] };
  for (const k of ['mediaType', 'filename', 'metadata']) {
    if (part[k] !== undefined) out[k] = part[k];
  }
  return out;
}

export function makeTextPart(text, mediaType = 'text/plain') {
  return { text: String(text), mediaType };
}

export function makeDataPart(data, mediaType = 'application/json') {
  return { data, mediaType };
}

export function makeUrlPart(url, mediaType = 'text/plain', filename = undefined) {
  return compact({ url, mediaType, filename });
}

export function normalizeMessage(input, { role, taskId, contextId } = {}) {
  if (!isPlainObject(input)) throw new RpcError(-32602, 'Invalid Message', { a2aCode: 'INVALID_ARGUMENT' });
  const parts = Array.isArray(input.parts) ? input.parts : [];
  if (parts.length === 0) throw new RpcError(-32602, 'Message.parts must not be empty', { a2aCode: 'INVALID_ARGUMENT' });
  const message = compact({
    messageId: pick(input, 'messageId', 'message_id') || uuid(),
    role: normalizeRole(role ?? pick(input, 'role')) || 'ROLE_USER',
    parts: parts.map(normalizePart),
    contextId: pick(input, 'contextId', 'context_id') ?? contextId,
    taskId: pick(input, 'taskId', 'task_id') ?? taskId,
    metadata: input.metadata,
    extensions: input.extensions,
    referenceTaskIds: pick(input, 'referenceTaskIds', 'reference_task_ids'),
  });
  if (!ROLES.has(message.role)) throw new RpcError(-32602, `Invalid role: ${message.role}`, { a2aCode: 'INVALID_ARGUMENT' });
  return message;
}

export function messageText(message) {
  return (message?.parts ?? []).filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
}

export function agentStatus(agent, now = Date.now()) {
  const lastSeen = agent.lastSeen ? Date.parse(agent.lastSeen) : 0;
  const ttl = (agent.heartbeatTtlSeconds ?? 120) * 1000;
  if (!lastSeen) return 'idle';
  return now - lastSeen <= ttl ? 'online' : 'offline';
}

export function buildSkill(input) {
  if (typeof input === 'string') {
    const [id, ...rest] = input.split(':');
    const name = rest.join(':').trim() || id;
    return normalizeSkill({ id: id.trim(), name, description: name, tags: [id.split('.')[0]] });
  }
  return normalizeSkill(input);
}

export function normalizeSkill(input) {
  const skill = requireObject(input, 'skill');
  const id = requireString(pick(skill, 'id'), 'skill.id', { max: 128 });
  const name = String(pick(skill, 'name') || id);
  const description = String(pick(skill, 'description') || name);
  const tags = Array.isArray(skill.tags) && skill.tags.length ? skill.tags.map(String) : [id.split('.')[0]];
  return compact({
    id,
    name,
    description,
    tags,
    examples: Array.isArray(skill.examples) ? skill.examples.map(String) : undefined,
    inputModes: pick(skill, 'inputModes', 'input_modes'),
    outputModes: pick(skill, 'outputModes', 'output_modes'),
  });
}

export function buildAgentCard({
  agentId,
  baseUrl,
  name,
  description,
  version = '0.1.0',
  skills = [],
  defaultInputModes = ['text/plain', 'application/json'],
  defaultOutputModes = ['text/plain', 'application/json'],
  wakePolicy = 'none',
  sessionId,
  workspace,
  heartbeatTtlSeconds = 120,
  syncWaitMs = 20000,
  documentationUrl,
}) {
  const extensions = [
    {
      uri: EXT_SESSION_DELIVERY,
      description: 'Durable inbox, SSE delivery, and wake policy for intermittent DSH sessions.',
      required: false,
      params: compact({
        agentId,
        sessionId,
        workspace,
        heartbeatTtlSeconds,
        wakePolicy,
        syncWaitMs,
      }),
    },
    {
      uri: EXT_WAKE,
      description: 'Wake hints for Connector implementations.',
      required: false,
      params: { policy: wakePolicy },
    },
  ];
  const interfaces = [
    {
      url: `${baseUrl}/agents/${encodeURIComponent(agentId)}/a2a`,
      protocolBinding: 'JSONRPC',
      protocolVersion: PROTOCOL_VERSION,
    },
  ];
  return compact({
    name,
    description,
    version,
    documentationUrl,
    supportedInterfaces: interfaces,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions,
    },
    defaultInputModes,
    defaultOutputModes,
    skills,
  });
}

export function buildHubCard({ baseUrl, version = '0.1.0' }) {
  return compact({
    name: 'A2A Exchange Hub',
    description:
      'Registry, durable inbox, and A2A v1.0 endpoint for intermittently-running agents (e.g. DeepSeek Harness sessions).',
    version,
    supportedInterfaces: [
      { url: `${baseUrl}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: PROTOCOL_VERSION },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: EXT_SESSION_DELIVERY,
          description: 'Registry + durable delivery for session-backed agents.',
          required: false,
        },
      ],
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'exchange.registry',
        name: 'Agent registry and discovery',
        description:
          'Register a conversation as an A2A agent, search agents by skill/tag, and route A2A tasks to durable inboxes.',
        tags: ['registry', 'a2a', 'discovery'],
      },
    ],
  });
}

export function buildTask({ taskId, contextId, message, agentId, wakePolicy }) {
  const when = nowIso();
  return {
    id: taskId,
    contextId,
    status: {
      state: 'TASK_STATE_SUBMITTED',
      timestamp: when,
    },
    artifacts: [],
    history: [message],
    metadata: {
      'x-exchange': compact({ agentId, wakePolicy, createdAt: when }),
    },
  };
}

export function buildStatusUpdate(task, state, message = undefined, timestamp = nowIso()) {
  const status = { state, timestamp };
  if (message) status.message = message;
  return status;
}

export function taskToA2A(task) {
  return compact({
    id: task.id,
    contextId: task.contextId,
    status: task.status,
    artifacts: task.artifacts ?? [],
    history: task.history ?? [],
    metadata: task.metadata,
  });
}
