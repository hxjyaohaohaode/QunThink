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

test('fresh accounts have no implicit models or providers even with every old server key and opt-in set', () => {
  const catalog = publicCatalog({});
  assert.deepEqual(catalog.models, []);
  assert.deepEqual(catalog.providers, []);
  assert.deepEqual(catalog.defaults, { chat: null, vision: null, tts: null });
  for (const [, id] of vendorInputs) assert.throws(() => resolveModelSnapshot({}, id, 'chat', { allowUnverified: true }), { status: 404 });
});

test('explicit per-user catalog remains unchanged; all four server-key sources stay unavailable', () => {
  const modelCatalog = explicitCatalog();
  const data = { modelCatalog };
  const before = structuredClone(data);
  assert.deepEqual(getCatalogData(data), modelCatalog);
  const visible = publicCatalog(data);
  for (const p of visible.providers) {
    assert.equal(p.keySource, 'none'); assert.equal(p.apiKeyConfigured, false); assert.equal(p.ready, false);
    assert.equal(Object.hasOwn(p, 'apiKey'), false);
  }
  for (const m of modelCatalog.models) assert.throws(() => resolveModelSnapshot(data, m.id, 'chat', { allowUnverified: true }), { status: 409 });
  assert.deepEqual(data, before);
});

test('server-key rotation cannot affect user connection fingerprint, readiness, or explicit no-key connection', () => {
  const modelCatalog = explicitCatalog('user-owned-test-secret');
  const data = { modelCatalog };
  const model = modelCatalog.models[0], provider = modelCatalog.providers[0];
  const before = capabilityFingerprint(model, provider, data);
  process.env.DEEPSEEK_API_KEY += '-rotated';
  assert.equal(capabilityFingerprint(model, provider, data), before);
  assert.equal(publicCatalog(data).providers[0].keySource, 'user');
  assert.equal(resolveModelSnapshot(data, model.id, null).apiKey, 'user-owned-test-secret');
  provider.apiKey = ''; provider.keyRequired = false;
  const noKey = resolveModelSnapshot(data, model.id, null);
  assert.equal(noKey.apiKey, '');
  assert.equal(publicCatalog(data).providers[0].keySource, 'none');
  assert.equal(publicCatalog(data).providers[0].ready, true);
});

test('fresh API lists and groups contain no selectable preset AI', async () => {
  const s = await session();
  const catalog = await request.get('/api/user/model-catalog').set('Cookie', s.cookie);
  assert.equal(catalog.status, 200); assert.deepEqual(catalog.body.models, []); assert.deepEqual(catalog.body.providers, []);
  const personas = await request.get('/api/personas').set('Cookie', s.cookie);
  assert.equal(personas.status, 200); assert.deepEqual(personas.body.personas, {});
  const models = await request.get('/api/ai/models').set('Cookie', s.cookie);
  assert.equal(models.status, 200); assert.deepEqual(models.body.models, {}); assert.equal(models.body.totalModels, 0);
  const agents = await request.get('/api/agents').set('Cookie', s.cookie);
  assert.equal(agents.status, 200); assert.deepEqual(agents.body, []);
  const groups = await request.get('/api/groups').set('Cookie', s.cookie);
  assert.equal(groups.status, 200); assert.ok(groups.body.every(group => group.ai_members.length === 0));
  clearUserDbCache(s.userId);
  const reloaded = await getUserDb(s.userId);
  assert.ok(reloaded.data.groups.every(group => group.ai_members.length === 0));
});

test('all legacy provider test routes reject environment-funded probes before any dispatch', async () => {
  const s = await session();
  const before = outbound.length;
  for (const [vendor, , baseUrl] of vendorInputs) {
    for (const body of [{ vendor }, { vendor, baseUrl }]) {
      const response = await request.post('/api/user/apiconfig/test').set('Cookie', s.cookie).send(body);
      assert.ok(response.status >= 400, `${vendor}: ${response.status}`);
      assert.notEqual(response.body.healthy, true);
    }
  }
  assert.equal(outbound.length, before, 'legacy test routes must not reach the provider transport');
});

