import { appendFixtureMessages, initializeAccountStoreFixture } from './helpers/accountStoreFixtures.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// This fixture has no external model credentials or destinations. Every model
// completion, including a regression that accidentally dispatches, is counted
// by an actual loopback HTTP provider rather than a mocked eligibility helper.
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-dependencies-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { initDatabase, createNewUserDatabase, getUserDb, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { readCatalog, saveCatalog } = await import('../src/services/ai/catalog.js');
const { createTask, listTasks, runTask, updateTask, deleteTask, tickTasks, stopTaskScheduler } = await import('../src/services/tasks.js');
const { getTaskResult, saveTaskResultVersion, acceptTaskResultVersion, adoptTaskResultVersion } = await import('../src/services/taskResults.js');
const request = (await import('supertest')).default(createTestApp());
await initializeAccountStoreFixture(); await initDatabase();
await initAuthDb();

const calls = [], probes = [], held = [];
let behavior = 'ok';
function reply(res, content = '本地依赖回归生成的完整文稿') {
  if (res.destroyed || res.writableEnded) return;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }));
}
const provider = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (JSON.stringify(body.messages).includes('请回复 OK')) { probes.push(body); reply(res, 'OK'); return; }
  calls.push(body);
  if (behavior === 'hold') { held.push(res); return; }
  if (behavior === 'disconnect') { req.socket.destroy(); return; }
  if (behavior === '429') { res.writeHead(429); res.end('isolated quota rejection'); return; }
  reply(res);
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const origin = `http://127.0.0.1:${provider.address().port}`;
process.env.AI_ALLOWED_LOCAL_ORIGINS = origin;
after(async () => {
  stopTaskScheduler();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
});

const uuid = () => crypto.randomUUID();
const input = (extra = {}) => ({ title: '依赖回归任务', prompt: '仅按本任务要求写作', ...extra });
const create = (s, extra = {}) => createTask(s.userId, input(extra));
const head = doc => doc.versions.find(version => version.id === doc.head_version_id);
const saveInput = (doc, content, extra = {}) => ({ client_request_id: uuid(), expected_revision: doc.revision, base_version_id: doc.head_version_id, reviewed_dependency_signature: doc.dependency_state.signature, content, ...extra });
const acceptInput = doc => ({ client_request_id: uuid(), expected_revision: doc.revision, version_id: doc.head_version_id, content_hash: head(doc).content_hash, source_hash: doc.source.hash });
const depPath = task => `/api/tasks/${task.id}/dependencies`;
const depInput = (task, ids, extra = {}) => ({ client_request_id: uuid(), expected_revision: task.dependency_revision, dependency_ids: ids, ...extra });
const putDependencies = (s, task, body) => request.put(depPath(task)).set('Cookie', s.cookie).send(body);
const receipt = (s, task, id) => request.get(`${depPath(task)}/commands/${id}`).set('Cookie', s.cookie);
const currentTask = async (s, task) => (await listTasks(s.userId)).find(item => item.id === task.id);
async function mutate(s, fn) {
  return withWriteLock(s.userId, async () => {
    s.db = await getUserDb(s.userId);
    await s.db.read({ force: true });
    fn(s.db.data);
    await s.db.write();
  });
}
async function session(withModel = false) {
  const userId = uuid(), token = generateSessionToken(), db = await createNewUserDatabase(userId);
  if (!process.env.SUPABASE_DB_URL) await provisionNewLocalMemoryAccount(userId, db);
  const auth = getAuthDb();
  await auth.read();
  auth.data.users.push({ id: userId, username: userId, password: 'unused' });
  auth.data.sessions.push({ token, userId, expires_at: new Date(Date.now() + 3600000).toISOString() });
  await auth.write();
  const s = { userId, db, cookie: `session_token=${token}` };
  behavior = 'ok';
  if (withModel) {
    const catalog = await readCatalog(userId);
    catalog.providers.push({ id: 'dependency_loopback', name: '依赖隔离测试', baseUrl: `${origin}/v1`, protocol: 'openai', enabled: true, keyRequired: false });
    catalog.models.push({ id: 'dependency_model', providerId: 'dependency_loopback', name: '依赖隔离模型', model: 'isolated-dependency-model', enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 2048, temperature: null });
    catalog.defaults.chat = 'dependency_model';
    await saveCatalog(userId, catalog);
    const before = probes.length;
    const probe = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ clientRequestId: uuid(), modelId: 'dependency_model', capability: 'chat' });
    assert.equal(probe.status, 200, JSON.stringify(probe.body));
    assert.equal(probes.length, before + 1);
  }
  return s;
}
async function manual(s, task, content = '人工撰写并验收的前置文稿', accept = true, extra = {}) {
  let doc = await getTaskResult(s.userId, task.id);
  doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(doc, content, extra))).document;
  if (accept) doc = (await acceptTaskResultVersion(s.userId, task.id, acceptInput(doc))).document;
  return doc;
}
async function eventually(condition, message = 'Expected local condition did not occur') {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}
function stateOf(value) {
  const state = value.dependency_state;
  assert.ok(state && typeof state === 'object', 'public response must include dependency_state');
  assert.equal(typeof state.blocked, 'boolean');
  assert.equal(typeof state.result_stale, 'boolean');
  assert.ok(Array.isArray(state.reasons));
  assert.ok(state.signature === null || typeof state.signature === 'string');
  for (const reason of state.reasons) {
    assert.equal(typeof reason.task_id, 'string');
    assert.ok(['missing', 'unaccepted', 'failed', 'cancelled', 'outcome_unknown', 'running', 'source_changed', 'dependency_changed', 'invalid'].includes(reason.code), JSON.stringify(reason));
  }
  return state;
}
function blockedBy(value, code, taskId) {
  const state = stateOf(value);
  assert.equal(state.blocked, true);
  assert.ok(state.reasons.some(reason => reason.code === code && (!taskId || reason.task_id === taskId)), JSON.stringify(state));
  return state;
}
async function budget(s) {
  const db = await getUserDb(s.userId);
  await db.read({ force: true });
  return db.data.taskDailyBudget?.count || 0;
}
async function assertRunBlocked(s, task) {
  const before = calls.length, oldBudget = await budget(s);
  const response = await request.post(`/api/tasks/${task.id}/run`).set('Cookie', s.cookie).send({ client_request_id: uuid() });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(calls.length, before, 'blocked dependency must not reach provider');
  assert.equal(await budget(s), oldBudget, 'blocked admission must not consume a daily dispatch slot');
}

