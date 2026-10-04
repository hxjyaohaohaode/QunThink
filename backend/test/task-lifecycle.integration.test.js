import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-task-lifecycle-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { initDatabase, initUserDatabase, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { readCatalog, saveCatalog } = await import('../src/services/ai/catalog.js');
const { createTask, listTasks, runTask, updateTask, deleteTask, acceptTaskResult,
  resolveUnknownTaskRun, tickTasks, startTaskScheduler, stopTaskScheduler } = await import('../src/services/tasks.js');
const request = (await import('supertest')).default(createTestApp());
await initDatabase(); await initAuthDb();

const calls = [], held = [];
let behavior = 'ok';
function reply(res, content = '可验收的本地草稿') {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }));
}
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (JSON.stringify(body.messages).includes('请回复 OK')) return reply(res, 'OK');
  calls.push(body);
  if (behavior === 'hold') { held.push(res); return; }
  if (behavior === 'disconnect') { req.socket.destroy(); return; }
  if (['503', '408', '429'].includes(behavior)) { res.writeHead(Number(behavior)); res.end('private provider diagnostic'); return; }
  reply(res);
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const origin = `http://127.0.0.1:${provider.address().port}`;
process.env.AI_ALLOWED_LOCAL_ORIGINS = origin;
after(async () => { stopTaskScheduler(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });

async function session(withModel = false) {
  const userId = crypto.randomUUID(), token = generateSessionToken();
  const db = await initUserDatabase(userId);
  await provisionNewLocalMemoryAccount(userId, db);
  const auth = getAuthDb(); await auth.read();
  auth.data.users.push({ id: userId, username: userId, password: 'unused' });
  auth.data.sessions.push({ token, userId, expires_at: new Date(Date.now() + 3600000).toISOString() });
  await auth.write();
  const s = { userId, db, cookie: `session_token=${token}` };
  if (withModel) {
    const catalog = await readCatalog(userId);
    catalog.providers.push({ id: 'local_task_test', name: '隔离测试', baseUrl: `${origin}/v1`, protocol: 'openai', enabled: true, keyRequired: false });
    catalog.models.push({ id: 'task_test', providerId: 'local_task_test', name: '隔离任务模型', model: 'isolated-task-model', enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 2048, temperature: null });
    catalog.defaults.chat = 'task_test';
    await saveCatalog(userId, catalog);
    const probe = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ modelId: 'task_test', capability: 'chat' });
    assert.equal(probe.status, 200);
  }
  behavior = 'ok';
  return s;
}
async function eventually(condition) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Expected local condition did not occur');
}
const input = (extra = {}) => ({ title: '可靠任务', prompt: '生成文字草稿', ...extra });
const create = (s, extra = {}) => createTask(s.userId, input(extra));
const mutate = (s, fn) => withWriteLock(s.userId, async () => { await s.db.read(); fn(s.db.data); await s.db.write(); });

test('concurrent create retries are tenant-scoped, conflict checked and durable after cache eviction', async () => {
  const s = await session(), requestId = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 12 }, () => request.post('/api/tasks').set('Cookie', s.cookie).set('Idempotency-Key', requestId).send(input())));
  assert.ok(results.every(result => result.status === 201));
  assert.equal(new Set(results.map(result => result.body.id)).size, 1);
  assert.equal((await listTasks(s.userId)).length, 1);
  const conflict = await request.post('/api/tasks').set('Cookie', s.cookie).set('Idempotency-Key', requestId).send(input({ prompt: '不同要求' }));
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  clearUserDbCache(s.userId);
  const replay = await request.post('/api/tasks').set('Cookie', s.cookie).send(input({ client_request_id: requestId.toUpperCase() }));
  assert.equal(replay.body.id, results[0].body.id);
  const other = await session();
  assert.notEqual((await create(other, { client_request_id: requestId })).id, replay.body.id);
});

