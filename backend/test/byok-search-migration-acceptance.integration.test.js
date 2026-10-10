import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import axios from 'axios';
import { mockProviderDns } from './helpers/mockProviderDns.js';
mockProviderDns(['api.deepseek.com', 'api.xiaomimimo.com', 'open.bigmodel.cn', 'dashscope.aliyuncs.com']);
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-byok-independent-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const envKeys = ['DEEPSEEK_API_KEY', 'GLM_API_KEY', 'MIMO_API_KEY', 'QWEN_API_KEY'];
for (const name of envKeys) process.env[name] = `server-owned-must-never-dispatch-${name}`;
process.env.QUNTHINK_SHARED_PROVIDER_KEYS = '1';
process.env.AI_HEALTH_PROBES = '1';
const outbound = [];
let mockSuccess = false;
const oldAdapter = axios.defaults.adapter;
axios.defaults.adapter = async config => {
  outbound.push({ url: config.url, headers: config.headers });
  if (mockSuccess) return { config, status: 200, statusText: 'OK', headers: {}, data: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } };
  throw new Error('AUDIT_BLOCKED_ALL_PROVIDER_TRANSPORT');
};
const { getCatalogData, publicCatalog, resolveModelSnapshot, capabilityFingerprint, readCatalog, saveCatalog, resolveModel, defaultModelId } = await import('../src/services/ai/catalog.js');
const { initDatabase, initUserDatabase, getUserDb, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const aiService = await import('../src/services/ai/index.js');
const { callAI, callAIStream, callAIDebate } = aiService;
const { createAgent } = await import('../src/services/agent/index.js');
const { createTask, runTask, stopTaskScheduler } = await import('../src/services/tasks.js');
const loadBalancerExists = await fs.access(new URL('../src/services/ai/loadBalancer.js', import.meta.url)).then(() => true, () => false);
const loadBalancer = loadBalancerExists ? (await import('../src/services/ai/loadBalancer.js')).default : null;
const request = (await import('supertest')).default(createTestApp());
await initDatabase();
await initAuthDb();
after(() => { axios.defaults.adapter = oldAdapter; stopTaskScheduler(); loadBalancer?.cleanupTimers(); });
const vendorInputs = [
  ['deepseek', 'deepseek', 'https://api.deepseek.com', 'deepseek-v4-flash'],
  ['zhipu', 'glm_air', 'https://open.bigmodel.cn/api/paas/v4', 'GLM-4.5-Air'],
  ['mimo', 'mimo_flash', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5-pro'],
  ['qwen', 'qwen_flash', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'Qwen3.5-Flash']
];
function explicitCatalog(apiKey = '') {
  return { revision: 7, defaults: { chat: 'deepseek', vision: null, tts: null },
    providers: vendorInputs.map(([id, , baseUrl]) => ({ id, name: id, protocol: 'openai', baseUrl, enabled: true, keyRequired: true, apiKey })),
    models: vendorInputs.map(([providerId, id, , model]) => ({ id, providerId, name: `User saved ${id}`, model, enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 2048, temperature: null, tokenParameter: 'max_tokens', ttsMode: 'speech', ttsVoice: null, color: '#123456' })) };
}
async function session() {
  const userId = crypto.randomUUID(), token = generateSessionToken();
  const userDb = await initUserDatabase(userId);
  await provisionNewLocalMemoryAccount(userId, userDb);
  const auth = getAuthDb(); await auth.read();
  auth.data.users.push({ id: userId, username: userId, password: 'unused', role: 'admin', created_at: new Date().toISOString() });
  auth.data.sessions.push({ token, userId, expires_at: new Date(Date.now() + 3600000).toISOString() });
  await auth.write();
  return { userId, cookie: `session_token=${token}`, userDb };
}

test('fresh account search exposes no retired preset personas', async () => {
  const s = await session();
  for (const query of ['deepseek', 'GLM', 'MiMo', 'Qwen']) {
    const result = await request.get('/api/search').set('Cookie', s.cookie).query({ q: query, type: 'personas' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.personas, [], query);
  }
});

test('persona search indexes account catalog and saved persona names only', async () => {
  const s = await session();
  const input = explicitCatalog('user-owned-key'); input.revision = (await readCatalog(s.userId)).revision;
  input.models = [ { ...input.models[0], id: 'user_search_model', name: 'My unique BYOK assistant' } ];
  input.defaults.chat = 'user_search_model';
  await saveCatalog(s.userId, input);
  const result = await request.get('/api/search').set('Cookie', s.cookie).query({ q: 'unique BYOK', type: 'personas' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.personas.map(p => p.id), ['user_search_model']);
  await s.userDb.read();
  s.userDb.data.customPersonas = { user_search_model: { name: 'Renamed user assistant' } };
  await s.userDb.write();
  const renamed = await request.get('/api/search').set('Cookie', s.cookie).query({ q: 'Renamed user', type: 'personas' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.personas.map(p => p.id), ['user_search_model']);
  const other = await session();
  const isolated = await request.get('/api/search').set('Cookie', other.cookie).query({ q: 'Renamed user', type: 'personas' });
  assert.deepEqual(isolated.body.personas, []);
});

test('legacy API-config save/read and migration preserve user keys without recreating default models', async () => {
  const s = await session(), secret = 'legacy-user-owned-preserved';
  const saved = await request.put('/api/user/apiconfig').set('Cookie', s.cookie)
    .send({ deepseek: { apiKey: secret, baseUrl: 'https://api.deepseek.com' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.deepseek.apiKeyConfigured, true);
  assert.equal(JSON.stringify(saved.body).includes(secret), false);
  const unchanged = await request.put('/api/user/apiconfig').set('Cookie', s.cookie)
    .send({ deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com' } });
  assert.equal(unchanged.status, 200);
  const { decryptStoredApiKey } = await import('../src/utils/apiConfigSecurity.js');
  await s.userDb.read();
  const legacyStored = structuredClone(s.userDb.data.aiApiConfigs);
  assert.equal(decryptStoredApiKey(legacyStored.deepseek), secret);
  assert.equal(legacyStored.deepseek.apiKeyEncrypted, true);
  const catalog = await readCatalog(s.userId);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.providers[0].keySource, 'user');
  catalog.models.push(explicitCatalog().models[0]);
  catalog.defaults.chat = 'deepseek';
  const upgraded = await saveCatalog(s.userId, catalog);
  assert.deepEqual(upgraded.models.map(m => m.id), ['deepseek']);
  assert.equal(upgraded.providers[0].keySource, 'user');
  assert.equal((await resolveModel(s.userId, 'deepseek')).apiKey, secret);
  await s.userDb.read();
  assert.deepEqual(s.userDb.data.aiApiConfigs, legacyStored);
  assert.equal(s.userDb.data.modelCatalog.providers[0].apiKeyEncrypted, true);
  assert.equal(JSON.stringify(upgraded).includes(secret), false);
  clearUserDbCache(s.userId);
  assert.equal((await resolveModel(s.userId, 'deepseek')).apiKey, secret);
});

test('member search finds user catalog/persona names while preserving unavailable historical member labels', async () => {
  const s = await session();
  const input = explicitCatalog('user-owned-key'); input.revision = (await readCatalog(s.userId)).revision;
  input.models = [{ ...input.models[0], id: 'custom_member', name: 'Catalog Member Unique' }];
  input.defaults.chat = 'custom_member';
  await saveCatalog(s.userId, input);
  await s.userDb.read();
  s.userDb.data.groups.push({ id: 'custom-history-group', type: 'custom', name: 'Historical user group', ai_members: ['custom_member', 'deepseek'], created_at: new Date().toISOString() });
  await s.userDb.write();
  const catalogName = await request.get('/api/search').set('Cookie', s.cookie).query({ q: 'Catalog Member Unique', type: 'members' });
  assert.equal(catalogName.status, 200);
  assert.deepEqual(catalogName.body.members.map(m => m.id), ['custom_member']);
  await s.userDb.read();
  s.userDb.data.customPersonas = { custom_member: { name: 'Renamed Member Unique', keywords: ['special-owned-expertise'] } };
  await s.userDb.write();
  for (const q of ['Renamed Member Unique', 'special-owned-expertise']) {
    const custom = await request.get('/api/search').set('Cookie', s.cookie).query({ q, type: 'members' });
    assert.equal(custom.status, 200);
    assert.deepEqual(custom.body.members.map(m => m.id), ['custom_member']);
  }
  const historical = await request.get('/api/search').set('Cookie', s.cookie).query({ q: 'deepseek', type: 'members' });
  assert.equal(historical.status, 200);
  assert.deepEqual(historical.body.members.map(m => m.id), ['deepseek']);
  assert.match(historical.body.members[0].name, /deepseek/i);
});

test('retired legacy probe cannot select a platform model even when a user key is supplied or stored', async () => {
  const s = await session();
  await request.put('/api/user/apiconfig').set('Cookie', s.cookie)
    .send({ deepseek: { apiKey: 'owned-key', baseUrl: 'https://api.deepseek.com' } });
  const before = outbound.length;
  for (const body of [{ vendor: 'deepseek' }, { vendor: 'deepseek', apiKey: 'owned-key' }, { vendor: 'deepseek', apiKey: 'owned-key', model: 'deepseek-chat' }]) {
    const response = await request.post('/api/user/apiconfig/test').set('Cookie', s.cookie).send(body);
    assert.equal(response.status, 410);
    assert.equal(response.body.replacement, '/api/user/model-catalog/test');
  }
  assert.equal(outbound.length, before);
});