// Public HTTP contracts, account isolation and account-serialized graph writes.
test('create validates dependency UUIDs, uniqueness, cap and ownership; old tasks default to an empty graph', async () => {
  const before = calls.length, alice = await session(), bob = await session();
  const own = await create(alice), foreign = await create(bob, { title: 'B_ONLY_PRIVATE_TITLE' });
  assert.deepEqual(own.dependency_ids, []);
  assert.equal(own.dependency_revision, 0);
  assert.equal(stateOf(own).blocked, false);
  assert.equal(stateOf(await getTaskResult(alice.userId, own.id)).blocked, false);
  const invalid = [null, 'not-an-array', [null], ['not-a-uuid'], [own.id, own.id], [own.id, own.id.toUpperCase()], Array.from({ length: 33 }, uuid)];
  for (const dependency_ids of invalid) {
    const result = await request.post('/api/tasks').set('Cookie', alice.cookie).send(input({ dependency_ids }));
    assert.equal(result.status, 400, JSON.stringify({ dependency_ids, body: result.body }));
  }
  for (const dependency_ids of [[uuid()], [foreign.id]]) {
    const result = await request.post('/api/tasks').set('Cookie', alice.cookie).send(input({ dependency_ids }));
    assert.ok([400, 404, 409].includes(result.status), JSON.stringify(result.body));
    assert.doesNotMatch(JSON.stringify(result.body), /B_ONLY_PRIVATE_TITLE/);
  }
  const dependent = await create(alice, { dependency_ids: [own.id] });
  assert.deepEqual(dependent.dependency_ids, [own.id]);
  blockedBy(dependent, 'unaccepted', own.id);
  assert.equal((await listTasks(alice.userId)).length, 2);
  assert.equal(calls.length, before);
});

test('dependency commands enforce revision, HTTP account scope, exact request identity and durable receipts', async () => {
  const before = calls.length, alice = await session(), bob = await session();
  const a = await create(alice), b = await create(alice), target = await create(alice), foreign = await create(bob);
  const body = depInput(target, [a.id]);
  assert.equal((await putDependencies(bob, target, body)).status, 404);
  const changedAccount = await request.put(depPath(target)).set('Cookie', bob.cookie).set('X-Expected-User-Id', alice.userId).send(body);
  assert.equal(changedAccount.status, 409);
  assert.equal((await putDependencies(alice, target, { ...body, dependency_ids: [foreign.id] })).status, 404);
  const invalid = [ { ...body, expected_revision: -1 }, { ...body, expected_revision: 0.5 }, { ...body, client_request_id: 'bad' }, { ...body, dependency_ids: [a.id, a.id] }, { ...body, unexpected: true } ];
  for (const value of invalid) assert.equal((await putDependencies(alice, target, value)).status, 400);
  assert.equal((await request.put(depPath(target)).set('Cookie', alice.cookie).set('Idempotency-Key', uuid()).send(body)).status, 400);
  const saved = await putDependencies(alice, target, body);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.headers['cache-control'], 'no-store');
  assert.equal(saved.body.receipt.id, body.client_request_id);
  assert.equal(saved.body.receipt.operation, 'dependencies');
  assert.equal(saved.body.receipt.task_id, target.id);
  assert.equal(saved.body.receipt.status, 'succeeded');
  assert.equal(saved.body.receipt.committed_revision, target.dependency_revision + 1);
  assert.equal(saved.body.task.dependency_revision, saved.body.receipt.committed_revision);
  assert.deepEqual(saved.body.task.dependency_ids, [a.id]);
  assert.equal((await putDependencies(alice, target, depInput(target, [b.id]))).status, 409);
  assert.equal((await putDependencies(alice, target, { ...body, dependency_ids: [b.id] })).status, 409);
  clearUserDbCache(alice.userId);
  const replay = await putDependencies(alice, target, body);
  assert.deepEqual(replay.body.receipt, saved.body.receipt);
  assert.equal(replay.body.task.dependency_revision, 1);
  assert.equal((await receipt(bob, target, body.client_request_id)).status, 404);
  assert.equal((await receipt(alice, a, body.client_request_id)).status, 404);
  assert.equal((await putDependencies(alice, a, depInput(a, [], { client_request_id: body.client_request_id }))).status, 409);
  assert.equal((await receipt(alice, target, uuid())).status, 404);
  assert.equal((await receipt(alice, target, 'not-a-uuid')).status, 400);
  const recovered = await receipt(alice, target, body.client_request_id);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.receipt, saved.body.receipt);
  assert.doesNotMatch(JSON.stringify(recovered.body), /input_hash/);
  assert.equal((await request.patch(`/api/tasks/${target.id}`).set('Cookie', alice.cookie).send({ dependency_ids: [] })).status, 400);
  assert.equal((await putDependencies(bob, foreign, depInput(foreign, [], { client_request_id: body.client_request_id }))).status, 200);
  await deleteTask(alice.userId, target.id);
  const deleted = await receipt(alice, target, body.client_request_id);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.task_deleted, true);
  assert.equal(deleted.body.task, null);
  assert.deepEqual(deleted.body.receipt, saved.body.receipt);
  const delayed = await putDependencies(alice, target, body);
  assert.equal(delayed.status, 200);
  assert.equal(delayed.body.task_deleted, true);
  assert.equal((await listTasks(alice.userId)).some(task => task.id === target.id), false);
  assert.equal(calls.length, before);
});

test('self, indirect and simultaneous opposite edges cannot commit a dependency cycle', async () => {
  const before = calls.length, s = await session(), a = await create(s), b = await create(s), c = await create(s);
  assert.equal((await putDependencies(s, a, depInput(a, [a.id]))).status, 409);
  assert.equal((await putDependencies(s, a, depInput(a, [b.id]))).status, 200);
  assert.equal((await putDependencies(s, b, depInput(b, [c.id]))).status, 200);
  assert.equal((await putDependencies(s, c, depInput(c, [a.id]))).status, 409);
  const x = await create(s), y = await create(s);
  const raced = await Promise.all([putDependencies(s, x, depInput(x, [y.id])), putDependencies(s, y, depInput(y, [x.id]))]);
  assert.deepEqual(raced.map(result => result.status).sort(), [200, 409]);
  const all = await listTasks(s.userId);
  assert.equal(all.find(task => task.id === x.id).dependency_ids.length + all.find(task => task.id === y.id).dependency_ids.length, 1);
  const left = await create(s), right = await create(s), target = await create(s);
  const cas = await Promise.all([putDependencies(s, target, depInput(target, [left.id])), putDependencies(s, target, depInput(target, [right.id]))]);
  assert.deepEqual(cas.map(result => result.status).sort(), [200, 409]);
  assert.equal((await currentTask(s, target)).dependency_revision, 1);
  assert.equal(calls.length, before);
});

test('an unaccepted dependency blocks real run admission without provider calls or budget consumption', async () => {
  const s = await session(true), before = calls.length, predecessor = await create(s), dependent = await create(s, { dependency_ids: [predecessor.id] });
  await manual(s, predecessor, '前置尚未确认的人工稿', false);
  blockedBy(await currentTask(s, dependent), 'unaccepted', predecessor.id);
  blockedBy(await getTaskResult(s.userId, dependent.id), 'unaccepted', predecessor.id);
  await assertRunBlocked(s, dependent);
  assert.equal((await currentTask(s, dependent)).run_count, 0);
  assert.equal(calls.length, before);
});

