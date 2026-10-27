import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExchangeServer } from '../src/server.mjs';
import { ExchangeClient } from '../sdk/client.mjs';

export async function startHub(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-exchange-test-'));
  const hub = createExchangeServer({ dataDir, ...options });
  const { baseUrl } = await hub.listen({ host: '127.0.0.1', port: 0 });
  return { hub, dataDir, baseUrl, serverToken: options.token };
}

export async function cleanupHub({ hub, dataDir }) {
  await hub.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

export function client(baseUrl, { serverToken, agentId, agentToken } = {}) {
  return new ExchangeClient({ baseUrl, serverToken, agentId, agentToken });
}

export async function registerAgent(baseUrl, { id, skills = [], tags = [], wakePolicy = 'none', serverToken } = {}) {
  const anonymous = client(baseUrl, { serverToken });
  const registration = await anonymous.register({
    agentId: id,
    name: `${id} agent`,
    description: `test agent ${id}`,
    skills: skills.map((skill) => ({
      id: skill,
      name: skill,
      description: skill,
      tags,
    })),
    wakePolicy,
  });
  const agentClient = client(baseUrl, { serverToken, agentId: id, agentToken: registration.token });
  return { client: agentClient, registration };
}

export async function waitFor(predicate, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
