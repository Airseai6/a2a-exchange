import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHub, registerAgent, sleep, startHub, waitFor } from './helpers.mjs';

let hub;
let asker;
let provider;
before(async () => {
  hub = await startHub();
  const a = await registerAgent(hub.baseUrl, { id: 'asker', skills: ['qa.browser-e2e'] });
  const b = await registerAgent(hub.baseUrl, { id: 'provider', skills: ['code.fix.html'] });
  asker = a.client;
  provider = b.client;
});
after(async () => {
  await cleanupHub(hub);
});

function textMessage(text) {
  return {
    messageId: globalThis.crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text, mediaType: 'text/plain' }],
  };
}

test('agent SSE feed emits task.created and replays by Last-Event-ID', async () => {
  await provider.heartbeat('provider');
  const events = [];
  const controller = new AbortController();
  const feed = provider.streamAgentEvents('provider', (event) => events.push(event), { signal: controller.signal }).catch(() => {});
  await sleep(120);
  const sent = await asker.sendMessage('provider', { message: textMessage('sse test') });
  await waitFor(() => events.some((e) => e.event === 'task.created' && JSON.parse(e.data).task.id === sent.task.id), { message: 'task.created SSE' });
  controller.abort();
  await feed;

  // reconnect with last event id -> replay
  const replay = [];
  const controller2 = new AbortController();
  const feed2 = provider.streamAgentEvents('provider', (event) => replay.push(event), { signal: controller2.signal, lastEventId: 0 }).catch(() => {});
  await waitFor(() => replay.some((e) => e.event === 'task.created'), { message: 'replayed task.created' });
  controller2.abort();
  await feed2;
  assert.ok(replay.some((e) => e.event === 'task.created'));
});

test('SubscribeToTask streams status updates until completion', async () => {
  const sent = await asker.sendMessage('provider', { message: textMessage('stream me') });
  const taskId = sent.task.id;
  await provider.claim('provider', taskId);

  const results = [];
  const controller = new AbortController();
  const stream = asker.streamTask('provider', taskId, (result) => results.push(result), { signal: controller.signal }).catch(() => {});
  await waitFor(() => results.some((r) => r.task), { message: 'initial task in stream' });

  await provider.update('provider', taskId, { status: { state: 'TASK_STATE_COMPLETED' } });
  await waitFor(() => results.some((r) => r.statusUpdate?.status?.state === 'TASK_STATE_COMPLETED'), { message: 'completed status event' });
  controller.abort();
  await stream;
  assert.ok(results.length >= 2);
});

test('SendStreamingMessage sends the task then live updates', async () => {
  const results = [];
  const controller = new AbortController();
  const stream = asker.sendStreamingMessage('provider', {
    message: textMessage('streaming send'),
    signal: controller.signal,
    onEvent: (result) => results.push(result),
  }).catch(() => {});
  await waitFor(() => results.some((r) => r.task), { message: 'stream initial task' });
  const taskId = results.find((r) => r.task).task.id;
  await provider.claim('provider', taskId);
  await provider.update('provider', taskId, { status: { state: 'TASK_STATE_COMPLETED' } });
  await waitFor(() => results.some((r) => r.statusUpdate?.status?.state === 'TASK_STATE_COMPLETED'), { message: 'stream completion' });
  controller.abort();
  await stream;
});