test('manually accepted current head unlocks generation and never inserts predecessor body into model input', async () => {
  const s = await session(true), before = calls.length, predecessor = await create(s);
  const secret = `DO_NOT_COPY_PREDECESSOR_${uuid()}`;
  await manual(s, predecessor, secret);
  assert.equal(calls.length, before, 'manual acceptance must not need a model');
  const dependent = await create(s, { dependency_ids: [predecessor.id], prompt: '只写下游的独立说明' });
  assert.equal(stateOf(dependent).blocked, false);
  assert.ok(stateOf(dependent).signature);
  const generated = await runTask(s.userId, dependent.id);
  assert.equal(generated.status, 'needs_review');
  assert.equal(calls.length, before + 1);
  assert.ok(!JSON.stringify(calls.at(-1)).includes(secret), 'dependency verification is not an implicit context-sharing grant');
  const doc = await getTaskResult(s.userId, dependent.id);
  assert.equal(stateOf(doc).result_stale, false);
  assert.equal(stateOf(doc).signature, stateOf(generated).signature);
  await acceptTaskResultVersion(s.userId, dependent.id, acceptInput(doc));
  const legacy = await create(s);
  await manual(s, legacy, '依赖功能之前保存的独立人工稿');
  await mutate(s, data => {
    const oldTask = data.tasks.find(task => task.id === legacy.id);
    delete oldTask.dependency_ids;
    delete oldTask.dependency_revision;
    for (const version of oldTask.result_editor.versions) delete version.dependency_signature;
  });
  assert.deepEqual((await currentTask(s, legacy)).dependency_ids, []);
  assert.equal(stateOf(await getTaskResult(s.userId, legacy.id)).result_stale, false);
  await runTask(s.userId, legacy.id);
  assert.equal(calls.length, before + 2, 'tasks with no dependencies retain normal generation');
});

test('failed and unknown upstream reruns override an older accepted head; cancelled predecessors also block', async () => {
  const s = await session(true), before = calls.length;
  for (const [mode, code] of [['429', 'failed'], ['disconnect', 'outcome_unknown']]) {
    const predecessor = await create(s);
    await manual(s, predecessor, `早先验收稿 ${code}`);
    const dependent = await create(s, { dependency_ids: [predecessor.id] });
    const count = calls.length;
    behavior = mode;
    const failed = await runTask(s.userId, predecessor.id);
    behavior = 'ok';
    assert.equal(failed.status, code);
    assert.equal(calls.length, count + 1);
    blockedBy(await currentTask(s, dependent), code, predecessor.id);
    await assertRunBlocked(s, dependent);
    if (code === 'outcome_unknown') {
      const changed = await putDependencies(s, failed, depInput(failed, []));
      assert.equal(changed.status, 409, 'unknown task cannot change its dependencies');
    }
  }
  const cancelled = await create(s);
  await updateTask(s.userId, cancelled.id, { status: 'cancelled', cancel_request_id: uuid() });
  const dependent = await create(s, { dependency_ids: [cancelled.id] });
  blockedBy(dependent, 'cancelled', cancelled.id);
  await assertRunBlocked(s, dependent);
  assert.equal(calls.length, before + 2);
});

test('running predecessor blocks downstream and running dependent refuses dependency edits', async () => {
  const s = await session(true), before = calls.length, predecessor = await create(s);
  await manual(s, predecessor);
  const dependent = await create(s, { dependency_ids: [predecessor.id] });
  let offset = held.length;
  behavior = 'hold';
  let running = runTask(s.userId, predecessor.id);
  try {
    await eventually(() => held.length > offset);
    blockedBy(await currentTask(s, dependent), 'running', predecessor.id);
    await assertRunBlocked(s, dependent);
  } finally { reply(held.at(-1)); await running; behavior = 'ok'; }
  // The rerun leaves an unaccepted generated candidate behind a manual head.
  await manual(s, predecessor, '再次明确验收的当前前置正文');
  offset = held.length;
  behavior = 'hold';
  running = runTask(s.userId, dependent.id);
  try {
    await eventually(() => held.length > offset);
    const live = await currentTask(s, dependent);
    assert.equal(live.status, 'running');
    assert.equal((await putDependencies(s, live, depInput(live, []))).status, 409);
  } finally { reply(held.at(-1)); await running; behavior = 'ok'; }
  assert.equal(calls.length, before + 2);
});

test('new current head must be accepted; accepted dependency changes preserve old downstream versions but require explicit resave', async () => {
  const s = await session(true), before = calls.length, predecessor = await create(s);
  await manual(s, predecessor, '前置第一版');
  const dependent = await create(s, { dependency_ids: [predecessor.id] });
  const original = await manual(s, dependent, '必须保留的下游人工正文');
  const originalHead = original.head_version_id, originalSignature = stateOf(original).signature;
  await manual(s, predecessor, '前置第二版未验收', false);
  let doc = await getTaskResult(s.userId, dependent.id);
  blockedBy(doc, 'unaccepted', predecessor.id);
  assert.equal(stateOf(doc).result_stale, true);
  await assertRunBlocked(s, dependent);
  let upstream = await getTaskResult(s.userId, predecessor.id);
  await acceptTaskResultVersion(s.userId, predecessor.id, acceptInput(upstream));
  doc = await getTaskResult(s.userId, dependent.id);
  assert.equal(stateOf(doc).blocked, false);
  assert.equal(stateOf(doc).result_stale, true);
  assert.notEqual(stateOf(doc).signature, originalSignature);
  assert.equal(doc.accepted_version_id, originalHead, 'prior acceptance remains historical evidence');
  assert.equal(head(doc).content, '必须保留的下游人工正文');
  await assert.rejects(acceptTaskResultVersion(s.userId, dependent.id, acceptInput(doc)), error => error.status === 409);
  doc = (await saveTaskResultVersion(s.userId, dependent.id, saveInput(doc, '核对新前置后的下游正文'))).document;
  assert.equal(stateOf(doc).result_stale, false);
  doc = (await acceptTaskResultVersion(s.userId, dependent.id, acceptInput(doc))).document;
  assert.equal(doc.accepted_version_id, doc.head_version_id);
  assert.equal(doc.versions.find(version => version.id === originalHead).content, '必须保留的下游人工正文');
  assert.equal(calls.length, before);
});

