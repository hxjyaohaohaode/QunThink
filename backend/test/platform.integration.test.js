import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import sharp from 'sharp';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-platform-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.DEEPSEEK_API_KEY = 'server-owned-test-key';
process.env.QUNTHINK_SHARED_PROVIDER_KEYS = '1';
const { initDatabase, initUserDatabase, getUserDb, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { readCatalog, saveCatalog, resolveModel, defaultModelId, modelPersona } = await import('../src/services/ai/catalog.js');
const { callAI, callAIStream, callAIDebate } = await import('../src/services/ai/index.js');
const { consumeSSE, buildRequestBody, requestCompletion, requestCompletionStream, responseUsage } = await import('../src/services/ai/transport.js');
const { createTask, listTasks, runTask, updateTask, tickTasks, startTaskScheduler, stopTaskScheduler } = await import('../src/services/tasks.js');
const { UserScopedMap, runAsUser } = await import('../src/services/userScope.js');
const { queueAIMessages, getActiveAutonomousTimerCount, startAutonomousChatTimer,
  stopAutonomousChatTimer, startAIPrivateChat, getChatStatus } = await import('../src/services/scheduler/index.js');
const { mentionedModelIds } = await import('../src/services/mentions.js');
const { encryptText } = await import('../src/utils/encryption.js');
const { default: systemMonitor } = await import('../src/services/monitoring/monitor.js');
const supertest = (await import('supertest')).default;
const request = supertest(createTestApp());
await initDatabase(); await initAuthDb();

const calls = [];
const slow = [];
let nextStreamReply = null;
let slowContinuationRequests = 0;
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  calls.push({ body, headers: req.headers, path: req.url });
  const isCapabilityProbe = JSON.stringify(body.messages || []).includes('请回复 OK');
  if (req.url.endsWith('/models')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'future/model-v99' }] })); return; }
  if (body.model === 'vision-probe' || body.model === 'vision-wrong') {
    const imageUrl = body.messages?.at(-1)?.content?.find(part => part.type === 'image_url')?.image_url?.url;
    const image = imageUrl && Buffer.from(imageUrl.split(',')[1], 'base64');
    const pixel = image && (await sharp(image).raw().toBuffer()).subarray(0, 3);
    const answer = body.model === 'vision-wrong' ? '绿色' : pixel?.[0] > pixel?.[2] ? '红色' : '蓝色';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: answer } }] })); return;
  }
  if (body.model === 'slow-model' || (body.model === 'slow-task-model' && !isCapabilityProbe)) { slow.push(res); return; }
  if (body.model === 'slow-continuation' && body.stream && ++slowContinuationRequests > 2) { slow.push(res); return; }
  if (body.model === 'broken-model' || (body.model === 'breaks-after-probe' && !isCapabilityProbe)) { res.writeHead(429); res.end('Do not leak this upstream response'); return; }
  if (body.model === 'empty-model' && !isCapabilityProbe) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '' } }], usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 } }));
    return;
  }
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const reply = nextStreamReply || '你好，世界🌏';
    nextStreamReply = null;
    const bytes = Buffer.from('data:' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\r\n\r\ndata: [DONE]\n\n');
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end(); return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url.endsWith('/messages')
    ? { content: [{ type: 'text', text: '原生协议回复' }], usage: { input_tokens: 12, output_tokens: 8 } }
    : { choices: [{ message: { content: '已完成测试任务 ✓' } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const origin = `http://127.0.0.1:${provider.address().port}`;
process.env.AI_ALLOWED_LOCAL_ORIGINS = origin;
after(async () => { stopTaskScheduler(); provider.closeAllConnections(); await new Promise(r => provider.close(r)); });

async function session() {
  const userId = crypto.randomUUID(), token = generateSessionToken();
  const userDb = await initUserDatabase(userId);
  await provisionNewLocalMemoryAccount(userId, userDb);
  const db = getAuthDb(); await db.read();
  db.data.users.push({ id: userId, username: userId, password: 'unused', created_at: new Date().toISOString() });
  db.data.sessions.push({ token, userId, expires_at: new Date(Date.now() + 3600000).toISOString() });
  await db.write();
  return { userId, token, cookie: `session_token=${token}` };
}
function customModel(overrides = {}) {
  return { id: 'custom', providerId: 'custom_provider', name: '我的模型', model: 'future/model-v99', enabled: true, capabilities: ['chat', 'vision'], contextWindow: 32000, maxTokens: 2048, temperature: null, tokenParameter: 'max_completion_tokens', color: '#6366f1', ...overrides };
}
async function configure(userId, overrides = {}) {
  const catalog = await readCatalog(userId);
  catalog.providers.push({ id: 'custom_provider', name: '本地测试', baseUrl: `${origin}/v1`, protocol: 'openai', enabled: true, keyRequired: true, apiKey: 'user-owned-test-secret' });
  catalog.models.push(customModel(overrides)); catalog.defaults.chat = 'custom';
  return saveCatalog(userId, catalog);
}
async function probeChat(s) {
  const result = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'custom', capability: 'chat' });
  assert.equal(result.status, 200);
}
async function eventually(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); }
  throw Error('Condition not reached');
}

test('unconfigured goal runtime does not intercept unrelated chat routes', async () => {
  const s = await session();
  const goals = await request.get('/api/goals').set('Cookie', s.cookie);
  assert.equal(goals.status, 503);
  assert.equal(goals.body.code, 'FOUNDATION_UNAVAILABLE');
  const groups = await request.get('/api/groups').set('Cookie', s.cookie);
  assert.equal(groups.status, 200);
  const messages = await request.get('/api/groups/group-presidential/messages')
    .set('Cookie', s.cookie);
  assert.equal(messages.status, 200);
  assert.deepEqual(messages.body.messages, []);
});

test('legacy admin model controls reject misleading writes and show the active catalog', async () => {
  const s = await session();
  const authDb = getAuthDb();
  await authDb.read();
  authDb.data.users.find(user => user.id === s.userId).role = 'admin';
  await authDb.write();
  await configure(s.userId);
  const beforeCalls = calls.length;
  const list = await request.get('/api/ai/models').set('Cookie', s.cookie);
  assert.equal(list.status, 200);
  assert.equal(list.body.source, 'user_model_catalog');
  assert.equal(list.body.models.custom.model, 'future/model-v99');
  const other = await session();
  assert.equal((await request.get('/api/ai/models').set('Cookie', other.cookie)).status, 403);
  const retired = await request.put('/api/ai/models/custom/enabled').set('Cookie', s.cookie).send({ enabled: false });
  assert.equal(retired.status, 410);
  assert.equal((await readCatalog(s.userId)).models.find(model => model.id === 'custom').enabled, true);
  const probe = await request.post('/api/ai/health-check').set('Cookie', s.cookie).send({});
  assert.equal(probe.status, 410);
  assert.equal(calls.length, beforeCalls);
  const report = await request.get('/api/ai/performance').set('Cookie', s.cookie);
  assert.equal(report.status, 200);
  assert.equal(report.body.status, 'unavailable');
});

test('monitoring does not report unknown model health or simulated scaling as success', async () => {
  const s = await session();
  const authDb = getAuthDb();
  await authDb.read();
  authDb.data.users.find(user => user.id === s.userId).role = 'admin';
  await authDb.write();
  const collected = await systemMonitor.collectMetrics();
  assert.equal(typeof collected.database.status, 'string');
  assert.notEqual(collected.database.status, undefined);
  const snapshot = systemMonitor.getCurrentMetrics();
  assert.equal(snapshot.aiModels.overallHealth, null);
  assert.equal(snapshot.meetsAvailabilityRequirement, null);
  assert.equal(systemMonitor.getSystemStatusReport().summary.availabilityScore, null);
  const before = systemMonitor.getRecentEvents().filter(event => event.type === 'scaling_completed').length;
  const result = await request.post('/api/scaling/trigger').set('Cookie', s.cookie).send({});
  assert.equal(result.status, 501);
  assert.equal(result.body.success, false);
  assert.equal(result.body.result.executed, false);
  assert.equal(systemMonitor.getSystemStatusReport().summary.lastScalingTime, null);
  assert.equal(systemMonitor.getRecentEvents().filter(event => event.type === 'scaling_completed').length, before);
  const manual = await request.post('/api/scaling/manual').set('Cookie', s.cookie)
    .send({ action: 'horizontal_scaling', target: 'workers', amount: 2 });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.result.executed, false);
  const history = await request.get('/api/scaling/history').set('Cookie', s.cookie);
  assert.equal(history.status, 200);
  assert.equal(history.body.persisted, false);
  assert.ok(history.body.history.some(event => event.type === 'manual_scaling_recommended'));
  const other = await session();
  assert.equal((await request.get('/api/metrics').set('Cookie', other.cookie)).status, 403);
  assert.equal((await request.get('/api/scaling/history').set('Cookie', other.cookie)).status, 403);
});

