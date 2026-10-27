import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHub, client, registerAgent, startHub } from './helpers.mjs';

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

test('SendMessage creates a task in TASK_STATE_SUBMITTED', async () => {
  const result = await asker.sendMessage('provider', { message: textMessage('do the thing') });
  assert.ok(result.task.id);
  assert.equal(result.task.status.state, 'TASK_STATE_SUBMITTED');
  assert.equal(result.task.history.length, 1);
  assert.equal(result.task.history[0].role, 'ROLE_USER');
  assert.ok(result.task.contextId);
});

test('GetTask and ListTasks return the task', async () => {
  const sent = await asker.sendMessage('provider', { message: textMessage('list me') });
  const got = await asker.getTask('provider', sent.task.id);
  assert.equal(got.id, sent.task.id);
  const list = await asker.listTasks('provider', { includeArtifacts: false });
  assert.ok(list.tasks.some((t) => t.id === sent.task.id));
  assert.ok(list.totalSize >= 1);
  assert.equal(list.pageSize > 0, true);
});

test('agent inbox/claim/progress/complete flow updates the task', async () => {
  const sent = await asker.sendMessage('provider', { message: textMessage('fix it') });
  const taskId = sent.task.id;

  const inbox = await provider.inbox('provider');
  assert.ok(inbox.tasks.some((t) => t.id === taskId));

  const claimed = await provider.claim('provider', taskId);
  assert.equal(claimed.status.state, 'TASK_STATE_WORKING');

  const progress = await provider.update('provider', taskId, {
    status: {
      state: 'TASK_STATE_WORKING',
      message: { messageId: globalThis.crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'working' }] },
    },
  });
  assert.equal(progress.status.state, 'TASK_STATE_WORKING');

  const completed = await provider.update('provider', taskId, {
    status: {
      state: 'TASK_STATE_COMPLETED',
      message: { messageId: globalThis.crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'done' }] },
    },
    artifacts: [{
      artifactId: 'report-1',
      name: 'report',
      parts: [{ url: 'file:///tmp/report.md', mediaType: 'text/markdown' }],
    }],
  });
  assert.equal(completed.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(completed.artifacts.length, 1);

  const final = await asker.getTask('provider', taskId);
  assert.equal(final.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(final.artifacts[0].name, 'report');
  assert.equal(final.history.at(-1).role, 'ROLE_AGENT');
});

test('terminal tasks reject further updates and cancellation', async () => {
  const sent = await asker.sendMessage('provider', { message: textMessage('will fail') });
  const taskId = sent.task.id;
  await provider.claim('provider', taskId);
  await provider.update('provider', taskId, { status: { state: 'TASK_STATE_COMPLETED' } });
  await assert.rejects(() => provider.update('provider', taskId, { status: { state: 'TASK_STATE_WORKING' } }), /terminal/i);
  await assert.rejects(() => asker.cancelTask('provider', taskId), /terminal/i);
});

test('CancelTask cancels a submitted task', async () => {
  const sent = await asker.sendMessage('provider', { message: textMessage('cancel me') });
  const canceled = await asker.cancelTask('provider', sent.task.id);
  assert.equal(canceled.status.state, 'TASK_STATE_CANCELED');
});

test('second agent cannot claim another agent task', async () => {
  const sent = await asker.sendMessage('provider', { message: textMessage('mine') });
  await provider.claim('provider', sent.task.id);
  const other = await registerAgent(hub.baseUrl, { id: 'intruder', skills: ['x.y'] });
  await assert.rejects(() => other.client.claim('intruder', sent.task.id), /another agent|forbidden/i);
});

test('invalid messages and unknown agents return JSON-RPC errors', async () => {
  await assert.rejects(
    () => asker.sendMessage('provider', { message: { role: 'ROLE_USER', parts: [] } }),
    /parts must not be empty/i,
  );
  await assert.rejects(() => asker.getTask('provider', 'no-such-task'), /Task not found/i);
  await assert.rejects(() => asker.sendMessage('no-such-agent', { message: textMessage('hi') }), /Agent not found/i);
});

test('GetExtendedAgentCard and reply work', async () => {
  const card = await asker.extendedCard('provider');
  assert.equal(card.name, 'provider agent');
  const sent = await asker.sendMessage('provider', { message: textMessage('reply please') });
  const acked = await provider.reply('provider', sent.task.id, 'on it');
  assert.equal(acked.history.at(-1).parts[0].text, 'on it');
});
