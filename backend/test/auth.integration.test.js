import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-data-'));
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

test('session auth status reflects login requirement and authenticated session', async () => {
  const beforeLogin = await request.get('/api/auth/token');
  assert.equal(beforeLogin.status, 401);
  assert.equal(beforeLogin.body.enabled, true);
  assert.equal(beforeLogin.body.valid, false);
  assert.equal(beforeLogin.body.mode, 'session');

  const username = uniqueUsername('authcase');
  const registerResponse = await request
    .post('/api/auth/register')
    .send({
      username,
      password: 'Passw0rd123',
      nickname: 'Auth Case'
    });

  assert.equal(registerResponse.status, 201);
  const cookies = registerResponse.headers['set-cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length > 0);

  const afterLogin = await request
    .get('/api/auth/token')
    .set('Cookie', cookies);
  assert.equal(afterLogin.status, 200);
  assert.equal(afterLogin.body.enabled, true);
  assert.equal(afterLogin.body.valid, true);
  assert.equal(afterLogin.body.mode, 'session');

  const meResponse = await request
    .get('/api/auth/me')
    .set('Cookie', cookies);
  assert.equal(meResponse.status, 200);
  assert.equal(meResponse.body.user.username, username);

  const logoutResponse = await request
    .post('/api/auth/logout')
    .set('Cookie', cookies);
  assert.equal(logoutResponse.status, 200);

  const tokenAfterLogout = await request
    .get('/api/auth/token')
    .set('Cookie', cookies);
  assert.equal(tokenAfterLogout.status, 401);
  assert.equal(tokenAfterLogout.body.valid, false);

  const meAfterLogout = await request
    .get('/api/auth/me')
    .set('Cookie', cookies);
  assert.equal(meAfterLogout.status, 401);
});
