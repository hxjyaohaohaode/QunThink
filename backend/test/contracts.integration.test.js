import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-contract-data-'));
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
  const username = uniqueUsername('contractcase');
  const response = await request
    .post('/api/auth/register')
    .send({
      username,
      password: 'Passw0rd123',
      nickname: 'Contract Case'
    });

  assert.equal(response.status, 201);
  return response.headers['set-cookie'];
}

test('group creation accepts canonical ai_members payload and persists avatar_color', async () => {
  const cookies = await registerAndGetSession();

  const response = await request
    .post('/api/groups')
    .set('Cookie', cookies)
    .send({
      name: '契约群聊',
      description: '契约测试',
      ai_members: ['deepseek', 'glm_air'],
      avatar_color: '#334455'
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.name, '契约群聊');
  assert.deepEqual(response.body.ai_members, ['deepseek', 'glm_air']);
  assert.equal(response.body.avatar_color, '#334455');
});

test('group creation rejects legacy aiMembers alias to prevent contract drift', async () => {
  const cookies = await registerAndGetSession();

  const response = await request
    .post('/api/groups')
    .set('Cookie', cookies)
    .send({
      name: '别名群聊',
      description: '旧字段测试',
      aiMembers: ['deepseek', 'glm_air']
    });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Unrecognized key|aiMembers/);
});
