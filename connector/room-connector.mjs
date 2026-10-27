// Room Connector: unattended delivery layer for A2A Exchange rooms.
// Polls a room, filters/batches new messages, writes a compact digest and
// optionally invokes a wake command (e.g. a DSH task-board/schedule adapter).
//
// This process NEVER calls an LLM. It is intentionally cheap: local HTTP + JSON.
//
// Usage:
//   node connector/room-connector.mjs --room fusion-data-academy \
//     --state D:\hermesWorkspace\.a2a-exchange --mentions \
//     --wake-cmd "powershell -File D:\hermesWorkspace\wake-h2.ps1"
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ExchangeClient } from '../sdk/client.mjs';

const { values: opts } = parseArgs({
  options: {
    hub: { type: 'string' },
    room: { type: 'string' },
    state: { type: 'string' },
    agent: { type: 'string' },
    interval: { type: 'string' },
    'wake-cmd': { type: 'string' },
    mentions: { type: 'boolean' },
    once: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

if (opts.help) {
  console.log(`room-connector.mjs --room <id> --state <agent-state-dir> [--mentions] [--wake-cmd "cmd"] [--interval 2000]`);
  process.exit(0);
}

const stateDir = path.resolve(opts.state ?? path.join(process.cwd(), '.a2a-exchange'));
const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'agent.json'), 'utf8'));
const hub = (opts.hub ?? state.hub ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const agentId = opts.agent ?? state.agentId;
const agentName = state.card?.name ?? agentId;
const room = opts.room ?? 'lobby';
const interval = Number(opts.interval ?? 2000);
const mentionsOnly = Boolean(opts.mentions);
const wakeCmd = opts['wake-cmd'] ?? null;
const cursorFile = path.join(stateDir, `connector-${agentId}-${room}.json`);
const spoolDir = path.join(stateDir, 'inbox');
fs.mkdirSync(spoolDir, { recursive: true });

function loadCursor() {
  try {
    return JSON.parse(fs.readFileSync(cursorFile, 'utf8')).lastSeq ?? 0;
  } catch {
    return 0;
  }
}
function saveCursor(seq) {
  fs.writeFileSync(cursorFile, JSON.stringify({ room, agentId, lastSeq: seq, updatedAt: new Date().toISOString() }, null, 2));
}
function isMentioned(message) {
  if (!mentionsOnly) return true;
  const text = String(message.text ?? '');
  return text.toLowerCase().includes('@all') ||
    text.toLowerCase().includes('@' + agentId.toLowerCase()) ||
    text.includes('@' + agentName);
}
function compact(message) {
  return { seq: message.seq, from: message.sender?.name, kind: message.sender?.kind, text: message.text, time: message.time };
}
function runWake(cmd, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: 'wake timeout' }); }, 60000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code }); });
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
  });
}

let lastSeq = loadCursor();
console.log(JSON.stringify({ ok: true, component: 'room-connector', hub, room, agentId, mentionsOnly, wake: Boolean(wakeCmd), cursor: lastSeq }));

const client = new ExchangeClient({ baseUrl: hub, agentId, agentToken: state.token });

async function tick() {
  let messages;
  try {
    const response = await fetch(hub + '/api/rooms/' + encodeURIComponent(room) + '?since=' + lastSeq + '&limit=100');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    messages = (await response.json()).messages ?? [];
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', message: 'poll failed', error: error.message }));
    return;
  }
  if (messages.length === 0) return;
  const visible = messages.filter(isMentioned);
  const nextSeq = messages.at(-1).seq;
  lastSeq = nextSeq;
  saveCursor(nextSeq);
  if (visible.length === 0) {
    console.log(JSON.stringify({ level: 'skip', count: messages.length, reason: 'no-mention' }));
    return;
  }
  const digest = {
    roomId: room,
    for: agentId,
    createdAt: new Date().toISOString(),
    messages: visible.map(compact),
  };
  const file = path.join(spoolDir, `${room}-${visible[0].seq}-${visible.at(-1).seq}.json`);
  fs.writeFileSync(file, JSON.stringify(digest, null, 2));
  console.log(JSON.stringify({ level: 'deliver', count: visible.length, file }));
  if (wakeCmd) {
    const result = await runWake(wakeCmd, {
      A2A_AGENT: agentId,
      A2A_ROOM: room,
      A2A_MESSAGE_FILE: file,
      A2A_LAST_SEQ: String(nextSeq),
    });
    console.log(JSON.stringify({ level: 'wake', ok: result.ok, ...result }));
  }
}

do {
  await tick();
  if (!opts.once) await new Promise((resolve) => setTimeout(resolve, interval));
} while (!opts.once);
