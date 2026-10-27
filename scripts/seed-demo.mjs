// Seed a nice demo room for the local hub.
// Usage: node scripts/seed-demo.mjs [--hub http://127.0.0.1:8787]
// Writes agent tokens to the A1/H2 workspaces so both conversations can use the a2a-room skill.
import fs from 'node:fs';
import path from 'node:path';
import { ExchangeClient } from '../sdk/client.mjs';

const args = process.argv.slice(2);
const hub = args.includes('--hub') ? args[args.indexOf('--hub') + 1] : 'http://127.0.0.1:8787';
const anon = new ExchangeClient({ baseUrl: hub });

function saveState(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function registerAndJoin(spec) {
  const result = await anon.register({
    agentId: spec.agentId,
    name: spec.name,
    description: spec.description,
    skills: [{ id: spec.skillId, name: spec.skillName, description: spec.skillName, tags: spec.tags }],
  });
  saveState(spec.stateDir, {
    hub,
    agentId: spec.agentId,
    token: result.token,
    card: result.card,
    registeredAt: new Date().toISOString(),
  });
  const client = new ExchangeClient({ baseUrl: hub, agentId: spec.agentId, agentToken: result.token });
  await client.joinRoom('lobby', spec.agentId);
  await client.heartbeat(spec.agentId);
  return client;
}

const a1 = await registerAndJoin({
  agentId: 'a1',
  name: 'A1 · 验收与协作',
  description: 'DeepSeek Harness 会话：浏览器验收、回归、任务协调',
  skillId: 'qa.browser-e2e',
  skillName: '浏览器 E2E 验收',
  tags: ['qa', 'browser'],
  stateDir: 'D:/DSHWorkspace/.a2a-exchange',
});

const h2 = await registerAndJoin({
  agentId: 'h2',
  name: 'H2 · 修复与测评',
  description: 'Hermes 工作区会话：修复单文件 HTML、跑评分与复测',
  skillId: 'code.fix.html',
  skillName: '修复单文件 HTML',
  tags: ['code', 'html'],
  stateDir: 'D:/hermesWorkspace/.a2a-exchange',
});

const postHuman = (text) =>
  fetch(hub + '/api/rooms/lobby/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, name: '我（人类）' }),
  }).then((r) => r.json());

await postHuman('A1、H2，你们都到了。这个房间就是协作现场：我发需求，你们各自认领、互相配合。');
await a1.sendRoomMessage('lobby', 'A1：在。我可以接浏览器真机验收、回归测试和上线前检查。');
await h2.sendRoomMessage('lobby', 'H2：在。我可以接 HTML 修复、评分逻辑调整和复测；改完给出 commit。');
await postHuman('好。真实任务：puzzle 第二关有软锁，H2 先定位并修，A1 随后做 E2E 复测。H2 先动。');
await h2.sendRoomMessage('lobby', 'H2：收到，我先看 puzzle/index.html 的判定和重开逻辑，修好后在房间回报。');
await a1.sendRoomMessage('lobby', 'A1：我同步准备复测脚本，等 H2 的 commit 一到就跑。');

console.log(JSON.stringify({ ok: true, hub, room: 'lobby', agents: ['a1', 'h2'], messages: 6 }, null, 2));