test('deletion keeps a tombstone against delayed creation retries', async () => {
  const s = await session(), client_request_id = crypto.randomUUID();
  const task = await create(s, { client_request_id });
  await deleteTask(s.userId, task.id);
  await assert.rejects(create(s, { client_request_id }), error => error.status === 410 && error.code === 'TASK_DELETED');
  assert.equal((await listTasks(s.userId)).length, 0);
});

test('request keys and run payloads are validated before model calls', async () => {
  const s = await session();
  assert.equal((await request.post('/api/tasks').set('Cookie', s.cookie).set('Idempotency-Key', 'bad-key').send(input())).status, 400);
  assert.equal((await request.post('/api/tasks').set('Cookie', s.cookie).set('Idempotency-Key', crypto.randomUUID()).send(input({ client_request_id: crypto.randomUUID() }))).status, 400);
  const task = await create(s), before = calls.length;
  assert.equal((await request.post(`/api/tasks/${task.id}/run`).set('Cookie', s.cookie).send({ force: true })).status, 400);
  assert.equal((await request.post(`/api/tasks/${task.id}/run`).set('Cookie', s.cookie).set('Idempotency-Key', 'bad-key').send({})).status, 400);
  assert.equal(calls.length, before);
});

test('parallel and completed run replays spend one call and budget slot; a fresh intent creates a related run', async () => {
  const s = await session(true), task = await create(s), requestId = crypto.randomUUID();
  behavior = 'hold';
  const before = calls.length, heldBefore = held.length;
  const firstPromise = request.post(`/api/tasks/${task.id}/run`).set('Cookie', s.cookie).set('Idempotency-Key', requestId).send({}).then(result => result);
  await eventually(() => held.length > heldBefore);
  const duplicates = await Promise.all(Array.from({ length: 8 }, () => request.post(`/api/tasks/${task.id}/run`).set('Cookie', s.cookie).set('Idempotency-Key', requestId).send({})));
  assert.ok(duplicates.every(result => result.status === 200 && result.body.status === 'running'));
  assert.equal(calls.length, before + 1);
  reply(held.at(-1));
  const first = await firstPromise;
  assert.equal(first.body.status, 'needs_review');
  const replay = await runTask(s.userId, task.id, { client_request_id: requestId });
  assert.equal(replay.run_id, first.body.run_id); assert.equal(replay.run_count, 1);
  assert.equal(s.db.data.taskDailyBudget.count, 1); assert.equal(calls.length, before + 1);
  behavior = 'ok';
  const next = await runTask(s.userId, task.id, { client_request_id: crypto.randomUUID() });
  assert.equal(next.history[1].retry_of_run_id, first.body.run_id);
  assert.notEqual(next.run_id, first.body.run_id); assert.equal(calls.length, before + 2);
  assert.equal((await runTask(s.userId, task.id, { client_request_id: requestId })).run_id, next.run_id);
  assert.equal(calls.length, before + 2);
});

test('disconnect becomes unknown and fences repeats until a run-specific explicit resolution', async () => {
  const s = await session(true), task = await create(s), requestId = crypto.randomUUID();
  behavior = 'disconnect'; const before = calls.length;
  const result = await runTask(s.userId, task.id, { client_request_id: requestId });
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.history[0].dispatch_status, 'sent_or_unknown');
  assert.equal(result.history[0].status, 'outcome_unknown');
  assert.equal((await runTask(s.userId, task.id, { client_request_id: requestId })).run_id, result.run_id);
  await assert.rejects(runTask(s.userId, task.id, { client_request_id: crypto.randomUUID() }), error => error.status === 409);
  await assert.rejects(deleteTask(s.userId, task.id), error => error.status === 409);
  assert.equal(calls.length, before + 1);
  await assert.rejects(resolveUnknownTaskRun(s.userId, task.id, 'allow_retry', crypto.randomUUID()), error => error.status === 409);
  await resolveUnknownTaskRun(s.userId, task.id, 'allow_retry', result.run_id);
  await resolveUnknownTaskRun(s.userId, task.id, 'allow_retry', result.run_id);
  behavior = 'ok';
  assert.equal((await runTask(s.userId, task.id, { client_request_id: requestId })).status, 'failed');
  assert.equal(calls.length, before + 1);
  assert.equal((await runTask(s.userId, task.id, { client_request_id: crypto.randomUUID() })).status, 'needs_review');
  assert.equal(calls.length, before + 2);
  await assert.rejects(resolveUnknownTaskRun(s.userId, task.id, 'allow_retry', result.run_id), error => error.status === 409);
});

