import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-persistent-memory-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase, getUserDb, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { forgetAllMemories, readableSourceMessages } = await import('../src/services/memory/persistentMemory.js');
const { initAuthDb, getAuthDb } = await import('../src/models/authDb.js');
const { runAsUser } = await import('../src/services/userScope.js');
const { getRecentDebateMessages } = await import('../src/services/debate/index.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;
await initDatabase();
await initAuthDb();
const request = supertest(createTestApp());

async function account(prefix) {
  const response = await request.post('/api/auth/register').send({
    username: `${prefix}_${randomUUID().slice(0, 12)}`,
    password: 'Passw0rd123', nickname: prefix
  });
  assert.equal(response.status, 201);
  return { cookie: response.headers['set-cookie'], id: response.body.user.id };
}

async function withFailedWrite(userId, action) {
  const db = await getUserDb(userId);
  const originalWrite = db.write.bind(db);
  db.write = async () => { throw new Error('injected memory write failure'); };
  try { return await action(); }
  finally { db.write = originalWrite; }
}

test('non-local ordinary message reads use current storage state without a local ledger', async () => {
  const messages = [
    { id: 'live', group_id: 'group', content: 'visible' },
    { id: 'deleted', group_id: 'group', content: 'hidden', is_deleted: true },
    { id: 'recalled', group_id: 'group', content: 'hidden', deleted_at: new Date().toISOString() }
  ];
  const adapter = { data: { messages } };
  assert.deepEqual((await readableSourceMessages('cloud-account', adapter)).map(message => message.id), ['live']);
});

test('new accounts have a ledger before first read; unregistered old accounts cannot create one from empty memoryRecords', async () => {
  const owner = await account('ledger_registration');
  const ownerHash = createHash('sha256').update(JSON.stringify(owner.id)).digest('hex');
  const ledgerRoot = path.join(process.env.DATA_DIR, 'memory-deletions');
  await fs.access(path.join(ledgerRoot, ownerHash, 'deletions.v1.log'));

  // Simulate an old account and user JSON restored into an already installed
  // instance. No account creation or audited migration registered this ID.
  const oldId = randomUUID();
  const token = randomUUID();
  const authDb = getAuthDb();
  await withWriteLock('auth', async () => {
    await authDb.read();
    const template = authDb.data.users.find(user => user.id === owner.id);
    authDb.data.users.push({ ...template, id: oldId, username: `old_${oldId}` });
    authDb.data.sessions.push({ token, userId: oldId,
      expires_at: new Date(Date.now() + 3600000).toISOString() });
    await authDb.write();
  });
  const ownerJson = path.join(process.env.DATA_DIR, 'users', `db_${owner.id}.json`);
  const oldJson = path.join(process.env.DATA_DIR, 'users', `db_${oldId}.json`);
  const snapshot = JSON.parse(await fs.readFile(ownerJson, 'utf8'));
  const groupId = snapshot.groups[0].id;
  snapshot.memoryRecords = [];
  snapshot.messages.push({ id: randomUUID(), group_id: groupId, sender_id: oldId,
    sender_type: 'user', content: '未注册旧账号的私人消息', content_type: 'text',
    metadata: {}, created_at: new Date().toISOString() });
  await fs.writeFile(oldJson, JSON.stringify(snapshot));

  const read = await request.get(`/api/groups/${groupId}/messages`)
    .set('Cookie', `session_token=${token}`);
  assert.equal(read.status, 503);
  assert.equal(read.body.code, 'MEMORY_BARRIER_UNAVAILABLE');
  const oldHash = createHash('sha256').update(JSON.stringify(oldId)).digest('hex');
  await assert.rejects(fs.access(path.join(ledgerRoot, oldHash)), { code: 'ENOENT' });
});

test('user note persists after cache reload; correction, idempotency and forget do not leak across accounts', async () => {
  const owner = await account('memory_owner');
  const other = await account('memory_other');
  const create = () => request.post('/api/memory/store').set('Cookie', owner.cookie)
    .set('Idempotency-Key', 'note-one').send({ content: '周三交付草稿', category: 'note' });
  const saved = await create();
  assert.equal(saved.status, 200);
  assert.equal(saved.body.memory.confirmedFact, false);
  assert.equal(saved.body.memory.evidence, 'user_asserted');
  const memoryId = saved.body.memoryId;
  assert.equal((await create()).body.replayed, true);
  const conflicting = await request.post('/api/memory/store').set('Cookie', owner.cookie)
    .set('Idempotency-Key', 'note-one').send({ content: '周五交付草稿' });
  assert.equal(conflicting.status, 409);
  clearUserDbCache(owner.id);
  const restored = await request.get(`/api/memory/${memoryId}`).set('Cookie', owner.cookie);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.memory.content, '周三交付草稿');
  assert.equal((await request.get(`/api/memory/${memoryId}`).set('Cookie', other.cookie)).status, 404);
  const stale = await request.post(`/api/memory/${memoryId}/correct`).set('Cookie', owner.cookie)
    .send({ content: '周四交付草稿', expectedRevision: 7 });
  assert.equal(stale.status, 409);
  const corrected = await request.post(`/api/memory/${memoryId}/correct`).set('Cookie', owner.cookie)
    .send({ content: '周四交付草稿', expectedRevision: 0 });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.memory.revision, 1);
  const oldSearch = await request.post('/api/memory/retrieve').set('Cookie', owner.cookie)
    .send({ query: '周三交付草稿' });
  assert.equal(oldSearch.body.count, 0);
  const newSearch = await request.post('/api/memory/retrieve').set('Cookie', owner.cookie)
    .send({ query: '周四交付草稿' });
  assert.equal(newSearch.body.count, 1);
  const forgotten = await request.post(`/api/memory/${memoryId}/forget`).set('Cookie', owner.cookie).send({});
  assert.equal(forgotten.status, 200);
  clearUserDbCache(owner.id);
  assert.equal((await request.get(`/api/memory/${memoryId}`).set('Cookie', owner.cookie)).status, 410);
  const after = await request.post('/api/memory/retrieve').set('Cookie', owner.cookie)
    .send({ query: '周四交付草稿' });
  assert.equal(after.body.count, 0);
  const db = await getUserDb(owner.id); await db.read();
  const forgottenRecord = db.data.memoryRecords.find(record => record.id === memoryId);
  assert.equal(forgottenRecord.content, null);
  assert.equal(forgottenRecord.requestHash, null);
});