test('malformed client diagnostics are rejected before storage and bounded per user', async () => {
  const s = await session();
  const malformed = await request.post('/api/monitoring/errors').set('Cookie', s.cookie)
    .send({ type: 'react_error', message: { unexpected: true } });
  assert.equal(malformed.status, 400);
  assert.equal((await request.get('/api/client-errors').set('Cookie', s.cookie)).body.count, 0);
  const report = await request.post('/api/monitoring/errors').set('Cookie', s.cookie)
    .send({ type: 'react_error', message: 'render failed', stack: 'secret-not-stored' });
  assert.equal(report.status, 200);
  const own = await request.get('/api/client-errors').set('Cookie', s.cookie);
  assert.equal(own.body.count, 1);
  assert.equal(own.body.errors[0].message, 'render failed');
  assert.equal(JSON.stringify(own.body).includes('secret-not-stored'), false);
  const other = await session();
  assert.equal((await request.get('/api/client-errors').set('Cookie', other.cookie)).body.count, 0);
  for (let index = 0; index < 19; index++) {
    const result = await request.post('/api/monitoring/errors').set('Cookie', s.cookie)
      .send({ type: 'runtime_error', message: `error ${index}` });
    assert.equal(result.status, 200);
  }
  assert.equal((await request.post('/api/monitoring/errors').set('Cookie', s.cookie)
    .send({ type: 'runtime_error', message: 'over limit' })).status, 429);
  assert.equal((await request.get('/api/client-errors').set('Cookie', s.cookie)).body.count, 20);
});

test('model registry persists arbitrary models, encrypts keys, accepts one member and rejects stale edits', async () => {
  const s = await session(); const saved = await configure(s.userId);
  const presetPersona = modelPersona(saved.models.find(model => model.id === 'deepseek'));
  assert.equal(presetPersona.styleTag, '逻辑派');
  assert.equal(presetPersona.responseConfig.maxResponsesPerConversation, 10);
  assert.equal(saved.models.find(m => m.id === 'custom').ready, true);
  assert.equal(JSON.stringify(saved).includes('user-owned-test-secret'), false);
  const db = await getUserDb(s.userId); await db.read();
  const persisted = db.data.modelCatalog.providers.find(p => p.id === 'custom_provider');
  assert.equal(persisted.apiKeyEncrypted, true); assert.notEqual(persisted.apiKey, 'user-owned-test-secret');
  const stale = await request.put('/api/user/model-catalog').set('Cookie', s.cookie).send({ ...saved, revision: 0 });
  assert.equal(stale.status, 409);
  const group = await request.post('/api/groups').set('Cookie', s.cookie).send({ name: '自定义模型会话', description: '', ai_members: ['custom'], space_category: 'work' });
  assert.equal(group.status, 201); assert.equal(group.body.space_category, 'work');
  const missing = await request.post('/api/groups').set('Cookie', s.cookie).send({ name: '错误成员', ai_members: ['does_not_exist'] });
  assert.equal(missing.status, 400);
  const changed = { ...saved, models: saved.models.filter(m => m.id !== 'custom'), defaults: { ...saved.defaults, chat: null } };
  assert.equal((await request.put('/api/user/model-catalog').set('Cookie', s.cookie).send(changed)).status, 409);
  const persona = await request.patch('/api/personas/custom').set('Cookie', s.cookie).send({ name: '小助手' });
  assert.equal(persona.status, 200); assert.equal(persona.body.persona.name, '小助手');
  assert.equal((await request.put('/api/personas/custom/reset').set('Cookie', s.cookie)).body.persona.name, '我的模型');
  const privateChat = await request.post('/api/private-chat/custom').set('Cookie', s.cookie).send({});
  assert.equal(privateChat.status, 201); assert.equal(privateChat.body.name, '我的模型');
});

test('provider discovery works before adding a model; private targets need an exact server allowlist', async () => {
  const s = await session(), catalog = await readCatalog(s.userId);
  catalog.providers.push({ id: 'local', name: '本地', protocol: 'openai', baseUrl: `${origin}/v1`, keyRequired: false, enabled: true });
  await saveCatalog(s.userId, catalog);
  const discovered = await request.post('/api/user/model-catalog/discover').set('Cookie', s.cookie).send({ providerId: 'local' });
  assert.equal(discovered.status, 200); assert.deepEqual(discovered.body.models, ['future/model-v99']);
  const latest = await readCatalog(s.userId); latest.providers.find(p => p.id === 'local').baseUrl = 'http://127.0.0.1:1/v1';
  assert.equal((await request.put('/api/user/model-catalog').set('Cookie', s.cookie).send(latest)).status, 400);
});

test('model declaration is not a verified capability; only a successful probe enables automatic routing', async () => {
  const s = await session();
  const configured = await configure(s.userId);
  assert.deepEqual(configured.models.find(m => m.id === 'custom').verifiedCapabilities, []);
  const beforeUnverified = calls.length;
  await assert.rejects(resolveModel(s.userId, 'custom', 'chat'), error => error.status === 409);
  await assert.rejects(createTask(s.userId, { title: '不得发送', prompt: '未验证能力', model_id: 'custom' }),
    error => error.status === 409);
  assert.equal(calls.length, beforeUnverified);
  assert.equal((await listTasks(s.userId)).length, 0);
  // Even an explicit default selection is a routing policy, not proof of ability.
  await assert.rejects(defaultModelId(s.userId, 'chat'), error => error.status === 409);
  const probe = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ modelId: 'custom' });
  assert.equal(probe.status, 200);
  const tested = await readCatalog(s.userId);
  assert.deepEqual(tested.models.find(m => m.id === 'custom').verifiedCapabilities, ['chat']);
  assert.equal(await defaultModelId(s.userId, 'chat'), 'custom');
  assert.equal(tested.models.find(m => m.id === 'custom').verifiedCapabilities.includes('vision'), false);
  tested.providers.find(p => p.id === 'custom_provider').apiKey = 'rotated-test-secret';
  const rotated = await saveCatalog(s.userId, tested);
  assert.deepEqual(rotated.models.find(m => m.id === 'custom').verifiedCapabilities, []);
  await assert.rejects(defaultModelId(s.userId, 'chat'), error => error.status === 409);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ modelId: 'custom' })).status, 200);
  const retested = await readCatalog(s.userId);
  assert.deepEqual(retested.models.find(m => m.id === 'custom').verifiedCapabilities, ['chat']);
  retested.models.find(m => m.id === 'custom').model = 'broken-model';
  await saveCatalog(s.userId, retested);
  assert.deepEqual((await readCatalog(s.userId)).models.find(m => m.id === 'custom').verifiedCapabilities, []);
  const failed = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ modelId: 'custom' });
  assert.equal(failed.status, 502);
  await assert.rejects(defaultModelId(s.userId, 'chat'), error => error.status === 409);
});

test('vision requires two matching image probes and is invalidated by a model change', async () => {
  const s = await session(); await configure(s.userId, { model: 'vision-probe' });
  await assert.rejects(resolveModel(s.userId, 'custom', 'vision'), error => error.status === 409);
  const before = calls.length;
  const probe = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'custom', capability: 'vision' });
  assert.equal(probe.status, 200);
  assert.equal(calls.slice(before).filter(call => call.body.model === 'vision-probe').length, 2);
  assert.deepEqual((await readCatalog(s.userId)).models.find(model => model.id === 'custom').verifiedCapabilities, ['vision']);
  assert.equal((await resolveModel(s.userId, 'custom', 'vision')).model, 'vision-probe');
  await assert.rejects(resolveModel(s.userId, 'custom', 'chat'), error => error.status === 409);
  const changed = await readCatalog(s.userId);
  changed.models.find(model => model.id === 'custom').model = 'vision-wrong';
  await saveCatalog(s.userId, changed);
  await assert.rejects(resolveModel(s.userId, 'custom', 'vision'), error => error.status === 409);
  const bad = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'custom', capability: 'vision' });
  assert.equal(bad.status, 502);
  assert.deepEqual((await readCatalog(s.userId)).models.find(model => model.id === 'custom').verifiedCapabilities, []);
});

test('a late probe for an earlier model revision cannot verify the replacement configuration', async () => {
  const s = await session();
  const initial = await configure(s.userId, { model: 'slow-model' });
  initial.defaults.chat = null;
  await saveCatalog(s.userId, initial);
  const pending = request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ modelId: 'custom' });
  const response = pending.then(value => value);
  await eventually(() => slow.length > 0);
  const changed = await readCatalog(s.userId);
  changed.models.find(m => m.id === 'custom').model = 'future/model-v99';
  await saveCatalog(s.userId, changed);
  slow.shift().end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  const stale = await response;
  assert.equal(stale.status, 409);
  assert.deepEqual((await readCatalog(s.userId)).models.find(m => m.id === 'custom').verifiedCapabilities, []);
  await assert.rejects(defaultModelId(s.userId, 'chat'), error => error.status === 409);
});