test('server errors and upstream timeouts are unknown; quota rejection is failed; neither leaks upstream body', async () => {
  const s = await session(true);
  behavior = '503';
  const unknown = await runTask(s.userId, (await create(s)).id);
  assert.equal(unknown.status, 'outcome_unknown'); assert.doesNotMatch(unknown.error, /private/);
  behavior = '408';
  assert.equal((await runTask(s.userId, (await create(s)).id)).status, 'outcome_unknown');
  behavior = '429';
  const failed = await runTask(s.userId, (await create(s)).id);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /限流|额度/); assert.doesNotMatch(failed.error, /private/);
});

test('cancellation after dispatch retains run evidence and defeats late completion', async () => {
  const s = await session(true), task = await create(s), requestId = crypto.randomUUID();
  behavior = 'hold'; const heldBefore = held.length;
  const running = runTask(s.userId, task.id, { client_request_id: requestId });
  await eventually(() => held.length > heldBefore);
  const stopped = await updateTask(s.userId, task.id, { status: 'cancelled', run_id: (await listTasks(s.userId)).find(item => item.id === task.id).run_id });
  assert.equal(stopped.status, 'outcome_unknown'); assert.equal(stopped.history.length, 1); assert.equal(stopped.run_count, 1);
  assert.equal(stopped.history[0].client_request_id, requestId);
  await running;
  assert.equal((await listTasks(s.userId))[0].status, 'outcome_unknown');
  assert.equal((await listTasks(s.userId))[0].history.length, 1);
});

test('cancellation before dispatch is known not sent with a terminal run record', async () => {
  const s = await session(true), task = await create(s), before = calls.length;
  const originalRead = s.db.read.bind(s.db);
  let entered, release;
  const gate = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  let paused = false;
  s.db.read = async (...args) => {
    if (!paused && s.db.data.tasks?.some(item => item.id === task.id && item.status === 'running')) { paused = true; entered(); await wait; }
    return originalRead(...args);
  };
  const running = runTask(s.userId, task.id);
  try {
    await gate;
    const cancelled = await updateTask(s.userId, task.id, { status: 'cancelled', run_id: (await listTasks(s.userId)).find(item => item.id === task.id).run_id });
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.history[0].dispatch_status, 'not_sent');
  } finally { release(); }
  try { await running; assert.equal(calls.length, before); }
  finally { s.db.read = originalRead; }
});

test('regeneration never revives source-stale history or accepts an older run token', async () => {
  const s = await session(true);
  await mutate(s, data => data.messages.push({ id: 'source-one', group_id: 'group-presidential', sender_type: 'user', content: '版本一', revision: 1 }));
  const task = await create(s, { group_id: 'group-presidential' });
  const first = await runTask(s.userId, task.id);
  await acceptTaskResult(s.userId, task.id, first.run_id);
  await mutate(s, data => Object.assign(data.messages.find(message => message.id === 'source-one'), { content: '版本二', revision: 2 }));
  const second = await runTask(s.userId, task.id);
  assert.equal(second.source_stale, false); assert.equal(second.history[0].source_stale, true);
  assert.equal(second.history[0].result, ''); assert.equal(second.history[1].result, second.result);
  assert.deepEqual(second.history[1].source_messages, [{ id: 'source-one', revision: 2, edited_at: null }]);
  await assert.rejects(acceptTaskResult(s.userId, task.id, first.run_id), error => error.status === 409);
  assert.equal((await acceptTaskResult(s.userId, task.id, second.run_id)).status, 'completed');
});

