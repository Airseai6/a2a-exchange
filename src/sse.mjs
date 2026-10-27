// Server-side SSE helpers: agent event feed and task streams (A2A StreamResponse).
import { taskToA2A, TERMINAL_STATES } from './a2a.mjs';

export function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function sseWrite(res, { id, event, data }) {
  if (res.writableEnded) return;
  if (id !== undefined) res.write(`id: ${id}\n`);
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function sseComment(res, text = 'ping') {
  if (!res.writableEnded) res.write(`: ${text}\n\n`);
}

export function sseEnd(res) {
  if (!res.writableEnded) res.end();
}

export function attachHeartbeat(res, intervalMs = 15000) {
  const timer = setInterval(() => sseComment(res, 'heartbeat'), intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

/**
 * Agent event feed (extension): replay + live events for one agent.
 * Returns a cleanup function.
 */
export function serveAgentEvents({ store, res, agentId, lastEventId = 0 }) {
  sseHead(res);
  const sent = new Set();
  const send = (event) => {
    if (sent.has(event.eventId)) return;
    sent.add(event.eventId);
    sseWrite(res, {
      id: event.eventId,
      event: event.type,
      data: { eventId: event.eventId, type: event.type, agentId: event.agentId, taskId: event.taskId, time: event.time, ...event.payload },
    });
  };
  for (const event of store.eventsSince(lastEventId)) {
    if (event.agentId === agentId) send(event);
  }
  const unsubscribe = store.subscribeAgent(agentId, send);
  const stopHeartbeat = attachHeartbeat(res);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    stopHeartbeat();
    sseEnd(res);
  };
  res.on('close', () => {
    if (!closed) {
      closed = true;
      unsubscribe();
      stopHeartbeat();
    }
  });
  return cleanup;
}

/**
 * A2A task stream: initial Task, then TaskStatusUpdateEvent / TaskArtifactUpdateEvent /
 * Message events until the task reaches an interrupted or terminal state.
 */
export function serveTaskStream({ store, res, rpcId, taskId, initialTask }) {
  sseHead(res);
  const sentArtifacts = new Set((initialTask.artifacts ?? []).map((a) => a.artifactId));
  const sendResult = (result) => {
    sseWrite(res, { data: { jsonrpc: '2.0', id: rpcId, result } });
  };
  sendResult({ task: taskToA2A(initialTask) });

  const finish = () => {
    cleanup();
  };

  const handle = (event) => {
    if (event.taskId !== taskId) return;
    const task = store.getTask(taskId);
    if (!task) return;
    if (event.type === 'task.updated') {
      const status = event.payload?.statusUpdate?.status ?? task.status;
      sendResult({
        statusUpdate: {
          taskId: task.id,
          contextId: task.contextId,
          status,
        },
      });
      for (const artifact of task.artifacts ?? []) {
        if (sentArtifacts.has(artifact.artifactId)) continue;
        sentArtifacts.add(artifact.artifactId);
        sendResult({
          artifactUpdate: {
            taskId: task.id,
            contextId: task.contextId,
            artifact,
            append: false,
            lastChunk: true,
          },
        });
      }
      if (TERMINAL_STATES.has(task.status.state)) finish();
    } else if (event.type === 'message.created') {
      sendResult({ message: event.payload?.message ?? task.history.at(-1) });
    }
  };

  const unsubscribe = store.subscribeTask(taskId, handle);
  const stopHeartbeat = attachHeartbeat(res);
  const timeout = setTimeout(() => finish(), 5 * 60 * 1000);
  if (timeout.unref) timeout.unref();
  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    unsubscribe();
    stopHeartbeat();
    clearTimeout(timeout);
    sseEnd(res);
  }
  res.on('close', () => {
    if (!closed) {
      closed = true;
      unsubscribe();
      stopHeartbeat();
      clearTimeout(timeout);
    }
  });
  // If the task is already terminal, initial Task was the only event.
  if (TERMINAL_STATES.has(initialTask.status.state)) {
    setTimeout(() => cleanup(), 10);
  }
  return cleanup;
}