test('a late probe cannot reverify a rotated credential at the same model endpoint', async () => {
  const s = await session(); await configure(s.userId, { model: 'slow-model' });
  const before = slow.length;
  const pending = request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ modelId: 'custom' }).then(value => value);
  await eventually(() => slow.length > before);
  const changed = await readCatalog(s.userId);
  changed.providers.find(p => p.id === 'custom_provider').apiKey = 'replacement-secret';
  await saveCatalog(s.userId, changed);
  slow.shift().end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  assert.equal((await pending).status, 409);
  assert.deepEqual((await readCatalog(s.userId)).models.find(m => m.id === 'custom').verifiedCapabilities, []);
});

test('a one-model group answers once; idle autonomous chat requires explicit opt-in', async () => {
  const s = await session(); await configure(s.userId);
  const one = await request.post('/api/groups').set('Cookie', s.cookie).send({ name: '单模型工作会话', ai_members: ['custom'] });
  assert.equal(one.status, 201);
  const before = calls.length;
  assert.deepEqual(await queueAIMessages(one.body.id, '未测试模型不能自动调用', null, s.userId),
    { queued: 0, reason: 'no_verified_chat_models' });
  assert.equal(calls.length, before);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'custom' })).status, 200);
  const afterProbe = calls.length;
  await queueAIMessages(one.body.id, '请回答一次', null, s.userId);
  assert.equal(calls.slice(afterProbe).filter(call => call.body.model === 'future/model-v99').length, 1);
  const db = await getUserDb(s.userId); await db.read();
  assert.equal(db.data.messages.filter(message => message.group_id === one.body.id && message.sender_type === 'ai').length, 1);
  assert.equal(runAsUser(s.userId, () => getActiveAutonomousTimerCount()), 0);

  const multi = await request.post('/api/groups').set('Cookie', s.cookie).send({ name: '多模型工作会话', ai_members: ['custom', 'deepseek'] });
  assert.equal(multi.status, 201);
  const endpoint = `/api/groups/${multi.body.id}/settings`;
  assert.equal((await request.put(endpoint).set('Cookie', s.cookie).send({ autonomous_chat_enabled: 'true' })).status, 400);
  const enabled = await request.put(endpoint).set('Cookie', s.cookie).send({ autonomous_chat_enabled: true });
  assert.equal(enabled.status, 200); assert.equal(enabled.body.group.autonomous_chat_enabled, true);
  assert.equal(runAsUser(s.userId, () => getActiveAutonomousTimerCount()), 1);
  const disabled = await request.put(endpoint).set('Cookie', s.cookie).send({ autonomous_chat_enabled: false });
  assert.equal(disabled.status, 200); assert.equal(disabled.body.group.autonomous_chat_enabled, false);
  assert.equal(runAsUser(s.userId, () => getActiveAutonomousTimerCount()), 0);
});

test('a multi-model group does not start additional paid AI rounds without opt-in', async () => {
  const s = await session(); await configure(s.userId); await probeChat(s);
  const catalog = await readCatalog(s.userId);
  catalog.models.push(customModel({ id: 'custom_partner', name: '协作模型', model: 'future/partner-v100' }));
  await saveCatalog(s.userId, catalog);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'custom_partner', capability: 'chat' })).status, 200);

  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '普通双模型会话', ai_members: ['custom', 'custom_partner'] });
  assert.equal(group.status, 201);
  assert.notEqual(group.body.autonomous_chat_enabled, true);
  const before = calls.length;
  await queueAIMessages(group.body.id, '每个模型只回答一次', null, s.userId);
  const generated = calls.slice(before).filter(call => call.body.stream);
  assert.equal(generated.length, 2);
  assert.deepEqual(new Set(generated.map(call => call.body.model)),
    new Set(['future/model-v99', 'future/partner-v100']));
  const db = await getUserDb(s.userId); await db.read();
  assert.equal(db.data.messages.filter(message => message.group_id === group.body.id && message.sender_type === 'ai').length, 2);
});

test('repeated generated agent-call markers cause at most one nested model request', async () => {
  const s = await session(); await configure(s.userId); await probeChat(s);
  const agent = await request.post('/api/agents').set('Cookie', s.cookie)
    .send({ name: '受控协作', description: '检查提议', openingMessage: '开始', modelId: 'custom' });
  assert.equal(agent.status, 200);
  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '协作上限会话', ai_members: ['custom'] });
  assert.equal(group.status, 201);
  const marker = `[CALL_AGENT:${agent.body.id}]`;
  nextStreamReply = `先检查。${marker.repeat(12)}`;
  try {
    const before = calls.length;
    await queueAIMessages(group.body.id, '请协作检查', null, s.userId);
    assert.equal(calls.slice(before).filter(call => call.body.stream).length, 2);
    const db = await getUserDb(s.userId); await db.read();
    const reply = db.data.messages.find(message => message.group_id === group.body.id && message.sender_type === 'ai');
    assert.ok(reply);
    assert.equal(reply.content.includes(marker), false);
  } finally { nextStreamReply = null; }
});

test('AI private chat stops after bounded failed attempts instead of charging indefinitely', async () => {
  const s = await session(); await configure(s.userId, { model: 'empty-model' }); await probeChat(s);
  const catalog = await readCatalog(s.userId);
  catalog.models.push(customModel({ id: 'empty_partner', name: '空回复协作模型', model: 'empty-model' }));
  await saveCatalog(s.userId, catalog);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'empty_partner', capability: 'chat' })).status, 200);
  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '失败有限次会话', ai_members: ['custom', 'empty_partner'] });
  assert.equal(group.status, 201);
  const before = calls.length;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const result = await runAsUser(s.userId, () => startAIPrivateChat(group.body.id, '讨论'));
    const attempted = calls.slice(before).filter(call => call.body.model === 'empty-model' && call.body.stream);
    assert.equal(result.status, 'success');
    assert.equal(result.totalMessages, 0);
    assert.equal(result.stoppedByLimit, true);
    assert.equal(result.attempts, 3);
    assert.equal(attempted.length, 3);
    assert.equal(runAsUser(s.userId, () => getChatStatus(group.body.id)).isRunning, false);
  } finally { Math.random = originalRandom; }
});

test('turning off autonomous chat stops further model calls in an active continuation', { timeout: 20000 }, async () => {
  const s = await session(); await configure(s.userId, { model: 'slow-continuation' }); await probeChat(s);
  const catalog = await readCatalog(s.userId);
  catalog.models.push(customModel({ id: 'slow_partner', name: '慢速协作模型', model: 'slow-continuation' }));
  await saveCatalog(s.userId, catalog);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'slow_partner', capability: 'chat' })).status, 200);
  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '运行中关闭主动对话', ai_members: ['custom', 'slow_partner'] });
  assert.equal(group.status, 201);
  const settings = `/api/groups/${group.body.id}/settings`;
  assert.equal((await request.put(settings).set('Cookie', s.cookie)
    .send({ autonomous_chat_enabled: true })).status, 200);
  slowContinuationRequests = 0;
  const priorSlow = slow.length;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const queued = queueAIMessages(group.body.id, '开始对话', null, s.userId);
    await eventually(() => slow.length > priorSlow);
    assert.equal((await request.put(settings).set('Cookie', s.cookie)
      .send({ autonomous_chat_enabled: false })).status, 200);
    for (const response of slow.splice(priorSlow)) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data:' + JSON.stringify({ choices: [{ delta: { content: '已经发出的回复' } }] }) + '\n\ndata: [DONE]\n\n');
    }
    await queued;
    assert.equal(slowContinuationRequests <= 4, true);
    assert.equal(runAsUser(s.userId, () => getActiveAutonomousTimerCount()), 0);
    const afterStop = slowContinuationRequests;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(slowContinuationRequests, afterStop);
  } finally { Math.random = originalRandom; }
});

