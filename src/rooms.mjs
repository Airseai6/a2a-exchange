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
    this.messageHook = null;
  }

  setMessageHook(fn) { this.messageHook = typeof fn === 'function' ? fn : null; }

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
      tasks: this.listTasks(roomId),
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
    this.store.appendRoomActivity?.({ roomId, agentId, type: 'join', detail: room.participants[agentId].role });
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
    return this.#post(room, { kind: 'human', name }, text, pick(params, 'type') ?? 'chat', pick(params, 'taskId', 'task_id'));
  }

  postAgent(roomId, agentId, params = {}) {
    const room = this.#requireRoom(roomId);
    const agent = this.registry.requireAgent(agentId);
    agent.lastSeen = new Date().toISOString();
    this.store.putAgent(agent);
    const text = this.#cleanText(pick(params, 'text'));
    const type = pick(params, 'type') ?? 'chat';
    const taskId = pick(params, 'taskId', 'task_id');
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
    const message = this.#post(room, { kind: 'agent', agentId, name: agent.card?.name ?? agentId }, text, type, taskId);
    this.#publish(roomId, { type: 'participants', roomId, participants: this.participants(room) });
    return message;
  }

  /* ── room task board ── */
  listTasks(roomId) {
    this.#requireRoom(roomId);
    return this.store.listRoomTasks(roomId).map((task) => ({ ...task, events: this.store.listRoomTaskEvents(task.taskId) }));
  }

  createTask(roomId, params = {}, actor = 'human') {
    this.#requireRoom(roomId);
    const title = String(pick(params, 'title') ?? '').trim();
    if (!title) throw new RpcError(-32602, 'task.title is required', { a2aCode: 'INVALID_ARGUMENT' });
    const task = {
      taskId: uuid(),
      roomId,
      title: title.slice(0, 200),
      detail: String(pick(params, 'detail') ?? '').slice(0, 4000),
      acceptance: String(pick(params, 'acceptance') ?? '').slice(0, 2000),
      status: 'open',
      assignee: pick(params, 'assignee') ? String(pick(params, 'assignee')) : null,
      verifier: pick(params, 'verifier') ? String(pick(params, 'verifier')) : null,
      branch: pick(params, 'branch') ? String(pick(params, 'branch')).slice(0, 200) : null,
      commit: pick(params, 'commit', 'commitRef', 'commit_ref') ? String(pick(params, 'commit', 'commitRef', 'commit_ref')).slice(0, 100) : null,
      summary: pick(params, 'summary') ? String(pick(params, 'summary')).slice(0, 1000) : null,
      createdBy: actor,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      verifiedBy: null,
      verifiedAt: null,
    };
    this.store.putRoomTask(task);
    this.store.appendRoomTaskEvent({ taskId: task.taskId, type: 'created', actor, note: title });
    this.#publish(roomId, { type: 'tasks', roomId, tasks: this.listTasks(roomId) });
    this.#postTaskNotice(roomId, task, 'created');
    return { ...task, events: this.store.listRoomTaskEvents(task.taskId) };
  }

  taskAction(roomId, taskId, action, params = {}, actor = 'human') {
    this.#requireRoom(roomId);
    const task = this.store.getRoomTask(taskId);
    if (!task || task.roomId !== roomId) throw new RpcError(-32004, 'Task not found', { a2aCode: 'TASK_NOT_FOUND' });
    const now = nowIso();
    const previousStatus = task.status;
    const previousAssignee = task.assignee;
    const previousVerifier = task.verifier;
    const note = String(pick(params, 'note') ?? '').slice(0, 2000);
    if (action === 'assign') {
      if (pick(params, 'assignee')) task.assignee = String(pick(params, 'assignee'));
      if (pick(params, 'verifier')) task.verifier = String(pick(params, 'verifier'));
    } else if (action === 'update') {
      if (pick(params, 'branch')) task.branch = String(pick(params, 'branch')).slice(0, 200);
      if (pick(params, 'commit', 'commitRef', 'commit_ref')) task.commit = String(pick(params, 'commit', 'commitRef', 'commit_ref')).slice(0, 100);
      if (pick(params, 'summary')) task.summary = String(pick(params, 'summary')).slice(0, 1000);
      if (pick(params, 'assignee')) task.assignee = String(pick(params, 'assignee'));
      if (pick(params, 'verifier')) task.verifier = String(pick(params, 'verifier'));
    } else if (action === 'claim') {
      task.status = 'in_progress';
      task.assignee = pick(params, 'assignee') ? String(pick(params, 'assignee')) : (task.assignee ?? null);
    } else if (action === 'resolve') {
      task.status = 'resolved';
    } else if (action === 'verify') {
      if (pick(params, 'pass') === false) {
        task.status = 'in_progress';
        task.verifiedBy = null;
        task.verifiedAt = null;
      } else {
        task.status = 'verified';
        task.verifiedBy = String(actor);
        task.verifiedAt = now;
      }
    } else if (action === 'reopen') {
      task.status = 'open';
    } else if (action === 'close') {
      task.status = 'closed';
    } else {
      throw new RpcError(-32602, `Unknown task action: ${action}`, { a2aCode: 'INVALID_ARGUMENT' });
    }
    task.updatedAt = now;
    this.store.putRoomTask(task);
    this.store.appendRoomTaskEvent({ taskId, type: action, actor, note });
    this.#publish(roomId, { type: 'tasks', roomId, tasks: this.listTasks(roomId) });
    const statusChanged = task.status !== previousStatus;
    const assignChanged = task.assignee !== previousAssignee || task.verifier !== previousVerifier;
    if (action === 'assign' && assignChanged) this.#postTaskNotice(roomId, task, 'assigned');
    if (action === 'resolve' && statusChanged) this.#postTaskNotice(roomId, task, 'resolved');
    if (action === 'verify' && statusChanged) this.#postTaskNotice(roomId, task, task.status === 'verified' ? 'verified' : 'rejected');
    if (action === 'reopen' && statusChanged) this.#postTaskNotice(roomId, task, 'reopened');
    return { ...task, events: this.store.listRoomTaskEvents(task.taskId) };
  }

  #taskContext(task) {
    const bits = [];
    if (task.branch) bits.push('分支 ' + task.branch);
    if (task.commit) bits.push('commit ' + task.commit);
    if (task.summary) bits.push('摘要 ' + task.summary);
    return bits.length ? '\n' + bits.join(' · ') : '';
  }

  #postTaskNotice(roomId, task, kind) {
    let target = null;
    let text = '';
    if (kind === 'created' && task.assignee) {
      target = task.assignee;
      text = `@${target} 新任务：${task.title}${task.acceptance ? '\n验收：' + task.acceptance : ''}${this.#taskContext(task)}（taskId ${task.taskId}）`;
    } else if (kind === 'assigned' && task.assignee) {
      target = task.assignee;
      text = `@${target} 任务已指派：${task.title}${this.#taskContext(task)}（taskId ${task.taskId}）`;
    } else if (kind === 'resolved') {
      target = task.verifier ?? (task.createdBy && !['human', 'system'].includes(task.createdBy) ? task.createdBy : null);
      if (target) text = `@${target} 任务待验收：${task.title}${this.#taskContext(task)}（taskId ${task.taskId}）`;
    } else if (kind === 'verified' && task.assignee) {
      target = task.assignee;
      text = `@${target} 任务已验证通过：${task.title}（taskId ${task.taskId}）`;
    } else if (kind === 'rejected' && task.assignee) {
      target = task.assignee;
      text = `@${target} 任务验收未通过，请继续处理：${task.title}（taskId ${task.taskId}）`;
    } else if (kind === 'reopened' && task.assignee) {
      target = task.assignee;
      text = `@${target} 任务已重新打开：${task.title}（taskId ${task.taskId}）`;
    }
    if (!target) return;
    const room = this.#requireRoom(roomId);
    this.#post(room, { kind: 'system', name: '任务板' }, text, 'task', task.taskId);
  }

  pin(roomId, seq, pinned = true) {
    const room = this.#requireRoom(roomId);
    const message = room.messages.find((m) => Number(m.seq) === Number(seq));
    if (!message) throw new RpcError(-32004, 'Message not found', { a2aCode: 'MESSAGE_NOT_FOUND' });
    message.pinned = Boolean(pinned);
    this.store.putRoom(room);
    this.#publish(roomId, { type: 'pinned', roomId, seq: Number(seq), pinned: message.pinned });
    return { ok: true, roomId, seq: Number(seq), pinned: message.pinned };
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
    const ackInfo = this.store.getRoomAck?.(roomId, agentId) ?? { seq: since, ackedAt: null };
    return {
      roomId,
      agentId,
      since,
      lastSeq: room.nextSeq - 1,
      lastAckSeq: ackInfo.seq,
      lastAckAt: ackInfo.ackedAt,
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
    const ackedAt = nowIso();
    this.store.setRoomAckTime?.(roomId, agentId, ackedAt);
    this.store.appendRoomActivity?.({ roomId, agentId, type: 'ack', seq: room.acks[agentId] });
    return { ok: true, roomId, agentId, ackSeq: room.acks[agentId], ackedAt };
  }

  activity(roomId, limit = 50) {
    this.#requireRoom(roomId);
    return this.store.listRoomActivity?.(roomId, limit) ?? [];
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

  #post(room, sender, text, type = 'chat', taskId = undefined) {
    const message = {
      messageId: uuid(),
      roomId: room.id,
      seq: room.nextSeq++,
      sender,
      text,
      ...(type && type !== 'chat' ? { type } : {}),
      ...(taskId ? { taskId } : {}),
      parts: [{ text, mediaType: 'text/plain' }],
      time: nowIso(),
    };
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    }
    this.store.putRoom(room);
    this.#publish(room.id, { type: 'message', roomId: room.id, message });
    try {
      const result = this.messageHook?.(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {}
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

  #cleanTask(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new RpcError(-32602, 'task must be an object', { a2aCode: 'INVALID_ARGUMENT' });
    }
    const title = String(value.title ?? '').trim();
    if (!title) throw new RpcError(-32602, 'task.title is required', { a2aCode: 'INVALID_ARGUMENT' });
    const task = {
      title: title.slice(0, 200),
      detail: String(value.detail ?? '').slice(0, 4000),
      acceptance: String(value.acceptance ?? '').slice(0, 2000),
      assignee: value.assignee ? String(value.assignee).slice(0, 128) : undefined,
      status: 'open',
      createdAt: nowIso(),
    };
    return task;
  }

  #requireRoom(roomId) {
    const room = this.store.getRoom(String(roomId));
    if (!room) throw new RpcError(-32004, `Room not found: ${roomId}`, { a2aCode: 'ROOM_NOT_FOUND' });
    return room;
  }
}
