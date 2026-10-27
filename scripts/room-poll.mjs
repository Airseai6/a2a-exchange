// Token-free room poller for cron.
// Exit 0 = no pending mention; exit 10 = pending mention(s) found.
// A shell-only cron can run this every 5 minutes and only wake the agent on exit 10.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    room: { type: 'string' },
    state: { type: 'string' },
    hub: { type: 'string' },
    agent: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});
if (opts.help || !opts.room) {
  console.log('room-poll.mjs --room <id> [--state <agent-dir-or-json>] [--hub url] [--agent id]');
  process.exit(2);
}
const statePath = opts.state
  ? path.resolve(opts.state.endsWith('.json') ? opts.state : path.join(opts.state, 'agent.json'))
  : path.resolve('.a2a-exchange/agent.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const hub = String(opts.hub ?? state.hub ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const agentId = String(opts.agent ?? state.agentId);
const agentName = state.card?.name ?? agentId;
const roomId = String(opts.room);
const response = await fetch(`${hub}/api/rooms/${encodeURIComponent(roomId)}/pending?agentId=${encodeURIComponent(agentId)}`);
if (!response.ok) {
  console.log(JSON.stringify({ wake: false, error: `HTTP ${response.status}` }));
  process.exit(0);
}
const data = await response.json();
const result = {
  wake: data.pendingCount > 0,
  roomId,
  agentId,
  lastSeq: data.lastSeq,
  unreadCount: data.pendingCount,
  pendingCount: data.pendingCount,
  pending: data.pendingForMe ?? [],
};
console.log(JSON.stringify(result));
process.exit(result.wake ? 10 : 0);