test('failed writes do not create or correct; a durable deletion prewrite stays effective', async () => {
  const owner = await account('memory_write_failure');
  const failedCreate = await withFailedWrite(owner.id, () =>
    request.post('/api/memory/store').set('Cookie', owner.cookie)
      .set('Idempotency-Key', 'failed-create').send({ content: '不应保存的内容' }));
  assert.equal(failedCreate.status, 500);
  const empty = await request.get('/api/memory').set('Cookie', owner.cookie);
  assert.equal(empty.body.total, 0);
  const created = await request.post('/api/memory/store').set('Cookie', owner.cookie)
    .set('Idempotency-Key', 'failed-create').send({ content: '后来成功的内容' });
  assert.equal(created.status, 200);
  const id = created.body.memoryId;
  const failedCorrection = await withFailedWrite(owner.id, () =>
    request.post(`/api/memory/${id}/correct`).set('Cookie', owner.cookie)
      .send({ content: '错误的新内容', expectedRevision: 0 }));
  assert.equal(failedCorrection.status, 500);
  const afterCorrection = await request.get(`/api/memory/${id}`).set('Cookie', owner.cookie);
  assert.equal(afterCorrection.body.memory.content, '后来成功的内容');
  assert.equal(afterCorrection.body.memory.revision, 0);
  const failedForget = await withFailedWrite(owner.id, () =>
    request.post(`/api/memory/${id}/forget`).set('Cookie', owner.cookie).send({}));
  assert.equal(failedForget.status, 500);
  const afterForget = await request.get(`/api/memory/${id}`).set('Cookie', owner.cookie);
  assert.equal(afterForget.status, 410);
  clearUserDbCache(owner.id);
  assert.equal((await request.get(`/api/memory/${id}`).set('Cookie', owner.cookie)).status, 410);
  const another = await request.post('/api/memory/store').set('Cookie', owner.cookie)
    .send({ content: '批量删除的测试内容' });
  assert.equal(another.status, 200);
  await assert.rejects(withFailedWrite(owner.id, () => forgetAllMemories(owner.id)),
    /injected memory write failure/);
  assert.equal((await request.get(`/api/memory/${another.body.memoryId}`)
    .set('Cookie', owner.cookie)).status, 410);
});

