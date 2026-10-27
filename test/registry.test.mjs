import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHub, client, registerAgent, startHub } from './helpers.mjs';

let hub;
before(async () => {
  hub = await startHub();
});
after(async () => {
  await cleanupHub(hub);
});

test('register returns an A2A v1.0 Agent Card and a one-time token', async () => {
  const { registration } = await registerAgent(hub.baseUrl, { id: 'a1', skills: ['demo.skill'], tags: ['demo'] });
  assert.equal(registration.agentId, 'a1');
  assert.match(registration.token, /^agent_/);
  const card = registration.card;
  assert.equal(card.name, 'a1 agent');
  assert.ok(card.description);
  assert.ok(card.version);
  assert.ok(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length === 1);
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.match(card.supportedInterfaces[0].url, /\/agents\/a1\/a2a$/);
  assert.equal(card.capabilities.streaming, true);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.ok(card.capabilities.extensions.some((e) => e.uri === 'urn:a2a-exchange:ext:session-delivery:v1'));
  assert.ok(Array.isArray(card.skills) && card.skills[0].id === 'demo.skill');
  assert.ok(card.defaultInputModes.length > 0);
  assert.ok(card.defaultOutputModes.length > 0);
});

test('agent card is served from the well-known path', async () => {
  const anon = client(hub.baseUrl);
  await registerAgent(hub.baseUrl, { id: 'card-agent', skills: ['x.skill'] });
  const card = await anon.card('card-agent');
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  const hubCard = await anon.hubCard();
  assert.equal(hubCard.name, 'A2A Exchange Hub');
  assert.match(hubCard.supportedInterfaces[0].url, /\/a2a$/);
});

test('discover filters by skill, tag and status', async () => {
  await registerAgent(hub.baseUrl, { id: 'fixer', skills: ['code.fix.html'], tags: ['code'] });
  await registerAgent(hub.baseUrl, { id: 'qa', skills: ['qa.browser-e2e'], tags: ['qa'] });
  const anon = client(hub.baseUrl);
  const bySkill = await anon.discover({ skill: 'qa.browser-e2e' });
  assert.deepEqual(bySkill.agents.map((a) => a.agentId), ['qa']);
  const byTag = await anon.discover({ tag: 'code' });
  assert.ok(byTag.agents.some((a) => a.agentId === 'fixer'));
  const byStatus = await anon.discover({ status: 'online' });
  assert.ok(byStatus.agents.length >= 2);
  const none = await anon.discover({ skill: 'nope.nothing' });
  assert.equal(none.totalSize, 0);
});

test('hub bootstrap token protects the API when configured', async () => {
  const secured = await startHub({ token: 'hub-secret' });
  try {
    const noToken = client(secured.baseUrl);
    await assert.rejects(() => noToken.discover({}), /Unauthorized|HTTP 401|Unauthenticated/);
    await assert.rejects(() => noToken.hub('exchange/discover', {}), /Unauthorized|HTTP 401|Unauthenticated/);
    const withToken = client(secured.baseUrl, { serverToken: 'hub-secret' });
    const reg = await withToken.register({
      agentId: 'secure-agent',
      name: 'Secure',
      description: 'secured agent',
      skills: [{ id: 'secure.skill', name: 'Secure', description: 'secure', tags: ['secure'] }],
    });
    assert.ok(reg.token);
    const agent = client(secured.baseUrl, { serverToken: 'hub-secret', agentId: 'secure-agent', agentToken: reg.token });
    const inbox = await agent.inbox();
    assert.deepEqual(inbox.tasks, []);
  } finally {
    await cleanupHub(secured);
  }
});

test('wrong agent token is rejected for agent-side methods', async () => {
  const { client: agentClient } = await registerAgent(hub.baseUrl, { id: 'token-check', skills: ['x.y'] });
  const bad = client(hub.baseUrl, { agentId: 'token-check', agentToken: 'agent_wrong' });
  await assert.rejects(() => bad.inbox(), /Unauthorized|HTTP 401|Unauthenticated/);
  await agentClient.inbox();
});
