import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-msg-data-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;

await initDatabase();
await initAuthDb();

const request = supertest(createTestApp());

function uniqueUsername(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function registerAndGetSession() {
  const username = uniqueUsername('msgcase');
  const response = await request
    .post('/api/auth/register')
    .send({
      username,
      password: 'Passw0rd123',
      nickname: 'Message Case'
    });

  assert.equal(response.status, 201);
  return response.headers['set-cookie'];
}

test('message route forces user identity and preserves metadata', async () => {
  const cookies = await registerAndGetSession();

  const groupsResponse = await request
    .get('/api/groups')
    .set('Cookie', cookies);
  assert.equal(groupsResponse.status, 200);
  assert.ok(groupsResponse.body.length > 0);

  const groupId = groupsResponse.body[0].id;
  const sendResponse = await request
    .post(`/api/groups/${groupId}/messages`)
    .set('Cookie', cookies)
    .send({
      content: '请记录这条消息',
      sender_type: 'system',
      sender_id: 'fake-ai',
      metadata: {
        traceId: 'trace-001',
        encryption: { encrypted: false }
      }
    });

  assert.equal(sendResponse.status, 201);
  assert.equal(sendResponse.body.sender_type, 'user');
  assert.notEqual(sendResponse.body.sender_id, 'fake-ai');
  assert.ok(typeof sendResponse.body.sender_id === 'string' && sendResponse.body.sender_id.length > 0);
  assert.equal(sendResponse.body.metadata.traceId, 'trace-001');

  const listResponse = await request
    .get(`/api/groups/${groupId}/messages`)
    .set('Cookie', cookies);
  assert.equal(listResponse.status, 200);
  assert.ok(Array.isArray(listResponse.body.messages));

  const savedMessage = listResponse.body.messages.find((message) => message.id === sendResponse.body.id);
  assert.ok(savedMessage);
  assert.equal(savedMessage.sender_type, 'user');
  assert.equal(savedMessage.sender_id, sendResponse.body.sender_id);
  assert.equal(savedMessage.metadata.traceId, 'trace-001');
});

test('comment nesting is limited to five levels', async () => {
  const cookies = await registerAndGetSession();
  const groupsResponse = await request
    .get('/api/groups')
    .set('Cookie', cookies);
  assert.equal(groupsResponse.status, 200);

  const groupId = groupsResponse.body[0].id;
  const sendResponse = await request
    .post(`/api/groups/${groupId}/messages`)
    .set('Cookie', cookies)
    .send({ content: '评论层级测试' });

  assert.equal(sendResponse.status, 201);
  const messageId = sendResponse.body.id;

  let parentId = null;
  for (let depth = 0; depth <= 5; depth++) {
    const commentResponse = await request
      .post('/api/comments')
      .set('Cookie', cookies)
      .send({
        message_id: messageId,
        content: `depth-${depth}`,
        parent_id: parentId,
        reply_to: parentId
      });

    if (depth < 5) {
      assert.equal(commentResponse.status, 201);
      parentId = commentResponse.body.comment.id;
    } else {
      assert.equal(commentResponse.status, 400);
      assert.match(commentResponse.body.error, /不能超过5层/);
    }
  }
});
