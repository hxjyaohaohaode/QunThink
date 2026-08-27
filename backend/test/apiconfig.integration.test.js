import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-chat-api-config-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { initDatabase, initUserDatabase, getUserDb } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { migrateApiConfigSecrets } = await import('../src/services/apiConfigMigration.js');
const { decryptStoredApiKey } = await import('../src/utils/apiConfigSecurity.js');
const supertest = (await import('supertest')).default;

await initDatabase();
await initAuthDb();

async function createSession() {
  const userId = crypto.randomUUID();
  const token = generateSessionToken();
  const authDb = getAuthDb();
  await authDb.read();
  authDb.data.users.push({ id: userId, username: `config_${userId}`, password: 'unused', created_at: new Date().toISOString() });
  authDb.data.sessions.push({ token, userId, expires_at: new Date(Date.now() + 60_000).toISOString() });
  await authDb.write();
  await initUserDatabase(userId);
  return { userId, token };
}

test('API config endpoint encrypts secrets and returns only configured state', async () => {
  const { userId, token } = await createSession();
  const request = supertest(createTestApp());
  const secret = 'sk-route-secret';

  const saved = await request
    .put('/api/user/apiconfig')
    .set('Cookie', `session_token=${token}`)
    .send({ deepseek: { apiKey: secret, baseUrl: 'https://api.deepseek.com/v1' } });

  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.deepseek.apiKey, '');
  assert.equal(saved.body.config.deepseek.apiKeyConfigured, true);
  assert.equal(JSON.stringify(saved.body).includes(secret), false);

  const db = await getUserDb(userId);
  await db.read();
  assert.equal(db.data.aiApiConfigs.deepseek.apiKeyEncrypted, true);
  assert.notEqual(db.data.aiApiConfigs.deepseek.apiKey, secret);

  const loaded = await request.get('/api/user/apiconfig').set('Cookie', `session_token=${token}`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.config.deepseek.apiKey, '');
  assert.equal(loaded.body.config.deepseek.apiKeyConfigured, true);
});

test('API config test rejects loopback targets before any network request', async () => {
  const { token } = await createSession();
  const response = await supertest(createTestApp())
    .post('/api/user/apiconfig/test')
    .set('Cookie', `session_token=${token}`)
    .send({ vendor: 'deepseek', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:3000/v1' });

  assert.equal(response.status, 400);
  assert.equal(response.body.healthy, false);
});

test('API config save rejects malformed and loopback Base URLs before persistence', async () => {
  const { userId, token } = await createSession();
  const request = supertest(createTestApp());

  const loopback = await request
    .put('/api/user/apiconfig')
    .set('Cookie', `session_token=${token}`)
    .send({ deepseek: { baseUrl: 'http://127.0.0.1:3000/v1' } });
  assert.equal(loopback.status, 400);

  const malformed = await request
    .put('/api/user/apiconfig')
    .set('Cookie', `session_token=${token}`)
    .send({ deepseek: { baseUrl: 'not a URL' } });
  assert.equal(malformed.status, 400);

  const db = await getUserDb(userId);
  await db.read();
  assert.equal(db.data.aiApiConfigs?.deepseek?.baseUrl || '', '');
});

test('startup migration encrypts legacy plaintext API keys under the user write lock', async () => {
  const { userId } = await createSession();
  const db = await getUserDb(userId);
  await db.read();
  db.data.aiApiConfigs = { zhipu: { apiKey: 'legacy-secret', baseUrl: '' } };
  await db.write();

  const result = await migrateApiConfigSecrets();
  assert.ok(result.migratedKeys >= 1);
  await db.read();
  assert.equal(db.data.aiApiConfigs.zhipu.apiKeyEncrypted, true);
  assert.notEqual(db.data.aiApiConfigs.zhipu.apiKey, 'legacy-secret');
  assert.equal(decryptStoredApiKey(db.data.aiApiConfigs.zhipu), 'legacy-secret');

  const secondRun = await migrateApiConfigSecrets();
  assert.equal(secondRun.migratedKeys, 0, 'migration is idempotent');
});
