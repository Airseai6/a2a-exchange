import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createExchangeServer } from '../src/server.mjs';
import { cleanupHub, client, registerAgent, sleep, startHub, waitFor } from './helpers.mjs';

function textMessage(text) {
  return {
    messageId: globalThis.crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text, mediaType: 'text/plain' }],
  };
}

test('two agents complete a task end-to-end and state survives a hub restart', async () => {
  const hub = await startHub();
  let restarted = null;
  try {
    const a = await registerAgent(hub.baseUrl, { id: 'a1', skills: ['qa.browser-e2e'], tags: ['qa'] });
    const b = await registerAgent(hub.baseUrl, { id: 'h2', skills: ['code.fix.html'], tags: ['code'], wakePolicy: 'task-board' });

    // discovery
    const discovered = await a.client.discover({ skill: 'qa.browser-e2e' });
    assert.ok(discovered.agents.some((x) => x.agentId === 'a1'));

    // watch h2 SSE
    const events = [];
    const controller = new AbortController();
    const feed = b.client.streamAgentEvents('h2', (event) => events.push(event), { signal: controller.signal }).catch(() => {});
    await sleep(120);

    // ask
    const sent = await a.client.sendMessage('h2', { message: textMessage('请复测 design v2 并返回报告') });
    const taskId = sent.task.id;
    assert.equal(sent.task.status.state, 'TASK_STATE_SUBMITTED');
    await waitFor(() => events.some((e) => e.event === 'task.created' && JSON.parse(e.data).task.id === taskId), { message: 'task.created' });

    // provide
    const inbox = await b.client.inbox('h2');
    assert.ok(inbox.tasks.some((t) => t.id === taskId));
    await b.client.claim('h2', taskId);
    await b.client.update('h2', taskId, {
      status: {
        state: 'TASK_STATE_COMPLETED',
        message: { messageId: globalThis.crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'E2E 30/30 通过' }] },
      },
      artifacts: [{
        artifactId: 'report-1',
        name: 'e2e-report',
        parts: [{ url: 'file:///D:/playtest/e2e-last.json', mediaType: 'application/json' }],
      }],
    });

    // result visible to asker
    const result = await a.client.getTask('h2', taskId);
    assert.equal(result.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(result.artifacts[0].name, 'e2e-report');
    assert.equal(result.history.at(-1).parts[0].text, 'E2E 30/30 通过');

    controller.abort();
    await feed;

    // persistence: restart hub on the same data dir
    await hub.hub.close();
    restarted = createExchangeServer({ dataDir: hub.dataDir });
    const { baseUrl: restartedUrl } = await restarted.listen({ host: '127.0.0.1', port: 0 });
    const afterRestart = new (await import('../sdk/client.mjs')).ExchangeClient({ baseUrl: restartedUrl });
    const persisted = await afterRestart.getTask('h2', taskId);
    assert.equal(persisted.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(persisted.artifacts[0].name, 'e2e-report');
    // cards survived too
    const card = await afterRestart.card('h2');
    assert.ok(card.skills.some((s) => s.id === 'code.fix.html'));
  } finally {
    if (restarted) {
      await restarted.close().catch(() => {});
      restarted = null;
    }
    // hub was closed manually in the happy path; guard for failures
    await hub.hub.close().catch(() => {});
    fs.rmSync(hub.dataDir, { recursive: true, force: true });
  }
});

test('returnImmediately=false waits up to syncWaitMs and marks async', async () => {
  const hub = await startHub({ syncWaitMs: 300 });
  try {
    await registerAgent(hub.baseUrl, { id: 'slow', skills: ['slow.skill'] });
    const anon = client(hub.baseUrl);
    const started = Date.now();
    const result = await anon.sendMessage('slow', {
      message: textMessage('please be slow'),
      configuration: { returnImmediately: false },
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250, `expected >=250ms wait, got ${elapsed}`);
    assert.equal(result.task.status.state, 'TASK_STATE_SUBMITTED');
    assert.equal(result.task.metadata['x-exchange'].async, true);
  } finally {
    await cleanupHub(hub);
  }
});