test('an unreviewed recurring draft does not starve another due task', async () => {
  const s = await session(true), run_at = new Date(Date.now() - 1000).toISOString();
  const first = await create(s, { auto_run: true, run_at, repeat_minutes: 15 });
  await runTask(s.userId, first.id);
  const second = await create(s, { auto_run: true, run_at });
  await mutate(s, data => { data.tasks.find(task => task.id === first.id).run_at = run_at; });
  await tickTasks();
  const all = await listTasks(s.userId);
  assert.equal(all.find(task => task.id === first.id).run_count, 1);
  assert.equal(all.find(task => task.id === second.id).run_count, 1);
});

test('failed create persistence leaves no phantom cached receipt', async () => {
  const s = await session(), client_request_id = crypto.randomUUID();
  const originalWrite = s.db.write.bind(s.db); let failed = false;
  s.db.write = async () => { if (!failed) { failed = true; throw new Error('injected write failure'); } return originalWrite(); };
  try {
    await assert.rejects(create(s, { client_request_id }), /injected/);
    const task = await create(s, { client_request_id });
    assert.equal((await listTasks(s.userId)).length, 1);
    assert.equal((await create(s, { client_request_id })).id, task.id);
  } finally { s.db.write = originalWrite; }
});

test('dispatch checkpoint failure never calls provider; lost response persistence becomes unknown', async () => {
  const s = await session(true), before = calls.length, first = await create(s);
  const originalWrite = s.db.write.bind(s.db); let failDispatch = true;
  s.db.write = async () => {
    if (failDispatch && s.db.data.tasks.some(task => task.status === 'running' && task.dispatch_status === 'sent_or_unknown')) { failDispatch = false; throw new Error('injected dispatch write failure'); }
    return originalWrite();
  };
  try {
    const failed = await runTask(s.userId, first.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.history[0].dispatch_status, 'not_sent'); assert.equal(calls.length, before);
  } finally { s.db.write = originalWrite; }
  const second = await create(s); let failResult = true;
  s.db.write = async () => {
    if (failResult && s.db.data.tasks.some(task => task.id === second.id && task.status === 'needs_review')) { failResult = false; throw new Error('injected result write failure'); }
    return originalWrite();
  };
  try {
    const unknown = await runTask(s.userId, second.id);
    assert.equal(unknown.status, 'outcome_unknown'); assert.equal(unknown.history[0].status, 'outcome_unknown');
    assert.equal(unknown.result_pending_review, false); assert.equal(calls.length, before + 1);
    await assert.rejects(runTask(s.userId, second.id), error => error.status === 409);
  } finally { s.db.write = originalWrite; }
});

test('failed acceptance writes cannot leak success from the cache', async () => {
  const s = await session(true), task = await create(s), draft = await runTask(s.userId, task.id);
  const originalWrite = s.db.write.bind(s.db);
  s.db.write = async () => { throw new Error('injected acceptance write failure'); };
  try { await assert.rejects(acceptTaskResult(s.userId, task.id, draft.run_id), /injected/); }
  finally { s.db.write = originalWrite; }
  const unchanged = (await listTasks(s.userId))[0];
  assert.equal(unchanged.status, 'needs_review'); assert.equal(unchanged.history[0].status, 'generated');
  assert.equal((await acceptTaskResult(s.userId, task.id, draft.run_id)).status, 'completed');
});

test('restart distinguishes unsent and potentially dispatched runs, preserving retry keys', async () => {
  const s = await session(), a = await create(s), b = await create(s);
  const aRun = crypto.randomUUID(), bRun = crypto.randomUUID(), requestId = crypto.randomUUID();
  await mutate(s, data => {
    Object.assign(data.tasks.find(task => task.id === a.id), { status: 'running', run_id: aRun, run_request_id: requestId, dispatch_status: 'not_sent' });
    Object.assign(data.tasks.find(task => task.id === b.id), { status: 'running', run_id: bRun, dispatch_status: 'sent_or_unknown' });
  });
  await startTaskScheduler(); stopTaskScheduler();
  const all = await listTasks(s.userId);
  assert.equal(all.find(task => task.id === a.id).status, 'failed');
  assert.equal(all.find(task => task.id === a.id).history[0].client_request_id, requestId);
  assert.equal(all.find(task => task.id === b.id).status, 'outcome_unknown');
  const replay = await runTask(s.userId, a.id, { client_request_id: requestId });
  assert.equal(replay.run_id, aRun); assert.equal(replay.run_count, 1);
});