test('memory pagination exposes older records without changing account scope', async () => {
  const owner = await account('memory_page');
  const ids = [];
  for (const content of ['第一条', '第二条', '第三条']) {
    const response = await request.post('/api/memory/store').set('Cookie', owner.cookie)
      .send({ content });
    assert.equal(response.status, 200);
    ids.push(response.body.memoryId);
  }
  const first = await request.get('/api/memory').set('Cookie', owner.cookie)
    .query({ limit: 2, offset: 0 });
  const last = await request.get('/api/memory').set('Cookie', owner.cookie)
    .query({ limit: 2, offset: 2 });
  assert.equal(first.status, 200);
  assert.equal(last.status, 200);
  assert.equal(first.body.total, 3);
  assert.equal(last.body.offset, 2);
  assert.deepEqual(new Set([...first.body.memories, ...last.body.memories].map(item => item.id)),
    new Set(ids));
  assert.equal((await request.get('/api/memory').set('Cookie', owner.cookie)
    .query({ offset: -1 })).status, 400);
});

test('message quotes stay unverified and source edit or delete removes them before retrieval', async () => {
  const owner = await account('source_owner');
  const db = await getUserDb(owner.id);
  let groupId, otherGroupId;
  const messageId = randomUUID();
  const otherMessageId = randomUUID();
  await withWriteLock(owner.id, async () => {
    await db.read();
    groupId = db.data.groups[0].id;
    otherGroupId = db.data.groups[1].id;
    db.data.messages.push({
      id: messageId, group_id: groupId, sender_id: owner.id, sender_type: 'user',
      content: '来源仍未核实的交付日是周二', content_type: 'text',
      metadata: {}, created_at: new Date().toISOString()
    });
    db.data.messages.push({
      id: otherMessageId, group_id: otherGroupId, sender_id: owner.id, sender_type: 'user',
      content: '来源仍未核实的交付日是周二', content_type: 'text',
      metadata: {}, created_at: new Date().toISOString()
    });
    await db.write();
  });
  const failedQuote = await withFailedWrite(owner.id, () =>
    request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
      .send({ groupId, messageIds: [messageId] }));
  assert.equal(failedQuote.status, 500);
  assert.equal((await request.get('/api/memory').set('Cookie', owner.cookie)).body.total, 0);
  const quote = await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
    .send({ groupId, messageIds: [messageId] });
  assert.equal(quote.status, 201);
  assert.equal(quote.body.evidence, 'source_quote_unverified');
  const quoteId = quote.body.results[0].memoryId;
  const otherQuote = await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
    .send({ groupId: otherGroupId, messageIds: [otherMessageId] });
  assert.equal(otherQuote.status, 201);
  const scopedDigest = await request.get('/api/memory/digest').set('Cookie', owner.cookie)
    .query({ groupId, limit: 8 });
  assert.equal(scopedDigest.status, 200);
  assert.equal(scopedDigest.body.total, 1);
  assert.equal(scopedDigest.body.memories[0].id, quoteId);
  const scopedSearch = await request.post('/api/memory/retrieve-for-conversation')
    .set('Cookie', owner.cookie).send({ groupId, limit: 5 });
  assert.equal(scopedSearch.status, 200);
  assert.deepEqual(scopedSearch.body.results.map(item => item.memory.id), [quoteId]);
  const crossReference = await request.post('/api/memory/reference')
    .set('Cookie', owner.cookie)
    .send({ memoryId: otherQuote.body.results[0].memoryId,
      context: { groupId, content: '引用交付日' } });
  assert.equal(crossReference.status, 403);
  assert.equal((await request.post('/api/memory/reference').set('Cookie', owner.cookie)
    .send({ memoryId: quoteId, context: { groupId, content: '引用交付日' } })).status, 200);
  assert.equal((await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
    .send({ messageIds: [messageId] })).status, 400);
  const before = await request.get(`/api/memory/${quoteId}`).set('Cookie', owner.cookie);
  assert.equal(before.status, 200);
  assert.equal(before.body.memory.confirmedFact, false);
  assert.equal(before.body.memory.evidence, 'source_quote_unverified');
  assert.equal((await request.post(`/api/memory/${quoteId}/correct`).set('Cookie', owner.cookie)
    .send({ content: '假装确认', expectedRevision: 0 })).status, 409);
  const failedEdit = await withFailedWrite(owner.id, () =>
    request.put(`/api/messages/${messageId}`).set('Cookie', owner.cookie)
      .send({ content: '失败写入后的来源撤销仍需生效' }));
  assert.equal(failedEdit.status, 503);
  assert.equal(failedEdit.body.code, 'SOURCE_CHANGE_UNCERTAIN');
  assert.equal((await request.get(`/api/memory/${quoteId}`).set('Cookie', owner.cookie)).status, 410);
  const edit = await request.put(`/api/messages/${messageId}`).set('Cookie', owner.cookie)
    .send({ content: '更正：交付日是周三' });
  assert.equal(edit.status, 200);
  clearUserDbCache(owner.id);
  const old = await request.post('/api/memory/retrieve').set('Cookie', owner.cookie)
    .send({ query: '周二' });
  assert.equal(old.body.results.some(item => item.memory.id === quoteId), false);
  assert.equal(old.body.results.some(item =>
    item.memory.id === otherQuote.body.results[0].memoryId), true);
  assert.equal((await request.get(`/api/memory/${quoteId}`).set('Cookie', owner.cookie)).status, 410);
  const diskAfterEdit = await getUserDb(owner.id); await diskAfterEdit.read();
  assert.equal(diskAfterEdit.data.memoryRecords.find(record => record.id === quoteId).content, null);
  assert.equal((await request.get(`/api/memory/${otherQuote.body.results[0].memoryId}`)
    .set('Cookie', owner.cookie)).status, 200);
  const again = await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
    .send({ groupId, messageIds: [messageId] });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.results[0].memoryId, quoteId);
  const deleted = await request.delete(`/api/messages/${messageId}`).set('Cookie', owner.cookie);
  assert.equal(deleted.status, 200);
  const after = await request.post('/api/memory/retrieve').set('Cookie', owner.cookie)
    .send({ query: '周三' });
  assert.equal(after.body.count, 0);
  const diskAfterDelete = await getUserDb(owner.id); await diskAfterDelete.read();
  assert.equal(diskAfterDelete.data.memoryRecords.find(record =>
    record.id === again.body.results[0].memoryId).content, null);
  const otherGroupDelete = await request.delete(`/api/groups/${otherGroupId}`)
    .set('Cookie', owner.cookie);
  assert.equal(otherGroupDelete.status, 200);
  assert.equal((await request.get(`/api/memory/${otherQuote.body.results[0].memoryId}`)
    .set('Cookie', owner.cookie)).status, 410);
});

