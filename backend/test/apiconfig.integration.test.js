import { mockProviderDns } from './helpers/mockProviderDns.js';
mockProviderDns(['api.deepseek.com', 'example.org']);
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import axios from 'axios';

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

test('retired API config test rejects every target before any network request', async () => {
  const { token } = await createSession();
  const response = await supertest(createTestApp())
    .post('/api/user/apiconfig/test')
    .set('Cookie', `session_token=${token}`)
    .send({ vendor: 'deepseek', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:3000/v1' });

  assert.equal(response.status, 410);
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

test('legacy test never sends a stored or environment key to a changed public endpoint', async () => {
  const { userId, token } = await createSession();
  const request = supertest(createTestApp());
  const cookie = `session_token=${token}`;
  const stored = await request.put('/api/user/apiconfig').set('Cookie', cookie)
    .send({ deepseek: { apiKey: 'sk-saved-secret', baseUrl: 'https://api.deepseek.com/v1' } });
  assert.equal(stored.status, 200);
  const changed = await request.post('/api/user/apiconfig/test').set('Cookie', cookie)
    .send({ vendor: 'deepseek', baseUrl: 'https://example.org/v1' });
  assert.equal(changed.status, 410);
  assert.equal(changed.body.healthy, false);
  assert.match(changed.body.error, /旧版连接测试已停用/);
  assert.equal((await request.post('/api/user/apiconfig/test').set('Cookie', cookie)
    .send({ vendor: 'deepseek', baseUrl: 'not a URL' })).status, 410);
  const previousEnvironmentKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'sk-server-secret';
  try {
    const noSaved = await createSession();
    const envChanged = await request.post('/api/user/apiconfig/test').set('Cookie', `session_token=${noSaved.token}`)
      .send({ vendor: 'deepseek', baseUrl: 'https://example.org/v1' });
    assert.equal(envChanged.status, 410);
    assert.equal(envChanged.body.healthy, false);
    assert.match(envChanged.body.error, /旧版连接测试已停用/);
  } finally {
    if (previousEnvironmentKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousEnvironmentKey;
  }
  const moved = await request.put('/api/user/apiconfig').set('Cookie', cookie)
    .send({ deepseek: { baseUrl: 'https://example.org/v1' } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.config.deepseek.apiKeyConfigured, false);
  const db = await getUserDb(userId); await db.read();
  assert.equal(decryptStoredApiKey(db.data.aiApiConfigs.deepseek), '');
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


test('retired legacy probes never spend a saved or supplied user key or choose a preset model', async () => {
  const { token } = await createSession();
  const request = supertest(createTestApp());
  const cookie = `session_token=${token}`;
  const original = axios.defaults.adapter;
  let calls = 0;
  axios.defaults.adapter = async () => { calls++; throw new Error('Unexpected provider dispatch'); };
  try {
    assert.equal((await request.put('/api/user/apiconfig').set('Cookie', cookie)
      .send({ deepseek: { apiKey: 'synthetic-saved-user-key' } })).status, 200);
    for (const body of [
      { vendor: 'deepseek' },
      { vendor: 'deepseek', apiKey: 'synthetic-supplied-key' },
      { vendor: 'deepseek', model: 'explicit-model', apiKey: 'synthetic-supplied-key' }
    ]) {
      const response = await request.post('/api/user/apiconfig/test').set('Cookie', cookie).send(body);
      assert.equal(response.status, 410);
      assert.equal(response.body.replacement, '/api/user/model-catalog/test');
    }
    assert.equal(calls, 0);
  } finally { axios.defaults.adapter = original; }
});