test('catalog discovery/probes, agents, tasks, and new private/group chat reject retired model IDs', async () => {
  const s = await session();
  const before = outbound.length;
  assert.equal((await request.post('/api/user/model-catalog/discover').set('Cookie', s.cookie).send({ providerId: 'deepseek' })).status, 404);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ clientRequestId: crypto.randomUUID(), modelId: 'deepseek', capability: 'chat' })).status, 404);
  assert.equal((await request.post('/api/private-chat/deepseek').set('Cookie', s.cookie).send({})).status, 400);
  assert.equal((await request.post('/api/groups').set('Cookie', s.cookie).send({ name: 'No preset', ai_members: ['deepseek'] })).status, 400);
  assert.equal((await request.post('/api/agents').set('Cookie', s.cookie).send({ name: 'No preset', description: 'user description', openingMessage: 'hello', modelId: 'deepseek' })).status, 404);
  assert.equal((await request.post('/api/tasks').set('Cookie', s.cookie).send({ title: 'No preset', prompt: 'hello', model_id: 'deepseek' })).status, 404);
  assert.equal((await request.post('/api/tasks').set('Cookie', s.cookie).send({ title: 'No default', prompt: 'hello', auto_run: true, run_at: new Date(Date.now() + 60000).toISOString() })).status, 409);
  await assert.rejects(createAgent(s.userId, 'No default', 'description', 'hello', false, {}), { status: 409 });
  assert.equal(outbound.length, before);
});

test('explicit keyless canonical providers cannot be discovered, probed, or used despite populated server environment', async () => {
  const s = await session();
  s.userDb.data.modelCatalog = explicitCatalog();
  s.userDb.data.modelCapabilityChecks = {};
  for (const model of s.userDb.data.modelCatalog.models) {
    const provider = s.userDb.data.modelCatalog.providers.find(p => p.id === model.providerId);
    s.userDb.data.modelCapabilityChecks[model.id] = { chat: { status: 'verified', fingerprint: capabilityFingerprint(model, provider, s.userDb.data) } };
  }
  await s.userDb.write();
  const before = outbound.length;
  for (const [providerId, modelId] of vendorInputs) {
    const discover = await request.post('/api/user/model-catalog/discover').set('Cookie', s.cookie).send({ providerId });
    assert.equal(discover.status, 409, `${providerId}: discovery must reject absent user key`);
    const probe = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
      .send({ clientRequestId: crypto.randomUUID(), modelId, capability: 'chat' });
    assert.equal(probe.status, 409, `${providerId}: probe must reject absent user key`);
    await assert.rejects(resolveModel(s.userId, modelId, 'chat'), { status: 409 });
  }
  await assert.rejects(defaultModelId(s.userId), { status: 409 });
  await assert.rejects(createAgent(s.userId, 'No key', 'description', 'hello', false, {}, null, 'deepseek'), { status: 409 });
  await assert.rejects(createTask(s.userId, { title: 'No key', prompt: 'hello', model_id: 'deepseek' }), { status: 409 });
  assert.equal(outbound.length, before);
});

test('direct chat, stream, debate and task execution cannot obtain a server fallback', async () => {
  const s = await session();
  const before = outbound.length;
  const persona = { id: 'deepseek', name: 'Retired preset' };
  await assert.rejects(callAI('deepseek', persona, 'hello', [], 'free_chat', null, [], null, null, false, [], s.userId), { status: 404 });
  await assert.rejects(callAIStream('deepseek', persona, 'hello', [], 'free_chat', null, [], null, null, false, [], null, [], null, null, s.userId), { status: 404 });
  await assert.rejects(callAIDebate('deepseek', persona, 'hello', [], 1, 2, 1, null, s.userId), { status: 404 });
  const task = await createTask(s.userId, { title: 'Offline draft', prompt: 'hello' });
  const failedTask = await runTask(s.userId, task.id, { client_request_id: crypto.randomUUID() });
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.history.at(-1).dispatch_status, 'not_sent');
  assert.match(failedTask.error, /模型中心/);
  assert.equal(outbound.length, before);
});

test('legacy saved keys and user history survive reads without automatic model seeding', async () => {
  const s = await session();
  s.userDb.data.aiApiConfigs = { deepseek: { apiKey: 'legacy-user-owned-test-secret', baseUrl: 'https://api.deepseek.com' } };
  s.userDb.data.agents = [{ id: 'user-agent', name: 'My agent', model_roles: [{ modelId: 'deepseek', role: '主回复' }] }];
  s.userDb.data.agent_messages = [{ id: 'historic-agent-message', agent_id: 'user-agent', role: 'assistant', content: 'Saved content' }];
  s.userDb.data.messages = [{ id: 'historic-group-message', group_id: 'group-presidential', sender_id: 'deepseek', sender_type: 'ai', content: 'Saved content' }];
  const preserved = structuredClone({ config: s.userDb.data.aiApiConfigs, agents: s.userDb.data.agents, agentMessages: s.userDb.data.agent_messages, messages: s.userDb.data.messages });
  await s.userDb.write(); clearUserDbCache(s.userId);
  const catalog = await readCatalog(s.userId);
  assert.deepEqual(catalog.models, []);
  const reloaded = await getUserDb(s.userId);
  assert.deepEqual(reloaded.data.aiApiConfigs, preserved.config);
  assert.deepEqual(reloaded.data.agents, preserved.agents);
  assert.deepEqual(reloaded.data.agent_messages, preserved.agentMessages);
  assert.deepEqual(reloaded.data.messages, preserved.messages);
});

