// CLI: serve / register / discover / send / inbox / claim / answer / reply / task ...
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { PROTOCOL_VERSION } from './a2a.mjs';
import { createExchangeServer } from './server.mjs';
import { ExchangeClient, ExchangeError } from '../sdk/client.mjs';
import { ensureDir, nowIso, readJson, writeFileAtomic } from './util.mjs';

const DEFAULT_HUB = process.env.A2A_EXCHANGE_HUB || 'http://127.0.0.1:8787';

const options = {
  hub: { type: 'string' },
  state: { type: 'string' },
  token: { type: 'string' },
  agent: { type: 'string' },
  'agent-token': { type: 'string' },
  'agent-id': { type: 'string' },
  name: { type: 'string' },
  description: { type: 'string' },
  version: { type: 'string' },
  skill: { type: 'string', multiple: true },
  tag: { type: 'string', multiple: true },
  workspace: { type: 'string' },
  session: { type: 'string' },
  'wake-policy': { type: 'string' },
  text: { type: 'string' },
  file: { type: 'string', multiple: true },
  data: { type: 'string' },
  to: { type: 'string' },
  task: { type: 'string' },
  status: { type: 'string' },
  artifact: { type: 'string', multiple: true },
  wait: { type: 'boolean' },
  timeout: { type: 'string' },
  interval: { type: 'string' },
  'page-size': { type: 'string' },
  'last-event-id': { type: 'string' },
  context: { type: 'string' },
  'data-dir': { type: 'string' },
  host: { type: 'string' },
  port: { type: 'string' },
  'sync-wait-ms': { type: 'string' },
  heartbeat: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

function usage() {
  return `A2A Exchange ${PROTOCOL_VERSION} · CLI

Usage:
  a2a-exchange <command> [options]

Commands:
  serve        Start the hub (registry + A2A JSON-RPC + SSE)
  register     Register this workspace/session as an A2A agent
  unregister   Remove an agent from the hub
  discover     Search agents by skill/tag/status
  send         Send an A2A message (task) to an agent
  task         Get one task
  tasks        List tasks
  cancel       Cancel a task
  inbox        List tasks in an agent's inbox (agent token)
  claim        Claim a task (agent token)
  answer       Complete/fail a task (agent token)
  reply        Add an agent message to a task (agent token)
  info         Agent diagnostics
  card         Print an agent's Agent Card
  events       Stream an agent's SSE events
  heartbeat    Heartbeat an agent

Common options:
  --hub <url>            Hub base URL (default ${DEFAULT_HUB})
  --state <file|dir>     Agent state file/dir (default ./.a2a-exchange/)
  --token <token>        Hub bootstrap token (or A2A_EXCHANGE_TOKEN)
  --json                 Print raw JSON (default output is JSON anyway)
  --help                 Show this help

Serve options:
  --host <host> --port <port> --data-dir <dir> --token <hub-token> --sync-wait-ms <ms>

Register options:
  --agent-id <id> --name <name> --description <text> --skill <id:描述> (repeatable)
  --tag <tag> (repeatable) --workspace <path> --session <id> --wake-policy <none|schedule|task-board|notify>

Send options:
  --to <agentId> --text <text> | --file <path> (repeatable) | --data <json>
  --wait --timeout <ms>

Agent-side options (inbox/claim/answer/reply/info/events):
  --agent <id> --agent-token <token> (defaults come from the state file)
  --task <taskId> --status <state> --artifact <name=url> (repeatable)
`;
}

function stateFile(opts) {
  if (opts.state) {
    const resolved = path.resolve(opts.state);
    return resolved.endsWith('.json') ? resolved : path.join(resolved, 'agent.json');
  }
  return path.join(process.cwd(), '.a2a-exchange', 'agent.json');
}

function loadState(opts) {
  return readJson(stateFile(opts), null);
}

function saveState(opts, state) {
  const file = stateFile(opts);
  ensureDir(path.dirname(file));
  writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n');
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

function clientFor(opts, { needAgent = false } = {}) {
  const state = loadState(opts) ?? {};
  const hub = opts.hub || state.hub || DEFAULT_HUB;
  const serverToken = opts.token || process.env.A2A_EXCHANGE_TOKEN || state.serverToken || undefined;
  const agentToken = opts['agent-token'] || state.token || undefined;
  if (needAgent && !agentToken) {
    throw new Error('No agent token found. Run `a2a-exchange register` first, or pass --agent-token.');
  }
  return {
    client: new ExchangeClient({
      baseUrl: hub,
      serverToken,
      agentId: opts.agent || state.agentId,
      agentToken,
    }),
    state,
  };
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function requireOpt(opts, name) {
  if (!opts[name]) throw new Error(`Missing required option --${name}`);
  return opts[name];
}

function parseArtifact(spec) {
  const index = spec.indexOf('=');
  if (index <= 0) throw new Error(`Invalid --artifact "${spec}", expected name=url`);
  const name = spec.slice(0, index);
  const url = spec.slice(index + 1);
  return {
    artifactId: `art_${Math.random().toString(36).slice(2, 10)}`,
    name,
    parts: [{ url, mediaType: 'text/markdown' }],
  };
}

function mediaTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md') return 'text/markdown';
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.html') return 'text/html';
  if (ext === '.txt') return 'text/plain';
  return 'application/octet-stream';
}

function fileUrl(file) {
  return 'file:///' + path.resolve(file).replace(/\\/g, '/').replace(/^\//, '');
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  const { values: opts, positionals } = parsed;
  if (opts.help || positionals.length === 0) {
    process.stdout.write(usage());
    return;
  }
  const command = positionals[0];
  try {
    switch (command) {
      case 'serve': {
        const server = createExchangeServer({
          dataDir: opts['data-dir'] || path.join(process.cwd(), '.data'),
          token: opts.token || process.env.A2A_EXCHANGE_TOKEN || null,
          syncWaitMs: Number(opts['sync-wait-ms'] ?? 20000),
          heartbeatTtlSeconds: Number(opts.heartbeat ?? 120),
        });
        const { baseUrl, host, port } = await server.listen({
          host: opts.host || '127.0.0.1',
          port: Number(opts.port ?? 8787),
        });
        print({
          ok: true,
          name: 'a2a-exchange',
          protocolVersion: PROTOCOL_VERSION,
          baseUrl,
          host,
          port,
          dataDir: path.resolve(opts['data-dir'] || path.join(process.cwd(), '.data')),
          auth: server.tokenRequired ?? Boolean(opts.token || process.env.A2A_EXCHANGE_TOKEN),
        });
        const shutdown = async () => {
          await server.close();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        await new Promise(() => {});
        break;
      }
      case 'register': {
        const { client, state } = clientFor(opts);
        const skills = (opts.skill ?? []).map((s) => s);
        if (skills.length === 0) {
          throw new Error('At least one --skill <id:description> is required');
        }
        const tags = opts.tag ?? [];
        const skillObjects = skills.map((entry) => {
          const [id, ...rest] = entry.split(':');
          return {
            id: id.trim(),
            name: rest.join(':').trim() || id.trim(),
            description: rest.join(':').trim() || id.trim(),
            tags,
          };
        });
        const result = await client.register({
          agentId: opts['agent-id'],
          name: opts.name,
          description: opts.description,
          version: opts.version ?? '0.1.0',
          skills: skillObjects,
          workspace: opts.workspace ?? process.cwd(),
          sessionId: opts.session,
          wakePolicy: opts['wake-policy'] ?? 'none',
        });
        const file = saveState(opts, {
          hub: client.baseUrl,
          serverToken: client.serverToken,
          agentId: result.agentId,
          token: result.token,
          card: result.card,
          registeredAt: nowIso(),
        });
        print({ ...result, cardUrl: `${client.baseUrl}/agents/${result.agentId}/.well-known/agent-card.json`, stateFile: file });
        process.stderr.write('\nNOTE: the agent token above is shown once. It is stored in the state file (0600).\n');
        break;
      }
      case 'unregister': {
        const { client, state } = clientFor(opts);
        const agentId = opts.agent || state.agentId;
        const result = await client.unregister(agentId);
        print(result);
        break;
      }
      case 'heartbeat': {
        const { client, state } = clientFor(opts, { needAgent: true });
        print(await client.heartbeat(opts.agent || state.agentId));
        break;
      }
      case 'discover': {
        const { client } = clientFor(opts);
        const result = await client.discover({
          skill: opts.skill?.[0],
          tag: opts.tag?.[0],
          status: opts.status,
          pageSize: opts['page-size'] ? Number(opts['page-size']) : undefined,
        });
        if (opts.json) return print(result);
        print({
          totalSize: result.totalSize,
          agents: result.agents.map((a) => ({
            agentId: a.agentId,
            status: a.status,
            name: a.card?.name,
            skills: (a.card?.skills ?? []).map((s) => s.id),
            wakePolicy: a.wakePolicy,
            lastSeen: a.lastSeen,
          })),
        });
        break;
      }
      case 'send': {
        const { client } = clientFor(opts);
        const to = requireOpt(opts, 'to');
        const parts = [];
        if (opts.text) parts.push({ text: opts.text, mediaType: 'text/plain' });
        for (const file of opts.file ?? []) {
          parts.push({ url: fileUrl(file), mediaType: mediaTypeFor(file), filename: path.basename(file) });
        }
        if (opts.data) {
          let data;
          try {
            data = JSON.parse(opts.data);
          } catch {
            throw new Error('--data must be valid JSON');
          }
          parts.push({ data, mediaType: 'application/json' });
        }
        if (parts.length === 0) throw new Error('Provide --text, --file and/or --data');
        const result = await client.sendMessage(to, {
          message: { messageId: globalThis.crypto.randomUUID(), role: 'ROLE_USER', parts },
          configuration: { returnImmediately: !opts.wait },
        });
        print(result);
        if (opts.wait) {
          const taskId = result.task.id;
          const timeout = Number(opts.timeout ?? 60000);
          const deadline = Date.now() + timeout;
          let task = result.task;
          while (Date.now() < deadline) {
            if (['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED'].includes(task.status?.state)) break;
            await sleep(500);
            task = await client.getTask(to, taskId);
          }
          print(task);
        }
        break;
      }
      case 'task': {
        const { client } = clientFor(opts);
        print(await client.getTask(opts.agent || requireOpt(opts, 'agent'), requireOpt(opts, 'task')));
        break;
      }
      case 'tasks': {
        const { client } = clientFor(opts);
        print(await client.listTasks(opts.agent, {
          status: opts.status,
          contextId: opts.context,
          pageSize: opts['page-size'] ? Number(opts['page-size']) : undefined,
        }));
        break;
      }
      case 'cancel': {
        const { client } = clientFor(opts);
        print(await client.cancelTask(opts.agent, requireOpt(opts, 'task')));
        break;
      }
      case 'inbox': {
        const { client, state } = clientFor(opts, { needAgent: true });
        const agentId = opts.agent || state.agentId;
        print(await client.inbox(agentId, {
          state: opts.status ? [opts.status] : undefined,
          pageSize: opts['page-size'] ? Number(opts['page-size']) : undefined,
        }));
        break;
      }
      case 'claim': {
        const { client, state } = clientFor(opts, { needAgent: true });
        print(await client.claim(opts.agent || state.agentId, requireOpt(opts, 'task')));
        break;
      }
      case 'answer': {
        const { client, state } = clientFor(opts, { needAgent: true });
        const agentId = opts.agent || state.agentId;
        const artifacts = (opts.artifact ?? []).map(parseArtifact);
        const status = opts.status || 'TASK_STATE_COMPLETED';
        const task = await client.update(agentId, requireOpt(opts, 'task'), {
          status: { state: status, ...(opts.text ? { message: { messageId: globalThis.crypto.randomUUID(), role: 'ROLE_AGENT', parts: [{ text: opts.text, mediaType: 'text/plain' }] } } : {}) },
          ...(artifacts.length ? { artifacts } : {}),
        });
        print(task);
        break;
      }
      case 'reply': {
        const { client, state } = clientFor(opts, { needAgent: true });
        print(await client.reply(opts.agent || state.agentId, requireOpt(opts, 'task'), requireOpt(opts, 'text')));
        break;
      }
      case 'info': {
        const { client, state } = clientFor(opts, { needAgent: true });
        print(await client.info(opts.agent || state.agentId));
        break;
      }
      case 'card': {
        const { client } = clientFor(opts);
        print(await client.card(requireOpt(opts, 'agent')));
        break;
      }
      case 'events': {
        const { client, state } = clientFor(opts, { needAgent: true });
        const agentId = opts.agent || state.agentId;
        const lastEventId = Number(opts['last-event-id'] ?? 0);
        await client.streamAgentEvents(agentId, (event) => {
          process.stdout.write(JSON.stringify(event) + '\n');
        }, { lastEventId });
        break;
      }
      case 'version': {
        print({ name: 'a2a-exchange', protocolVersion: PROTOCOL_VERSION });
        break;
      }
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${usage()}`);
        process.exitCode = 2;
    }
  } catch (error) {
    const payload = error instanceof ExchangeError
      ? { error: error.message, code: error.code, data: error.data, httpStatus: error.httpStatus }
      : { error: error?.message ?? String(error) };
    print(payload);
    process.exitCode = 1;
  }
}