test('one-response persona limits bound each model even with autonomous chat enabled', async () => {
  const s = await session(); await configure(s.userId); await probeChat(s);
  const catalog = await readCatalog(s.userId);
  catalog.models.push(customModel({ id: 'one_partner', name: '单次协作模型', model: 'future/one-partner' }));
  await saveCatalog(s.userId, catalog);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'one_partner', capability: 'chat' })).status, 200);
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => {
    await db.read();
    db.data.customPersonas ||= {};
    for (const id of ['custom', 'one_partner']) {
      db.data.customPersonas[id] = { responseConfig: {
        responseFrequency: 1, maxResponsesPerConversation: 1, minDelay: 0, maxDelay: 0
      } };
    }
    await db.write();
  });
  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '每模型一次会话', ai_members: ['custom', 'one_partner'] });
  assert.equal(group.status, 201);
  const settings = `/api/groups/${group.body.id}/settings`;
  assert.equal((await request.put(settings).set('Cookie', s.cookie)
    .send({ autonomous_chat_enabled: true })).status, 200);
  const before = calls.length;
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    await queueAIMessages(group.body.id, '每位仅答一次', null, s.userId);
    assert.equal(calls.slice(before).filter(call => call.body.stream).length, 2);
  } finally {
    Math.random = originalRandom;
    await request.put(settings).set('Cookie', s.cookie).send({ autonomous_chat_enabled: false });
  }
});

test('overlapping idle timer ticks claim one autonomous run before asynchronous loading', { timeout: 15000 }, async () => {
  const s = await session(); await configure(s.userId, { model: 'slow-task-model' }); await probeChat(s);
  const catalog = await readCatalog(s.userId);
  catalog.models.push(customModel({ id: 'idle_partner', name: '闲聊协作模型', model: 'slow-task-model' }));
  await saveCatalog(s.userId, catalog);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'idle_partner', capability: 'chat' })).status, 200);
  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '重叠定时器会话', ai_members: ['custom', 'idle_partner'] });
  assert.equal(group.status, 201);
  const settings = `/api/groups/${group.body.id}/settings`;
  assert.equal((await request.put(settings).set('Cookie', s.cookie)
    .send({ autonomous_chat_enabled: true })).status, 200);
  runAsUser(s.userId, () => stopAutonomousChatTimer(group.body.id));
  let tick;
  const originalSetInterval = global.setInterval;
  global.setInterval = callback => { tick = callback; return 123456; };
  try { runAsUser(s.userId, () => startAutonomousChatTimer(group.body.id)); }
  finally { global.setInterval = originalSetInterval; }
  assert.equal(typeof tick, 'function');
  const before = calls.length, priorSlow = slow.length;
  const first = runAsUser(s.userId, () => tick());
  const second = runAsUser(s.userId, () => tick());
  await eventually(() => slow.length > priorSlow);
  assert.equal(calls.slice(before).filter(call => call.body.model === 'slow-task-model' && call.body.stream).length, 1);
  assert.equal((await request.put(settings).set('Cookie', s.cookie)
    .send({ autonomous_chat_enabled: false })).status, 200);
  for (const response of slow.splice(priorSlow)) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data:' + JSON.stringify({ choices: [{ delta: { content: '已停止的旧请求' } }] }) + '\n\ndata: [DONE]\n\n');
  }
  await Promise.all([first, second]);
  assert.equal(calls.slice(before).filter(call => call.body.model === 'slow-task-model' && call.body.stream).length, 1);
});

test('manual autonomous starter respects verified models, stop, and group deletion', { timeout: 15000 }, async () => {
  const s = await session(); await configure(s.userId, { model: 'slow-task-model' });
  const catalog = await readCatalog(s.userId);
  catalog.models.push(customModel({ id: 'manual_partner', name: '手动协作模型', model: 'slow-task-model' }));
  await saveCatalog(s.userId, catalog);
  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '手动自主对话取消', ai_members: ['custom', 'manual_partner'] });
  assert.equal(group.status, 201);
  const endpoint = `/api/groups/${group.body.id}/autonomous-chat`;
  const beforeUnverified = calls.length;
  assert.equal((await request.post(`${endpoint}/start`).set('Cookie', s.cookie)
    .send({ topic: '讨论' })).status, 400);
  assert.equal(calls.length, beforeUnverified);
  await probeChat(s);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'manual_partner', capability: 'chat' })).status, 200);

  for (const action of ['stop', 'delete']) {
    const beforeSlow = slow.length, beforeCalls = calls.length;
    const running = request.post(`${endpoint}/start`).set('Cookie', s.cookie)
      .send({ topic: '停止后不能留下首轮回复' }).then(value => value);
    await eventually(() => slow.length > beforeSlow);
    assert.equal(calls.slice(beforeCalls).filter(call => call.body.stream).length, 1);
    const changed = action === 'stop'
      ? await request.post(`${endpoint}/stop`).set('Cookie', s.cookie).send({})
      : await request.delete(`/api/groups/${group.body.id}`).set('Cookie', s.cookie);
    assert.equal(changed.status, 200);
    assert.equal((await running).status, 400);
    const db = await getUserDb(s.userId); await db.read();
    assert.equal(db.data.messages.some(message =>
      message.group_id === group.body.id && message.sender_type === 'ai'), false);
    assert.equal(calls.slice(beforeCalls).filter(call => call.body.stream).length, 1);
  }
});

test('stopping during a manual reply commit reports the result as unknown', { timeout: 15000 }, async () => {
  const s = await session(); await configure(s.userId); await probeChat(s);
  const catalog = await readCatalog(s.userId);
  catalog.models.push(customModel({ id: 'commit_partner', name: '并发协作模型', model: 'future/commit-partner' }));
  await saveCatalog(s.userId, catalog);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie)
    .send({ modelId: 'commit_partner', capability: 'chat' })).status, 200);
  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '提交期停止', ai_members: ['custom', 'commit_partner'] });
  assert.equal(group.status, 201);
  const db = await getUserDb(s.userId);
  const write = db.write.bind(db);
  let reachedCommit, releaseCommit;
  const enteredCommit = new Promise(resolve => { reachedCommit = resolve; });
  const waitCommit = new Promise(resolve => { releaseCommit = resolve; });
  let delayed = false;
  db.write = async (...args) => {
    if (!delayed && db.data.messages.some(message =>
      message.group_id === group.body.id && message.sender_type === 'ai')) {
      delayed = true;
      reachedCommit();
      await waitCommit;
    }
    return write(...args);
  };
  try {
    const endpoint = `/api/groups/${group.body.id}/autonomous-chat`;
    const started = request.post(`${endpoint}/start`).set('Cookie', s.cookie)
      .send({ topic: '提交期竞态' }).then(value => value);
    await enteredCommit;
    const stopped = await request.post(`${endpoint}/stop`).set('Cookie', s.cookie).send({});
    assert.equal(stopped.status, 200);
    releaseCommit();
    const result = await started;
    assert.equal(result.status, 400);
    assert.equal(result.body.outcomeUnknown, true);
    await db.read();
    assert.equal(db.data.messages.some(message =>
      message.group_id === group.body.id && message.sender_type === 'ai'), true);
  } finally {
    releaseCommit();
    db.write = write;
  }
});

test('a source revoked during stream preparation blocks HTTP dispatch', async () => {
  const s = await session(); await configure(s.userId); await probeChat(s);
  const config = await resolveModel(s.userId, 'custom', 'chat');
  const before = calls.length;
  let revoked = false;
  await assert.rejects(requestCompletionStream(config, [{ role: 'user', content: '不得发送' }], {
    beforeDispatch: async () => { revoked = true; return false; }
  }), error => error.status === 409);
  assert.equal(revoked, true);
  assert.equal(calls.length, before);
});

test('a revoked refusal source blocks non-stream provider dispatch', async () => {
  const s = await session(); await configure(s.userId); await probeChat(s);
  const before = calls.length;
  await assert.rejects(callAI('custom', modelPersona(customModel()), '不得发送拒绝理由', [],
    'refusal', null, [], null, [], false, [], s.userId, null, () => false),
  error => error.status === 409);
  assert.equal(calls.length, before);
});

test('credential rotation during a source guard blocks both request protocols', async () => {
  const s = await session(); await configure(s.userId); await probeChat(s);
  const rotate = async () => {
    const catalog = await readCatalog(s.userId);
    catalog.providers.find(provider => provider.id === 'custom_provider').apiKey = crypto.randomBytes(12).toString('hex');
    await saveCatalog(s.userId, catalog);
    return true;
  };
  let before = calls.length;
  await assert.rejects(callAI('custom', modelPersona(customModel()), '旧密钥不得派发', [],
    'refusal', null, [], null, [], false, [], s.userId, null, rotate),
  error => error.status === 409);
  assert.equal(calls.length, before);
  await probeChat(s);
  before = calls.length;
  await assert.rejects(callAIStream('custom', modelPersona(customModel()), '旧密钥不得派发', [],
    'reply', null, [], null, ['custom'], false, [], null, [], null, null, s.userId, null, rotate),
  error => error.status === 409);
  assert.equal(calls.length, before);
});