test('restoring old user JSON cannot revive forgotten notes or revoked message quotes', async () => {
  const owner = await account('memory_old_snapshot');
  const db = await getUserDb(owner.id);
  const groupId = db.data.groups[0].id;
  const messageId = randomUUID();
  await withWriteLock(owner.id, async () => {
    await db.read();
    db.data.messages.push({ id: messageId, group_id: groupId, sender_id: owner.id,
      sender_type: 'user', content: '旧来源的私人摘录', content_type: 'text',
      metadata: {}, created_at: new Date().toISOString(),
      comments: [{ id: randomUUID(), message_id: messageId, sender_type: 'user',
        sender_id: owner.id, content: '旧来源下的私人评论', created_at: new Date().toISOString() }] });
    await db.write();
  });
  const note = await request.post('/api/memory/store').set('Cookie', owner.cookie)
    .send({ content: '应永久遗忘的私人笔记' });
  const quote = await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
    .send({ groupId, messageIds: [messageId] });
  assert.equal(note.status, 200);
  assert.equal(quote.status, 201);
  const dbPath = path.join(process.env.DATA_DIR, 'users', `db_${owner.id}.json`);
  const oldSnapshot = await fs.readFile(dbPath);
  assert.equal((await request.post(`/api/memory/${note.body.memoryId}/forget`)
    .set('Cookie', owner.cookie).send({})).status, 200);
  assert.equal((await request.put(`/api/messages/${messageId}`).set('Cookie', owner.cookie)
    .send({ content: '更正后的消息' })).status, 200);
  await fs.writeFile(dbPath, oldSnapshot);
  clearUserDbCache(owner.id);
  const restoredMessages = await request.get(`/api/groups/${groupId}/messages`)
    .set('Cookie', owner.cookie);
  assert.equal(restoredMessages.status, 200);
  assert.equal(restoredMessages.body.messages.some(message => message.id === messageId), false);
  const restoredInsights = await request.get(`/api/groups/${groupId}/insights`)
    .set('Cookie', owner.cookie);
  assert.equal(restoredInsights.status, 200);
  assert.equal(restoredInsights.body.totals.messages, 0);
  assert.equal((await request.post('/api/comments').set('Cookie', owner.cookie)
    .send({ message_id: messageId, content: '不得评论已撤回的旧消息' })).status, 404);
  assert.equal((await request.post(`/api/messages/${messageId}/like`)
    .set('Cookie', owner.cookie).send({})).status, 404);
  assert.equal((await request.post(`/api/messages/${messageId}/dislike`)
    .set('Cookie', owner.cookie).send({})).status, 404);
  const restoredSearch = await request.get('/api/search').set('Cookie', owner.cookie)
    .query({ q: '旧来源的私人摘录', type: 'messages,comments' });
  assert.equal(restoredSearch.status, 200);
  assert.equal(restoredSearch.body.messages.some(message => message.id === messageId), false);
  const restoredCommentSearch = await request.get('/api/search').set('Cookie', owner.cookie)
    .query({ q: '旧来源下的私人评论', type: 'comments' });
  assert.equal(restoredCommentSearch.status, 200);
  assert.equal(restoredCommentSearch.body.comments.some(comment => comment.message_id === messageId), false);
  const conversationMemory = await request.post('/api/memory/retrieve-for-conversation')
    .set('Cookie', owner.cookie).send({ groupId, limit: 5 });
  assert.equal(conversationMemory.status, 200);
  assert.equal(conversationMemory.body.query.includes('旧来源的私人摘录'), false);
  const debateContext = await runAsUser(owner.id, () => getRecentDebateMessages(groupId));
  assert.equal(debateContext.some(message => message.id === messageId), false);
  assert.equal((await request.get(`/api/memory/${note.body.memoryId}`)
    .set('Cookie', owner.cookie)).status, 410);
  assert.equal((await request.get(`/api/memory/${quote.body.results[0].memoryId}`)
    .set('Cookie', owner.cookie)).status, 410);
  const search = await request.post('/api/memory/retrieve').set('Cookie', owner.cookie)
    .send({ query: '私人' });
  assert.equal(search.status, 200);
  assert.equal(search.body.count, 0);
  const reQuote = await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
    .send({ groupId, messageIds: [messageId] });
  assert.equal(reQuote.status, 410);
  const scrubbed = await fs.readFile(dbPath, 'utf8');
  assert.equal(scrubbed.includes('应永久遗忘的私人笔记'), false);
  const current = await getUserDb(owner.id);
  await current.read();
  assert.equal(current.data.memoryRecords.find(record => record.id === note.body.memoryId).content, null);
  assert.equal(current.data.memoryRecords.find(record => record.id === quote.body.results[0].memoryId).content, null);
});

