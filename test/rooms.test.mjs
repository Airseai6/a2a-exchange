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

test('messages can be pinned and unpinned', async () => {
  await a1.createRoom({ roomId: 'pin-test', name: 'Pin Test' });
  const sent = await a1.sendRoomMessage('pin-test', '需要置顶的分工确认', 'room-a1');
  await a1.pinRoomMessage('pin-test', sent.message.seq, true);
  const pinnedRoom = await a1.getRoom('pin-test');
  assert.equal(pinnedRoom.messages.at(-1).pinned, true);
  await a1.pinRoomMessage('pin-test', sent.message.seq, false);
  const unpinnedRoom = await a1.getRoom('pin-test');
  assert.equal(unpinnedRoom.messages.at(-1).pinned, false);
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
  assert.ok(after.lastAckAt);
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

test('room task board supports open → in_progress → resolved → verified', async () => {
  await a1.createRoom({ roomId: 'task-test', name: 'Task Test' });
  await h2.joinRoom('task-test', 'room-h2');
  const created = await a1.createRoomTask('task-test', {
    title: '测试任务卡',
    detail: '验证任务看板生命周期',
    acceptance: 'A1 验证通过',
    assignee: 'room-h2',
    verifier: 'room-a1',
  });
  assert.equal(created.task.status, 'open');
  const afterCreate = await a1.getRoom('task-test');
  assert.equal(afterCreate.messages.at(-1).type, 'task');
  assert.match(afterCreate.messages.at(-1).text, /@room-h2/);
  const claimed = await h2.roomTaskAction('task-test', created.task.taskId, 'claim', { assignee: 'room-h2' });
  assert.equal(claimed.task.status, 'in_progress');
  const resolved = await h2.roomTaskAction('task-test', created.task.taskId, 'resolve', { note: '已实现' });
  assert.equal(resolved.task.status, 'resolved');
  const afterResolve = await a1.getRoom('task-test');
  assert.equal(afterResolve.messages.at(-1).type, 'task');
  assert.match(afterResolve.messages.at(-1).text, /@room-a1/);
  const seqBeforeDuplicate = afterResolve.lastSeq;
  await h2.roomTaskAction('task-test', created.task.taskId, 'resolve', { note: '重复 resolve' });
  const afterDuplicate = await a1.getRoom('task-test');
  assert.equal(afterDuplicate.lastSeq, seqBeforeDuplicate, 'duplicate resolve must not emit another task notice');
  const verified = await a1.roomTaskAction('task-test', created.task.taskId, 'verify', { pass: true, note: 'E2E 通过' });
  assert.equal(verified.task.status, 'verified');
  const board = await a1.listRoomTasks('task-test');
  assert.equal(board.tasks[0].status, 'verified');
  assert.ok(board.tasks[0].events.some((event) => event.type === 'verify'));
});
