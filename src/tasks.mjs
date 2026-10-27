// A2A task service: SendMessage, task lifecycle, agent-side inbox/claim/update/reply.
import {
  buildTask,
  INTERRUPTED_STATES,
  makeTextPart,
  normalizeMessage,
  normalizePart,
  normalizeState,
  TASK_STATES,
  TERMINAL_STATES,
  taskToA2A,
} from './a2a.mjs';
import { deepClone, nowIso, pick, RpcError, uuid } from './util.mjs';

const MAX_BODY_CHARS = 512 * 1024;

export class TaskService {
  constructor(store, registry) {
    this.store = store;
    this.registry = registry;
  }

  /* ── A2A: SendMessage ── */
  async sendMessage(agentId, params = {}) {
    const agent = this.registry.requireAgent(agentId);
    if (!params.message) throw new RpcError(-32602, 'message is required', { a2aCode: 'INVALID_ARGUMENT' });
    const message = normalizeMessage(params.message, { role: 'ROLE_USER' });
    message.role = 'ROLE_USER';

    const taskId = pick(message, 'taskId', 'task_id');
    let task;
    if (taskId) {
      task = this.#requireTask(taskId);
      if (task.agentId !== agentId) {
        throw new RpcError(-32003, 'Task belongs to another agent', { a2aCode: 'TASK_FORBIDDEN' });
      }
      if (task.status.state && TERMINAL_STATES.has(task.status.state)) {
        throw new RpcError(-32002, 'Task is already terminal', { a2aCode: 'TASK_TERMINAL' });
      }
      message.taskId = task.id;
      message.contextId = task.contextId;
      task.history.push(message);
      if (INTERRUPTED_STATES.has(task.status.state)) {
        task.status = { state: 'TASK_STATE_WORKING', timestamp: nowIso(), message: undefined };
      }
      this.store.putTask(task);
      this.store.appendEvent({
        type: 'message.created',
        agentId,
        taskId: task.id,
        payload: { taskId: task.id, message, task: taskToA2A(task) },
      });
      return { task: taskToA2A(task) };
    }

    const contextId = message.contextId || uuid();
    message.contextId = contextId;
    const newTask = buildTask({ taskId: uuid(), contextId, message, agentId, wakePolicy: agent.wakePolicy });
    newTask.agentId = agentId;
    newTask.claimedBy = null;
    newTask.createdAt = nowIso();
    message.taskId = newTask.id;
    this.store.putTask(newTask);
    this.store.appendEvent({
      type: 'task.created',
      agentId,
      taskId: newTask.id,
      payload: { taskId: newTask.id, task: taskToA2A(newTask) },
    });

    const configuration = params.configuration ?? {};
    const returnImmediately = pick(configuration, 'returnImmediately', 'return_immediately') === true;
    const syncWaitMs = Math.min(Math.max(Number(agent.syncWaitMs ?? 20000), 0), 120000);
    if (returnImmediately || syncWaitMs === 0) {
      return { task: taskToA2A(newTask) };
    }
    const settled = await this.store.waitForTask(
      newTask.id,
      (t) => TERMINAL_STATES.has(t.status.state) || INTERRUPTED_STATES.has(t.status.state),
      syncWaitMs,
    );
    const current = settled ?? this.store.getTask(newTask.id) ?? newTask;
    if (!settled) {
      current.metadata = {
        ...(current.metadata ?? {}),
        'x-exchange': {
          ...(current.metadata?.['x-exchange'] ?? {}),
          async: true,
          syncWaitMs,
        },
      };
      this.store.putTask(current);
    }
    return { task: taskToA2A(current) };
  }

  /* ── A2A: GetTask ── */
  getTask(params = {}) {
    const taskId = pick(params, 'id', 'taskId', 'task_id');
    if (!taskId) throw new RpcError(-32602, 'id is required', { a2aCode: 'INVALID_ARGUMENT' });
    const task = this.#requireTask(taskId);
    const out = taskToA2A(task);
    const historyLength = pick(params, 'historyLength', 'history_length');
    if (historyLength !== undefined) out.history = (out.history ?? []).slice(-Math.max(0, Number(historyLength)));
    return out;
  }

  /* ── A2A: ListTasks ── */
  listTasks(params = {}) {
    const contextId = pick(params, 'contextId', 'context_id');
    const status = pick(params, 'status');
    const pageSize = Math.min(Math.max(Number(pick(params, 'pageSize', 'page_size') ?? 50), 1), 100);
    const pageToken = pick(params, 'pageToken', 'page_token');
    const includeArtifacts = pick(params, 'includeArtifacts', 'include_artifacts') === true;
    const historyLength = pick(params, 'historyLength', 'history_length');
    const offset = pageToken ? Number(Buffer.from(String(pageToken), 'base64url').toString()) || 0 : 0;
    let tasks = this.store.listTasks();
    if (contextId) tasks = tasks.filter((t) => t.contextId === contextId);
    if (status) {
      const wanted = normalizeState(status);
      tasks = tasks.filter((t) => t.status.state === wanted);
    }
    tasks.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    const totalSize = tasks.length;
    const page = tasks.slice(offset, offset + pageSize).map((t) => {
      const out = taskToA2A(t);
      if (!includeArtifacts) out.artifacts = [];
      if (historyLength !== undefined) out.history = (out.history ?? []).slice(-Math.max(0, Number(historyLength)));
      return out;
    });
    const nextOffset = offset + page.length;
    return {
      tasks: page,
      nextPageToken: nextOffset < totalSize ? Buffer.from(String(nextOffset)).toString('base64url') : '',
      pageSize,
      totalSize,
    };
  }

