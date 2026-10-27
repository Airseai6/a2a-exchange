// Local collaboration rooms: durable chat + agent participants.
// Normalized internally onto A2A Message/Part shapes when agents send content.
import { agentStatus } from './a2a.mjs';
import { nowIso, pick, RpcError, uuid } from './util.mjs';

const ROOM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_MESSAGES_PER_ROOM = 5000;

export class RoomService {
  constructor(store, registry) {
    this.store = store;
    this.registry = registry;
    this.subs = new Map();
  }

  ensureRoom(roomId = 'lobby', name = '协作房间', description = '本地 agent 协作房间') {
    const existing = this.store.getRoom(roomId);
    if (existing) return existing;
    return this.create({ roomId, name, description });
  }

  create(params = {}) {
    const roomId = String(pick(params, 'roomId', 'room_id', 'id') ?? '').trim();
    if (!ROOM_ID_RE.test(roomId)) {
      throw new RpcError(-32602, `Invalid roomId: ${roomId}`, { a2aCode: 'INVALID_ARGUMENT' });
    }
    if (this.store.getRoom(roomId)) {
      throw new RpcError(-32602, `Room already exists: ${roomId}`, { a2aCode: 'INVALID_ARGUMENT' });
    }
    const room = {
      id: roomId,
      name: String(pick(params, 'name') ?? roomId),
      description: String(pick(params, 'description') ?? ''),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      nextSeq: 1,
      participants: {},
      acks: {},
      messages: [],
    };
    this.store.putRoom(room);
    return room;
  }