test('a failed refusal request does not create a fabricated refusal message', async () => {
  const s = await session(); await configure(s.userId, { model: 'breaks-after-probe' }); await probeChat(s);
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => {
    await db.read();
    db.data.customPersonas ||= {};
    db.data.customPersonas.custom = { refusalProbability: 1 };
    await db.write();
  });
  const group = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '未知拒绝结果', ai_members: ['custom'] });
  assert.equal(group.status, 201);
  const before = calls.length;
  await queueAIMessages(group.body.id, '询问', null, s.userId);
  assert.equal(calls.slice(before).filter(call => call.body.model === 'breaks-after-probe').length, 1);
  await db.read();
  assert.equal(db.data.messages.some(message =>
    message.group_id === group.body.id && message.metadata?.refusal), false);
});

test('server keys never follow a custom endpoint; clearing a key cannot revive environment fallback', async () => {
  const s = await session(), catalog = await readCatalog(s.userId);
  const p = catalog.providers.find(p => p.id === 'deepseek'); assert.equal(p.keySource, 'environment');
  p.baseUrl = `${origin}/v1`;
  const changed = await saveCatalog(s.userId, catalog);
  assert.equal(changed.providers.find(p => p.id === 'deepseek').ready, false);
  await assert.rejects(resolveModel(s.userId, 'deepseek'), e => e.status === 409);
  changed.providers.find(p => p.id === 'deepseek').baseUrl = 'https://api.deepseek.com';
  changed.providers.find(p => p.id === 'deepseek').clearApiKey = true;
  const cleared = await saveCatalog(s.userId, changed);
  assert.equal(cleared.providers.find(p => p.id === 'deepseek').keySource, 'none');
});

test('a user key is scoped to its saved destination and is not carried to a changed endpoint', async () => {
  const s = await session();
  const catalog = await configure(s.userId);
  const provider = catalog.providers.find(p => p.id === 'custom_provider');
  provider.baseUrl = `${origin}/new-path`;
  const moved = await saveCatalog(s.userId, catalog);
  assert.equal(moved.providers.find(p => p.id === 'custom_provider').apiKeyConfigured, false);
  assert.equal(moved.models.find(m => m.id === 'custom').ready, false);
  await assert.rejects(resolveModel(s.userId, 'custom'), error => error.status === 409);
  moved.providers.find(p => p.id === 'custom_provider').baseUrl = `${origin}/v1`;
  const returned = await saveCatalog(s.userId, moved);
  assert.equal(returned.providers.find(p => p.id === 'custom_provider').apiKeyConfigured, false);
  returned.providers.find(p => p.id === 'custom_provider').apiKey = 'new-explicit-secret';
  const reconnected = await saveCatalog(s.userId, returned);
  assert.equal(reconnected.models.find(m => m.id === 'custom').ready, true);
});

test('custom models reach the real transport for chat and debate, with tenant credentials and no fixed model substitution', async () => {
  const s = await session(); await configure(s.userId);
  await probeChat(s);
  let chunks = '';
  const result = await runAsUser(s.userId, () => callAIStream('custom', modelPersona(customModel()), '你好', [], 'reply', null, [], null, ['custom'], true, [], null, [], c => { chunks += c; }, 'unique-stream', s.userId));
  assert.equal(result, '你好，世界🌏'); assert.equal(chunks, result);
  assert.equal(calls.at(-1).body.model, 'future/model-v99');
  assert.equal(calls.at(-1).headers.authorization, 'Bearer user-owned-test-secret');
  assert.equal(calls.at(-1).body.max_completion_tokens, 2048); assert.equal('temperature' in calls.at(-1).body, false);
  const debate = await callAIDebate('custom', modelPersona(customModel()), '一个话题', [], 1, 2, 1, ['custom'], s.userId);
  assert.equal(debate, '已完成测试任务 ✓');
  const other = await session(); await assert.rejects(resolveModel(other.userId, 'custom'), e => e.status === 404);
});

test('SSE preserves fragmented UTF-8 and flags empty, malformed and interrupted output', async () => {
  const text = 'data:' + JSON.stringify({ choices: [{ delta: { content: '中文🦊' } }] }) + '\n\ndata:[DONE]';
  const bytes = [...Buffer.from(text)].map(b => Buffer.from([b]));
  assert.equal(await consumeSSE(Readable.from(bytes), 'openai'), '中文🦊');
  const partial = 'data:' + JSON.stringify({ choices: [{ delta: { content: '部分回复' } }] }) + '\n\n';
  await assert.rejects(consumeSSE(Readable.from([partial]), 'openai'), e => e.partialContent === '部分回复');
  await assert.rejects(consumeSSE(Readable.from(['data:[DONE]\n\n']), 'openai'), /空内容/);
  await assert.rejects(consumeSSE(Readable.from(['data:{broken}\n\n']), 'openai'), SyntaxError);
  const anthropic = ['data:{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private"}}\n\n', 'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"答案"}}\n\n', 'data:{"type":"message_stop"}\n\n'];
  assert.equal(await consumeSSE(Readable.from(anthropic), 'anthropic'), '答案');
  const observedOpenAI = [];
  const openAIUsage = ['data:' + JSON.stringify({ choices: [{ delta: { content: '正文' } }] }) + '\n\n',
    'data:' + JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }) + '\n\n', 'data:[DONE]\n\n'];
  assert.equal(await consumeSSE(Readable.from(openAIUsage), 'openai', () => {}, value => observedOpenAI.push(value)), '正文');
  assert.deepEqual(observedOpenAI, [{ inputTokens: 9, outputTokens: 2, totalTokens: 11, source: 'provider_response' }]);
  const observedAnthropic = [];
  const anthropicUsage = ['data:{"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
    'data:{"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
    'data:{"type":"message_delta","usage":{"output_tokens":3}}\n\n', 'data:{"type":"message_stop"}\n\n'];
  assert.equal(await consumeSSE(Readable.from(anthropicUsage), 'anthropic', () => {}, value => observedAnthropic.push(value)), '好');
  assert.equal(observedAnthropic.at(-1).totalTokens, 10);
});

test('a charged empty model response reports provider usage even though the draft fails', async () => {
  const s = await session(); await configure(s.userId, { model: 'empty-model' });
  await probeChat(s);
  const config = await resolveModel(s.userId, 'custom');
  let usage = null;
  await assert.rejects(requestCompletion(config, [{ role: 'user', content: 'test' }], { onUsage: value => { usage = value; } }), /空内容/);
  assert.deepEqual(usage, { inputTokens: 7, outputTokens: 0, totalTokens: 7, source: 'provider_response' });
  const task = await createTask(s.userId, { title: '空回复', prompt: '生成草稿', model_id: 'custom' });
  const failed = await runTask(s.userId, task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.history.at(-1).usage_status, 'provider_reported');
  assert.equal(failed.history.at(-1).usage.totalTokens, 7);
  assert.equal(failed.history.at(-1).cost, null);
});

test('Anthropic payload separates system messages and converts actual images; stream timeout aborts stalled providers', async () => {
  const body = buildRequestBody({ ...customModel(), protocol: 'anthropic' }, [{ role: 'system', content: '规则' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] }]);
  assert.equal(body.system, '规则'); assert.equal(body.messages[0].content[0].source.type, 'base64'); assert.equal(body.max_tokens, 2048); assert.equal('max_completion_tokens' in body, false);
  const s = await session(); await configure(s.userId, { model: 'slow-model' });
  const config = await resolveModel(s.userId, 'custom');
  await assert.rejects(requestCompletionStream(config, [{ role: 'user', content: 'x' }], { firstTokenTimeout: 40, timeout: 200 }), e => e.code === 'ERR_CANCELED');
});

