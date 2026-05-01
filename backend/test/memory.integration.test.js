import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-memory-data-'));
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

async function registerAndGetSession(prefix) {
  const username = uniqueUsername(prefix);
  const response = await request
    .post('/api/auth/register')
    .send({
      username,
      password: 'Passw0rd123',
      nickname: 'Memory Case'
    });

  assert.equal(response.status, 201);

  const cookies = response.headers['set-cookie'];
  const meResponse = await request
    .get('/api/auth/me')
    .set('Cookie', cookies);

  assert.equal(meResponse.status, 200);

  return {
    cookies,
    user: meResponse.body.user
  };
}

test('memory routes enforce user identity, honor dateRange, and isolate per user', async () => {
  const userA = await registerAndGetSession('memorya');
  const userB = await registerAndGetSession('memoryb');

  const storeResponse = await request
    .post('/api/memory/store')
    .set('Cookie', userA.cookies)
    .send({
      content: '只属于用户A的重要事实 12345',
      sender_id: 'fake-ai',
      sender_type: 'system',
      metadata: {
        traceId: 'memory-trace-1'
      }
    });

  assert.equal(storeResponse.status, 200);
  assert.equal(storeResponse.body.success, true);
  assert.ok(storeResponse.body.memoryId);

  const today = new Date().toISOString().slice(0, 10);

  const ownRetrieveResponse = await request
    .post('/api/memory/retrieve')
    .set('Cookie', userA.cookies)
    .send({
      query: '重要事实 12345',
      senderId: userA.user.id,
      dateRange: {
        start: today,
        end: today
      },
      limit: 10
    });

  assert.equal(ownRetrieveResponse.status, 200);
  assert.equal(ownRetrieveResponse.body.success, true);
  assert.ok(ownRetrieveResponse.body.count >= 1);

  const ownStoredMemory = ownRetrieveResponse.body.results.find(
    (item) => item.memory.id === storeResponse.body.memoryId
  );
  assert.ok(ownStoredMemory);
  assert.equal(ownStoredMemory.memory.sender_id, userA.user.id);
  assert.equal(ownStoredMemory.memory.sender_type, 'user');
  assert.equal(ownStoredMemory.memory.metadata.traceId, 'memory-trace-1');

  const forgedSenderRetrieveResponse = await request
    .post('/api/memory/retrieve')
    .set('Cookie', userA.cookies)
    .send({
      query: '重要事实 12345',
      senderId: 'fake-ai',
      limit: 10
    });

  assert.equal(forgedSenderRetrieveResponse.status, 200);
  assert.equal(forgedSenderRetrieveResponse.body.count, 0);

  const crossUserRetrieveResponse = await request
    .post('/api/memory/retrieve')
    .set('Cookie', userB.cookies)
    .send({
      query: '重要事实 12345',
      limit: 10
    });

  assert.equal(crossUserRetrieveResponse.status, 200);
  assert.equal(crossUserRetrieveResponse.body.count, 0);
});