test('user configured catalog, model defaults and verification survive reload and contain only user keys', async () => {
  const s = await session();
  const initial = await readCatalog(s.userId);
  const input = explicitCatalog('explicit-user-owned-test-secret');
  input.revision = initial.revision;
  const saved = await saveCatalog(s.userId, input);
  assert.deepEqual(saved.models.map(m => m.id), input.models.map(m => m.id));
  for (const p of saved.providers) assert.equal(p.keySource, 'user');
  assert.equal(JSON.stringify(saved).includes('explicit-user-owned-test-secret'), false);
  clearUserDbCache(s.userId);
  for (const [, id] of vendorInputs) assert.equal((await resolveModel(s.userId, id)).apiKey, 'explicit-user-owned-test-secret');
  const reloaded = await readCatalog(s.userId);
  assert.deepEqual(reloaded.defaults, input.defaults);
});

test('retired process-global health/load-balancer entrypoints expose no presets and cannot probe', async () => {
  const before = outbound.length;
  if (aiService.getAIConfigs) assert.deepEqual(aiService.getAIConfigs(), {});
  if (loadBalancer) {
    assert.equal(loadBalancer.models.size, 0);
    await loadBalancer.performInitialHealthChecks();
    await loadBalancer.performHealthChecks();
    for (const [, id] of vendorInputs) assert.equal(await loadBalancer.probeHealth(id), false);
  }
  const entrypoint = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(entrypoint, /checkAllAIHealth|AI_HEALTH_PROBES/);
  assert.equal(outbound.length, before);
});


test('user-key probes and chat succeed only through intercepted mock transport with all server keys present', async () => {
  const s = await session();
  const input = explicitCatalog('positive-user-owned-test-secret');
  input.revision = (await readCatalog(s.userId)).revision;
  await saveCatalog(s.userId, input);
  const before = outbound.length;
  mockSuccess = true;
  try {
    for (const [, modelId] of vendorInputs) {
      const response = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
        .send({ clientRequestId: crypto.randomUUID(), modelId, capability: 'chat' });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.healthy, true);
    }
    const response = await callAI('deepseek', { id: 'deepseek', name: 'User model' }, 'hello', [], 'free_chat', null, [], null, null, false, [], s.userId);
    assert.equal(response, 'OK');
    assert.equal(outbound.length - before, 5);
    for (const call of outbound.slice(before)) {
      assert.equal(call.headers.get('Authorization'), 'Bearer positive-user-owned-test-secret');
      assert.equal(JSON.stringify(call.headers).includes('server-owned'), false);
    }
  } finally { mockSuccess = false; }
});

test('upgrade detaches auto-seeded participants reversibly and preserves explicit catalog participants', async () => {
  const s = await session();
  const group = s.userDb.data.groups.find(g => g.id === 'group-presidential');
  group.ai_members = ['deepseek', 'glm_air'];
  const history = [{ id: 'old-ai-message', group_id: group.id, sender_type: 'ai', sender_id: 'deepseek', content: 'retained' }];
  s.userDb.data.messages = history;
  await s.userDb.write(); clearUserDbCache(s.userId);
  const upgraded = await getUserDb(s.userId);
  const migrated = upgraded.data.groups.find(g => g.id === group.id);
  assert.deepEqual(migrated.ai_members, []);
  assert.deepEqual([...migrated.retired_ai_members].sort(), ['deepseek', 'glm_air']);
  assert.deepEqual(upgraded.data.messages, history);
  const first = structuredClone(upgraded.data);
  clearUserDbCache(s.userId);
  assert.deepEqual((await getUserDb(s.userId)).data, first);
  const owned = await session();
  owned.userDb.data.modelCatalog = explicitCatalog('user-owned-key');
  const ownGroup = owned.userDb.data.groups.find(g => g.id === 'group-presidential');
  ownGroup.ai_members = ['deepseek', 'glm_air'];
  const originalCatalog = structuredClone(owned.userDb.data.modelCatalog);
  await owned.userDb.write(); clearUserDbCache(owned.userId);
  const ownedReloaded = await getUserDb(owned.userId);
  assert.deepEqual(ownedReloaded.data.groups.find(g => g.id === ownGroup.id).ai_members, ['deepseek', 'glm_air']);
  assert.deepEqual(ownedReloaded.data.modelCatalog, originalCatalog);
});