test('tasks persist encrypted results, use only linked tenant context and honor explicit scheduling', async () => {
  assert.deepEqual(responseUsage({ usage: { input_tokens: 12, output_tokens: 8 } }, 'anthropic'),
    { inputTokens: 12, outputTokens: 8, totalTokens: 20, source: 'provider_response' });
  assert.equal(responseUsage({ usage: { prompt_tokens: '12', completion_tokens: 8 } }), null);
  const s = await session(); await configure(s.userId);
  await probeChat(s);
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => { await db.read(); db.data.messages.push({ id: 'ctx', group_id: 'group-presidential', sender_type: 'user', content: encryptText('所属会话上下文'), metadata: { encryption: { encrypted: true } } }, { id: 'other', group_id: 'other', sender_type: 'user', content: '未关联秘密' }); await db.write(); });
  const task = await createTask(s.userId, { title: '总结', prompt: '整理行动', model_id: 'custom', group_id: 'group-presidential' });
  const done = await runTask(s.userId, task.id);
  assert.equal(done.status, 'needs_review'); assert.equal(done.result, '已完成测试任务 ✓');
  assert.equal(done.history.at(-1).status, 'generated');
  assert.deepEqual(done.history.at(-1).usage,
    { inputTokens: 12, outputTokens: 8, totalTokens: 20, source: 'provider_response' });
  assert.equal(done.history.at(-1).usage_status, 'provider_reported');
  assert.equal(done.history.at(-1).cost, null);
  assert.equal((await request.patch(`/api/tasks/${task.id}`).set('Cookie', s.cookie).send({ status: 'completed' })).status, 400);
  const accepted = await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie).send({ run_id: done.run_id });
  assert.equal(accepted.status, 200); assert.equal(accepted.body.status, 'completed');
  assert.equal(accepted.body.history.at(-1).status, 'accepted');
  assert.equal((await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie).send({ run_id: done.run_id })).status, 200);
  await withWriteLock(s.userId, async () => { await db.read(); db.data.messages.push({ id: 'after-accept', group_id: 'group-presidential', sender_type: 'user', content: '已更正事实', created_at: new Date().toISOString() }); await db.write(); });
  assert.equal((await listTasks(s.userId)).find(t => t.id === task.id).source_stale, true);
  assert.equal((await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie).send({ run_id: done.run_id })).status, 409);
  const sent = JSON.stringify(calls.at(-1).body); assert.ok(sent.includes('所属会话上下文')); assert.ok(!sent.includes('未关联秘密'));
  await db.read(); assert.notEqual(db.data.tasks[0].result, done.result); assert.notEqual(db.data.tasks[0].prompt, task.prompt);
  const manual = await createTask(s.userId, { title: '仅提醒', prompt: '不要自动执行', run_at: new Date(Date.now() - 1000).toISOString() });
  const auto = await createTask(s.userId, { title: '主动总结', prompt: '执行', model_id: 'custom', run_at: new Date(Date.now() - 1000).toISOString(), auto_run: true, repeat_minutes: 15 });
  await tickTasks(); const all = await listTasks(s.userId);
  assert.equal(all.find(t => t.id === manual.id).run_count, 0); assert.equal(all.find(t => t.id === auto.id).run_count, 1); assert.ok(Date.parse(all.find(t => t.id === auto.id).run_at) > Date.now());
  await withWriteLock(s.userId, async () => { await db.read(); db.data.tasks.find(t => t.id === auto.id).run_at = new Date(Date.now() - 1000).toISOString(); await db.write(); });
  await tickTasks();
  assert.equal((await listTasks(s.userId)).find(t => t.id === auto.id).run_count, 1, 'unaccepted recurring draft must not be overwritten by the next interval');
  const other = await session();
  assert.equal((await request.post(`/api/tasks/${task.id}/run`).set('Cookie', other.cookie)).status, 404);
  assert.equal((await request.post('/api/tasks').set('Cookie', s.cookie).send({ title: '', prompt: 'bad' })).status, 400);
});

test('task acceptance rejects changed conversation evidence and another account', async () => {
  const s = await session(), other = await session(); await configure(s.userId);
  await probeChat(s);
  const task = await createTask(s.userId, { title: '根据讨论整理', prompt: '总结', model_id: 'custom', group_id: 'group-presidential' });
  const draft = await runTask(s.userId, task.id);
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => {
    await db.read();
    db.data.messages.push({ id: 'later-message', group_id: 'group-presidential', sender_type: 'user', content: '新修正', created_at: new Date().toISOString() });
    await db.write();
  });
  assert.equal((await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', other.cookie).send({ run_id: draft.run_id })).status, 404);
  const stale = await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie).send({ run_id: draft.run_id });
  assert.equal(stale.status, 409);
  assert.equal((await listTasks(s.userId))[0].status, 'needs_review');
});

test('a source deleted after task preparation is never sent to the model', async () => {
  const s = await session(); await configure(s.userId);
  await probeChat(s);
  const created = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '派发前删除竞态' });
  assert.equal(created.status, 201);
  const groupId = created.body.id;
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => {
    await db.read();
    db.data.messages.push({ id: 'delete-before-dispatch', group_id: groupId,
      sender_type: 'user', sender_id: s.userId, content: 'delete-race-secret',
      created_at: new Date().toISOString() });
    await db.write();
  });
  const task = await createTask(s.userId, { title: '派发竞态任务', prompt: '根据讨论整理',
    model_id: 'custom', group_id: groupId });
  let enterGate, releaseGate;
  const entered = new Promise(resolve => { enterGate = resolve; });
  const release = new Promise(resolve => { releaseGate = resolve; });
  const originalRead = db.read.bind(db);
  let paused = false;
  db.read = async (...args) => {
    if (!paused && db.data.tasks?.some(item => item.id === task.id && item.status === 'running')) {
      paused = true;
      enterGate();
      await release;
    }
    return originalRead(...args);
  };
  const beforeCalls = calls.length;
  let running;
  try {
    running = runTask(s.userId, task.id);
    await entered;
    const deletion = await request.delete('/api/messages/delete-before-dispatch')
      .set('Cookie', s.cookie);
    assert.equal(deletion.status, 200);
  } finally {
    releaseGate();
  }
  try {
    const result = await running;
    assert.equal(result.status, 'failed');
    assert.equal(result.history.at(-1).dispatch_status, 'not_sent');
    assert.equal(calls.length, beforeCalls);
  } finally {
    db.read = originalRead;
  }
});

test('restored deleted group cannot revive task context, draft, acceptance or scheduled execution', async () => {
  const s = await session(); await configure(s.userId);
  await probeChat(s);
  const created = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '待撤销资料组', description: '旧快照反例' });
  assert.equal(created.status, 201);
  const groupId = created.body.id;
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => {
    await db.read();
    db.data.groups.find(group => group.id === groupId).ai_members = ['custom'];
    db.data.messages.push({ id: 'old-task-source', group_id: groupId,
      sender_type: 'user', content: '已撤销的任务来源', created_at: new Date().toISOString() });
    await db.write();
  });
  const task = await createTask(s.userId, { title: '撤销来源任务', prompt: '根据资料写摘要',
    model_id: 'custom', group_id: groupId });
  const draft = await runTask(s.userId, task.id);
  assert.equal(draft.status, 'needs_review');
  assert.ok(draft.result);
  const oldJsonPath = path.join(process.env.DATA_DIR, 'users', `db_${s.userId}.json`);
  const oldJson = await fs.readFile(oldJsonPath);
  assert.equal((await request.delete(`/api/groups/${groupId}`).set('Cookie', s.cookie)).status, 200);
  await fs.writeFile(oldJsonPath, oldJson);
  clearUserDbCache(s.userId);

  const view = (await listTasks(s.userId)).find(item => item.id === task.id);
  assert.equal(view.source_stale, true);
  assert.equal(view.result, '');
  assert.equal(view.history.at(-1).result, '');
  assert.equal((await request.post(`/api/groups/${groupId}/messages/old-task-source/read`)
    .set('Cookie', s.cookie).send({})).status, 404);
  assert.equal((await request.post(`/api/groups/${groupId}/messages/read-batch`)
    .set('Cookie', s.cookie).send({ messageIds: ['old-task-source'] })).status, 404);
  const beforeCalls = calls.length;
  const restoredDb = await getUserDb(s.userId);
  await restoredDb.read();
  const beforeBudget = restoredDb.data.taskDailyBudget?.count;
  await assert.rejects(runTask(s.userId, task.id), error => error.status === 404);
  assert.equal(calls.length, beforeCalls);
  await queueAIMessages(groupId, '不要重启已删会话', null, s.userId);
  assert.equal(calls.length, beforeCalls);
  await restoredDb.read();
  assert.equal(restoredDb.data.taskDailyBudget?.count, beforeBudget);
  await assert.rejects(createTask(s.userId, { title: '重用旧组', prompt: '不应创建',
    model_id: 'custom', group_id: groupId }), error => error.status === 404);
  assert.equal((await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie)
    .send({ run_id: draft.run_id })).status, 409);
});