test('recursive dependencies fail closed when an ancestor changes, even if the direct predecessor remains accepted', async () => {
  const s = await session(true), before = calls.length, ancestor = await create(s);
  await manual(s, ancestor, '祖先第一版');
  const middle = await create(s, { dependency_ids: [ancestor.id] });
  await manual(s, middle, '已验收中间稿');
  const leaf = await create(s, { dependency_ids: [middle.id] });
  await manual(s, leaf, '叶子已验收稿');
  await manual(s, ancestor, '祖先第二版并已验收');
  const midDoc = await getTaskResult(s.userId, middle.id);
  assert.equal(midDoc.accepted_version_id, midDoc.head_version_id);
  assert.equal(stateOf(midDoc).result_stale, true);
  const leafDoc = await getTaskResult(s.userId, leaf.id);
  blockedBy(leafDoc, 'dependency_changed');
  assert.equal(stateOf(leafDoc).result_stale, true);
  await assertRunBlocked(s, leaf);
  await assert.rejects(acceptTaskResultVersion(s.userId, leaf.id, acceptInput(leafDoc)), error => error.status === 409);
  await manual(s, middle, '重新核对祖先的中间稿');
  assert.equal(stateOf(await currentTask(s, leaf)).blocked, false);
  assert.equal(stateOf(await getTaskResult(s.userId, leaf.id)).result_stale, true);
  assert.equal(calls.length, before);
});

test('source edits, removed source messages and deleted predecessors invalidate dependency eligibility', async () => {
  const s = await session(true), before = calls.length, messageId = uuid();
  await mutate(s, data => appendFixtureMessages(data, { id: messageId, group_id: 'group-presidential', sender_type: 'user', sender_id: s.userId, content: '约定10月20日', revision: 1 }));
  const predecessor = await create(s, { group_id: 'group-presidential' });
  await manual(s, predecessor, '基于旧日期的已验收稿');
  const dependent = await create(s, { dependency_ids: [predecessor.id] });
  await mutate(s, data => Object.assign(data.messages.find(message => message.id === messageId), { content: '日期改为10月22日', revision: 2 }));
  blockedBy(await currentTask(s, dependent), 'source_changed', predecessor.id);
  await assertRunBlocked(s, dependent);
  const changed = await getTaskResult(s.userId, predecessor.id);
  await manual(s, predecessor, '已核对10月22日', true, { reviewed_source_hash: changed.source.hash });
  assert.equal(stateOf(await currentTask(s, dependent)).blocked, false);
  await mutate(s, data => { data.messages = data.messages.filter(message => message.id !== messageId); });
  blockedBy(await currentTask(s, dependent), 'source_changed', predecessor.id);
  await assertRunBlocked(s, dependent);
  await deleteTask(s.userId, predecessor.id);
  const missing = await currentTask(s, dependent);
  assert.deepEqual(missing.dependency_ids, [predecessor.id], 'deletion must not silently drop a dependency');
  blockedBy(missing, 'missing', predecessor.id);
  await assertRunBlocked(s, dependent);
  assert.equal(calls.length, before);
});

test('dependency edit invalidates a previously accepted result, including removal of all prerequisites', async () => {
  const s = await session(), before = calls.length, predecessor = await create(s);
  await manual(s, predecessor);
  const dependent = await create(s, { dependency_ids: [predecessor.id] });
  const old = await manual(s, dependent, '以原前置为依据的已验收稿');
  const removed = await putDependencies(s, dependent, depInput(dependent, []));
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.task.dependency_ids, []);
  let doc = await getTaskResult(s.userId, dependent.id);
  assert.equal(stateOf(doc).blocked, false);
  assert.equal(stateOf(doc).result_stale, true);
  assert.equal(doc.accepted_version_id, old.accepted_version_id);
  await assert.rejects(acceptTaskResultVersion(s.userId, dependent.id, acceptInput(doc)), error => error.status === 409);
  doc = (await saveTaskResultVersion(s.userId, dependent.id, saveInput(doc, '明确采用无前置的新稿'))).document;
  assert.equal(stateOf(doc).result_stale, false);
  await acceptTaskResultVersion(s.userId, dependent.id, acceptInput(doc));
  assert.equal(calls.length, before);
});

// Concurrency around the actual paid dispatch boundary and result commit.
test('dependency is rechecked immediately before dispatch and a changed signature spends no provider call or paid slot', async () => {
  const s = await session(true), before = calls.length, predecessor = await create(s);
  await manual(s, predecessor, '准入时前置');
  const dependent = await create(s, { dependency_ids: [predecessor.id] }), oldBudget = await budget(s);
  const originalRead = s.db.read.bind(s.db);
  let entered = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  s.db.read = async (...args) => {
    if (!entered && s.db.data.tasks?.some(task => task.id === dependent.id && task.status === 'running')) {
      entered = true;
      await gate;
    }
    return originalRead(...args);
  };
  const running = runTask(s.userId, dependent.id);
  try {
    await eventually(() => entered, 'generation never reached post-admission read');
    await manual(s, predecessor, '派发前已经更新并验收的前置');
  } finally { release(); }
  let result;
  try { result = await running; }
  finally { s.db.read = originalRead; }
  assert.equal(result.status, 'failed');
  assert.equal(result.history.at(-1).dispatch_status, 'not_sent');
  assert.match(result.error, /未发送模型请求/);
  assert.doesNotMatch(result.error, /已发出的模型请求/);
  assert.equal(calls.length, before);
  assert.equal(await budget(s), oldBudget, 'dependency-rejected dispatch must release its reserved slot');
});

test('dependency changes during a held provider response keep generated evidence stale and cannot be accepted or adopted into freshness', async () => {
  const s = await session(true), before = calls.length, predecessor = await create(s);
  await manual(s, predecessor, '发出请求时前置版本');
  const dependent = await create(s, { dependency_ids: [predecessor.id] }), heldBefore = held.length;
  behavior = 'hold';
  const running = runTask(s.userId, dependent.id);
  try {
    await eventually(() => held.length > heldBefore);
    await manual(s, predecessor, '等待响应时更新并验收的前置');
  } finally { reply(held.at(-1), '必须保留但不能直接验收的旧依据生成稿'); await running; behavior = 'ok'; }
  let doc = await getTaskResult(s.userId, dependent.id);
  assert.equal(calls.length, before + 1, 'already dispatched request cannot be retracted or silently repeated');
  assert.equal(stateOf(doc).blocked, false);
  assert.equal(stateOf(doc).result_stale, true);
  assert.match(head(doc).content, /必须保留/);
  const legacyAccept = await request.post(`/api/tasks/${dependent.id}/accept`).set('Cookie', s.cookie).send({ run_id: head(doc).run_id });
  assert.equal(legacyAccept.status, 409, 'legacy run acceptance must not bypass the dependency signature guard');
  await assert.rejects(acceptTaskResultVersion(s.userId, dependent.id, acceptInput(doc)), error => error.status === 409);
  // Explicit adoption is allowed as an editing choice, but cannot stamp a new
  // dependency signature onto an old generated version.
  const adopted = await Promise.allSettled([adoptTaskResultVersion(s.userId, dependent.id, { client_request_id: uuid(), expected_revision: doc.revision, version_id: doc.head_version_id })]);
  if (adopted[0].status === 'fulfilled') {
    doc = adopted[0].value.document;
    assert.equal(stateOf(doc).result_stale, true);
  } else assert.equal(adopted[0].reason.status, 409);
  doc = (await saveTaskResultVersion(s.userId, dependent.id, saveInput(doc, '用户明确复核后保存的新版本'))).document;
  assert.equal(stateOf(doc).result_stale, false);
  await acceptTaskResultVersion(s.userId, dependent.id, acceptInput(doc));
  assert.equal(calls.length, before + 1);
});

