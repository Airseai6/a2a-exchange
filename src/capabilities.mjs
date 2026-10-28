// 能力（capabilities）服务：落 SQLite capabilities 表，agent_id 外键到 agents。
import { nowIso, pick, RpcError } from './util.mjs';

export class CapabilityService {
  constructor({ store }) {
    this.store = store;
  }

  list(agentId) {
    return this.store.listCapabilities(agentId ?? undefined);
  }

  declare(agentId, params = {}, source = 'self') {
    const capability = String(pick(params, 'capability', 'id', 'name') ?? '').trim();
    if (!capability) throw new RpcError(-32602, 'capability is required', { a2aCode: 'INVALID_ARGUMENT' });
    if (!this.store.getAgent(agentId)) {
      throw new RpcError(-32001, 'Unknown agent: ' + agentId, { a2aCode: 'UNAUTHENTICATED' });
    }
    return this.store.upsertCapability({
      agentId,
      capability: capability.slice(0, 64),
      description: String(pick(params, 'description', 'desc') ?? '').slice(0, 500) || null,
      level: String(pick(params, 'level', 'sideEffect') ?? '').slice(0, 16) || null,
      source,
    });
  }

  remove(agentId, capability) {
    this.store.deleteCapability(agentId, capability);
    return { ok: true, agentId, capability };
  }

  /** 注册时把 Agent Card 的 skills 同步成能力（source=agent-card） */
  syncFromCard(agent) {
    const skills = agent?.card?.skills ?? [];
    const out = [];
    for (const skill of skills) {
      if (!skill?.id) continue;
      out.push(this.store.upsertCapability({
        agentId: agent.agentId,
        capability: skill.id,
        description: skill.description ?? null,
        level: null,
        source: 'agent-card',
      }));
    }
    return out;
  }
}
