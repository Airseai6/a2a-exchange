// Minimal polling connector (M1 fallback for waking an idle session).
// It registers/heartbeats as an agent, polls the inbox, claims tasks and auto-answers.
// This is intentionally dumb: M2 replaces it with a DSH plugin that can run
// task-board cards / schedules to wake the real session.
//
// Usage:
//   node connector/agent.mjs --state ./.a2a-exchange/agent.json --interval 5000 \
//     --auto-reply "收到，正在处理（connector 自动回复）"
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { ExchangeClient } from '../sdk/client.mjs';

const { values: opts } = parseArgs({
  options: {
    hub: { type: 'string' },
    state: { type: 'string' },
    agent: { type: 'string' },
    interval: { type: 'string' },
    'auto-reply': { type: 'string' },
    'heartbeat-ttl': { type: 'string' },
    once: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (opts.help) {
  console.log(`connector/agent.mjs --state <agent.json> [--interval 5000] [--auto-reply text] [--once]

Reads the agent state written by \`a2a-exchange register\`, connects to the hub,
heartbeats, polls its inbox and auto-completes new tasks.`);
  process.exit(0);
}

const statePath = path.resolve(opts.state ?? path.join(process.cwd(), '.a2a-exchange', 'agent.json'));
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const baseUrl = opts.hub ?? state.hub;
const agentId = opts.agent ?? state.agentId;
const interval = Number(opts.interval ?? 5000);
const autoReply = opts['auto-reply'] ?? `[auto-connector] 收到任务，已由 ${agentId} 自动确认。`;
const client = new ExchangeClient({ baseUrl, agentId, agentToken: state.token });

let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
  console.log('\n[connector] stopping');
  process.exit(0);
});

async function tick() {
  await client.heartbeat(agentId);
  const inbox = await client.inbox(agentId);
  for (const task of inbox.tasks) {
    if (task.status.state !== 'TASK_STATE_SUBMITTED') continue;
    console.log(`[connector] claim ${task.id}`);
    await client.claim(agentId, task.id);
    const lastUserText = (task.history ?? []).filter((m) => m.role === 'ROLE_USER').at(-1)?.parts?.find((p) => p.text)?.text;
    await client.update(agentId, task.id, {
      status: {
        state: 'TASK_STATE_COMPLETED',
        message: {
          messageId: crypto.randomUUID(),
          role: 'ROLE_AGENT',
          parts: [{ text: `${autoReply}\n\n收到内容：${lastUserText ?? '(非文本)'}` }],
        },
      },
    });
    console.log(`[connector] completed ${task.id}`);
  }
}

do {
  try {
    await tick();
  } catch (error) {
    console.error('[connector] error:', error.message);
  }
  if (opts.once) break;
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, interval));
} while (!stopped);