test('blocked automatic task does not starve a later eligible due task', async () => {
  const s = await session(true), before = calls.length, run_at = new Date(Date.now() - 1000).toISOString();
  const predecessor = await create(s), blocked = await create(s, { dependency_ids: [predecessor.id], auto_run: true, run_at });
  const eligible = await create(s, { auto_run: true, run_at, prompt: '后续应如期执行的任务' });
  await tickTasks();
  assert.equal((await currentTask(s, blocked)).run_count, 0);
  assert.equal((await currentTask(s, eligible)).run_count, 1);
  assert.equal(calls.length, before + 1);
  assert.match(JSON.stringify(calls.at(-1)), /后续应如期执行的任务/);
  assert.equal(await budget(s), 1);
  const cooling = await currentTask(s, blocked);
  assert.ok(Date.parse(cooling.dependency_retry_at) > Date.now(), 'blocked scheduler task needs a persisted retry delay');
  await tickTasks();
  assert.equal(calls.length, before + 1, 'immediate second scheduler tick must not spin or repeat dispatch');
  await manual(s, predecessor, '冷却后已完成并验收的前置');
  await mutate(s, data => { data.tasks.find(task => task.id === blocked.id).dependency_retry_at = new Date(Date.now() - 1).toISOString(); });
  await tickTasks();
  assert.equal((await currentTask(s, blocked)).run_count, 1);
  assert.equal(calls.length, before + 2, 'satisfied task resumes once at an eligible later tick');
  assert.equal(await budget(s), 2);
});

test('lost dependency write acknowledgement recovers the original receipt and pre-commit failure leaves no phantom mutation', async () => {
  const s = await session(), before = calls.length, predecessor = await create(s), target = await create(s);
  const body = depInput(target, [predecessor.id]), originalWrite = s.db.write.bind(s.db);
  let loseAck = true;
  s.db.write = async () => { await originalWrite(); if (loseAck) { loseAck = false; throw new Error('dependency ACK lost after disk commit'); } };
  let uncertain;
  try { uncertain = await putDependencies(s, target, body); }
  finally { s.db.write = originalWrite; }
  assert.equal(uncertain.status, 503, 'uncertain storage must not masquerade as successful acknowledgement');
  clearUserDbCache(s.userId);
  const recovered = await receipt(s, target, body.client_request_id);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.deepEqual(recovered.body.task.dependency_ids, [predecessor.id]);
  assert.equal(recovered.body.receipt.committed_revision, 1);
  assert.deepEqual((await putDependencies(s, target, body)).body.receipt, recovered.body.receipt);
  assert.equal((await putDependencies(s, target, depInput(target, [], { client_request_id: uuid() }))).status, 409, 'new ID cannot overwrite a committed change using stale revision');
  s.db = await getUserDb(s.userId);
  const write = s.db.write.bind(s.db), failed = depInput(recovered.body.task, []);
  s.db.write = async () => { throw new Error('dependency write failed before commit'); };
  try { assert.equal((await putDependencies(s, target, failed)).status, 503); }
  finally { s.db.write = write; }
  assert.equal((await receipt(s, target, failed.client_request_id)).status, 404);
  assert.deepEqual((await currentTask(s, target)).dependency_ids, [predecessor.id]);
  assert.equal((await currentTask(s, target)).dependency_revision, 1);
  assert.equal(calls.length, before);
});

