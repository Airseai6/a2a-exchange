// Loopback wake listener for A2A Exchange webhooks.
//
// The platform POSTs {"event":"room.message",...} when an agent is @mentioned.
// This listener safely spawns the configured wake command (e.g. hermes.exe)
// without blocking the HTTP response and without an LLM turn for empty rooms.
//
// Example (Hermes):
//   node scripts/wake-http-listener.mjs --port 8790 --path /a2a-wake `
//     --exec "C:\Users\Q\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe" `
//     --exec-arg -z --exec-arg "{prompt}" --exec-arg --yolo --exec-arg --accept-hooks
import http from 'node:http';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string' },
    path: { type: 'string' },
    exec: { type: 'string' },
    'exec-arg': { type: 'string', multiple: true },
    cwd: { type: 'string' },
    secret: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});
if (opts.help) {
  console.log('wake-http-listener.mjs --port 8790 --path /a2a-wake --exec <cmd> [--exec-arg <arg>]... [--secret <token>] [--dry-run]');
  process.exit(0);
}
const port = Number(opts.port ?? 8790);
const path = opts.path ?? '/a2a-wake';
const exec = opts.exec;
const execArgs = opts['exec-arg'] ?? [];
const secret = opts.secret;
if (!exec && !opts['dry-run']) {
  console.error('missing --exec (or pass --dry-run)');
  process.exit(2);
}

function buildPrompt(payload) {
  const text = String(payload?.text ?? '').slice(0, 4000);
  return [
    `[A2A Exchange] 房间 ${payload?.roomId ?? '?'} 收到新消息 seq=${payload?.seq ?? '?'}（来自 ${payload?.from ?? 'unknown'}）。`,
    '请用 a2a-room skill 进入房间，只处理与你相关的部分，处理后 room send 回复并用 room status --ack 标记已读。',
    '',
    text,
  ].join('\n');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url.split('?')[0] !== path) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  if (secret && req.headers['x-a2a-secret'] !== secret) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    return res.end('unauthorized');
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch {}
    if (payload.event !== 'room.message') {
      res.writeHead(202, { 'content-type': 'application/json' });
      return res.end('{"ok":true,"ignored":true}');
    }
    const prompt = buildPrompt(payload);
    console.log(`[wake-listener] seq=${payload.seq} room=${payload.roomId} from=${payload.from}`);
    if (exec) {
      const args = execArgs.map((arg) => arg.replaceAll('{prompt}', prompt));
      try {
        const child = spawn(exec, args, { cwd: opts.cwd ?? process.cwd(), detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } catch (error) {
        console.error('[wake-listener] spawn failed:', error?.message);
      }
    } else {
      console.log(JSON.stringify({ dryRun: true, prompt }, null, 2));
    }
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`[wake-listener] listening http://127.0.0.1:${port}${path}${opts['dry-run'] ? ' (dry-run)' : ''}`);
});