  listRooms() {
    return this.store
      .listRooms()
      .map((room) => this.summary(room))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  summary(room) {
    const last = room.messages.at(-1);
    return {
      id: room.id,
      name: room.name,
      description: room.description,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      participantCount: Object.keys(room.participants ?? {}).length,
      messageCount: room.messages.length,
      lastMessageAt: last?.time ?? null,
      lastMessageText: last ? `${last.sender.name}: ${last.text.slice(0, 80)}` : '',
    };
  }

  get(roomId, params = {}) {
    const room = this.#requireRoom(roomId);
    const since = Math.max(0, Number(pick(params, 'since') ?? 0) || 0);
    const limit = Math.min(Math.max(Number(pick(params, 'limit') ?? 200), 1), 500);
    const messages = room.messages.filter((m) => m.seq > since).slice(-limit);
    return {
      room: this.summary(room),
      participants: this.participants(room),
      messages,
      lastSeq: room.nextSeq - 1,
    };
  }

  participants(room) {
    return Object.values(room.participants ?? {}).map((p) => {
      const agent = this.store.getAgent(p.agentId);
      return {
        agentId: p.agentId,
        name: p.name,
        role: p.role ?? 'member',
        joinedAt: p.joinedAt,
        lastSeen: agent?.lastSeen ?? p.lastSeen ?? null,
        status: agent ? agentStatus(agent) : 'offline',
        skills: agent?.card?.skills?.map((s) => s.id) ?? [],
      };
    });
  }

  join(roomId, agentId, params = {}) {
    const room = this.#requireRoom(roomId);
    const agent = this.registry.requireAgent(agentId);
    const role = params.role === 'admin' ? 'admin' : 'member';
    agent.lastSeen = new Date().toISOString();
    this.store.putAgent(agent);    room.participants[agentId] = {
      agentId,
      name: agent.card?.name ?? agentId,
      role: room.participants[agentId]?.role ?? role,
      joinedAt: room.participants[agentId]?.joinedAt ?? nowIso(),
      lastSeen: nowIso(),
    };
    this.store.putRoom(room);
    this.#publish(roomId, { type: 'participants', roomId, participants: this.participants(room) });
    return { room: this.summary(room), participant: room.participants[agentId] };
  }

  setRole(roomId, agentId, role) {
    const room = this.#requireRoom(roomId);
    if (!room.participants[agentId]) throw new RpcError(-32004, `Agent not in room: ${agentId}`, { a2aCode: 'AGENT_NOT_FOUND' });
    room.participants[agentId].role = role === 'admin' ? 'admin' : 'member';
    this.store.putRoom(room);
    this.#publish(roomId, { type: 'participants', roomId, participants: this.participants(room) });
    return { ok: true, roomId, agentId, role: room.participants[agentId].role };
  }

  update(roomId, params = {}) {
    const room = this.#requireRoom(roomId);
    if (params.name !== undefined) {
      const name = String(params.name).trim();
      if (!name) throw new RpcError(-32602, 'Room name is required', { a2aCode: 'INVALID_ARGUMENT' });
      room.name = name;
    }
    if (params.description !== undefined) room.description = String(params.description);
    this.store.putRoom(room);
    this.#publish(roomId, { type: 'participants', roomId, participants: this.participants(room) });
    return { ok: true, room: this.summary(room) };
  }

  destroy(roomId) {
    const room = this.#requireRoom(roomId);
    this.store.deleteRoom(roomId);
    return { ok: true, roomId, name: room.name };
  }

  leave(roomId, agentId) {
    const room = this.#requireRoom(roomId);
    delete room.participants[agentId];
    this.store.putRoom(room);
    this.#publish(roomId, { type: 'participants', roomId, participants: this.participants(room) });
    return { ok: true, room: this.summary(room) };
  }
  postHuman(roomId, params = {}) {
    const room = this.#requireRoom(roomId);
    const text = this.#cleanText(pick(params, 'text'));
    const name = String(pick(params, 'name') ?? '我（人类）').slice(0, 64);
    return this.#post(room, { kind: 'human', name }, text);
  }

  postAgent(roomId, agentId, params = {}) {
    const room = this.#requireRoom(roomId);
    const agent = this.registry.requireAgent(agentId);
    agent.lastSeen = new Date().toISOString();
    this.store.putAgent(agent);
    const text = this.#cleanText(pick(params, 'text'));
    if (!room.participants[agentId]) {
      room.participants[agentId] = {
        agentId,
        name: agent.card?.name ?? agentId,
        role: 'member',
        joinedAt: nowIso(),
        lastSeen: nowIso(),
      };
    } else {
      room.participants[agentId].lastSeen = nowIso();
    }
    const message = this.#post(room, { kind: 'agent', agentId, name: agent.card?.name ?? agentId }, text);
    this.#publish(roomId, { type: 'participants', roomId, participants: this.participants(room) });
    return message;
  }

  read(roomId, params = {}) {
    const room = this.#requireRoom(roomId);
    const since = Math.max(0, Number(pick(params, 'since') ?? 0) || 0);
    const limit = Math.min(Math.max(Number(pick(params, 'limit') ?? 200), 1), 500);
    const messages = room.messages.filter((m) => m.seq > since).slice(0, limit);
    return { roomId, messages, lastSeq: room.nextSeq - 1 };
  }

  /** Server-side unread/pending for one agent (survives local state loss). */
  pending(roomId, agentId) {
    const room = this.#requireRoom(roomId);
    const agent = this.registry.requireAgent(agentId);
    if (!room.acks) room.acks = {};
    const since = Number(room.acks[agentId] ?? 0);
    const name = agent.card?.name ?? agentId;
    const messages = room.messages.filter((m) => m.seq > since && this.#mentions(m.text, agentId, name));
    return {
      roomId,
      agentId,
      since,
      lastSeq: room.nextSeq - 1,
      pendingCount: messages.length,
      pendingForMe: messages.map((m) => ({
        seq: m.seq,
        from: m.sender?.name ?? 'unknown',
        kind: m.sender?.kind ?? 'agent',
        text: m.text,
        time: m.time,
      })),
    };
  }

  ack(roomId, agentId, seq) {
    const room = this.#requireRoom(roomId);
    if (!room.acks) room.acks = {};
    const target = Math.min(Number(seq ?? room.nextSeq - 1) || 0, room.nextSeq - 1);
    room.acks[agentId] = Math.max(Number(room.acks[agentId] ?? 0), target);
    this.store.putRoom(room);
    return { ok: true, roomId, agentId, ackSeq: room.acks[agentId] };
  }

  #mentions(text, agentId, agentName) {
    const value = String(text ?? '');
    const lower = value.toLowerCase();
    return lower.includes('@all') ||
      lower.includes('@' + String(agentId).toLowerCase()) ||
      (agentName ? value.includes('@' + agentName) : false);
  }

  subscribe(roomId, fn) {
    if (!this.subs.has(roomId)) this.subs.set(roomId, new Set());
    this.subs.get(roomId).add(fn);
    return () => this.subs.get(roomId)?.delete(fn);
  }

  #post(room, sender, text) {
    const message = {
      messageId: uuid(),
      roomId: room.id,
      seq: room.nextSeq++,
      sender,
      text,
      parts: [{ text, mediaType: 'text/plain' }],
      time: nowIso(),
    };
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    }
    this.store.putRoom(room);
    this.#publish(room.id, { type: 'message', roomId: room.id, message });
    return message;
  }

  #publish(roomId, event) {
    const subscribers = this.subs.get(roomId);
    if (!subscribers) return;
    for (const fn of [...subscribers]) {
      try {
        fn(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  #cleanText(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new RpcError(-32602, 'text is required', { a2aCode: 'INVALID_ARGUMENT' });
    }
    if (value.length > 8000) {
      throw new RpcError(-32602, 'text too long (max 8000)', { a2aCode: 'INVALID_ARGUMENT' });
    }
    return value.trim();
  }

  #requireRoom(roomId) {
    const room = this.store.getRoom(String(roomId));
    if (!room) throw new RpcError(-32004, `Room not found: ${roomId}`, { a2aCode: 'ROOM_NOT_FOUND' });
    return room;
  }
}