test('fresh process reconstructs dependency staleness and command receipts without dispatching after cache eviction', async () => {
  const s = await session(true), before = calls.length, ancestor = await create(s), dependent = await create(s);
  await manual(s, ancestor, '进程重开前的第一版');
  const command = depInput(dependent, [ancestor.id]);
  const saved = await putDependencies(s, dependent, command);
  assert.equal(saved.status, 200);
  const previous = await manual(s, dependent, '进程重开仍须保留的下游正文');
  await manual(s, ancestor, '进程重开前的未验收新版本', false);
  clearUserDbCache(s.userId);
  assert.equal(stateOf(await getTaskResult(s.userId, dependent.id)).result_stale, true);
  const script = `
    const { initDatabase } = await import(${JSON.stringify(new URL('../src/models/db.js', import.meta.url).href)});
    const { initAuthDb } = await import(${JSON.stringify(new URL('../src/models/authDb.js', import.meta.url).href)});
    const { createTestApp } = await import(${JSON.stringify(new URL('./helpers/createTestApp.js', import.meta.url).href)});
    const { default: supertest } = await import('supertest');
    await initDatabase(); await initAuthDb();
    const request = supertest(createTestApp());
    const cookie = ${JSON.stringify(s.cookie)};
    const taskId = ${JSON.stringify(dependent.id)};
    const list = await request.get('/api/tasks').set('Cookie', cookie);
    const doc = await request.get('/api/tasks/' + taskId + '/result').set('Cookie', cookie);
    const receipt = await request.get('/api/tasks/' + taskId + '/dependencies/commands/' + ${JSON.stringify(command.client_request_id)}).set('Cookie', cookie);
    const run = await request.post('/api/tasks/' + taskId + '/run').set('Cookie', cookie).send({ client_request_id: ${JSON.stringify(uuid())} });
    console.log('DEPENDENCY_REOPEN_RESULT=' + JSON.stringify({ task: list.body.find(t => t.id === taskId), document: doc.body, receiptStatus: receipt.status, receipt: receipt.body.receipt, runStatus: run.status }));
    if (process.env.SUPABASE_DB_URL) { const { closeSupabaseConnection } = await import('./src/models/supabaseAdapter.js'); await closeSupabaseConnection(); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), env: { ...process.env }, timeout: 15000, maxBuffer: 1024 * 1024
  });
  const line = stdout.split('\n').find(value => value.startsWith('DEPENDENCY_REOPEN_RESULT='));
  assert.ok(line, stdout);
  const reopened = JSON.parse(line.slice('DEPENDENCY_REOPEN_RESULT='.length));
  blockedBy(reopened.task, 'unaccepted', ancestor.id);
  assert.equal(stateOf(reopened.document).result_stale, true);
  assert.equal(reopened.document.accepted_version_id, previous.accepted_version_id);
  assert.equal(head(reopened.document).content, '进程重开仍须保留的下游正文');
  assert.equal(reopened.receiptStatus, 200);
  assert.deepEqual(reopened.receipt, saved.body.receipt);
  assert.equal(reopened.runStatus, 409);
  assert.equal(calls.length, before);
  assert.equal(await budget(s), 0);
});

test('corrupt persisted dependency graph fails closed instead of recursion, cross-account access or provider dispatch', async () => {
  const s = await session(true), before = calls.length, a = await create(s), b = await create(s);
  await manual(s, a, '原本合法的A稿');
  await manual(s, b, '原本合法的B稿');
  await mutate(s, data => {
    data.tasks.find(task => task.id === a.id).dependency_ids = [b.id];
    data.tasks.find(task => task.id === b.id).dependency_ids = [a.id];
  });
  clearUserDbCache(s.userId);
  const tasks = await request.get('/api/tasks').set('Cookie', s.cookie);
  assert.equal(tasks.status, 200, 'invalid graph is a blocked projection, not stack overflow');
  blockedBy(tasks.body.find(task => task.id === a.id), 'invalid');
  await assertRunBlocked(s, a);
  assert.equal(calls.length, before);
});


test('exactly 32 owned prerequisites are supported and do not dispatch while unaccepted', async () => {
  const s = await session(true), before = calls.length, ids = [];
  for (let index = 0; index < 32; index++) ids.push((await create(s, { title: `前置 ${index + 1}` })).id);
  const result = await request.post('/api/tasks').set('Cookie', s.cookie).send(input({ dependency_ids: ids }));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.deepEqual(result.body.dependency_ids, ids);
  assert.equal(stateOf(result.body).reasons.length, 32);
  await assertRunBlocked(s, result.body);
  assert.equal(calls.length, before);
});

test('manual save preserves writing during dependency blockage but cannot certify it before an explicit later resave', async () => {
  const s = await session(true), before = calls.length, predecessor = await create(s);
  await manual(s, predecessor, '保存时可用的前置');
  const dependent = await create(s, { dependency_ids: [predecessor.id] });
  const original = await manual(s, dependent, '已验收且必须保留的正文');
  const attemptedSave = saveInput(original, '前置变化期间仍需保留的人工文字');
  await manual(s, predecessor, '尚未验收的新前置', false);
  await assert.rejects(acceptTaskResultVersion(s.userId, dependent.id, acceptInput(original)), error => error.status === 409);
  await assert.rejects(saveTaskResultVersion(s.userId, dependent.id, attemptedSave), error => error.status === 409 && error.code === 'TASK_DEPENDENCY_CHANGED');
  const blockedDocument = await getTaskResult(s.userId, dependent.id);
  let saved = (await saveTaskResultVersion(s.userId, dependent.id, saveInput(blockedDocument, attemptedSave.content))).document;
  assert.equal(saved.versions.length, original.versions.length + 1);
  assert.equal(saved.accepted_version_id, original.accepted_version_id);
  assert.equal(head(saved).content, attemptedSave.content);
  assert.equal(saved.versions.find(version => version.id === original.head_version_id).content, '已验收且必须保留的正文');
  blockedBy(saved, 'unaccepted', predecessor.id);
  assert.equal(stateOf(saved).result_stale, true);
  await assert.rejects(acceptTaskResultVersion(s.userId, dependent.id, acceptInput(saved)), error => error.status === 409);
  await assertRunBlocked(s, dependent);
  const upstream = await getTaskResult(s.userId, predecessor.id);
  await acceptTaskResultVersion(s.userId, predecessor.id, acceptInput(upstream));
  saved = await getTaskResult(s.userId, dependent.id);
  assert.equal(stateOf(saved).blocked, false);
  assert.equal(stateOf(saved).result_stale, true, 'a blocked save cannot become verified just because its prerequisite later completes');
  await assert.rejects(acceptTaskResultVersion(s.userId, dependent.id, acceptInput(saved)), error => error.status === 409);
  saved = (await saveTaskResultVersion(s.userId, dependent.id, saveInput(saved, attemptedSave.content))).document;
  assert.equal(stateOf(saved).result_stale, false);
  await acceptTaskResultVersion(s.userId, dependent.id, acceptInput(saved));
  assert.equal(calls.length, before);
});

test('persisted foreign references and altered accepted content cannot unlock generation or expose another account', async () => {
  const alice = await session(true), bob = await session(), before = calls.length;
  const foreign = await create(bob, { title: 'BOB_PRIVATE_DEPENDENCY_TITLE' });
  await manual(bob, foreign, 'BOB_PRIVATE_ACCEPTED_CONTENT');
  const target = await create(alice);
  await mutate(alice, data => { data.tasks.find(task => task.id === target.id).dependency_ids = [foreign.id]; });
  const isolated = await currentTask(alice, target);
  blockedBy(isolated, 'missing', foreign.id);
  assert.doesNotMatch(JSON.stringify(isolated), /BOB_PRIVATE/);
  const document = await getTaskResult(alice.userId, target.id);
  assert.doesNotMatch(JSON.stringify(document), /BOB_PRIVATE/);
  await assertRunBlocked(alice, target);
  const predecessor = await create(alice);
  await manual(alice, predecessor, '内容hash被篡改之前的已验收正文');
  const dependent = await create(alice, { dependency_ids: [predecessor.id] });
  await mutate(alice, data => {
    const task = data.tasks.find(task => task.id === predecessor.id);
    const version = task.result_editor.versions.find(item => item.id === task.result_editor.head_version_id);
    version.content = '篡改存储正文而保留旧的验收hash';
  });
  blockedBy(await currentTask(alice, dependent), 'invalid', predecessor.id);
  await assertRunBlocked(alice, dependent);
  assert.equal(calls.length, before);
});


test('manual result save requires the dependency signature actually reviewed by the client, including after dependencies are removed', async () => {
  const s = await session(true), before = calls.length, predecessor = await create(s);
  await manual(s, predecessor, '客户端打开前已验收的前置');
  const dependent = await create(s, { dependency_ids: [predecessor.id] });
  const oldDocument = await getTaskResult(s.userId, dependent.id);
  const missing = saveInput(oldDocument, '没有证明复核依据的正文');
  delete missing.reviewed_dependency_signature;
  await assert.rejects(saveTaskResultVersion(s.userId, dependent.id, missing), error => error.status === 409 && error.code === 'TASK_DEPENDENCY_REVIEW_REQUIRED');
  const staleCommand = saveInput(oldDocument, '基于客户端旧视图填写的正文');
  await manual(s, predecessor, '客户端尚未见过但已验收的新前置');
  await assert.rejects(saveTaskResultVersion(s.userId, dependent.id, staleCommand), error => error.status === 409 && error.code === 'TASK_DEPENDENCY_CHANGED');
  const latest = await getTaskResult(s.userId, dependent.id);
  assert.equal(latest.versions.length, 0);
  assert.notEqual(stateOf(latest).signature, stateOf(oldDocument).signature);
  const saved = (await saveTaskResultVersion(s.userId, dependent.id, saveInput(latest, '用户明确核对当前前置后保存'))).document;
  assert.equal(stateOf(saved).result_stale, false);
  await acceptTaskResultVersion(s.userId, dependent.id, acceptInput(saved));
  const removed = await putDependencies(s, dependent, depInput(dependent, []));
  assert.equal(removed.status, 200);
  const noDependencies = await getTaskResult(s.userId, dependent.id);
  const unreviewedRemoval = saveInput(noDependencies, '尚未确认取消前置依据');
  delete unreviewedRemoval.reviewed_dependency_signature;
  await assert.rejects(saveTaskResultVersion(s.userId, dependent.id, unreviewedRemoval), error => error.status === 409 && error.code === 'TASK_DEPENDENCY_REVIEW_REQUIRED');
  const reviewedRemoval = (await saveTaskResultVersion(s.userId, dependent.id, saveInput(noDependencies, '已明确核对不再依赖前置'))).document;
  assert.equal(stateOf(reviewedRemoval).result_stale, false);
  await acceptTaskResultVersion(s.userId, dependent.id, acceptInput(reviewedRemoval));
  assert.equal(calls.length, before);
});


const closeDependencies = (s, task, requestId) => request.post(`${depPath(task)}/commands/${requestId}/close`).set('Cookie', s.cookie).send({});

test('closing an absent dependency intent fences its delayed PUT and preserves a recoverable cancelled receipt', async () => {
  const s = await session(), before = calls.length, predecessor = await create(s), target = await create(s);
  const body = depInput(target, [predecessor.id]);
  const closed = await closeDependencies(s, target, body.client_request_id);
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.headers['cache-control'], 'no-store');
  assert.equal(closed.body.receipt.id, body.client_request_id);
  assert.equal(closed.body.receipt.operation, 'dependencies');
  assert.equal(closed.body.receipt.task_id, target.id);
  assert.equal(closed.body.receipt.status, 'cancelled');
  assert.equal(closed.body.receipt.committed_revision, null);
  assert.deepEqual(closed.body.task.dependency_ids, []);
  assert.equal(closed.body.task.dependency_revision, 0);
  clearUserDbCache(s.userId);
  assert.deepEqual((await closeDependencies(s, target, body.client_request_id)).body.receipt, closed.body.receipt);
  assert.deepEqual((await receipt(s, target, body.client_request_id)).body.receipt, closed.body.receipt);
  const late = await putDependencies(s, target, body);
  assert.equal(late.status, 410);
  assert.equal(late.body.code, 'TASK_DEPENDENCY_COMMAND_CLOSED');
  assert.deepEqual((await currentTask(s, target)).dependency_ids, []);
  assert.equal((await currentTask(s, target)).dependency_revision, 0);
  const deliberateNewIntent = await putDependencies(s, target, depInput(target, [predecessor.id]));
  assert.equal(deliberateNewIntent.status, 200);
  assert.equal(deliberateNewIntent.body.task.dependency_revision, 1);
  assert.equal(calls.length, before);
});

test('closing an already committed dependency command returns its success and never revokes the committed graph', async () => {
  const s = await session(), before = calls.length, predecessor = await create(s), target = await create(s);
  const body = depInput(target, [predecessor.id]);
  const saved = await putDependencies(s, target, body);
  assert.equal(saved.status, 200);
  const closed = await closeDependencies(s, target, body.client_request_id);
  assert.equal(closed.status, 200);
  assert.deepEqual(closed.body.receipt, saved.body.receipt);
  assert.equal(closed.body.receipt.status, 'succeeded');
  assert.deepEqual(closed.body.task.dependency_ids, [predecessor.id]);
  assert.equal(closed.body.task.dependency_revision, 1);
  clearUserDbCache(s.userId);
  assert.deepEqual((await putDependencies(s, target, body)).body.receipt, saved.body.receipt);
  assert.equal((await currentTask(s, target)).dependency_revision, 1);
  assert.equal(calls.length, before);
});

test('dependency close acknowledgement loss and pre-commit write failure are recovered with the same intent', async () => {
  const s = await session(), before = calls.length, predecessor = await create(s), target = await create(s);
  const body = depInput(target, [predecessor.id]), originalWrite = s.db.write.bind(s.db);
  let loseAck = true;
  s.db.write = async () => { await originalWrite(); if (loseAck) { loseAck = false; throw new Error('dependency close ACK lost'); } };
  try { assert.equal((await closeDependencies(s, target, body.client_request_id)).status, 503); }
  finally { s.db.write = originalWrite; }
  clearUserDbCache(s.userId);
  const recovered = await receipt(s, target, body.client_request_id);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.receipt.status, 'cancelled');
  assert.equal(recovered.body.receipt.committed_revision, null);
  assert.deepEqual((await closeDependencies(s, target, body.client_request_id)).body.receipt, recovered.body.receipt);
  assert.equal((await putDependencies(s, target, body)).status, 410);
  s.db = await getUserDb(s.userId);
  const write = s.db.write.bind(s.db), second = depInput(target, [predecessor.id]);
  s.db.write = async () => { throw new Error('dependency close write failed before commit'); };
  try { assert.equal((await closeDependencies(s, target, second.client_request_id)).status, 503); }
  finally { s.db.write = write; }
  assert.equal((await receipt(s, target, second.client_request_id)).status, 404);
  const retried = await closeDependencies(s, target, second.client_request_id);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.receipt.status, 'cancelled');
  assert.equal((await putDependencies(s, target, second)).status, 410);
  assert.deepEqual((await currentTask(s, target)).dependency_ids, []);
  assert.equal((await currentTask(s, target)).dependency_revision, 0);
  assert.equal(calls.length, before);
});

test('dependency close validates payload and binds receipts to both account and task', async () => {
  const alice = await session(), bob = await session(), before = calls.length;
  const target = await create(alice, { title: 'ALICE_PRIVATE_CLOSE_TITLE' }), other = await create(alice), foreign = await create(bob), requestId = uuid();
  await manual(alice, target, 'ALICE_PRIVATE_CLOSE_BODY');
  const foreignIntent = uuid(), isolated = await closeDependencies(bob, target, foreignIntent);
  assert.equal(isolated.status, 200, 'closing an unknown task intent only fences the caller account');
  assert.equal(isolated.body.receipt.status, 'cancelled');
  assert.equal(isolated.body.receipt.task_id, target.id);
  assert.equal(isolated.body.receipt.committed_revision, null);
  assert.equal(isolated.body.task, null);
  assert.doesNotMatch(JSON.stringify(isolated.body), /ALICE_PRIVATE_CLOSE/);
  assert.equal((await receipt(alice, target, foreignIntent)).status, 404);
  assert.equal((await currentTask(alice, target)).dependency_revision, 0);
  assert.equal(head(await getTaskResult(alice.userId, target.id)).content, 'ALICE_PRIVATE_CLOSE_BODY');
  assert.equal((await closeDependencies(alice, target, 'not-a-uuid')).status, 400);
  assert.equal((await request.post(`${depPath(target)}/commands/${requestId}/close`).set('Cookie', alice.cookie).send({ force: true })).status, 400);
  assert.equal((await request.post(`${depPath(target)}/commands/${requestId}/close`).set('Cookie', bob.cookie).set('X-Expected-User-Id', alice.userId).send({})).status, 409);
  const closed = await closeDependencies(alice, target, requestId);
  assert.equal(closed.status, 200);
  assert.equal((await closeDependencies(alice, other, requestId)).status, 409);
  assert.equal((await putDependencies(alice, other, depInput(other, [], { client_request_id: requestId }))).status, 409);
  assert.equal((await receipt(alice, other, requestId)).status, 404);
  assert.equal((await receipt(bob, target, requestId)).status, 404);
  const independent = await closeDependencies(bob, foreign, requestId);
  assert.equal(independent.status, 200);
  assert.equal(independent.body.receipt.task_id, foreign.id);
  assert.equal(independent.body.receipt.status, 'cancelled');
  assert.equal((await currentTask(alice, target)).dependency_revision, 0);
  assert.equal((await currentTask(bob, foreign)).dependency_revision, 0);
  assert.equal(calls.length, before);
});

// JSON-file locks are deliberately process-local. Exercise independent stale
// process snapshots against actual PgLow compare-and-swap persistence.
if (process.env.SUPABASE_DB_URL) {
  async function raceProcesses(s, operations) {
    const workers = operations.map(({ task, body }) => {
      const script = `
        const { initDatabase, getUserDb } = await import('./src/models/db.js');
        const { updateTaskDependencies } = await import('./src/services/tasks.js');
        const { closeSupabaseConnection } = await import('./src/models/supabaseAdapter.js');
        const userId = ${JSON.stringify(s.userId)};
        try {
          await initDatabase();
          const db = await getUserDb(userId); await db.read({ force: true });
          const gate = new Promise(resolve => process.stdin.once('data', resolve));
          console.log('DEPENDENCY_WORKER_READY');
          await gate;
          try {
            const response = await updateTaskDependencies(userId, ${JSON.stringify(task.id)}, ${JSON.stringify(body)});
            console.log('DEPENDENCY_WORKER_RESULT=' + JSON.stringify({ status: 200, response }));
          } catch (error) {
            console.log('DEPENDENCY_WORKER_RESULT=' + JSON.stringify({ status: error.status || error.statusCode || 500, code: error.code, message: error.message }));
          }
        } finally { process.stdin.destroy(); await closeSupabaseConnection(); }
      `;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '', stderr = '', ready = false;
      child.stdout.on('data', data => { stdout += data; ready ||= stdout.includes('DEPENDENCY_WORKER_READY\n'); });
      child.stderr.on('data', data => { stderr += data; });
      const completion = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code !== 0) { reject(new Error(`dependency worker failed (${code || signal}): ${stderr}\n${stdout}`)); return; }
          const line = stdout.split('\n').find(value => value.startsWith('DEPENDENCY_WORKER_RESULT='));
          if (!line) { reject(new Error(`dependency worker omitted result: ${stderr}\n${stdout}`)); return; }
          try { resolve(JSON.parse(line.slice('DEPENDENCY_WORKER_RESULT='.length))); }
          catch (error) { reject(error); }
        });
      });
      // Attach rejection handling before readiness waits, so early process
      // failure is reported by the test rather than as an unhandled rejection.
      completion.catch(() => {});
      return { child, completion, isReady: () => ready };
    });
    const timeout = setTimeout(() => { for (const worker of workers) worker.child.kill('SIGKILL'); }, 20000);
    try {
      await Promise.race([
        eventually(() => workers.every(worker => worker.isReady()), 'independent PgLow workers never loaded their pre-race snapshots'),
        Promise.all(workers.map(worker => worker.completion)).then(() => { throw new Error('workers finished before the shared release gate'); })
      ]);
      assert.equal(new Set(workers.map(worker => worker.child.pid)).size, operations.length);
      for (const worker of workers) worker.child.stdin.end('go\n');
      return await Promise.all(workers.map(worker => worker.completion));
    } finally {
      clearTimeout(timeout);
      for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
      await Promise.allSettled(workers.map(worker => worker.completion));
    }
  }

  test('real PgLow independent processes cannot commit simultaneous opposite edges into a cycle', { timeout: 30000 }, async () => {
    const s = await session(true), before = calls.length, a = await create(s), b = await create(s);
    const operations = [{ task: a, body: depInput(a, [b.id]) }, { task: b, body: depInput(b, [a.id]) }];
    const results = await raceProcesses(s, operations);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409], JSON.stringify(results));
    assert.ok(['TASK_DEPENDENCY_CYCLE', 'TASK_DEPENDENCY_REVISION_CONFLICT'].includes(results.find(result => result.status === 409).code), JSON.stringify(results));
    clearUserDbCache(s.userId);
    const all = await listTasks(s.userId);
    assert.equal(all.find(task => task.id === a.id).dependency_ids.length + all.find(task => task.id === b.id).dependency_ids.length, 1);
    for (const [index, operation] of operations.entries()) {
      const lookup = await receipt(s, operation.task, operation.body.client_request_id);
      assert.equal(lookup.status, results[index].status === 200 ? 200 : 404);
      if (lookup.status === 200) assert.deepEqual(lookup.body.receipt, results[index].response.receipt);
    }
    assert.equal(await budget(s), 0);
    assert.equal(calls.length, before);
  });

  test('real PgLow independent processes compare dependency revision and persist exactly one winning command', { timeout: 30000 }, async () => {
    const s = await session(true), before = calls.length, left = await create(s), right = await create(s), target = await create(s);
    const operations = [{ task: target, body: depInput(target, [left.id]) }, { task: target, body: depInput(target, [right.id]) }];
    const results = await raceProcesses(s, operations);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409], JSON.stringify(results));
    assert.equal(results.find(result => result.status === 409).code, 'TASK_DEPENDENCY_REVISION_CONFLICT');
    const winner = results.findIndex(result => result.status === 200);
    clearUserDbCache(s.userId);
    const current = await currentTask(s, target);
    assert.equal(current.dependency_revision, 1);
    assert.deepEqual(current.dependency_ids, operations[winner].body.dependency_ids);
    const replay = await putDependencies(s, target, operations[winner].body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.receipt, results[winner].response.receipt);
    assert.equal(replay.body.task.dependency_revision, 1);
    assert.equal((await receipt(s, target, operations[1 - winner].body.client_request_id)).status, 404);
    assert.equal(await budget(s), 0);
    assert.equal(calls.length, before);
  });
}
