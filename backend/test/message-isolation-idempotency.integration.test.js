import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-message-idempotency-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase, getUserDb, withWriteLock } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;

await initDatabase();
await initAuthDb();
const request = supertest(createTestApp());

async function account(label) {
  const username = `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const registered = await request.post('/api/auth/register').send({
    username, password: 'Passw0rd123', nickname: label
  });
  assert.equal(registered.status, 201);
  const cookie = registered.headers['set-cookie'];
  const groups = await request.get('/api/groups').set('Cookie', cookie);
  assert.equal(groups.status, 200);
  return { cookie, userId: registered.body.user?.id || registered.body.id, groups: groups.body };
}

test('same preset group ID has separate message indexes for each account', async () => {
  const a = await account('index_a');
  const b = await account('index_b');
  const groupId = a.groups[0].id;
  assert.equal(groupId, b.groups[0].id);

  const aSent = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', a.cookie).send({ content: '甲的独立消息' });
  const bSent = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', b.cookie).send({ content: '乙的独立消息' });
  assert.equal(aSent.status, 201);
  assert.equal(bSent.status, 201);
  assert.notEqual(aSent.body.id, bSent.body.id);

  for (const [accountInfo, ownId, otherId] of [[a, aSent.body.id, bSent.body.id], [b, bSent.body.id, aSent.body.id], [a, aSent.body.id, bSent.body.id]]) {
    const listed = await request.get(`/api/groups/${groupId}/messages`).set('Cookie', accountInfo.cookie);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.messages.map(message => message.id), [ownId]);
    assert.ok(!listed.body.messages.some(message => message.id === otherId));
  }
});

test('message index rejects an equal-length stale cache after stored IDs change', async () => {
  const owner = await account('index_revision');
  const groupId = owner.groups[0].id;
  const endpoint = `/api/groups/${groupId}/messages`;
  const sent = await request.post(endpoint).set('Cookie', owner.cookie).send({ content: '旧消息' });
  assert.equal(sent.status, 201);
  assert.deepEqual((await request.get(endpoint).set('Cookie', owner.cookie)).body.messages.map(m => m.id), [sent.body.id]);

  const db = await getUserDb(sent.body.sender_id);
  await withWriteLock(sent.body.sender_id, async () => {
    await db.read();
    db.data.messages = db.data.messages.map(message => message.id === sent.body.id
      ? { ...message, id: 'replacement-source-id', content: '新消息', metadata: {} }
      : message);
    await db.write();
  });
  const listed = await request.get(endpoint).set('Cookie', owner.cookie);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.messages.map(message => message.id), ['replacement-source-id']);
});

test('concurrent retries with one clientMessageId create one persisted message and one receipt', async () => {
  const owner = await account('retry_owner');
  const groupId = owner.groups[0].id;
  const endpoint = `/api/groups/${groupId}/messages`;
  const payload = { content: '只发送一次', clientMessageId: 'client-send-0001' };
  const responses = await Promise.all(Array.from({ length: 8 }, () => request.post(endpoint).set('Cookie', owner.cookie).send(payload)));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 7);
  assert.equal(new Set(responses.map(response => response.body.id)).size, 1);
  const messageId = responses[0].body.id;

  const listed = await request.get(endpoint).set('Cookie', owner.cookie);
  assert.deepEqual(listed.body.messages.map(message => message.id), [messageId]);
  const db = await getUserDb(responses[0].body.sender_id);
  await db.read();
  assert.equal(db.data.messages.filter(message => message.group_id === groupId).length, 1);
  assert.equal(db.data.messageIdempotency.filter(entry => entry.client_message_id === payload.clientMessageId).length, 1);

  const changed = await request.post(endpoint).set('Cookie', owner.cookie).send({ ...payload, content: '不同内容' });
  assert.equal(changed.status, 409);
  const differentGroup = await request.post(`/api/groups/${owner.groups[1].id}/messages`).set('Cookie', owner.cookie).send(payload);
  assert.equal(differentGroup.status, 409);

  const deleted = await request.delete(`/api/messages/${messageId}`).set('Cookie', owner.cookie);
  assert.equal(deleted.status, 200);
  const retryAfterDelete = await request.post(endpoint).set('Cookie', owner.cookie).send(payload);
  assert.equal(retryAfterDelete.status, 410);
  await db.read();
  assert.equal(db.data.messages.some(message => message.id === messageId), false);
});

test('clientMessageId is isolated by account and conflicts with a different header key', async () => {
  const a = await account('key_a');
  const b = await account('key_b');
  const id = 'shared-client-id';
  const endpoint = `/api/groups/${a.groups[0].id}/messages`;
  const first = await request.post(endpoint).set('Cookie', a.cookie).send({ content: 'A', clientMessageId: id });
  const second = await request.post(endpoint).set('Cookie', b.cookie).send({ content: 'B', clientMessageId: id });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.id, second.body.id);
  const conflict = await request.post(endpoint).set('Cookie', a.cookie).set('Idempotency-Key', 'different-key').send({ content: 'A', clientMessageId: id });
  assert.equal(conflict.status, 400);
});

test('failed source writes report uncertainty; concurrent delete has one winner', async () => {
  const owner = await account('mutation_owner');
  const groupId = owner.groups[0].id;
  const endpoint = `/api/groups/${groupId}/messages`;
  const sent = await request.post(endpoint).set('Cookie', owner.cookie).send({ content: '原文' });
  assert.equal(sent.status, 201);
  const failWrite = async action => {
    const db = await getUserDb(sent.body.sender_id);
    const originalWrite = db.write.bind(db);
    db.write = async () => { throw new Error('injected message write failure'); };
    try { return await action(); } finally { db.write = originalWrite; }
  };
  const edit = await failWrite(() => request.put(`/api/messages/${sent.body.id}`)
    .set('Cookie', owner.cookie).send({ content: '编辑后' }));
  assert.equal(edit.status, 503);
  assert.equal(edit.body.code, 'SOURCE_CHANGE_UNCERTAIN');
  const deletion = await failWrite(() => request.delete(`/api/messages/${sent.body.id}`)
    .set('Cookie', owner.cookie));
  assert.equal(deletion.status, 503);
  assert.equal(deletion.body.code, 'SOURCE_CHANGE_UNCERTAIN');
  const hiddenOldRevision = await request.get(endpoint).set('Cookie', owner.cookie);
  assert.deepEqual(hiddenOldRevision.body.messages, []);

  const edited = await request.put(`/api/messages/${sent.body.id}`).set('Cookie', owner.cookie).send({ content: '编辑后' });
  // The deletion prewrite is durable even when the user JSON write receipt is
  // uncertain. Editing that identity again must not make it readable.
  assert.equal(edited.status, 404);
  const removals = await Promise.all(Array.from({ length: 4 }, () => request.delete(`/api/messages/${sent.body.id}`).set('Cookie', owner.cookie)));
  assert.equal(removals.filter(response => response.status === 200).length, 1);
  assert.equal(removals.filter(response => response.status === 404).length, 3);
  assert.deepEqual((await request.get(endpoint).set('Cookie', owner.cookie)).body.messages, []);
});

test('batch and whole-group deletion report uncertain writes and hide prewritten sources', async () => {
  const owner = await account('batch_owner');
  const groupId = owner.groups[0].id;
  const endpoint = `/api/groups/${groupId}/messages`;
  const first = await request.post(endpoint).set('Cookie', owner.cookie).send({ content: '第一条' });
  const second = await request.post(endpoint).set('Cookie', owner.cookie).send({ content: '第二条' });
  assert.equal(first.status, 201); assert.equal(second.status, 201);
  const failWrite = async action => {
    const db = await getUserDb(first.body.sender_id);
    const originalWrite = db.write.bind(db);
    db.write = async () => { throw new Error('injected batch write failure'); };
    try { return await action(); } finally { db.write = originalWrite; }
  };
  const failedBatch = await failWrite(() => request.post('/api/messages/batch-delete')
    .set('Cookie', owner.cookie).send({ group_id: groupId, message_ids: [first.body.id] }));
  assert.equal(failedBatch.status, 503);
  assert.equal(failedBatch.body.code, 'SOURCE_CHANGE_UNCERTAIN');
  const failedClear = await failWrite(() => request.delete(endpoint).set('Cookie', owner.cookie));
  assert.equal(failedClear.status, 503);
  assert.equal(failedClear.body.code, 'SOURCE_CHANGE_UNCERTAIN');
  assert.deepEqual((await request.get(endpoint).set('Cookie', owner.cookie)).body.messages, []);
  const batch = await request.post('/api/messages/batch-delete').set('Cookie', owner.cookie).send({ group_id: groupId, message_ids: [first.body.id] });
  assert.equal(batch.status, 200);
  assert.equal(batch.body.deleted_count, 1);
  assert.equal((await request.post('/api/messages/batch-delete').set('Cookie', owner.cookie).send({ group_id: groupId, message_ids: [first.body.id] })).status, 404);
  const clear = await request.delete(endpoint).set('Cookie', owner.cookie);
  assert.equal(clear.status, 200); assert.equal(clear.body.deleted_count, 1);
  assert.deepEqual((await request.get(endpoint).set('Cookie', owner.cookie)).body.messages, []);
});