test('unreadable deletion journal fails closed before reading or mutating memory', async () => {
  const owner = await account('memory_broken_barrier');
  const saved = await request.post('/api/memory/store').set('Cookie', owner.cookie)
    .send({ content: '损坏账本时不得泄露' });
  assert.equal(saved.status, 200);
  const ownerHash = createHash('sha256').update(JSON.stringify(owner.id)).digest('hex');
  const journal = path.join(process.env.DATA_DIR, 'memory-deletions', ownerHash, 'deletions.v1.log');
  const original = await fs.readFile(journal);
  await fs.writeFile(journal, 'broken journal');
  try {
    const read = await request.get(`/api/memory/${saved.body.memoryId}`).set('Cookie', owner.cookie);
    const list = await request.get('/api/memory').set('Cookie', owner.cookie);
    const forget = await request.post(`/api/memory/${saved.body.memoryId}/forget`)
      .set('Cookie', owner.cookie).send({});
    const messages = await request.get(`/api/groups/${(await getUserDb(owner.id)).data.groups[0].id}/messages`)
      .set('Cookie', owner.cookie);
    const search = await request.get('/api/search').set('Cookie', owner.cookie)
      .query({ q: '损坏账本', type: 'messages' });
    assert.equal(read.status, 503);
    assert.equal(list.status, 503);
    assert.equal(forget.status, 503);
    assert.equal(messages.status, 503);
    assert.equal(search.status, 503);
  } finally {
    await fs.writeFile(journal, original);
  }
  assert.equal((await request.get(`/api/memory/${saved.body.memoryId}`)
    .set('Cookie', owner.cookie)).status, 200);
});

