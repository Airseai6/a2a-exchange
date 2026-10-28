// 职责（duties）登记：能力/职责清单落盘，agent 自己认领。
// 独立 JSON 文件，不依赖 store 实现，SQLite / JSON 两种模式下都能用。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, pick, RpcError, uuid } from './util.mjs';

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
  constructor({ dataDir }) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'duties.json');
    this.items = this.#load();
    this.#seed();
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  #save() {
    ensureDir(this.dir);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  #seed() {
    let changed = false;
    for (const seed of DEFAULT_DUTIES) {
      if (!this.items.some((d) => d.dutyId === seed.dutyId)) {
        this.items.push({
          ...seed,
          status: 'open',
          claimedBy: null,
          claimedAt: null,
          createdBy: 'system',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  list(filter = {}) {
    let items = [...this.items];
    if (filter.roomId) items = items.filter((d) => d.roomId === filter.roomId);
    if (filter.claimedBy) items = items.filter((d) => d.claimedBy === filter.claimedBy);
    if (filter.status) items = items.filter((d) => d.status === filter.status);
    return items.sort((a, b) => String(a.dutyId).localeCompare(String(b.dutyId)));
  }

  get(dutyId) {
    const found = this.items.find((d) => d.dutyId === dutyId);
    if (!found) throw new RpcError(-32004, 'Duty not found: ' + dutyId, { a2aCode: 'DUTY_NOT_FOUND' });
    return found;
  }

  create(params = {}, actor = 'human') {
    const title = String(pick(params, 'title') ?? '').trim();
    if (!title) throw new RpcError(-32602, 'duty.title is required', { a2aCode: 'INVALID_ARGUMENT' });
    const id = String(pick(params, 'dutyId', 'duty_id', 'id') ?? '').trim() || ('duty-' + uuid().slice(0, 8));
    if (this.items.some((d) => d.dutyId === id)) {
      throw new RpcError(-32602, 'Duty already exists: ' + id, { a2aCode: 'INVALID_ARGUMENT' });
    }
    const duty = {
      dutyId: id,
      title: title.slice(0, 120),
      description: String(pick(params, 'description') ?? '').slice(0, 1000),
      roomId: String(pick(params, 'roomId', 'room_id') ?? 'lobby'),
      scopes: Array.isArray(params.scopes) ? params.scopes.map(String) : [],
      status: 'open',
      claimedBy: null,
      claimedAt: null,
      createdBy: actor,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.items.push(duty);
    this.#save();
    return duty;
  }

  claim(dutyId, agentId) {
    const duty = this.get(dutyId);
    if (duty.claimedBy && duty.claimedBy !== agentId) {
      throw new RpcError(-32003, 'Duty already claimed by ' + duty.claimedBy, { a2aCode: 'DUTY_TAKEN' });
    }
    duty.claimedBy = agentId;
    duty.claimedAt = duty.claimedAt ?? nowIso();
    duty.status = 'claimed';
    duty.updatedAt = nowIso();
    this.#save();
    return duty;
  }

  release(dutyId, agentId) {
    const duty = this.get(dutyId);
    if (duty.claimedBy && duty.claimedBy !== agentId) {
      throw new RpcError(-32003, 'Duty owned by ' + duty.claimedBy, { a2aCode: 'DUTY_FORBIDDEN' });
    }
    duty.claimedBy = null;
    duty.claimedAt = null;
    duty.status = 'open';
    duty.updatedAt = nowIso();
    this.#save();
    return duty;
  }
}
