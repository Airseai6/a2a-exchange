// Durable state + append-only event log + in-process event bus.
// M1 uses a single JSON state file (atomic writes) and a JSONL event log.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, nowIso, readJson, writeFileAtomic } from './util.mjs';

const STATE_VERSION = 1;

export class ExchangeStore {
  constructor({ dataDir }) {
    this.dataDir = path.resolve(dataDir);
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.eventsFile = path.join(this.dataDir, 'events.jsonl');
    this.state = { version: STATE_VERSION, nextEventId: 1, agents: {}, tasks: {}, rooms: {} };
    this.events = [];
    this.agentSubs = new Map();
    this.taskSubs = new Map();
  }

  load() {
    ensureDir(this.dataDir);
    const state = readJson(this.stateFile);
    if (state && state.version === STATE_VERSION) {
      this.state = {
        version: STATE_VERSION,
        nextEventId: Number(state.nextEventId) || 1,
        agents: state.agents && typeof state.agents === 'object' ? state.agents : {},
        tasks: state.tasks && typeof state.tasks === 'object' ? state.tasks : {},
        rooms: state.rooms && typeof state.rooms === 'object' ? state.rooms : {},
      };
    }
    this.events = [];
    try {
      const raw = fs.readFileSync(this.eventsFile, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // ignore a torn last line
        }
      }
    } catch {
      // no event log yet
    }
    return this;
  }

  saveState() {
    writeFileAtomic(this.stateFile, JSON.stringify(this.state) + '\n');
  }

  /* ── agents ── */
  putAgent(agent) {
    this.state.agents[agent.agentId] = agent;
    this.saveState();
    return agent;
  }

  getAgent(agentId) {
    return this.state.agents[agentId];
  }

  deleteAgent(agentId) {
    delete this.state.agents[agentId];
    this.saveState();
  }

  listAgents() {
    return Object.values(this.state.agents);
  }

  /* ── tasks ── */
  putTask(task) {
    task.updatedAt = nowIso();
    this.state.tasks[task.id] = task;
    this.saveState();
    return task;
  }

  getTask(taskId) {
    return this.state.tasks[taskId];
  }

  deleteTask(taskId) {
    delete this.state.tasks[taskId];
    this.saveState();
  }

  listTasks() {
    return Object.values(this.state.tasks);
  }

  /* ── rooms ── */
  putRoom(room) {
    room.updatedAt = nowIso();
    this.state.rooms[room.id] = room;
    this.saveState();
    return room;
  }

  getRoom(roomId) {
    return this.state.rooms[roomId];
  }

  listRooms() {
    return Object.values(this.state.rooms);
  }

  deleteRoom(roomId) {
    delete this.state.rooms[roomId];
    this.saveState();
  }

  /* ── events ── */
  appendEvent({ type, agentId, taskId, payload = {} }) {
    const event = {
      eventId: this.state.nextEventId++,
      type,
      agentId,
      taskId,
      time: nowIso(),
      payload,
    };
    ensureDir(this.dataDir);
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n');
    this.events.push(event);
    this.saveState();
    this.#publish(event);
    return event;
  }

  eventsSince(eventId = 0) {
    return this.events.filter((e) => e.eventId > Number(eventId || 0));
  }

  #publish(event) {
    const agentSubs = this.agentSubs.get(event.agentId);
    if (agentSubs) {
      for (const fn of [...agentSubs]) {
        try {
          fn(event);
        } catch {
          // subscriber errors must not break the store
        }
      }
    }
    if (event.taskId) {
      const taskSubs = this.taskSubs.get(event.taskId);
      if (taskSubs) {
        for (const fn of [...taskSubs]) {
          try {
            fn(event);
          } catch {
            // ignore
          }
        }
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

  /**
   * Resolve with the task once `predicate(task)` is true, or with null on timeout.
   * The current task is checked immediately.
   */
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
      agents: Object.keys(this.state.agents).length,
      tasks: Object.keys(this.state.tasks).length,
      rooms: Object.keys(this.state.rooms).length,
      events: this.state.nextEventId - 1,
    };
  }
}
