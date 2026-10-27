// SQLite-backed store (WAL). Same public API as ExchangeStore so the rest of
// the platform does not care which backend is active.
//
// Tables:
//   agents(agent_id, json)
//   tasks(task_id, json)
//   rooms(room_id, meta)          -- room without messages
//   messages(room_id, seq, json)  -- durable ordered room messages
//   events(seq, json)             -- A2A event log
//   meta(key, value)
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson } from './util.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, meta TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (room_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (room_id, seq));
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
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
    this.db.exec(SCHEMA);
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

  open() {
    return this;
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  /* ── agents ── */
  putAgent(agent) {
    this.db.prepare('INSERT INTO agents(agent_id, json) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET json = excluded.json').run(agent.agentId, JSON.stringify(agent));
    return agent;
  }

  getAgent(agentId) {
    const row = this.db.prepare('SELECT json FROM agents WHERE agent_id = ?').get(agentId);
    return row ? JSON.parse(row.json) : undefined;
  }

  deleteAgent(agentId) {
    this.db.prepare('DELETE FROM agents WHERE agent_id = ?').run(agentId);
  }

  listAgents() {
    return this.db.prepare('SELECT json FROM agents').all().map((row) => JSON.parse(row.json));
  }

  /* ── tasks ── */
  putTask(task) {
    this.db.prepare('INSERT INTO tasks(task_id, json) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET json = excluded.json').run(task.id, JSON.stringify(task));
    return task;
  }

  getTask(taskId) {
    const row = this.db.prepare('SELECT json FROM tasks WHERE task_id = ?').get(taskId);
    return row ? JSON.parse(row.json) : undefined;
  }

  deleteTask(taskId) {
    this.db.prepare('DELETE FROM tasks WHERE task_id = ?').run(taskId);
  }

  listTasks() {
    return this.db.prepare('SELECT json FROM tasks').all().map((row) => JSON.parse(row.json));
  }

  /* ── rooms ── */
  putRoom(room) {
    const meta = { ...room };
    delete meta.messages;
    this.db.prepare('INSERT INTO rooms(room_id, meta) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET meta = excluded.meta').run(room.id, JSON.stringify(meta));
    const saved = Number(room._savedSeq ?? 0);
    const insert = this.db.prepare('INSERT OR REPLACE INTO messages(room_id, seq, json) VALUES (?, ?, ?)');
    for (const message of room.messages ?? []) {
      if (Number(message.seq) <= saved) continue;
      insert.run(room.id, message.seq, JSON.stringify(message));
    }
    room._savedSeq = Math.max(saved, ...(room.messages ?? []).map((m) => Number(m.seq) || 0), 0);
    return room;
  }

  getRoom(roomId) {
    const row = this.db.prepare('SELECT meta FROM rooms WHERE room_id = ?').get(roomId);
    if (!row) return undefined;
    const meta = JSON.parse(row.meta);
    const messages = this.db.prepare('SELECT json FROM messages WHERE room_id = ? ORDER BY seq').all(roomId).map((r) => JSON.parse(r.json));
    const room = { ...meta, messages };
    Object.defineProperty(room, '_savedSeq', { value: messages.at(-1)?.seq ?? 0, writable: true, enumerable: false });
    return room;
  }

  listRooms() {
    return this.db.prepare('SELECT room_id FROM rooms').all().map((row) => this.getRoom(row.room_id));
  }

  deleteRoom(roomId) {
    this.db.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId);
    this.db.prepare('DELETE FROM rooms WHERE room_id = ?').run(roomId);
  }

  /* ── events ── */
  appendEvent({ type, agentId, taskId, payload = {} }) {
    const event = {
      eventId: this.nextEventId++,
      type,
      agentId,
      taskId,
      time: new Date().toISOString(),
      payload,
    };
    this.db.prepare('INSERT INTO events(seq, json) VALUES (?, ?)').run(event.eventId, JSON.stringify(event));
    this.setMeta('nextEventId', String(this.nextEventId));
    this.events.push(event);
    this.#publish(event);
    return event;
  }

  eventsSince(eventId = 0) {
    return this.events.filter((e) => e.eventId > Number(eventId || 0));
  }

  #publish(event) {
    for (const fn of [...(this.agentSubs.get(event.agentId) ?? [])]) {
      try { fn(event); } catch {}
    }
    if (event.taskId) {
      for (const fn of [...(this.taskSubs.get(event.taskId) ?? [])]) {
        try { fn(event); } catch {}
      }
    }
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
        if (task && predicate(task)) {
          cleanup();
          resolve(task);
        }
      });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
      };
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, Math.max(0, timeoutMs));
      if (timer.unref) timer.unref();
    });
  }

  stats() {
    return {
      agents: this.db.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
      tasks: this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
      rooms: this.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n,
      events: this.db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
      storage: 'sqlite',
      file: this.dbFile,
    };
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row?.value;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  /* ── one-time import from state.json/events.jsonl ── */
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
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    } catch {}
    const insert = this.db.prepare('INSERT OR IGNORE INTO events(seq, json) VALUES (?, ?)');
    for (const event of events) insert.run(event.eventId, JSON.stringify(event));
    const maxSeq = events.at(-1)?.eventId ?? 0;
    this.setMeta('nextEventId', String(Math.max(Number(state.nextEventId ?? 1), maxSeq + 1)));
    if (events.length) this.setMeta('migratedFrom', 'state.json');
  }
}
