import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-data-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');

const { initDatabase } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, hashPassword, generateSessionToken } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;

await initDatabase();
await initAuthDb();

const request = supertest(createTestApp());

async function createTestUser() {
  const db = getAuthDb();
  const userId = crypto.randomUUID();
  const phone = `138${String(Date.now()).slice(-8)}`;
  const phoneSuffix = phone.substring(phone.length - 4);
  const user = {
    id: userId,
    username: `user_${phoneSuffix}_${Date.now().toString(36)}`,
    password: hashPassword(crypto.randomBytes(32).toString('hex')),
    nickname: `测试用户${phoneSuffix}`,
    phone,
    created_at: new Date().toISOString()
  };

  await db.read();
  db.data.users.push(user);
  await db.write();

  const token = generateSessionToken();
  const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
  const session = {
    token,
    userId,
    expires_at: new Date(Date.now() + SESSION_MAX_AGE).toISOString()
  };
  db.data.sessions.push(session);
  await db.write();

  return { user, token };
}

test('session auth status reflects login requirement and authenticated session', async () => {
  const beforeLogin = await request.get('/api/auth/token');
  assert.equal(beforeLogin.status, 401);
  assert.equal(beforeLogin.body.enabled, true);
  assert.equal(beforeLogin.body.valid, false);
  assert.equal(beforeLogin.body.mode, 'session');

  const { user, token } = await createTestUser();
  const cookie = `session_token=${token}`;

  const afterLogin = await request
    .get('/api/auth/token')
    .set('Cookie', cookie);
  assert.equal(afterLogin.status, 200);
  assert.equal(afterLogin.body.enabled, true);
  assert.equal(afterLogin.body.valid, true);
  assert.equal(afterLogin.body.mode, 'session');

  const meResponse = await request
    .get('/api/auth/me')
    .set('Cookie', cookie);
  assert.equal(meResponse.status, 200);
  assert.equal(meResponse.body.user.id, user.id);

  const logoutResponse = await request
    .post('/api/auth/logout')
    .set('Cookie', cookie);
  assert.equal(logoutResponse.status, 200);

  const tokenAfterLogout = await request
    .get('/api/auth/token')
    .set('Cookie', cookie);
  assert.equal(tokenAfterLogout.status, 401);
  assert.equal(tokenAfterLogout.body.valid, false);

  const meAfterLogout = await request
    .get('/api/auth/me')
    .set('Cookie', cookie);
  assert.equal(meAfterLogout.status, 401);
});
