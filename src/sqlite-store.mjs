// SQLite-backed store (WAL) with normalized room tables.
//
// Tables:
//   agents(agent_id, json)                 -- A2A agent records
//   tasks(task_id, json)                   -- A2A tasks
//   events(seq, json)                      -- A2A event log
//   rooms(room_id, name, description, created_at, updated_at, next_seq)
//   room_members(room_id, agent_id, name, role, joined_at, last_seen)
//   room_acks(room_id, agent_id, ack_seq, acked_at)
//   room_messages(message_id, room_id, seq, sender_kind, sender_id, sender_name, text, type, task_id, parts_json, time)
//   room_tasks(task_id, room_id, title, detail, acceptance, status, assignee, created_by, created_at, updated_at, verified_by, verified_at)
//   room_task_events(event_id, task_id, type, actor, note, created_at)
//   meta(key, value)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson } from './util.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT,
  updated_at TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT,
  role TEXT,
  joined_at TEXT,
  last_seen TEXT,
  PRIMARY KEY (room_id, agent_id)
);
CREATE TABLE IF NOT EXISTS room_acks (
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  ack_seq INTEGER NOT NULL DEFAULT 0,
  acked_at TEXT,
  PRIMARY KEY (room_id, agent_id)
);
CREATE TABLE IF NOT EXISTS room_messages (
  message_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sender_kind TEXT,
  sender_id TEXT,
  sender_name TEXT,
  text TEXT,
  type TEXT DEFAULT 'chat',
  task_id TEXT,
  parts_json TEXT,
  time TEXT,
  UNIQUE (room_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_room_messages_room_seq ON room_messages(room_id, seq);
CREATE TABLE IF NOT EXISTS room_tasks (
  task_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  acceptance TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assignee TEXT,
  verifier TEXT,
  created_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  verified_by TEXT,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_tasks_room ON room_tasks(room_id, status);
CREATE TABLE IF NOT EXISTS room_task_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT,
  actor TEXT,
  note TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS room_activity (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  agent_id TEXT,
  type TEXT NOT NULL,
  seq INTEGER,
  detail TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_activity_room ON room_activity(room_id, event_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class SqliteStore {
  constructor({ dataDir }) {
    this.dataDir = path.resolve(dataDir);
    ensureDir(this.dataDir);
    this.dbFile = path.join(this.dataDir, 'a2a-exchange.db');
    this.db = new DatabaseSync(this.dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.#migrateOldSchema();
    this.db.exec(SCHEMA);
    this.#ensureColumns();
    this.agentSubs = new Map();
    this.taskSubs = new Map();
    this.events = [];
    this.nextEventId = 1;
    this.load();
  }

  load() {
    this.#migrateJsonIfEmpty();
    const eventRows = this.db.prepare('SELECT seq, json FROM events ORDER BY seq').all();
    this.events = eventRows.map((row) => JSON.parse(row.json));
    const maxSeq = this.events.at(-1)?.eventId ?? 0;
    this.nextEventId = Math.max(Number(this.getMeta('nextEventId') ?? 1), maxSeq + 1);
    return this;
  }

  open() { return this; }
  close() { try { this.db.close(); } catch {} }

  /* ── agents / A2A tasks ── */
  putAgent(agent) {
    this.db.prepare('INSERT INTO agents(agent_id, json) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json').run(agent.agentId, JSON.stringify(agent));
    return agent;
  }
  getAgent(agentId) {
    const row = this.db.prepare('SELECT json FROM agents WHERE agent_id = ?').get(agentId);
    return row ? JSON.parse(row.json) : undefined;
  }
  deleteAgent(agentId) { this.db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agentId); }
  listAgents() { return this.db.prepare('SELECT json FROM agents').all().map((row) => JSON.parse(row.json)); }

  putTask(task) {
    this.db.prepare('INSERT INTO tasks(task_id, json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET json = excluded.json').run(task.id, JSON.stringify(task));
    return task;
  }
  getTask(taskId) {
    const row = this.db.prepare('SELECT json FROM tasks WHERE task_id = ?').get(taskId);
    return row ? JSON.parse(row.json) : undefined;
  }
  deleteTask(taskId) { this.db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId); }
  listTasks() { return this.db.prepare('SELECT json FROM tasks').all().map((row) => JSON.parse(row.json)); }

  /* ── rooms ── */
  putRoom(room) {
    this.db.prepare(`
      INSERT INTO rooms(room_id, name, description, created_at, updated_at, next_seq)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET name=excluded.name, description=excluded.description, updated_at=excluded.updated_at, next_seq=excluded.next_seq
    `).run(room.id, room.name, room.description ?? '', room.createdAt ?? null, room.updatedAt ?? null, room.nextSeq ?? 1);

    this.db.prepare('DELETE FROM room_members WHERE room_id = ?').run(room.id);
    const member = this.db.prepare('INSERT INTO room_members(room_id, agent_id, name, role, joined_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of Object.values(room.participants ?? {})) member.run(room.id, p.agentId, p.name ?? p.agentId, p.role ?? 'member', p.joinedAt ?? null, p.lastSeen ?? null);

    const ack = this.db.prepare(`
      INSERT INTO room_acks(room_id, agent_id, ack_seq, acked_at)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(room_id, agent_id) DO UPDATE SET ack_seq = excluded.ack_seq
    `);
    for (const [agentId, seq] of Object.entries(room.acks ?? {})) ack.run(room.id, agentId, Number(seq) || 0);

    const message = this.db.prepare(`
      INSERT INTO room_messages(message_id, room_id, seq, sender_kind, sender_id, sender_name, text, type, task_id, parts_json, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, seq) DO UPDATE SET text=excluded.text, type=excluded.type, task_id=excluded.task_id, parts_json=excluded.parts_json
    `);
    for (const m of room.messages ?? []) {
      message.run(
        m.messageId,
        room.id,
        m.seq,
        m.sender?.kind ?? 'agent',
        m.sender?.agentId ?? null,
        m.sender?.name ?? null,
        m.text ?? '',
        m.type ?? 'chat',
        m.taskId ?? null,
        JSON.stringify(m.parts ?? []),
        m.time ?? null,
      );
    }
    return room;
  }

  getRoom(roomId) {
    const row = this.db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId);
    if (!row) return undefined;
    const members = this.db.prepare('SELECT * FROM room_members WHERE room_id = ?').all(roomId);
    const acks = Object.fromEntries(this.db.prepare('SELECT agent_id, ack_seq FROM room_acks WHERE room_id = ?').all(roomId).map((r) => [r.agent_id, r.ack_seq]));
    const messages = this.db.prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY seq').all(roomId).map((m) => ({
      messageId: m.message_id,
      roomId: m.room_id,
      seq: m.seq,
      sender: { kind: m.sender_kind, ...(m.sender_id ? { agentId: m.sender_id } : {}), name: m.sender_name ?? 'unknown' },
      text: m.text ?? '',
      ...(m.type && m.type !== 'chat' ? { type: m.type } : {}),
      ...(m.task_id ? { taskId: m.task_id } : {}),
      parts: safeParse(m.parts_json, []),
      time: m.time ?? null,
    }));
    return {
      id: row.room_id,
      name: row.name,
      description: row.description ?? '',
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      nextSeq: Number(row.next_seq) || 1,
      participants: Object.fromEntries(members.map((p) => [p.agent_id, {
        agentId: p.agent_id,
        name: p.name ?? p.agent_id,
        role: p.role ?? 'member',
        joinedAt: p.joined_at ?? null,
        lastSeen: p.last_seen ?? null,
      }])),
      acks,
      messages,
    };
  }

  listRooms() {
    return this.db.prepare('SELECT room_id FROM rooms').all().map((row) => this.getRoom(row.room_id));
  }

  deleteRoom(roomId) {
    this.db.prepare('DELETE FROM room_messages WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM room_members WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM room_acks WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM room_activity WHERE room_id = ?').run(roomId);
    for (const task of this.listRoomTasks(roomId)) this.deleteRoomTask(task.taskId);
    this.db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
  }

  setRoomAckTime(roomId, agentId, ackedAt) {
    this.db.prepare(`
      INSERT INTO room_acks(room_id, agent_id, ack_seq, acked_at)
      VALUES (?, ?, COALESCE((SELECT ack_seq FROM room_acks WHERE room_id = ? AND agent_id = ?), 0), ?)
      ON CONFLICT(room_id, agent_id) DO UPDATE SET acked_at = excluded.acked_at
    `).run(roomId, agentId, roomId, agentId, ackedAt);
  }

  getRoomAck(roomId, agentId) {
    const row = this.db.prepare('SELECT ack_seq, acked_at FROM room_acks WHERE room_id = ? AND agent_id = ?').get(roomId, agentId);
    return row ? { seq: Number(row.ack_seq), ackedAt: row.acked_at ?? null } : { seq: 0, ackedAt: null };
  }

  appendRoomActivity({ roomId, agentId, type, seq, detail }) {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO room_activity(room_id, agent_id, type, seq, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(roomId, agentId ?? null, type, seq ?? null, detail ?? null, createdAt);
    return { eventId: Number(result.lastInsertRowid), roomId, agentId, type, seq, detail, createdAt };
  }

  listRoomActivity(roomId, limit = 50) {
    return this.db.prepare('SELECT * FROM room_activity WHERE room_id = ? ORDER BY event_id DESC LIMIT ?')
      .all(roomId, Math.min(Math.max(Number(limit) || 50, 1), 200))
      .map((row) => ({
        eventId: row.event_id,
        roomId: row.room_id,
        agentId: row.agent_id,
        type: row.type,
        seq: row.seq,
        detail: row.detail,
        createdAt: row.created_at,
      }));
  }

  /* ── room task board ── */
  putRoomTask(task) {
    this.db.prepare(`
      INSERT INTO room_tasks(task_id, room_id, title, detail, acceptance, status, assignee, verifier, created_by, created_at, updated_at, verified_by, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET title=excluded.title, detail=excluded.detail, acceptance=excluded.acceptance,
        status=excluded.status, assignee=excluded.assignee, verifier=excluded.verifier, updated_at=excluded.updated_at,
        verified_by=excluded.verified_by, verified_at=excluded.verified_at
    `).run(task.taskId, task.roomId, task.title, task.detail ?? '', task.acceptance ?? '', task.status, task.assignee ?? null, task.verifier ?? null, task.createdBy ?? null, task.createdAt ?? null, task.updatedAt ?? null, task.verifiedBy ?? null, task.verifiedAt ?? null);
    return task;
  }

  getRoomTask(taskId) {
    const row = this.db.prepare('SELECT * FROM room_tasks WHERE task_id = ?').get(taskId);
    return row ? taskFromRow(row) : undefined;
  }

  listRoomTasks(roomId) {
    return this.db.prepare('SELECT * FROM room_tasks WHERE room_id = ? ORDER BY created_at ASC').all(roomId).map(taskFromRow);
  }

  deleteRoomTask(taskId) {
    this.db.prepare('DELETE FROM room_task_events WHERE task_id = ?').run(taskId);
    this.db.prepare('DELETE FROM room_tasks WHERE task_id = ?').run(taskId);
  }

  appendRoomTaskEvent({ taskId, type, actor, note }) {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO room_task_events(task_id, type, actor, note, created_at) VALUES (?, ?, ?, ?, ?)').run(taskId, type, actor ?? null, note ?? null, createdAt);
    return { eventId: Number(result.lastInsertRowid), taskId, type, actor, note, createdAt };
  }

  listRoomTaskEvents(taskId) {
    return this.db.prepare('SELECT * FROM room_task_events WHERE task_id = ? ORDER BY event_id').all(taskId).map((row) => ({
      eventId: row.event_id,
      taskId: row.task_id,
      type: row.type,
      actor: row.actor,
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  /* ── events ── */
  appendEvent({ type, agentId, taskId, payload = {} }) {
    const event = { eventId: this.nextEventId++, type, agentId, taskId, time: new Date().toISOString(), payload };
    this.db.prepare('INSERT INTO events(seq, json) VALUES (?, ?)').run(event.eventId, JSON.stringify(event));
    this.setMeta('nextEventId', String(this.nextEventId));
    this.events.push(event);
    this.#publish(event);
    return event;
  }
  eventsSince(eventId = 0) { return this.events.filter((e) => e.eventId > Number(eventId || 0)); }

  #publish(event) {
    for (const fn of [...(this.agentSubs.get(event.agentId) ?? [])]) { try { fn(event); } catch {} }
    if (event.taskId) for (const fn of [...(this.taskSubs.get(event.taskId) ?? [])]) { try { fn(event); } catch {} }
  }
  subscribeAgent(agentId, fn) {
    if (!this.agentSubs.has(agentId)) this.agentSubs.set(agentId, new Set());
    this.agentSubs.get(agentId).add(fn);
    return () => this.agentSubs.get(agentId)?.delete(fn);
  }
  subscribeTask(taskId, fn) {
    if (!this.taskSubs.has(taskId)) this.taskSubs.set(taskId, new Set());
    this.taskSubs.get(taskId).add(fn);
    return () => this.taskSubs.get(taskId)?.delete(fn);
  }
  waitForTask(taskId, predicate, timeoutMs) {
    const current = this.getTask(taskId);
    if (current && predicate(current)) return Promise.resolve(current);
    return new Promise((resolve) => {
      let timer = null;
      const unsubscribe = this.subscribeTask(taskId, () => {
        const task = this.getTask(taskId);
        if (task && predicate(task)) { cleanup(); resolve(task); }
      });
      const cleanup = () => { if (timer) clearTimeout(timer); unsubscribe(); };
      timer = setTimeout(() => { cleanup(); resolve(null); }, Math.max(0, timeoutMs));
      if (timer.unref) timer.unref();
    });
  }

  stats() {
    return {
      agents: this.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
      tasks: this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
      rooms: this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n,
      roomTasks: this.db.prepare('SELECT COUNT(*) AS n FROM room_tasks').get().n,
      events: this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
      storage: 'sqlite',
      file: this.dbFile,
    };
  }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

  /* ── migrations ── */
  #tableInfo(name) {
    try { return this.db.prepare(`PRAGMA table_info(${name})`).all(); } catch { return []; }
  }

  #ensureColumns() {
    const taskColumns = this.#tableInfo('room_tasks');
    if (taskColumns.length > 0 && !taskColumns.some((c) => c.name === 'verifier')) {
      this.db.exec('ALTER TABLE room_tasks ADD COLUMN verifier TEXT');
    }
  }

  #migrateOldSchema() {
    const info = this.#tableInfo('rooms');
    if (!info.some((c) => c.name === 'meta')) return;
    this.db.exec('ALTER TABLE rooms RENAME TO rooms_v1');
    try { this.db.exec('ALTER TABLE messages RENAME TO messages_v1'); } catch {}
    this.db.exec(SCHEMA);
    const oldRooms = this.db.prepare('SELECT room_id, meta FROM rooms_v1').all();
    for (const row of oldRooms) {
      let meta;
      try { meta = JSON.parse(row.meta); } catch { continue; }
      this.db.prepare('INSERT OR REPLACE INTO rooms(room_id, name, description, created_at, updated_at, next_seq) VALUES (?, ?, ?, ?, ?, ?)')
        .run(meta.id, meta.name ?? meta.id, meta.description ?? '', meta.createdAt ?? null, meta.updatedAt ?? null, meta.nextSeq ?? 1);
      const member = this.db.prepare('INSERT OR REPLACE INTO room_members(room_id, agent_id, name, role, joined_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
      for (const p of Object.values(meta.participants ?? {})) member.run(meta.id, p.agentId, p.name ?? p.agentId, p.role ?? 'member', p.joinedAt ?? null, p.lastSeen ?? null);
      const ack = this.db.prepare('INSERT OR REPLACE INTO room_acks(room_id, agent_id, ack_seq, acked_at) VALUES (?, ?, ?, ?)');
      for (const [agentId, seq] of Object.entries(meta.acks ?? {})) ack.run(meta.id, agentId, Number(seq) || 0, null);
    }
    const oldMessages = this.db.prepare('SELECT room_id, seq, json FROM messages_v1').all();
    const insertMessage = this.db.prepare(`
      INSERT OR REPLACE INTO room_messages(message_id, room_id, seq, sender_kind, sender_id, sender_name, text, type, task_id, parts_json, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of oldMessages) {
      let m; try { m = JSON.parse(row.json); } catch { continue; }
      insertMessage.run(m.messageId, row.room_id, row.seq, m.sender?.kind ?? 'agent', m.sender?.agentId ?? null, m.sender?.name ?? null, m.text ?? '', m.type ?? 'chat', m.taskId ?? null, JSON.stringify(m.parts ?? []), m.time ?? null);
    }
    try { this.db.exec('DROP TABLE rooms_v1'); } catch {}
    try { this.db.exec('DROP TABLE messages_v1'); } catch {}
    this.setMeta('schemaVersion', '2');
  }

  #migrateJsonIfEmpty() {
    const empty = this.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n === 0 &&
      this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n === 0 &&
      this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0;
    if (!empty) return;
    const state = readJson(path.join(this.dataDir, 'state.json'));
    if (!state) return;
    for (const agent of Object.values(state.agents ?? {})) this.putAgent(agent);
    for (const task of Object.values(state.tasks ?? {})) this.putTask(task);
    for (const room of Object.values(state.rooms ?? {})) this.putRoom(room);
    const events = [];
    try {
      const raw = fs.readFileSync(path.join(this.dataDir, 'events.jsonl'), 'utf8');
      for (const line of raw.split('\n')) { if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch {} }
    } catch {}
    const insert = this.db.prepare('INSERT OR IGNORE INTO events(seq, json) VALUES (?, ?)');
    for (const event of events) insert.run(event.eventId, JSON.stringify(event));
    const maxSeq = events.at(-1)?.eventId ?? 0;
    this.setMeta('nextEventId', String(Math.max(Number(state.nextEventId ?? 1), maxSeq + 1)));
    this.setMeta('migratedFrom', 'state.json');
  }
}

function safeParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function taskFromRow(row) {
  return {
    taskId: row.task_id,
    roomId: row.room_id,
    title: row.title,
    detail: row.detail ?? '',
    acceptance: row.acceptance ?? '',
    status: row.status,
    assignee: row.assignee ?? null,
    verifier: row.verifier ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    verifiedBy: row.verified_by ?? null,
    verifiedAt: row.verified_at ?? null,
  };
}