test('clearing messages revokes old sources but permits later messages in the same group', async () => {
  const owner = await account('memory_clear_group');
  const db = await getUserDb(owner.id);
  const groupId = db.data.groups[0].id;
  const oldId = randomUUID();
  await withWriteLock(owner.id, async () => {
    await db.read();
    db.data.messages.push({ id: oldId, group_id: groupId, sender_id: owner.id,
      sender_type: 'user', content: '清空前的摘录', content_type: 'text',
      metadata: {}, created_at: new Date().toISOString() });
    await db.write();
  });
  const oldQuote = await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
    .send({ groupId, messageIds: [oldId] });
  assert.equal(oldQuote.status, 201);
  const cleared = await request.delete(`/api/groups/${groupId}/messages`)
    .set('Cookie', owner.cookie);
  assert.equal(cleared.status, 200);
  assert.equal((await request.get(`/api/memory/${oldQuote.body.results[0].memoryId}`)
    .set('Cookie', owner.cookie)).status, 410);
  const newId = randomUUID();
  await withWriteLock(owner.id, async () => {
    await db.read();
    db.data.messages.push({ id: newId, group_id: groupId, sender_id: owner.id,
      sender_type: 'user', content: '清空后的新摘录', content_type: 'text',
      metadata: {}, created_at: new Date().toISOString() });
    await db.write();
  });
  const newQuote = await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
    .send({ groupId, messageIds: [newId] });
  assert.equal(newQuote.status, 201);
  assert.equal((await request.get(`/api/memory/${newQuote.body.results[0].memoryId}`)
    .set('Cookie', owner.cookie)).status, 200);
  const visible = await request.get(`/api/groups/${groupId}/messages`).set('Cookie', owner.cookie);
  assert.equal(visible.status, 200);
  assert.equal(visible.body.messages.some(message => message.id === oldId), false);
  assert.equal(visible.body.messages.some(message => message.id === newId), true);
});

