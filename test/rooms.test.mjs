import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupHub, client, registerAgent, startHub } from './helpers.mjs';

let hub;
let a1;
let h2;
before(async () => {
  hub = await startHub();
  a1 = (await registerAgent(hub.baseUrl, { id: 'room-a1', skills: ['qa.browser-e2e'] })).client;
  h2 = (await registerAgent(hub.baseUrl, { id: 'room-h2', skills: ['code.fix.html'] })).client;
  await a1.joinRoom('lobby', 'room-a1');
  await h2.joinRoom('lobby', 'room-h2');
});
after(async () => {
  await cleanupHub(hub);
});

test('lobby exists and lists registered agents', async () => {
  const rooms = await a1.listRooms();
  const lobby = rooms.rooms.find((r) => r.id === 'lobby');
  assert.ok(lobby);
  assert.equal(lobby.participantCount, 2);
});

test('human and agent messages are persisted in the room', async () => {
  const posted = await a1.postHumanRoomMessage('lobby', '大家好，先对一下接口', '我（人类）');
  assert.equal(posted.message.sender.kind, 'human');
  assert.equal(posted.message.seq, 1);

  const reply = await h2.sendRoomMessage('lobby', 'H2 收到，检查 puzzle 第二关', 'room-h2');
  assert.equal(reply.message.sender.kind, 'agent');
  assert.equal(reply.message.seq, 2);

  const data = await a1.getRoom('lobby');
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[1].text, 'H2 收到，检查 puzzle 第二关');
  assert.equal(data.participants.length, 2);
});

test('room create/join and message filtering by since', async () => {
  const created = await a1.createRoom({ roomId: 'test-room', name: '测试房间' });
  assert.equal(created.room.id, 'test-room');
  await a1.joinRoom('test-room', 'room-a1');
  const m1 = await a1.postHumanRoomMessage('test-room', '第一条');
  await new Promise((r) => setTimeout(r, 5));
  await a1.sendRoomMessage('test-room', '第二条', 'room-a1');
  const all = await a1.getRoom('test-room');
  assert.ok(all.messages.length >= 2);
  const since = all.messages[0].seq;
  const rest = await a1.getRoom('test-room', { since });
  assert.ok(rest.messages.every((m) => m.seq > since));
  assert.ok(rest.messages.length < all.messages.length);
});

test('agent room APIs require the agent token', async () => {
  const bad = client(hub.baseUrl, { agentId: 'room-a1', agentToken: 'agent_wrong' });
  await assert.rejects(() => bad.joinRoom('lobby', 'room-a1'), /Unauthorized|HTTP 401|Unauthenticated/);
  await assert.rejects(() => bad.sendRoomMessage('lobby', 'bad', 'room-a1'), /Unauthorized|HTTP 401|Unauthenticated/);
});

test('invalid room ids and unknown rooms are rejected', async () => {
  await assert.rejects(() => a1.createRoom({ roomId: 'BAD ID', name: 'x' }), /Invalid roomId/);
  await assert.rejects(() => a1.getRoom('missing-room'), /Room not found/);
});

test('server-side pending/ack is independent from local state', async () => {
  await a1.createRoom({ roomId: 'ack-test', name: 'Ack Test' });
  await h2.joinRoom('ack-test', 'room-h2');
  await a1.sendRoomMessage('ack-test', '@room-h2 请处理 ack 测试', 'room-a1');
  const pending = await h2.roomPending('ack-test', 'room-h2');
  assert.ok(pending.pendingCount >= 1);
  await h2.roomAck('ack-test', 'room-h2', pending.lastSeq);
  const after = await h2.roomPending('ack-test', 'room-h2');
  assert.equal(after.pendingCount, 0);
});

test('admin can invite, set role, rename and delete a room', async () => {
  await a1.createRoom({ roomId: 'admin-test', name: 'Admin Test' });
  await a1.inviteRoom('admin-test', 'room-h2', 'admin');
  await a1.setRoomRole('admin-test', 'room-h2', 'member');
  const renamed = await a1.updateRoom('admin-test', { name: 'Admin Renamed', description: 'managed' });
  assert.equal(renamed.room.name, 'Admin Renamed');
  const data = await a1.getRoom('admin-test');
  const member = data.participants.find((p) => p.agentId === 'room-h2');
  assert.equal(member.role, 'member');
  await a1.kickRoom('admin-test', 'room-h2');
  const afterKick = await a1.getRoom('admin-test');
  assert.ok(!afterKick.participants.some((p) => p.agentId === 'room-h2'));
  await a1.deleteRoom('admin-test');
  await assert.rejects(() => a1.getRoom('admin-test'), /Room not found/);
});