  /* ── A2A: CancelTask ── */
  cancelTask(params = {}) {
    const taskId = pick(params, 'id', 'taskId', 'task_id');
    if (!taskId) throw new RpcError(-32602, 'id is required', { a2aCode: 'INVALID_ARGUMENT' });
    const task = this.#requireTask(taskId);
    if (TERMINAL_STATES.has(task.status.state)) {
      throw new RpcError(-32002, 'Task is already terminal', { a2aCode: 'TASK_NOT_CANCELABLE' });
    }
    const message = {
      messageId: uuid(),
      role: 'ROLE_AGENT',
      parts: [makeTextPart('Task canceled by client.')],
      taskId: task.id,
      contextId: task.contextId,
    };
    task.history.push(message);
    task.status = { state: 'TASK_STATE_CANCELED', timestamp: nowIso(), message };
    this.store.putTask(task);
    this.store.appendEvent({
      type: 'task.updated',
      agentId: task.agentId,
      taskId: task.id,
      payload: { taskId: task.id, task: taskToA2A(task), statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } },
    });
    return taskToA2A(task);
  }

  /* ── extension: inbox ── */
  inbox(agentId, params = {}) {
    this.registry.requireAgent(agentId);
    const stateFilter = pick(params, 'state');
    const states = stateFilter
      ? (Array.isArray(stateFilter) ? stateFilter : [stateFilter]).map(normalizeState)
      : null;
    const pageSize = Math.min(Math.max(Number(pick(params, 'pageSize', 'page_size') ?? 50), 1), 100);
    const pageToken = pick(params, 'pageToken', 'page_token');
    const offset = pageToken ? Number(Buffer.from(String(pageToken), 'base64url').toString()) || 0 : 0;
    let tasks = this.store.listTasks().filter((t) => t.agentId === agentId);
    tasks = states
      ? tasks.filter((t) => states.includes(t.status.state))
      : tasks.filter((t) => !TERMINAL_STATES.has(t.status.state));
    tasks.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    const totalSize = tasks.length;
    const page = tasks.slice(offset, offset + pageSize).map(taskToA2A);
    const nextOffset = offset + page.length;
    return {
      tasks: page,
      nextPageToken: nextOffset < totalSize ? Buffer.from(String(nextOffset)).toString('base64url') : '',
      pageSize,
      totalSize,
    };
  }

  /* ── extension: claim ── */
  claim(agentId, params = {}) {
    this.registry.requireAgent(agentId);
    const task = this.#requireTask(pick(params, 'taskId', 'task_id', 'id'));
    if (task.agentId !== agentId) {
      throw new RpcError(-32003, 'Task belongs to another agent', { a2aCode: 'TASK_FORBIDDEN' });
    }
    if (TERMINAL_STATES.has(task.status.state)) {
      throw new RpcError(-32002, 'Task is already terminal', { a2aCode: 'TASK_TERMINAL' });
    }
    if (task.claimedBy && task.claimedBy !== agentId) {
      throw new RpcError(-32003, 'Task already claimed by another agent', { a2aCode: 'TASK_FORBIDDEN' });
    }
    task.claimedBy = agentId;
    task.status = { state: 'TASK_STATE_WORKING', timestamp: nowIso() };
    this.store.putTask(task);
    this.store.appendEvent({
      type: 'task.updated',
      agentId,
      taskId: task.id,
      payload: { taskId: task.id, task: taskToA2A(task), statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } },
    });
    return taskToA2A(task);
  }

  /* ── extension: update ── */
  update(agentId, params = {}) {
    this.registry.requireAgent(agentId);
    const task = this.#requireTask(pick(params, 'taskId', 'task_id', 'id'));
    if (task.agentId !== agentId) {
      throw new RpcError(-32003, 'Task belongs to another agent', { a2aCode: 'TASK_FORBIDDEN' });
    }
    const rawStatus = pick(params, 'status');
    const rawState = typeof rawStatus === 'string' ? rawStatus : pick(rawStatus ?? {}, 'state');
    if (rawState !== undefined) {
      const state = normalizeState(rawState);
      if (!TASK_STATES.includes(state)) {
        throw new RpcError(-32602, `Invalid task state: ${rawState}`, { a2aCode: 'INVALID_ARGUMENT' });
      }
      if (TERMINAL_STATES.has(task.status.state) && state !== task.status.state) {
        throw new RpcError(-32002, `Task is already terminal (${task.status.state})`, { a2aCode: 'TASK_TERMINAL' });
      }
      const status = { state, timestamp: nowIso() };
      const rawMessage = pick(rawStatus ?? {}, 'message');
      if (rawMessage) {
        status.message = normalizeMessage(rawMessage, { role: 'ROLE_AGENT', taskId: task.id, contextId: task.contextId });
        task.history.push(status.message);
      }
      task.status = status;
    }
    const artifacts = pick(params, 'artifacts');
    if (artifacts !== undefined) {
      this.#validateArtifacts(artifacts);
      const byId = new Map((task.artifacts ?? []).map((a) => [a.artifactId, a]));
      for (const artifact of artifacts) byId.set(artifact.artifactId, artifact);
      task.artifacts = [...byId.values()];
    }
    const history = pick(params, 'history');
    if (history !== undefined) {
      if (!Array.isArray(history)) throw new RpcError(-32602, 'history must be an array', { a2aCode: 'INVALID_ARGUMENT' });
      for (const message of history) {
        task.history.push(normalizeMessage(message, { role: 'ROLE_AGENT', taskId: task.id, contextId: task.contextId }));
      }
    }
    const text = pick(params, 'text');
    if (text !== undefined && !history && !rawStatus?.message) {
      task.history.push({
        messageId: uuid(),
        role: 'ROLE_AGENT',
        parts: [makeTextPart(String(text))],
        taskId: task.id,
        contextId: task.contextId,
      });
    }
    this.store.putTask(task);
    const final = TERMINAL_STATES.has(task.status.state) || INTERRUPTED_STATES.has(task.status.state);
    this.store.appendEvent({
      type: 'task.updated',
      agentId,
      taskId: task.id,
      payload: {
        taskId: task.id,
        task: taskToA2A(task),
        statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status },
        ...(final ? { final: true } : {}),
      },
    });
    return taskToA2A(task);
  }

  /* ── extension: reply ── */
  reply(agentId, params = {}) {
    this.registry.requireAgent(agentId);
    const task = this.#requireTask(pick(params, 'taskId', 'task_id', 'id'));
    if (task.agentId !== agentId) {
      throw new RpcError(-32003, 'Task belongs to another agent', { a2aCode: 'TASK_FORBIDDEN' });
    }
    let message = pick(params, 'message');
    if (message) {
      message = normalizeMessage(message, { role: 'ROLE_AGENT', taskId: task.id, contextId: task.contextId });
    } else {
      const text = pick(params, 'text');
      if (!text) throw new RpcError(-32602, 'message or text is required', { a2aCode: 'INVALID_ARGUMENT' });
      message = {
        messageId: uuid(),
        role: 'ROLE_AGENT',
        parts: [makeTextPart(String(text))],
        taskId: task.id,
        contextId: task.contextId,
      };
    }
    task.history.push(message);
    this.store.putTask(task);
    this.store.appendEvent({
      type: 'message.created',
      agentId,
      taskId: task.id,
      payload: { taskId: task.id, message, task: taskToA2A(task) },
    });
    return taskToA2A(task);
  }

  /* ── extension: info ── */
  info(agentId) {
    const agent = this.registry.requireAgent(agentId);
    const tasks = this.store.listTasks().filter((t) => t.agentId === agentId);
    return {
      agentId,
      status: !agent.lastSeen ? 'idle' : 'online',
      lastHeartbeat: agent.lastSeen ?? null,
      pendingTasks: tasks.filter((t) => !TERMINAL_STATES.has(t.status.state)).length,
      totalTasks: tasks.length,
      cardUrl: `${this.registry.baseUrl}/agents/${agentId}/.well-known/agent-card.json`,
    };
  }

  /* ── helpers ── */
  #requireTask(taskId) {
    if (!taskId) throw new RpcError(-32602, 'taskId is required', { a2aCode: 'INVALID_ARGUMENT' });
    const task = this.store.getTask(String(taskId));
    if (!task) throw new RpcError(-32004, `Task not found: ${taskId}`, { a2aCode: 'TASK_NOT_FOUND' });
    return task;
  }

  #validateArtifacts(artifacts) {
    if (!Array.isArray(artifacts)) {
      throw new RpcError(-32602, 'artifacts must be an array', { a2aCode: 'INVALID_ARGUMENT' });
    }
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object') throw new RpcError(-32602, 'Invalid artifact', { a2aCode: 'INVALID_ARGUMENT' });
      if (typeof artifact.artifactId !== 'string' || !artifact.artifactId) {
        throw new RpcError(-32602, 'artifact.artifactId is required', { a2aCode: 'INVALID_ARGUMENT' });
      }
      if (!Array.isArray(artifact.parts) || artifact.parts.length === 0) {
        throw new RpcError(-32602, 'artifact.parts must not be empty', { a2aCode: 'INVALID_ARGUMENT' });
      }
      artifact.parts = artifact.parts.map(normalizePart);
      if (JSON.stringify(artifact).length > MAX_BODY_CHARS) {
        throw new RpcError(-32602, 'artifact too large for M1 (use url parts)', { a2aCode: 'INVALID_ARGUMENT' });
      }
    }
  }
}
