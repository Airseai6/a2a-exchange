// Agent registry: registration, tokens, heartbeats, discovery, cards.
import {
  agentStatus,
  buildAgentCard,
  buildHubCard,
  buildSkill,
  normalizeSkill,
} from './a2a.mjs';
import { newToken, RpcError, sha256, safeEqual, uuid, pick, compact } from './util.mjs';

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function normalizeWakeUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  let url;
  try { url = new URL(String(value)); } catch {
    throw new RpcError(-32602, 'wakeUrl must be a valid URL', { a2aCode: 'INVALID_ARGUMENT' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RpcError(-32602, 'wakeUrl must use http/https', { a2aCode: 'INVALID_ARGUMENT' });
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new RpcError(-32602, 'wakeUrl must point to loopback/localhost', { a2aCode: 'INVALID_ARGUMENT' });
  }
  return url.toString();
}

export class Registry {
  constructor(store, options = {}) {
    this.store = store;
    this.syncWaitMs = options.syncWaitMs ?? 20000;
    this.hubVersion = options.hubVersion ?? '0.1.0';
    this.defaultHeartbeatTtlSeconds = options.heartbeatTtlSeconds ?? 900;
    this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:8787';
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = baseUrl;
  }

  hubCard(baseUrl = this.baseUrl) {
    return buildHubCard({ baseUrl, version: this.hubVersion });
  }

  #generateAgentId() {
    return `agent-${uuid().slice(0, 8)}`;
  }

  register(params = {}) {
    const rawId = pick(params, 'agentId', 'agent_id');
    let agentId = rawId ? String(rawId) : this.#generateAgentId();
    if (!AGENT_ID_RE.test(agentId)) {
      throw new RpcError(-32602, `Invalid agentId: ${agentId}`, { a2aCode: 'INVALID_ARGUMENT' });
    }
    const name = String(pick(params, 'name') ?? agentId);
    const description = String(pick(params, 'description') ?? `Agent ${agentId}`);
    const version = String(pick(params, 'version') ?? '0.1.0');
    const skillsInput = pick(params, 'skills') ?? [];
    const skills = (Array.isArray(skillsInput) ? skillsInput : [skillsInput]).map(buildSkill);
    if (skills.length === 0) {
      skills.push(normalizeSkill({ id: 'generic', name: 'Generic agent', description: 'Generic A2A agent', tags: ['generic'] }));
    }
    const wakePolicy = String(pick(params, 'wakePolicy', 'wake_policy') ?? 'none');
    if (!['none', 'schedule', 'task-board', 'notify'].includes(wakePolicy)) {
      throw new RpcError(-32602, `Invalid wakePolicy: ${wakePolicy}`, { a2aCode: 'INVALID_ARGUMENT' });
    }
    const heartbeatTtlSeconds = Number(
      pick(params, 'heartbeatTtlSeconds', 'heartbeat_ttl_seconds') ?? this.defaultHeartbeatTtlSeconds,
    );
    const syncWaitMs = Number(pick(params, 'syncWaitMs', 'sync_wait_ms') ?? this.syncWaitMs);
    const card = buildAgentCard({
      agentId,
      baseUrl: pick(params, 'baseUrl', 'base_url') ?? this.baseUrl,
      name,
      description,
      version,
      skills,
      defaultInputModes: pick(params, 'defaultInputModes', 'default_input_modes'),
      defaultOutputModes: pick(params, 'defaultOutputModes', 'default_output_modes'),
      wakePolicy,
      sessionId: pick(params, 'sessionId', 'session_id'),
      workspace: pick(params, 'workspace'),
      heartbeatTtlSeconds,
      syncWaitMs,
      documentationUrl: pick(params, 'documentationUrl', 'documentation_url'),
    });
    const token = newToken('agent');
    const existing = this.store.getAgent(agentId);
    const wakeUrl = normalizeWakeUrl(pick(params, 'wakeUrl', 'wake_url')) ?? existing?.wakeUrl;
    const agent = compact({
      agentId,
      tokenHash: sha256(token),
      card,
      sessionId: pick(params, 'sessionId', 'session_id'),
      workspace: pick(params, 'workspace'),
      wakeUrl,
      wakePolicy,
      heartbeatTtlSeconds,
      syncWaitMs,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
    this.store.putAgent(agent);
    this.store.appendEvent({
      type: 'agent.status',
      agentId,
      payload: { agentId, status: 'online', card },
    });
    return { agentId, token, card };
  }

  setWakeUrl(agentId, value) {
    const agent = this.requireAgent(agentId);
    agent.wakeUrl = normalizeWakeUrl(value);
    this.store.putAgent(agent);
    return { ok: true, agentId, wakeUrl: agent.wakeUrl ?? null };
  }

  heartbeat(params = {}, authenticatedAgentId = null) {    const agentId = authenticatedAgentId ?? pick(params, 'agentId', 'agent_id');
    if (!agentId) throw new RpcError(-32602, 'agentId is required', { a2aCode: 'INVALID_ARGUMENT' });
    const agent = this.requireAgent(agentId);
    agent.lastSeen = new Date().toISOString();
    this.store.putAgent(agent);
    this.store.appendEvent({
      type: 'agent.status',
      agentId,
      payload: { agentId, status: 'online' },
    });
    return {
      ok: true,
      agentId,
      status: agentStatus(agent),
      lastSeen: agent.lastSeen,
      expiresAt: new Date(Date.parse(agent.lastSeen) + (agent.heartbeatTtlSeconds ?? 120) * 1000).toISOString(),
    };
  }

  discover(params = {}) {
    const skill = pick(params, 'skill', 'skillId', 'skill_id');
    const tag = pick(params, 'tag');
    const statusFilter = pick(params, 'status');
    const keyword = pick(params, 'q', 'keyword');
    const pageSize = Math.min(Math.max(Number(pick(params, 'pageSize', 'page_size') ?? 20), 1), 100);
    const pageToken = pick(params, 'pageToken', 'page_token');
    const offset = pageToken ? Number(Buffer.from(String(pageToken), 'base64url').toString()) || 0 : 0;
    const now = Date.now();

    let agents = this.store.listAgents().map((agent) => ({
      agentId: agent.agentId,
      status: agentStatus(agent, now),
      lastSeen: agent.lastSeen,
      card: agent.card,
      wakePolicy: agent.wakePolicy,
    }));

    if (skill) {
      agents = agents.filter((a) => (a.card.skills ?? []).some((s) => s.id === skill || s.id.startsWith(`${skill}.`)));
    }
    if (tag) {
      agents = agents.filter((a) => (a.card.skills ?? []).some((s) => (s.tags ?? []).includes(tag)));
    }
    if (statusFilter) {
      agents = agents.filter((a) => a.status === statusFilter);
    }
    if (keyword) {
      const q = String(keyword).toLowerCase();
      agents = agents.filter((a) => {
        const hay = [a.agentId, a.card.name, a.card.description, ...(a.card.skills ?? []).map((s) => `${s.id} ${s.name} ${s.description} ${(s.tags ?? []).join(' ')}`)].join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    agents.sort((a, b) => {
      const rank = { online: 0, idle: 1, offline: 2 };
      return (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || String(b.lastSeen).localeCompare(String(a.lastSeen));
    });
    const totalSize = agents.length;
    const page = agents.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      agents: page,
      nextPageToken: nextOffset < totalSize ? Buffer.from(String(nextOffset)).toString('base64url') : '',
      pageSize,
      totalSize,
    };
  }

  unregister(params = {}, authenticatedAgentId = null) {
    const agentId = authenticatedAgentId ?? pick(params, 'agentId', 'agent_id');
    if (!agentId) throw new RpcError(-32602, 'agentId is required', { a2aCode: 'INVALID_ARGUMENT' });
    this.requireAgent(agentId);
    for (const task of this.store.listTasks()) {
      if (task.agentId === agentId) continue;
      if (!task.agentId) continue;
    }
    this.store.deleteAgent(agentId);
    this.store.appendEvent({ type: 'agent.status', agentId, payload: { agentId, status: 'offline', unregistered: true } });
    return { ok: true, agentId };
  }

  requireAgent(agentId) {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new RpcError(-32004, `Agent not found: ${agentId}`, { a2aCode: 'AGENT_NOT_FOUND' });
    return agent;
  }

  card(agentId) {
    return this.requireAgent(agentId).card;
  }

  verifyAgentToken(agentId, token) {
    const agent = this.store.getAgent(agentId);
    if (!agent || !token) return false;
    return safeEqual(agent.tokenHash, sha256(token));
  }
}