test('a transient finalization read outage leaves a recoverable unknown run, never an idle running task', async () => {
  const s = await session(true), task = await create(s);
  behavior = 'hold'; const heldBefore = held.length;
  const running = runTask(s.userId, task.id);
  await eventually(() => held.length > heldBefore);
  const originalRead = s.db.read.bind(s.db); let failRead = true;
  s.db.read = async (...args) => {
    if (failRead) { failRead = false; throw new Error('injected finalization read failure'); }
    return originalRead(...args);
  };
  try {
    reply(held.at(-1));
    await assert.rejects(running, /injected finalization/);
    const recovered = (await listTasks(s.userId))[0];
    assert.equal(recovered.status, 'outcome_unknown');
    assert.equal(recovered.run_count, 1); assert.equal(recovered.history.length, 1);
    assert.equal(recovered.history[0].usage_status, 'provider_reported');
    await assert.rejects(runTask(s.userId, task.id), error => error.status === 409);
  } finally { s.db.read = originalRead; }
});

test('message-derived tasks bind the selected revision, suppress edited input and never resend stale copied text', async () => {
  const s = await session(true);
  await mutate(s, data => data.messages.push({ id: 'origin-message', group_id: 'group-presidential', sender_type: 'user', content: '不能重发的原文' }));
  const task = await create(s, { prompt: '不能重发的原文', group_id: 'group-presidential', source_message_id: 'origin-message', source_message_edited_at: null });
  const draft = await runTask(s.userId, task.id), before = calls.length;
  await mutate(s, data => Object.assign(data.messages.find(message => message.id === 'origin-message'), { content: '用户的新内容', edited_at: new Date().toISOString() }));
  const view = (await listTasks(s.userId))[0];
  assert.equal(view.source_input_stale, true); assert.equal(view.prompt, ''); assert.equal(view.result, '');
  assert.equal(view.history[0].result, '');
  await assert.rejects(runTask(s.userId, task.id), error => error.code === 'TASK_SOURCE_CHANGED');
  await assert.rejects(acceptTaskResult(s.userId, task.id, draft.run_id), error => error.code === 'TASK_SOURCE_CHANGED');
  assert.equal(calls.length, before);
  await assert.rejects(create(s, { prompt: '不能重发的原文', group_id: 'group-presidential', source_message_id: 'origin-message', source_message_edited_at: null }), error => error.code === 'TASK_SOURCE_CHANGED');
  const edited_at = s.db.data.messages.find(message => message.id === 'origin-message').edited_at;
  const corrected = await create(s, { prompt: '用户的新内容', group_id: 'group-presidential', source_message_id: 'origin-message', source_message_edited_at: edited_at });
  assert.equal((await runTask(s.userId, corrected.id)).status, 'needs_review');
});

test('message provenance cannot cross groups or survive deletion plus old JSON restore', async () => {
  const s = await session(true);
  await mutate(s, data => data.messages.push({ id: 'revoked-origin', group_id: 'group-presidential', sender_type: 'user', sender_id: s.userId, content: '撤销源文本' }));
  await assert.rejects(create(s, { group_id: 'group-debate', source_message_id: 'revoked-origin' }), error => error.status === 404);
  await assert.rejects(create(s, { source_message_id: 'revoked-origin' }), error => error.name === 'ZodError');
  const task = await create(s, { prompt: '撤销源文本', group_id: 'group-presidential', source_message_id: 'revoked-origin', source_message_edited_at: null });
  await runTask(s.userId, task.id);
  const dbPath = path.join(process.env.DATA_DIR, 'users', `db_${s.userId}.json`), snapshot = await fs.readFile(dbPath);
  assert.equal((await request.delete('/api/messages/revoked-origin').set('Cookie', s.cookie)).status, 200);
  await fs.writeFile(dbPath, snapshot); clearUserDbCache(s.userId);
  const restored = (await listTasks(s.userId))[0], before = calls.length;
  assert.equal(restored.source_input_stale, true); assert.equal(restored.prompt, ''); assert.equal(restored.result, '');
  await assert.rejects(runTask(s.userId, task.id), error => error.status === 409);
  assert.equal(calls.length, before);
});