test('restored single file stays absent from group listing and cannot be deleted again', async () => {
  const s = await session(); const other = await session(); await configure(s.userId);
  await probeChat(s);
  const created = await request.post('/api/groups').set('Cookie', s.cookie)
    .send({ name: '独立附件组' });
  assert.equal(created.status, 201);
  const groupId = created.body.id;
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => {
    await db.read();
    db.data.files ||= [];
    db.data.files.push({ id: 'file-restored-alone', group_id: groupId,
      owner_user_id: s.userId, filename: '已删附件.txt', file_size: 4,
      mime_type: 'text/plain', parsed_content: '已删附件中的秘密',
      created_at: new Date().toISOString() });
    db.data.files.push({ id: 'foreign-file-record', group_id: groupId,
      owner_user_id: other.userId, uploader_id: other.userId,
      filename: '外部账号私人附件.txt', file_size: 7,
      parsed_content: '不属于本账号', created_at: new Date().toISOString() });
    db.data.messages.push({ id: 'message-with-deleted-file', group_id: groupId,
      sender_type: 'user', content: '附件引用', created_at: new Date().toISOString(),
      attachments: [{ id: 'file-restored-alone', name: '已删附件.txt',
        type: 'text/plain', size: 4, media_description: '旧附件摘要' }] });
    db.data.messages.push({ id: 'message-with-legacy-url', group_id: groupId,
      sender_type: 'user', content: '旧格式附件引用', created_at: new Date().toISOString(),
      attachments: [{ url: `/api/files/public/file-restored-alone?group_id=${groupId}`,
        name: '已删附件.txt', type: 'text/plain', size: 4,
        media_description: '已删附件中的秘密', parsed_content: '旧快照中的解析正文' }] });
    await db.write();
  });
  const task = await createTask(s.userId, { title: '引用独立附件', prompt: '整理附件',
    model_id: 'custom', group_id: groupId });
  const draft = await runTask(s.userId, task.id);
  assert.equal(draft.source_stale, false);
  assert.ok(draft.result);
  const oldJsonPath = path.join(process.env.DATA_DIR, 'users', `db_${s.userId}.json`);
  const oldJson = await fs.readFile(oldJsonPath);
  const listing = () => request.get(`/api/groups/${groupId}/files`).set('Cookie', s.cookie);
  assert.equal((await listing()).body.files.length, 1);
  const beforeMessages = await request.get(`/api/groups/${groupId}/messages`).set('Cookie', s.cookie);
  assert.equal(beforeMessages.body.messages.find(message =>
    message.id === 'message-with-legacy-url').attachments.length, 1);
  assert.equal((await request.delete(`/api/groups/${groupId}/files/foreign-file-record`)
    .set('Cookie', s.cookie)).status, 403);
  assert.equal((await request.delete(`/api/groups/${groupId}/files/file-restored-alone`)
    .set('Cookie', s.cookie)).status, 200);
  await fs.writeFile(oldJsonPath, oldJson);
  clearUserDbCache(s.userId);
  const restored = await listing();
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.files, []);
  const restoredMessages = await request.get(`/api/groups/${groupId}/messages`).set('Cookie', s.cookie);
  assert.equal(restoredMessages.status, 200);
  assert.deepEqual(restoredMessages.body.messages.find(message =>
    message.id === 'message-with-deleted-file').attachments, []);
  assert.deepEqual(restoredMessages.body.messages.find(message =>
    message.id === 'message-with-legacy-url').attachments, []);
  const search = await request.get('/api/search').set('Cookie', s.cookie)
    .query({ q: '已删附件', type: 'files,messages,media' });
  assert.equal(search.status, 200);
  assert.equal(search.body.files.length, 0);
  assert.equal(search.body.media.length, 0);
  assert.equal(search.body.messages.some(message => message.id === 'message-with-deleted-file'), false);
  const legacySearch = await request.get('/api/search').set('Cookie', s.cookie)
    .query({ q: '已删附件中的秘密', type: 'messages' });
  assert.equal(legacySearch.status, 200);
  assert.equal(legacySearch.body.messages.some(message => message.id === 'message-with-legacy-url'), false);
  const oldTask = (await listTasks(s.userId)).find(item => item.id === task.id);
  assert.equal(oldTask.source_stale, true);
  assert.equal(oldTask.result, '');
  assert.equal(oldTask.history.at(-1).result, '');
  assert.equal((await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie)
    .send({ run_id: draft.run_id })).status, 409);
  assert.equal((await request.delete(`/api/groups/${groupId}/files/file-restored-alone`)
    .set('Cookie', s.cookie)).status, 404);
});

test('linked file revisions enter task context and invalidate an older draft without crossing groups', async () => {
  const s = await session(); await configure(s.userId);
  await probeChat(s);
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => {
    await db.read();
    db.data.files ||= [];
    db.data.files.push(
      { id: 'doc-a', group_id: 'group-presidential', filename: '报告.txt', parsed_content: '本组确认的指标为 42', parse_status: 'success' },
      { id: 'doc-b', group_id: 'another-group', filename: '私人.txt', parsed_content: '跨组秘密 999', parse_status: 'success' }
    );
    db.data.messages.push({ id: 'with-files', group_id: 'group-presidential', sender_type: 'user', content: '依据附件起草', attachments: [{ id: 'doc-a' }, { id: 'doc-b' }] });
    await db.write();
  });
  const task = await createTask(s.userId, { title: '文件修订', prompt: '整理指标', model_id: 'custom', group_id: 'group-presidential' });
  const draft = await runTask(s.userId, task.id);
  assert.equal(draft.status, 'needs_review');
  const submitted = JSON.stringify(calls.at(-1).body);
  assert.match(submitted, /本组确认的指标为 42/);
  assert.doesNotMatch(submitted, /跨组秘密 999/);
  await withWriteLock(s.userId, async () => {
    await db.read();
    db.data.files.find(file => file.id === 'doc-a').parsed_content = '本组更正后的指标为 43';
    await db.write();
  });
  assert.equal((await listTasks(s.userId))[0].source_stale, true);
  const accept = await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie).send({ run_id: draft.run_id });
  assert.equal(accept.status, 409);
  assert.equal((await listTasks(s.userId))[0].status, 'needs_review');
});

test('replacing an unaccepted draft preserves its history but invalidates its acceptance token', async () => {
  const s = await session(); await configure(s.userId);
  await probeChat(s);
  const task = await createTask(s.userId, { title: '可重新生成', prompt: '先写草稿', model_id: 'custom' });
  const first = await runTask(s.userId, task.id);
  const second = await runTask(s.userId, task.id);
  assert.notEqual(first.run_id, second.run_id);
  assert.equal(second.history.length, 2);
  assert.equal(second.history[0].result, first.result);
  assert.equal((await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie).send({ run_id: first.run_id })).status, 409);
  assert.equal((await request.post(`/api/tasks/${task.id}/accept`).set('Cookie', s.cookie).send({ run_id: second.run_id })).status, 200);
});

test('task cancellation defeats late completions, duplicate runs are rejected and restart pauses interrupted work', async () => {
  const s = await session(); await configure(s.userId, { model: 'slow-task-model' });
  await probeChat(s);
  const task = await createTask(s.userId, { title: '慢请求', prompt: '执行', model_id: 'custom' });
  const running = runTask(s.userId, task.id);
  await eventually(async () => (await listTasks(s.userId))[0]?.status === 'running');
  await assert.rejects(runTask(s.userId, task.id), e => e.status === 409);
  await updateTask(s.userId, task.id, { status: 'cancelled' });
  await running; assert.equal((await listTasks(s.userId))[0].status, 'cancelled');
  const db = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => { await db.read(); db.data.tasks[0].status = 'running'; db.data.tasks[0].auto_run = true; await db.write(); });
  await startTaskScheduler(); stopTaskScheduler();
  const recovered = (await listTasks(s.userId))[0]; assert.equal(recovered.status, 'outcome_unknown'); assert.equal(recovered.auto_run, false); assert.match(recovered.error, /重启/);
  assert.equal(recovered.history.at(-1).status, 'outcome_unknown');
  await assert.rejects(runTask(s.userId, task.id), error => error.status === 409);
  assert.equal((await request.post(`/api/tasks/${task.id}/resolve-unknown`).set('Cookie', s.cookie).send({ decision: 'retry' })).status, 400);
  const other = await session();
  assert.equal((await request.post(`/api/tasks/${task.id}/resolve-unknown`).set('Cookie', other.cookie).send({ decision: 'allow_retry' })).status, 404);
  const resolved = await request.post(`/api/tasks/${task.id}/resolve-unknown`).set('Cookie', s.cookie).send({ decision: 'allow_retry' });
  assert.equal(resolved.status, 200); assert.equal(resolved.body.status, 'failed');
  assert.equal(resolved.body.history.at(-1).resolution, 'allow_retry');
});

test('failed proactive tasks pause and keep a safe actionable error', async () => {
  const s = await session(); await configure(s.userId, { model: 'breaks-after-probe' });
  await probeChat(s);
  const task = await createTask(s.userId, { title: '失败场景', prompt: '执行', model_id: 'custom', auto_run: true, run_at: new Date(Date.now() - 1000).toISOString() });
  const result = await runTask(s.userId, task.id);
  assert.equal(result.status, 'failed'); assert.equal(result.auto_run, false); assert.match(result.error, /限流|额度/); assert.ok(!result.error.includes('upstream'));
  assert.equal(result.history.at(-1).usage_status, 'unknown');
  assert.equal(result.history.at(-1).cost, null);
});

