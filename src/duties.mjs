// 职责（duties）服务：数据落 SQLite（duties / duty_assignments，外键到 agents）。
// 早期版本用 duties.json，这里保留一次性迁移。
import fs from 'node:fs';
import path from 'node:path';
import { nowIso, pick, RpcError, uuid } from './util.mjs';

const DEFAULT_DUTIES = [
  {
    dutyId: 'platform-maintenance',
    title: '接收房间反馈、维护/更新平台',
    description: '盯 platform-feedback 房间：判断问题真伪、记进 docs/LAN-FINDINGS.md、按优先级改代码并回归。',
    roomId: 'platform-feedback',
    scopes: ['room:read', 'room:write', 'task:create'],
  },
  {
    dutyId: 'agent-onboarding',
    title: '接待新 agent：问候、自述核对、指路',
    description: '新 agent 进房后问候一次，核对【接入自述】里的唤醒/权限/副作用，把缺项补上。',
    roomId: 'lobby',
    scopes: ['room:read', 'room:write'],
  },
  {
    dutyId: 'fusion-data-check',
    title: '聚变数据查询与交叉核对',
    description: 'MDSplus / ClickHouse / MongoDB 只读取数；对同一炮号做跨机交叉验证，异常单独记。',
    roomId: 'data-platform',
    scopes: ['room:read', 'room:write', 'task:claim', 'task:resolve'],
  },
];

export class DutyService {
  constructor({ store, dataDir }) {
    this.store = store;
    this.dataDir = dataDir;
    this.#migrateLegacyFile();
    this.#seed();
  }

  /** 旧版 duties.json -> SQLite（只跑一次，跑完改名） */
  #migrateLegacyFile() {
    const file = path.join(this.dataDir, 'duties.json');
    if (!fs.existsSync(file)) return;
    try {
      const items = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const item of Array.isArray(items) ? items : []) {
        if (!item?.dutyId || this.store.getDuty(item.dutyId)) continue;
        this.store.createDuty({
          dutyId: item.dutyId,
          title: item.title ?? item.dutyId,
          description: item.description ?? '',
          roomId: item.roomId ?? 'lobby',
          scopes: item.scopes ?? [],
          createdBy: item.createdBy ?? 'system',
        });
        if (item.claimedBy) this.store.claimDuty(item.dutyId, item.claimedBy);
      }
      fs.renameSync(file, file + '.migrated');
      console.log('[duties] migrated legacy duties.json into sqlite');
    } catch (error) {
      console.log('[duties] legacy migration failed: ' + error.message);
    }
  }

  #seed() {
    for (const seed of DEFAULT_DUTIES) {
      if (!this.store.getDuty(seed.dutyId)) {
        this.store.createDuty({ ...seed, createdBy: 'system' });
      }
    }
  }

  list(filter = {}) {
    let items = this.store.listDuties();
    if (filter.roomId) items = items.filter((d) => d.roomId === filter.roomId);
    if (filter.claimedBy) items = items.filter((d) => d.claimedBy === filter.claimedBy);
    if (filter.status) items = items.filter((d) => d.status === filter.status);
    return items;
  }

  get(dutyId) {
    const duty = this.store.getDuty(dutyId);
    if (!duty) throw new RpcError(-32004, 'Duty not found: ' + dutyId, { a2aCode: 'DUTY_NOT_FOUND' });
    return duty;
  }

  create(params = {}, actor = 'human') {
    const title = String(pick(params, 'title') ?? '').trim();
    if (!title) throw new RpcError(-32602, 'duty.title is required', { a2aCode: 'INVALID_ARGUMENT' });
    const dutyId = String(pick(params, 'dutyId', 'duty_id', 'id') ?? '').trim() || ('duty-' + uuid().slice(0, 8));
    if (this.store.getDuty(dutyId)) {
      throw new RpcError(-32602, 'Duty already exists: ' + dutyId, { a2aCode: 'INVALID_ARGUMENT' });
    }
    const scopes = Array.isArray(params.scopes) ? params.scopes.map(String) : [];
    return this.store.createDuty({
      dutyId,
      title: title.slice(0, 120),
      description: String(pick(params, 'description') ?? '').slice(0, 1000),
      roomId: String(pick(params, 'roomId', 'room_id') ?? 'lobby'),
      scopes,
      createdBy: actor,
    });
  }

  claim(dutyId, agentId) {
    const duty = this.get(dutyId);
    if (duty.claimedBy && duty.claimedBy !== agentId) {
      throw new RpcError(-32003, 'Duty already claimed by ' + duty.claimedBy, { a2aCode: 'DUTY_TAKEN' });
    }
    if (!this.store.getAgent(agentId)) {
      throw new RpcError(-32001, 'Unknown agent: ' + agentId, { a2aCode: 'UNAUTHENTICATED' });
    }
    return this.store.claimDuty(dutyId, agentId);
  }

  release(dutyId, agentId) {
    const duty = this.get(dutyId);
    if (duty.claimedBy && duty.claimedBy !== agentId) {
      throw new RpcError(-32003, 'Duty owned by ' + duty.claimedBy, { a2aCode: 'DUTY_FORBIDDEN' });
    }
    return this.store.releaseDuty(dutyId);
  }
}
