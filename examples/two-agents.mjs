// Two simulated agents exchange one task end-to-end.
// Run: node examples/two-agents.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExchangeServer } from '../src/server.mjs';
import { ExchangeClient } from '../sdk/client.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-exchange-demo-'));
const server = createExchangeServer({ dataDir });
const { baseUrl } = await server.listen({ port: 0 });
console.log(`[hub] ${baseUrl}`);

const a = new ExchangeClient({ baseUrl });
const b = new ExchangeClient({ baseUrl });

const regA = await a.register({
  agentId: 'a1',
  name: 'A1 · QA Agent',
  description: 'Runs browser E2E for interactive web games.',
  skills: [{ id: 'qa.browser-e2e', name: 'Browser E2E', description: 'Playwright/CDP based validation', tags: ['qa', 'browser'] }],
  wakePolicy: 'none',
});
a.agentToken = regA.token;
a.agentId = 'a1';

const regB = await b.register({
  agentId: 'h2',
  name: 'H2 · Fixer',
  description: 'Fixes single-file HTML interactive demos.',
  skills: [{ id: 'code.fix.html', name: 'Fix HTML', description: 'Repair self-contained HTML games', tags: ['code', 'html'] }],
  wakePolicy: 'task-board',
});
b.agentToken = regB.token;
b.agentId = 'h2';

console.log(`[registry] a1 card: ${baseUrl}/agents/a1/.well-known/agent-card.json`);
const found = await a.discover({ skill: 'qa.browser-e2e' });
console.log(`[discover] qa.browser-e2e -> ${found.agents.map((x) => `${x.agentId}(${x.status})`).join(', ')}`);

// Watch H2's SSE feed before sending the task.
const events = [];
const controller = new AbortController();
const feed = b
  .streamAgentEvents('h2', (event) => {
    events.push(event.event);
    console.log(`[sse:h2] ${event.event} #${event.id}`);
  }, { signal: controller.signal })
  .catch(() => {});
await new Promise((r) => setTimeout(r, 120));

const sent = await a.sendMessage('h2', {
  message: {
    messageId: globalThis.crypto.randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: '请复测 design v2，并把报告作为产物返回。', mediaType: 'text/plain' }],
  },
});
const taskId = sent.task.id;
console.log(`[a1] sent task ${taskId} state=${sent.task.status.state}`);

const inbox = await b.inbox('h2');
console.log(`[h2] inbox: ${inbox.tasks.length} task(s)`);
await b.claim('h2', taskId);
await b.update('h2', taskId, {
  status: { state: 'TASK_STATE_WORKING', message: { messageId: globalThis.crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: '正在跑 E2E…' }] } },
});
const done = await b.update('h2', taskId, {
  status: { state: 'TASK_STATE_COMPLETED', message: { messageId: globalThis.crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'E2E 30/30 通过。' }] } },
  artifacts: [{
    artifactId: 'report-1',
    name: 'E2E report',
    parts: [{ url: 'file:///D:/DSHWorkspace/playtest/e2e-last.json', mediaType: 'application/json' }],
  }],
});
console.log(`[h2] task=${done.status.state} artifacts=${done.artifacts.length}`);

const result = await a.getTask('h2', taskId);
console.log(`[a1] result=${result.status.state} last=${result.history.at(-1)?.parts?.[0]?.text}`);
console.log(`[sse] events seen by h2: ${[...new Set(events)].join(', ')}`);

controller.abort();
await feed;
await server.close();
fs.rmSync(dataDir, { recursive: true, force: true });

if (result.status.state !== 'TASK_STATE_COMPLETED') {
  console.error('demo failed');
  process.exit(1);
}
console.log('\nOK: two agents completed one A2A task end-to-end.');