test('all source deletion routes reject restored old quotes without crossing surviving sources', async t => {
  for (const mode of ['single', 'batch', 'clear', 'group', 'ai_private']) {
    await t.test(mode, async () => {
      const owner = await account(`memory_${mode}`);
      const db = await getUserDb(owner.id);
      const groupId = db.data.groups[1].id;
      const groupName = db.data.groups[1].name;
      const ids = [randomUUID(), randomUUID()];
      const fileId = randomUUID();
      await withWriteLock(owner.id, async () => {
        await db.read();
        if (mode === 'ai_private') {
          const group = db.data.groups.find(item => item.id === groupId);
          group.type = 'ai_private';
          group.is_ai_private = true;
        }
        for (const id of ids) {
          db.data.messages.push({ id, group_id: groupId, sender_id: owner.id,
            sender_type: 'user', content: `旧来源 ${id}`, content_type: 'text',
            metadata: {}, created_at: new Date().toISOString() });
        }
        if (mode === 'group') db.data.files.push({ id: fileId, group_id: groupId,
          filename: `ghost-${fileId}.png`, mime_type: 'image/png',
          parsed_content: 'deleted-group-file' });
        await db.write();
      });
      const quotes = await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
        .send({ groupId, messageIds: ids });
      assert.equal(quotes.status, 201);
      const dbPath = path.join(process.env.DATA_DIR, 'users', `db_${owner.id}.json`);
      const beforeDelete = await fs.readFile(dbPath);
      let deleted;
      if (mode === 'single') {
        deleted = await request.delete(`/api/messages/${ids[0]}`).set('Cookie', owner.cookie);
      } else if (mode === 'batch') {
        deleted = await request.post('/api/messages/batch-delete').set('Cookie', owner.cookie)
          .send({ group_id: groupId, message_ids: ids });
      } else if (mode === 'clear') {
        deleted = await request.delete(`/api/groups/${groupId}/messages`).set('Cookie', owner.cookie);
      } else if (mode === 'group') {
        deleted = await request.delete(`/api/groups/${groupId}`).set('Cookie', owner.cookie);
      } else {
        deleted = await request.delete(`/api/ai-private-chats/${groupId}`)
          .set('Cookie', owner.cookie);
      }
      assert.equal(deleted.status, 200);
      await fs.writeFile(dbPath, beforeDelete);
      clearUserDbCache(owner.id);
      const restoredMessages = await request.get(`/api/groups/${groupId}/messages`)
        .set('Cookie', owner.cookie);
      if (mode === 'group' || mode === 'ai_private') {
        assert.equal(restoredMessages.status, 404);
      } else {
        assert.equal(restoredMessages.status, 200);
        assert.deepEqual(ids.map(id => restoredMessages.body.messages.some(message => message.id === id)),
          mode === 'single' ? [false, true] : [false, false]);
      }
      if (mode === 'group') {
        assert.equal((await request.post(`/api/groups/${groupId}/messages`)
          .set('Cookie', owner.cookie).send({ content: '不得在已删除群继续发消息' })).status, 404);
        const groups = await request.get('/api/groups').set('Cookie', owner.cookie);
        assert.equal(groups.status, 200);
        assert.equal(groups.body.some(group => group.id === groupId), false);
        assert.equal((await request.get(`/api/groups/${groupId}`)
          .set('Cookie', owner.cookie)).status, 404);
        assert.equal((await request.get(`/api/groups/${groupId}/insights`)
          .set('Cookie', owner.cookie)).status, 404);
        assert.equal((await request.delete(`/api/groups/${groupId}`)
          .set('Cookie', owner.cookie)).status, 404);
        const groupSearch = await request.get('/api/search').set('Cookie', owner.cookie)
          .query({ q: groupName, type: 'groups' });
        assert.equal(groupSearch.body.groups.some(group => group.id === groupId), false);
        const fileSearch = await request.get('/api/search').set('Cookie', owner.cookie)
          .query({ q: fileId, type: 'files,media' });
        assert.equal(fileSearch.body.files.some(file => file.id === fileId), false);
        assert.equal(fileSearch.body.media.some(file => file.id === fileId), false);
      }
      const restoredSearch = await request.get('/api/search').set('Cookie', owner.cookie)
        .query({ q: ids[0], type: 'messages,comments' });
      assert.equal(restoredSearch.status, 200);
      assert.equal(restoredSearch.body.messages.some(message => message.id === ids[0]), false);
      const blocked = mode === 'single' ? [0] : [0, 1];
      for (const index of blocked) {
        const id = quotes.body.results[index].memoryId;
        assert.equal((await request.get(`/api/memory/${id}`).set('Cookie', owner.cookie)).status, 410);
        assert.equal((await request.post('/api/memory/store-messages').set('Cookie', owner.cookie)
          .send({ groupId, messageIds: [ids[index]] })).status, 410);
      }
      if (mode === 'single') {
        assert.equal((await request.get(`/api/memory/${quotes.body.results[1].memoryId}`)
          .set('Cookie', owner.cookie)).status, 200);
      }
      const list = await request.get('/api/memory').set('Cookie', owner.cookie);
      assert.equal(list.status, 200);
      assert.equal(list.body.total, mode === 'single' ? 1 : 0);
      const search = await request.post('/api/memory/retrieve').set('Cookie', owner.cookie)
        .send({ query: ids[0] });
      assert.equal(search.status, 200);
      assert.equal(search.body.count, 0);
    });
  }
});