test('same group IDs cannot share scheduler state, and mentions accept full names plus following text', () => {
  const map = new UserScopedMap();
  runAsUser('A', () => map.set('group-presidential', 'A-work'));
  runAsUser('B', () => { assert.equal(map.get('group-presidential'), undefined); map.set('group-presidential', 'B-work'); });
  assert.equal(runAsUser('A', () => map.get('group-presidential')), 'A-work');
  assert.deepEqual(mentionedModelIds('@Alpha 2 请帮我分析 @小助手，继续', ['a', 'b'], id => id === 'a' ? 'Alpha 2' : '小助手'), ['a', 'b']);
  assert.deepEqual(mentionedModelIds('@Alpha 22', ['a'], () => 'Alpha 2'), []);
});

test('WebSocket delivery, typing and stop events cannot cross tenant boundaries with identical group IDs', async () => {
  const { WebSocket, WebSocketServer } = await import('ws');
  const { setupWebSocket, broadcastToGroup, broadcastPersonaUpdate } = await import('../src/websocket/index.js');
  const a = await session(), b = await session();
  await configure(a.userId);
  const server = createServer(), wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const incomingA = [], incomingB = [];
  const connect = async (s, received) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { headers: { Cookie: s.cookie, Origin: 'http://localhost:3010' } });
    ws.on('message', bytes => { const data = JSON.parse(bytes.toString()); received.push(...(data.type === 'batch' ? data.messages : [data])); });
    await once(ws, 'open');
    await eventually(() => received.some(e => e.type === 'connected'));
    ws.send(JSON.stringify({ type: 'join_group', group_id: 'group-presidential' }));
    await eventually(() => received.some(e => e.type === 'joined_group'));
    return ws;
  };
  let wsA, wsB;
  try {
    wsA = await connect(a, incomingA); wsB = await connect(b, incomingB);
    runAsUser(a.userId, () => broadcastToGroup('group-presidential', { type: 'private_probe', content: 'A only' }));
    await eventually(() => incomingA.some(e => e.type === 'private_probe'));
    wsA.send(JSON.stringify({ type: 'stop_generation', group_id: 'group-presidential' }));
    await eventually(() => incomingA.some(e => e.type === 'generation_stopped'));
    await broadcastPersonaUpdate('custom', a.userId);
    await eventually(() => incomingA.some(e => e.type === 'persona_updated' || e.type === 'persona_update'));
    assert.equal(incomingB.some(e => ['private_probe', 'generation_stopped', 'persona_update', 'persona_updated'].includes(e.type)), false);
  } finally {
    wsA?.terminate(); wsB?.terminate(); for (const ws of wss.clients) ws.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('editing agent capabilities does not deadlock, duplicate agents, or replace the selected model', { timeout: 5000 }, async () => {
  const s = await session(); await configure(s.userId);
  await probeChat(s);
  const created = await request.post('/api/agents').set('Cookie', s.cookie).send({ name: '项目伙伴', description: '帮助梳理项目', openingMessage: '从哪里开始？', modelId: 'custom' });
  assert.equal(created.status, 200); assert.equal(created.body.model_roles[0].modelId, 'custom');
  const updated = await request.put(`/api/agents/${created.body.id}`).set('Cookie', s.cookie).send({ capabilities: { web_search: true }, description: '帮助梳理项目并记录行动' });
  assert.equal(updated.status, 200); assert.equal(updated.body.model_roles[0].modelId, 'custom'); assert.equal(updated.body.capabilities.web_search, false);
  const all = await request.get('/api/agents').set('Cookie', s.cookie); assert.equal(all.body.length, 1);
});

test('empty debate history never falls back to another user with the same preset group', async () => {
  const { getRecentDebateMessages } = await import('../src/services/debate/index.js');
  const a = await session(), b = await session();
  const db = await getUserDb(a.userId); await db.read();
  db.data.messages.push({ id: 'private-a', group_id: 'group-presidential', sender_type: 'user', content: 'A私有历史' }); await db.write();
  assert.equal((await runAsUser(a.userId, () => getRecentDebateMessages('group-presidential'))).length, 1);
  assert.deepEqual(await runAsUser(b.userId, () => getRecentDebateMessages('group-presidential')), []);
  assert.deepEqual(await getRecentDebateMessages('group-presidential'), []);
});

test('queued user replies stop before dispatch and discard responses after source or group deletion', { timeout: 15000 }, async () => {
  const { WebSocket, WebSocketServer } = await import('ws');
  const { setupWebSocket } = await import('../src/websocket/index.js');
  const socketServer = createServer();
  const wss = new WebSocketServer({ server: socketServer, path: '/ws' });
  setupWebSocket(wss);
  socketServer.listen(0, '127.0.0.1');
  await once(socketServer, 'listening');
  const s = await session();
  await configure(s.userId, { model: 'slow-task-model' });
  await probeChat(s);
  const createGroup = async () => {
    const group = await request.post('/api/groups').set('Cookie', s.cookie)
      .send({ name: '删除竞态群组', ai_members: ['custom'] });
    assert.equal(group.status, 201);
    return group.body.id;
  };
  const send = async groupId => {
    const result = await request.post(`/api/groups/${groupId}/messages`).set('Cookie', s.cookie)
      .send({ content: '请回复这条消息' });
    assert.equal(result.status, 201);
    return result.body.id;
  };
  const finishSlowStream = () => {
    const response = slow.pop();
    assert.ok(response);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '迟到的内容' } }] }) +
      '\n\ndata: [DONE]\n\n');
  };
  const connect = async groupId => {
    const events = [];
    const ws = new WebSocket(`ws://127.0.0.1:${socketServer.address().port}/ws`,
      { headers: { Cookie: s.cookie, Origin: 'http://localhost:3010' } });
    ws.on('message', bytes => {
      const data = JSON.parse(bytes.toString());
      events.push(...(data.type === 'batch' ? data.messages : [data]));
    });
    await once(ws, 'open');
    await eventually(() => events.some(event => event.type === 'connected'));
    ws.send(JSON.stringify({ type: 'join_group', group_id: groupId }));
    await eventually(() => events.some(event => event.type === 'joined_group'));
    return { ws, events };
  };

  try {
  const beforeGroup = await createGroup();
  const beforeSource = await send(beforeGroup);
  const beforeCalls = calls.length;
  const beforeDispatch = queueAIMessages(beforeGroup, '请回复这条消息', null, s.userId, beforeSource);
  assert.equal((await request.delete(`/api/messages/${beforeSource}`).set('Cookie', s.cookie)).status, 200);
  await beforeDispatch;
  assert.equal(calls.length, beforeCalls);

  for (const deletion of ['message', 'group']) {
    const groupId = await createGroup();
    const sourceId = await send(groupId);
    const { ws, events } = await connect(groupId);
    const db = await getUserDb(s.userId);
    const slowCount = slow.length;
    const queued = queueAIMessages(groupId, '请回复这条消息', null, s.userId, sourceId);
    await eventually(() => slow.length > slowCount);
    const removed = deletion === 'message'
      ? await request.delete(`/api/messages/${sourceId}`).set('Cookie', s.cookie)
      : await request.delete(`/api/groups/${groupId}`).set('Cookie', s.cookie);
    assert.equal(removed.status, 200);
    finishSlowStream();
    await queued;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(events.some(event =>
      ['message_stream_chunk', 'message_stream_end', 'system_message'].includes(event.type) &&
      JSON.stringify(event).includes('迟到的内容')), false);
    await db.read();
    assert.equal(db.data.messages.some(message =>
      message.group_id === groupId && message.content?.includes('迟到的内容')), false);
    ws.terminate();
  }

  const refusalGroup = await createGroup();
  const refusalSource = await send(refusalGroup);
  const refusalDb = await getUserDb(s.userId);
  await withWriteLock(s.userId, async () => {
    await refusalDb.read();
    refusalDb.data.customPersonas ||= {};
    refusalDb.data.customPersonas.custom = { refusalProbability: 1 };
    await refusalDb.write();
  });
  const slowCount = slow.length;
  const refusal = queueAIMessages(refusalGroup, '请回复这条消息', null, s.userId, refusalSource);
  await eventually(() => slow.length > slowCount);
  assert.equal((await request.delete(`/api/messages/${refusalSource}`).set('Cookie', s.cookie)).status, 200);
  const refusalResponse = slow.pop();
  refusalResponse.setHeader('Content-Type', 'application/json');
  refusalResponse.end(JSON.stringify({ choices: [{ message: { content: '迟到的拒绝' } }] }));
  await refusal;
  await refusalDb.read();
  assert.equal(refusalDb.data.messages.some(message =>
    message.group_id === refusalGroup && message.metadata?.refusal), false);
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => socketServer.close(resolve));
  }
});