test('a delayed request cannot create, run, change, accept, resolve or delete under a different account session', async () => {
  const a = await session(), b = await session(true), task = await create(b), before = calls.length;
  const cases = [
    ['post', '/api/tasks', input()],
    ['post', `/api/tasks/${task.id}/run`, {}],
    ['patch', `/api/tasks/${task.id}`, { title: 'wrong account' }],
    ['post', `/api/tasks/${task.id}/accept`, { run_id: crypto.randomUUID() }],
    ['post', `/api/tasks/${task.id}/resolve-unknown`, { decision: 'allow_retry' }],
    ['delete', `/api/tasks/${task.id}`, {}]
  ];
  for (const [method, url, payload] of cases) {
    const response = await request[method](url).set('Cookie', b.cookie).set('X-Expected-User-Id', a.userId).send(payload);
    assert.equal(response.status, 409); assert.equal(response.body.code, 'ACCOUNT_CHANGED');
  }
  assert.equal(calls.length, before);
  assert.equal((await listTasks(b.userId)).length, 1);
  assert.equal((await listTasks(b.userId))[0].title, '可靠任务');
  assert.equal((await request.patch(`/api/tasks/${task.id}`).set('Cookie', b.cookie)
    .set('X-Expected-User-Id', b.userId).send({ title: '当前账号修改' })).status, 200);
});

test('pre-versioning source hashes remain readable and acceptable until the source really changes', async () => {
  const s = await session(true);
  await mutate(s, data => data.messages.push({ id: 'legacy-source', group_id: 'group-presidential', sender_type: 'user', content: '既有草稿的有效来源' }));
  const task = await create(s, { group_id: 'group-presidential' }), generated = await runTask(s.userId, task.id);
  await mutate(s, data => {
    const existing = data.tasks.find(item => item.id === task.id), run = existing.history[0];
    const legacyHash = crypto.createHash('sha256').update(JSON.stringify([{ id: 'legacy-source', content: '既有草稿的有效来源', attachments: [] }])).digest('hex');
    run.source_hash = legacyHash; existing.source_hash = legacyHash;
    delete run.source_hash_version; delete existing.source_hash_version;
  });
  const view = (await listTasks(s.userId))[0];
  assert.equal(view.source_stale, false); assert.equal(view.result, generated.result);
  assert.equal((await acceptTaskResult(s.userId, task.id, generated.run_id)).status, 'completed');
  await mutate(s, data => { data.messages.find(message => message.id === 'legacy-source').content = '真实更新'; });
  assert.equal((await listTasks(s.userId))[0].source_stale, true);
});


test('a revoked input pauses its scheduled task without starving the next valid schedule', async () => {
  const s = await session(true), run_at = new Date(Date.now() - 1000).toISOString();
  await mutate(s, data => data.messages.push({ id: 'scheduled-origin', group_id: 'group-presidential', sender_type: 'user', content: '过期输入' }));
  const stale = await create(s, { group_id: 'group-presidential', source_message_id: 'scheduled-origin', auto_run: true, run_at });
  const valid = await create(s, { auto_run: true, run_at });
  await mutate(s, data => { data.messages.find(message => message.id === 'scheduled-origin').content = '新输入'; });
  const before = calls.length;
  await tickTasks();
  const all = await listTasks(s.userId), paused = all.find(task => task.id === stale.id);
  assert.equal(paused.status, 'failed'); assert.equal(paused.auto_run, false); assert.equal(paused.run_count, 0);
  assert.equal(all.find(task => task.id === valid.id).status, 'needs_review'); assert.equal(calls.length, before + 1);
});


test('a stop request arriving before run admission prevents that exact late intent from dispatching', async () => {
  const s = await session(true), task = await create(s), before = calls.length;
  const key = crypto.randomUUID();
  const stopped = await updateTask(s.userId, task.id, { status: 'cancelled', cancel_request_id: key });
  assert.equal(stopped.status, 'cancelled');
  clearUserDbCache(s.userId);
  const replay = await runTask(s.userId, task.id, { client_request_id: key });
  assert.equal(replay.status, 'cancelled');
  assert.equal(calls.length, before);
  const intentional = await runTask(s.userId, task.id, { client_request_id: crypto.randomUUID() });
  assert.equal(intentional.status, 'needs_review');
  assert.equal(calls.length, before + 1);
});

test('stale cancellation cannot stop a newer running intent; unbound stop and resolution fail closed', async () => {
  const s = await session(true), task = await create(s), key = crypto.randomUUID();
  behavior = 'hold'; const heldBefore = held.length;
  const running = runTask(s.userId, task.id, { client_request_id: key });
  await eventually(() => held.length > heldBefore);
  const oldKey = crypto.randomUUID();
  const ignored = await updateTask(s.userId, task.id, { status: 'cancelled', cancel_request_id: oldKey });
  assert.equal(ignored.status, 'running');
  assert.equal(ignored.run_request_id, key);
  await assert.rejects(updateTask(s.userId, task.id, { status: 'cancelled' }), error => error.status === 400);
  const stopped = await updateTask(s.userId, task.id, { status: 'cancelled', cancel_request_id: key });
  await running;
  assert.equal(stopped.status, 'outcome_unknown');
  assert.equal((await request.post(`/api/tasks/${task.id}/resolve-unknown`).set('Cookie', s.cookie).send({decision:'allow_retry'})).status, 400);
});

test('replacing-read adapter preserves the durable dispatch checkpoint before cancellation', async () => {
  const s = await session(true), task = await create(s), before = calls.length;
  const originalRead = s.db.read.bind(s.db);
  s.db.read = async (...args) => { await originalRead(...args); s.db.data = structuredClone(s.db.data); };
  behavior = 'hold'; const heldBefore = held.length;
  const running = runTask(s.userId, task.id, { client_request_id: crypto.randomUUID() });
  await eventually(() => held.length > heldBefore);
  assert.equal(calls.length, before + 1);
  const during = (await listTasks(s.userId))[0];
  assert.equal(during.dispatch_status, 'sent_or_unknown');
  const stopped = await updateTask(s.userId, task.id, {status:'cancelled',run_id:during.run_id});
  await running;
  assert.equal(stopped.status, 'outcome_unknown');
  assert.equal(stopped.history.at(-1).dispatch_status, 'sent_or_unknown');
});

test('expected-account reads and logout never expose or terminate another tab account', async () => {
  const alice = await session(), bob = await session();
  await create(bob, { prompt: 'Bob private content' });
  for (const endpoint of ['/api/tasks', '/api/groups', '/api/user/model-catalog', '/api/auth/me']) {
    const response = await request.get(endpoint).set('Cookie', bob.cookie).set('X-Expected-User-Id', alice.userId);
    assert.equal(response.status, 409, endpoint);
    assert.equal(response.body.code, 'ACCOUNT_CHANGED');
    assert.equal(JSON.stringify(response.body).includes('Bob private content'), false);
  }
  const logout = await request.post('/api/auth/logout').set('Cookie', bob.cookie).set('X-Expected-User-Id', alice.userId);
  assert.equal(logout.status, 409);
  const stillValid = await request.get('/api/tasks').set('Cookie', bob.cookie).set('X-Expected-User-Id', bob.userId);
  assert.equal(stillValid.status, 200);
  assert.equal(stillValid.body[0].prompt, 'Bob private content');
});
