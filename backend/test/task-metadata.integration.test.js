import { initializeAccountStoreFixture } from './helpers/accountStoreFixtures.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Synthetic accounts, disk/SQL persistence and real Express HTTP only. Core
// metadata tests configure no provider. The separate repeat-scheduling test
// uses one counted loopback completion; metadata itself must never dispatch.
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-metadata-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
const { initDatabase, createNewUserDatabase, getUserDb, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { createTask, listTasks, runTask, updateTask, updateTaskMetadata, deleteTask, startTaskScheduler, stopTaskScheduler, tickTasks } = await import('../src/services/tasks.js');
const { getTaskResult, saveTaskResultVersion, acceptTaskResultVersion, rebaseTaskBrief } = await import('../src/services/taskResults.js');
await initializeAccountStoreFixture(); await initDatabase(); await initAuthDb();
const server = createServer(createTestApp());
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const request = (await import('supertest')).default(server);
after(async () => {
  stopTaskScheduler(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (process.env.SUPABASE_DB_URL) await (await import('../src/models/supabaseAdapter.js')).closeSupabaseConnection();
});
const uuid = () => randomUUID();
const create = (s, extra = {}) => createTask(s.userId, { title: '合成元数据任务', prompt: '无需模型的人工作品', run_at: '2030-01-02T03:00:00.000Z', ...extra });
const route = task => `/api/tasks/${task.id}/metadata`;
const body = (task, changes, extra = {}) => ({ client_request_id: uuid(), expected_revision: task.metadata_revision, changes, ...extra });
const put = (s, task, payload) => request.put(route(task)).set('Cookie', s.cookie).set('X-Expected-User-Id', s.userId).send(payload);
const lookup = (s, task, id) => request.get(`${route(task)}/commands/${id}`).set('Cookie', s.cookie).set('X-Expected-User-Id', s.userId);
const close = (s, task, id) => request.post(`${route(task)}/commands/${id}/close`).set('Cookie', s.cookie).set('X-Expected-User-Id', s.userId).send({});
const current = async (s, task) => (await listTasks(s.userId)).find(item => item.id === task.id);
async function session() {
  const userId = uuid(), token = generateSessionToken(), db = await createNewUserDatabase(userId);
  if (!process.env.SUPABASE_DB_URL) await provisionNewLocalMemoryAccount(userId, db);
  const auth = getAuthDb(); await auth.read();
  auth.data.users.push({ id: userId, username: userId, password: 'unused' });
  auth.data.sessions.push({ token, userId, expires_at: new Date(Date.now() + 3600000).toISOString() }); await auth.write();
  return { userId, db, cookie: `session_token=${token}` };
}
async function mutate(s, fn) {
  await withWriteLock(s.userId, async () => {
    s.db = await getUserDb(s.userId); await s.db.read({ force: true }); fn(s.db.data); await s.db.write();
  });
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, message, timeout = 12000) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function expectError(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (code) assert.equal(response.body.code, code, JSON.stringify(response.body));
}
async function assertNoDispatch(s) {
  const db = await getUserDb(s.userId); await db.read({ force: true });
  assert.equal(db.data.taskDailyBudget?.count || 0, 0);
  for (const task of db.data.tasks || []) assert.equal(task.run_count || 0, 0);
}

// Hold the tail of an actual incoming request body. The older client has
// already opened its HTTP connection when the newer client's PUT commits.
function delayedPut(s, task, payload) {
  const encoded = JSON.stringify(payload), gate = Math.floor(encoded.length / 2);
  let connection;
  const response = new Promise((resolve, reject) => {
    connection = httpRequest({ host: '127.0.0.1', port: server.address().port, path: route(task), method: 'PUT', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded), Cookie: s.cookie, 'X-Expected-User-Id': s.userId
    } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', x => { text += x; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); });
    connection.on('error', reject); connection.write(encoded.slice(0, gate));
  });
  response.catch(() => {});
  return { response, release: () => connection.end(encoded.slice(gate)), destroy: () => connection.destroy() };
}

for (const sample of [
  { field: 'title', older: '迟到的旧标题', newer: '更新的明确标题' },
  { field: 'auto_run', older: true, newer: false },
  { field: 'run_at', older: '2031-01-02T03:00:00.000Z', newer: '2032-01-02T03:00:00.000Z' },
  { field: 'priority', older: 'high', newer: 'low' },
  { field: 'estimated_minutes', older: 120, newer: 0 }
]) test(`real delayed HTTP ${sample.field} intent cannot overwrite the newer explicit decision`, async () => {
  const s = await session(), task = await create(s), old = body(task, { [sample.field]: sample.older });
  const pending = delayedPut(s, task, old);
  try {
    const newer = await put(s, task, body(task, { [sample.field]: sample.newer }));
    expectError(newer, 200); assert.equal(newer.body.task.metadata_revision, 1);
    pending.release(); expectError(await pending.response, 409, 'TASK_METADATA_REVISION_CONFLICT');
    const latest = await current(s, task);
    assert.equal(latest[sample.field], sample.newer); assert.equal(latest.metadata_revision, 1);
    expectError(await lookup(s, task, old.client_request_id), 404, 'TASK_METADATA_COMMAND_NOT_FOUND');
    await assertNoDispatch(s);
  } finally { pending.destroy(); }
});

test('legacy task reads project revision zero without a storage migration', async () => {
  const s = await session(), task = await create(s);
  await mutate(s, data => { delete data.tasks.find(item => item.id === task.id).metadata_revision; });
  const original = s.db.write.bind(s.db); let writes = 0;
  s.db.write = async (...args) => { writes++; return original(...args); };
  try {
    const response = await request.get('/api/tasks').set('Cookie', s.cookie);
    expectError(response, 200); assert.equal(response.body.find(item => item.id === task.id).metadata_revision, 0);
    assert.equal((await current(s, task)).metadata_revision, 0);
    expectError(await lookup(s, task, uuid()), 404, 'TASK_METADATA_COMMAND_NOT_FOUND');
    assert.equal(writes, 0, 'public projections must not persist a migration');
    assert.equal(Object.hasOwn(s.db.data.tasks.find(item => item.id === task.id), 'metadata_revision'), false);
  } finally { s.db.write = original; }
  const first = await put(s, task, body({ ...task, metadata_revision: 0 }, { title: '旧任务首次明确修改' }));
  expectError(first, 200); assert.equal(first.body.task.metadata_revision, 1); await assertNoDispatch(s);
});

test('metadata commands validate a strict nonempty three-field changes object', async () => {
  const s = await session(), task = await create(s), input = body(task, { title: '合法标题' });
  for (const changes of [{ title: undefined }, { auto_run: undefined }, { run_at: undefined }, { title: '不会混入', auto_run: undefined }]) {
    await assert.rejects(updateTaskMetadata(s.userId, task.id, { ...input, changes }), error => error.name === 'ZodError');
  }
  const invalid = [
    { ...input, client_request_id: 'bad' }, { ...input, client_request_id: undefined },
    { ...input, expected_revision: -1 }, { ...input, expected_revision: 0.5 }, { ...input, expected_revision: '0' },
    { ...input, expected_revision: Number.MAX_SAFE_INTEGER + 1 }, { ...input, expected_revision: undefined },
    { ...input, extra: true }, { ...input, changes: {} }, { ...input, changes: null }, { ...input, changes: [] },
    ...[{ title: '' }, { title: '  ' }, { title: 'x'.repeat(151) }, { title: null }, { title: 5 },
      { auto_run: 'true' }, { auto_run: null }, { run_at: 'tomorrow' }, { run_at: '2030-01-01T00:00:00+01:00' },
      { run_at: 1 }, { prompt: 'overwrite' }, { status: 'completed' }, { metadata_revision: 80 },
      { dependency_ids: [] }, { model_id: 'model' }, { title: '合法', unknown: true }].map(changes => ({ ...input, changes }))
  ];
  for (const payload of invalid) expectError(await put(s, task, payload), 400);
  expectError(await request.put(route(task)).set('Cookie', s.cookie).set('Idempotency-Key', uuid()).send(input), 400);
  expectError(await close(s, task, 'bad'), 400);
  expectError(await lookup(s, task, 'bad'), 400);
  expectError(await request.post(`${route(task)}/commands/${uuid()}/close`).set('Cookie', s.cookie).send({ force: true }), 400);
  expectError(await put(s, task, body(task, { auto_run: true, run_at: null })), 422, 'TASK_METADATA_INVALID');
  assert.equal((await current(s, task)).metadata_revision, 0); await assertNoDispatch(s);
});

test('metadata HTTP identities are account-scoped and unknown versus foreign tasks reveal no existence', async () => {
  const a = await session(), b = await session(), task = await create(a, { title: 'PRIVATE_ACCOUNT_A_TITLE' }), own = await create(b), key = uuid();
  const input = body(task, { title: 'safe' }, { client_request_id: key }), missing = { ...task, id: uuid() };
  expectError(await request.put(route(task)).send(input), 401);
  expectError(await request.get(`${route(task)}/commands/${key}`), 401);
  expectError(await request.post(`${route(task)}/commands/${key}/close`).send({}), 401);
  for (const [method, url, payload] of [['put', route(task), input], ['get', `${route(task)}/commands/${key}`], ['post', `${route(task)}/commands/${key}/close`, {}]]) {
    expectError(await request[method](url).set('Cookie', b.cookie).set('X-Expected-User-Id', a.userId).send(payload), 409, 'ACCOUNT_CHANGED');
  }
  const foreign = await put(b, task, input), absent = await put(b, missing, input);
  expectError(foreign, 404, 'TASK_METADATA_NOT_FOUND'); expectError(absent, 404, 'TASK_METADATA_NOT_FOUND');
  assert.deepEqual(foreign.body, absent.body); assert.doesNotMatch(JSON.stringify(foreign.body), /PRIVATE_ACCOUNT/);
  const isolated = await close(b, task, key), alsoAbsent = await close(b, missing, uuid());
  expectError(isolated, 200); expectError(alsoAbsent, 200); assert.equal(isolated.body.task, null);
  assert.equal(isolated.body.receipt.status, 'cancelled'); assert.equal(alsoAbsent.body.receipt.status, 'cancelled');
  assert.doesNotMatch(JSON.stringify(isolated.body), /PRIVATE_ACCOUNT/);
  expectError(await lookup(a, task, key), 404);
  expectError(await put(a, task, input), 200, undefined);
  expectError(await put(b, own, body(own, { title: 'own independent key' }, { client_request_id: input.client_request_id })), 409);
  const independentKey = uuid(); expectError(await put(a, task, body(await current(a, task), { title: 'A' }, { client_request_id: independentKey })), 200);
  expectError(await put(b, own, body(own, { title: 'B' }, { client_request_id: independentKey })), 200);
  await assertNoDispatch(a); await assertNoDispatch(b);
});

test('same command replays one receipt; changed payload, revision or task cannot reuse its identity', async () => {
  const s = await session(), task = await create(s), other = await create(s), input = body(task, { title: '首次标题', auto_run: false });
  const saved = await put(s, task, input); expectError(saved, 200);
  assert.equal(saved.headers['cache-control'], 'no-store');
  assert.deepEqual(saved.body.receipt, { id: input.client_request_id, operation: 'metadata', task_id: task.id, status: 'succeeded', committed_revision: 1, committed_at: saved.body.receipt.committed_at });
  assert.ok(Number.isFinite(Date.parse(saved.body.receipt.committed_at)));
  assert.equal(saved.body.task.metadata_revision, 1);
  for (const payload of [{ ...input, changes: { title: '不同内容' } }, { ...input, expected_revision: 1 }, { ...input, changes: { title: '首次标题' } }]) expectError(await put(s, task, payload), 409);
  expectError(await put(s, other, body(other, input.changes, { client_request_id: input.client_request_id })), 409);
  expectError(await lookup(s, other, input.client_request_id), 404);
  clearUserDbCache(s.userId);
  const replay = await put(s, task, { ...input, client_request_id: input.client_request_id.toUpperCase(), changes: { auto_run: false, title: '首次标题' } });
  expectError(replay, 200); assert.deepEqual(replay.body.receipt, saved.body.receipt);
  const second = await put(s, task, body(replay.body.task, { title: '更新后的当前标题' })); expectError(second, 200);
  const original = await lookup(s, task, input.client_request_id.toUpperCase()); expectError(original, 200);
  assert.deepEqual(original.body.receipt, saved.body.receipt); assert.equal(original.body.task.title, '更新后的当前标题');
  assert.equal(original.body.task.metadata_revision, 2); assert.doesNotMatch(JSON.stringify(original.body), /input_hash/);
  assert.deepEqual((await close(s, task, input.client_request_id)).body.receipt, saved.body.receipt);
  await assertNoDispatch(s);
});

test('new same-value decision advances revision once, while replay never increments again', async () => {
  const s = await session(), task = await create(s), input = body(task, { title: task.title, auto_run: task.auto_run, run_at: task.run_at });
  const saved = await put(s, task, input); expectError(saved, 200); assert.equal(saved.body.task.metadata_revision, 1);
  assert.equal((await put(s, task, input)).body.task.metadata_revision, 1);
  const second = await put(s, task, body(saved.body.task, input.changes)); expectError(second, 200);
  assert.equal(second.body.task.metadata_revision, 2); await assertNoDispatch(s);
});

test('closing an absent request fences every late same-key metadata PUT and is idempotent', async () => {
  const s = await session(), task = await create(s), other = await create(s), input = body(task, { title: '迟到请求' });
  expectError(await lookup(s, task, input.client_request_id), 404);
  const closed = await close(s, task, input.client_request_id); expectError(closed, 200);
  assert.equal(closed.headers['cache-control'], 'no-store');
  assert.deepEqual(closed.body.receipt, { id: input.client_request_id, operation: 'metadata', task_id: task.id, status: 'cancelled', committed_revision: null, committed_at: closed.body.receipt.committed_at });
  assert.ok(Number.isFinite(Date.parse(closed.body.receipt.committed_at)));
  assert.equal(closed.body.task.metadata_revision, 0);
  clearUserDbCache(s.userId);
  assert.deepEqual((await close(s, task, input.client_request_id)).body.receipt, closed.body.receipt);
  assert.deepEqual((await lookup(s, task, input.client_request_id)).body.receipt, closed.body.receipt);
  expectError(await put(s, task, input), 410, 'TASK_METADATA_COMMAND_CLOSED');
  expectError(await close(s, other, input.client_request_id), 409);
  expectError(await lookup(s, other, input.client_request_id), 404);
  assert.equal((await current(s, task)).title, task.title); assert.equal((await current(s, task)).metadata_revision, 0);
  expectError(await put(s, task, body(task, { title: '明确的新请求' })), 200); await assertNoDispatch(s);
});

test('success and cancelled receipts survive deletion without recreating a task', async () => {
  const s = await session(), task = await create(s), input = body(task, { title: '删除前写入' }), closedId = uuid();
  const saved = await put(s, task, input); expectError(saved, 200);
  const cancelled = await close(s, task, closedId); expectError(cancelled, 200);
  await deleteTask(s.userId, task.id); clearUserDbCache(s.userId);
  for (const found of [await lookup(s, task, input.client_request_id), await put(s, task, input), await close(s, task, input.client_request_id)]) {
    expectError(found, 200); assert.deepEqual(found.body.receipt, saved.body.receipt); assert.equal(found.body.task, null); assert.equal(found.body.task_deleted, true);
  }
  const gone = await lookup(s, task, closedId); expectError(gone, 200); assert.deepEqual(gone.body.receipt, cancelled.body.receipt); assert.equal(gone.body.task, null);
  expectError(await put(s, task, body(task, { title: '不得复活' }, { client_request_id: closedId })), 410);
  assert.equal((await listTasks(s.userId)).length, 0); await assertNoDispatch(s);
});

test('old bare and mixed PATCH metadata are fenced, including the exported updateTask service', async () => {
  const s = await session(), task = await create(s), cancelId = uuid();
  for (const changes of [{ title: '裸写' }, { auto_run: true }, { run_at: null }, { status: 'cancelled', cancel_request_id: cancelId, title: '混合绕过' }, { status: 'cancelled', run_id: uuid(), auto_run: false }]) {
    expectError(await request.patch(`/api/tasks/${task.id}`).set('Cookie', s.cookie).send(changes), 428, 'TASK_METADATA_PRECONDITION_REQUIRED');
    await assert.rejects(updateTask(s.userId, task.id, changes), error => error.status === 428 && error.code === 'TASK_METADATA_PRECONDITION_REQUIRED');
  }
  expectError(await request.patch(`/api/tasks/${task.id}`).set('Cookie', s.cookie).send({ status: 'cancelled' }), 400);
  expectError(await request.patch(`/api/tasks/${task.id}`).set('Cookie', s.cookie).send({ status: 'cancelled', cancel_request_id: cancelId }), 200);
  assert.equal((await current(s, task)).status, 'cancelled'); assert.equal((await current(s, task)).title, task.title); await assertNoDispatch(s);
});

test('running and unknown tasks reject edits; terminal tasks reject enabling automatic execution', async () => {
  const s = await session();
  for (const status of ['running', 'outcome_unknown', 'completed', 'cancelled']) {
    const task = await create(s); await mutate(s, data => { data.tasks.find(item => item.id === task.id).status = status; });
    expectError(await put(s, task, body(task, { auto_run: true })), 409);
    if (['running', 'outcome_unknown'].includes(status)) expectError(await put(s, task, body(task, { title: '拒绝编辑' })), 409);
    else { const changed = await put(s, task, body(task, { title: '允许修改标题', auto_run: false })); expectError(changed, 200); assert.equal(changed.body.task.auto_run, false); }
  }
  await assertNoDispatch(s);
});

for (const operation of ['put', 'close']) for (const committed of [false, true]) {
  test(`${operation} ${committed ? 'lost durable ACK' : 'pre-commit failure'} returns uncertainty and never exposes phantom success`, async () => {
    const s = await session(), task = await create(s), input = body(task, { title: '持久回执目标', priority: 'high', estimated_minutes: 0 });
    const original = s.db.write.bind(s.db); let injected = false;
    s.db.write = async (...args) => { if (injected) return original(...args); injected = true; if (committed) await original(...args); throw new Error('synthetic metadata acknowledgement fault'); };
    try { expectError(await (operation === 'put' ? put(s, task, input) : close(s, task, input.client_request_id)), 503, 'TASK_METADATA_STORAGE_UNCERTAIN'); }
    finally { s.db.write = original; }
    clearUserDbCache(s.userId);
    const recovered = await lookup(s, task, input.client_request_id);
    if (!committed) { expectError(recovered, 404); assert.equal((await current(s, task)).title, task.title); assert.equal((await current(s, task)).metadata_revision, 0); }
    else { expectError(recovered, 200); assert.equal(recovered.body.receipt.status, operation === 'put' ? 'succeeded' : 'cancelled'); }
    const retry = await (operation === 'put' ? put(s, task, input) : close(s, task, input.client_request_id)); expectError(retry, 200);
    assert.equal(retry.body.task.metadata_revision, operation === 'put' ? 1 : 0);
    if (committed) assert.deepEqual(retry.body.receipt, recovered.body.receipt);
    if (operation === 'close') expectError(await put(s, task, input), 410);
    await assertNoDispatch(s);
  });
}

for (const first of ['put', 'close']) test(`${first}-first live HTTP race settles one terminal receipt; lookup cannot observe an uncommitted result`, async () => {
  const s = await session(), task = await create(s), input = body(task, { title: '并发最终决定' });
  const entered = deferred(), release = deferred(), original = s.db.write.bind(s.db); let held = false;
  s.db.write = async (...args) => { if (!held) { held = true; entered.resolve(); await release.promise; } return original(...args); };
  const initial = (first === 'put' ? put(s, task, input) : close(s, task, input.client_request_id)).then(value => value);
  try {
    await bounded(entered.promise, 'first metadata command never reached storage');
    let queryFinished = false;
    const query = lookup(s, task, input.client_request_id).then(value => { queryFinished = true; return value; });
    const second = (first === 'put' ? close(s, task, input.client_request_id) : put(s, task, input)).then(value => value);
    await delay(30); assert.equal(queryFinished, false, 'read must wait behind in-flight storage barrier');
    release.resolve(); const [a, b, found] = await Promise.all([initial, second, query]);
    expectError(a, 200); expectError(b, first === 'put' ? 200 : 410); expectError(found, 200);
    assert.deepEqual(found.body.receipt, a.body.receipt);
    assert.equal(found.body.receipt.status, first === 'put' ? 'succeeded' : 'cancelled');
    assert.equal((await current(s, task)).metadata_revision, first === 'put' ? 1 : 0);
  } finally { release.resolve(); s.db.write = original; await initial; }
  await assertNoDispatch(s);
});

async function armedTask(s, extra = {}) {
  const task = await create(s, extra), armed = await put(s, task, body(task, { auto_run: true })); expectError(armed, 200); return armed.body.task;
}
async function assertFencedAfter(s, before, changes = { auto_run: true }) {
  const after = await current(s, before);
  assert.equal(after.metadata_revision, before.metadata_revision + 1); assert.equal(after.auto_run, false);
  expectError(await put(s, before, body(before, changes)), 409, 'TASK_METADATA_REVISION_CONFLICT');
  return after;
}

test('precise pending cancellation advances metadata revision when it disables automatic execution', async () => {
  const s = await session(), task = await armedTask(s), key = uuid();
  const cancelled = await updateTask(s.userId, task.id, { status: 'cancelled', cancel_request_id: key });
  assert.equal(cancelled.status, 'cancelled'); const after = await assertFencedAfter(s, task);
  const replay = await updateTask(s.userId, task.id, { status: 'cancelled', cancel_request_id: key }); assert.equal(replay.metadata_revision, after.metadata_revision);
  await assertNoDispatch(s);
});

test('manual result acceptance disables automatic execution and fences a previously viewed metadata revision', async () => {
  const s = await session(), task = await armedTask(s);
  let doc = await getTaskResult(s.userId, task.id);
  doc = (await saveTaskResultVersion(s.userId, task.id, { client_request_id: uuid(), expected_revision: doc.revision, base_version_id: doc.head_version_id, content: '人工完成的正文' })).document;
  const version = doc.versions.find(item => item.id === doc.head_version_id);
  await acceptTaskResultVersion(s.userId, task.id, { client_request_id: uuid(), expected_revision: doc.revision, version_id: version.id, content_hash: version.content_hash, source_hash: doc.source.hash });
  const after = await assertFencedAfter(s, task); assert.equal(after.status, 'completed'); await assertNoDispatch(s);
});

test('manual brief rebase disables automatic execution and preserves newer metadata against stale clients', async () => {
  const s = await session(), task = await armedTask(s), doc = await getTaskResult(s.userId, task.id);
  await rebaseTaskBrief(s.userId, task.id, { client_request_id: uuid(), expected_revision: doc.revision, prompt: '用户明确更新的写作要求', source_hash: doc.source.hash });
  const after = await assertFencedAfter(s, task); assert.equal(after.prompt, '用户明确更新的写作要求'); await assertNoDispatch(s);
});

test('scheduler rejects a due missing model before dispatch, advances metadata revision and fences stale re-enabling', async () => {
  const s = await session(), task = await armedTask(s, { run_at: '2020-01-01T00:00:00.000Z' });
  // A missing model is a deterministic 404 at admission, before any transport.
  await mutate(s, data => { data.tasks.find(item => item.id === task.id).model_id = 'synthetic-missing-model'; });
  await tickTasks(); const after = await assertFencedAfter(s, task); assert.equal(after.status, 'failed');
  assert.equal(after.history.at(-1).dispatch_status, 'not_sent', 'missing model fails before provider transport');
});

test('restart recovery advances the same metadata revision and does not permit stale scheduling decisions', async () => {
  const s = await session(), task = await armedTask(s);
  await mutate(s, data => Object.assign(data.tasks.find(item => item.id === task.id), { status: 'running', run_id: uuid(), dispatch_status: 'not_sent', started_at: new Date().toISOString() }));
  await startTaskScheduler(); stopTaskScheduler(); const after = await assertFencedAfter(s, task); assert.equal(after.status, 'failed');
  assert.equal(after.run_count, 1, 'recovery records the interrupted run without dispatching it');
  await startTaskScheduler(); stopTaskScheduler(); assert.equal((await current(s, task)).metadata_revision, after.metadata_revision);
});



test('planning never reorders due tasks; repeat revision and metadata add no extra loopback calls', async () => {
  const { readCatalog, saveCatalog } = await import('../src/services/ai/catalog.js');
  const s = await session(); let calls = 0, probes = 0;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw), probe = JSON.stringify(payload.messages).includes('请回复 OK');
    if (probe) probes++; else calls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: probe ? 'OK' : '仅用于元数据排期回归的合成本地成果' } }], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const origin = `http://127.0.0.1:${provider.address().port}`, oldOrigins = process.env.AI_ALLOWED_LOCAL_ORIGINS;
  process.env.AI_ALLOWED_LOCAL_ORIGINS = origin;
  try {
    const catalog = await readCatalog(s.userId);
    catalog.providers.push({ id: 'metadata_loopback', name: '隔离排期回归', baseUrl: `${origin}/v1`, protocol: 'openai', enabled: true, keyRequired: false });
    catalog.models.push({ id: 'metadata_model', providerId: 'metadata_loopback', name: '隔离合成模型', model: 'isolated-metadata', enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 2048, temperature: null });
    catalog.defaults.chat = 'metadata_model'; await saveCatalog(s.userId, catalog);
    expectError(await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ clientRequestId: uuid(), modelId: 'metadata_model', capability: 'chat' }), 200);
    assert.equal(probes, 1); assert.equal(calls, 0);
    const task = await create(s, { model_id: 'metadata_model', auto_run: true, repeat_minutes: 15, run_at: '2020-01-01T00:00:00.000Z', priority: 'low', estimated_minutes: 525600 });
    const later = await create(s, { model_id: 'metadata_model', auto_run: true, run_at: '2019-01-01T00:00:00.000Z', priority: 'high', estimated_minutes: 0 });
    assert.equal(calls, 0);
    const old = body(task, { run_at: '2021-01-01T00:00:00.000Z' });
    await tickTasks();
    const generated = await current(s, task);
    const untouched = await current(s, later); assert.equal(untouched.run_count, 0); assert.equal(untouched.status, 'pending');
    expectError(await put(s, later, body(untouched, { auto_run: false })), 200);
    assert.equal(calls, 1); assert.equal(generated.status, 'pending'); assert.equal(generated.auto_run, true);
    assert.ok(Date.parse(generated.run_at) > Date.now()); assert.equal(generated.metadata_revision, task.metadata_revision + 1);
    expectError(await put(s, task, old), 409, 'TASK_METADATA_REVISION_CONFLICT');
    const input = body(generated, { title: '排期后明确修改标题', priority: 'high', estimated_minutes: 0 }), saved = await put(s, task, input); expectError(saved, 200);
    expectError(await lookup(s, task, input.client_request_id), 200); expectError(await close(s, task, input.client_request_id), 200); expectError(await put(s, task, input), 200);
    assert.equal(calls, 1, 'PUT/query/close/replay must not dispatch an extra model call'); assert.equal(probes, 1);
    assert.equal((await current(s, task)).run_at, generated.run_at);
  } finally {
    if (oldOrigins === undefined) delete process.env.AI_ALLOWED_LOCAL_ORIGINS; else process.env.AI_ALLOWED_LOCAL_ORIGINS = oldOrigins;
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  }
});

test('malformed revisions and forged command owners fail closed without overwriting metadata', async () => {
  const s = await session(), task = await create(s);
  for (const value of [-1, null, '0', 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await mutate(s, data => { data.tasks.find(item => item.id === task.id).metadata_revision = value; });
    expectError(await put(s, task, body(task, { title: '不得覆盖损坏修订' })), 503, 'TASK_METADATA_STORAGE_UNCERTAIN');
  }
  await mutate(s, data => { data.tasks.find(item => item.id === task.id).metadata_revision = 0; });
  const input = body(task, { title: '真实归属' }); expectError(await put(s, task, input), 200);
  await s.db.read({ force: true }); const valid = structuredClone(s.db.data.taskMetadataCommands);
  const malformed = [null, {}, [null], [valid[0], valid[0]], [{ ...valid[0], actor_id: uuid() }], [{ ...valid[0], committed_revision: -1 }], [{ ...valid[0], input_hash: 'forged' }]];
  for (const entries of malformed) {
    await mutate(s, data => { data.taskMetadataCommands = entries; });
    for (const response of [await lookup(s, task, input.client_request_id), await put(s, task, input), await close(s, task, input.client_request_id)]) expectError(response, 503, 'TASK_METADATA_STORAGE_UNCERTAIN');
    await s.db.read({ force: true }); assert.equal(s.db.data.tasks.find(item => item.id === task.id).title, '真实归属');
  }
  await mutate(s, data => { data.taskMetadataCommands = valid; });
  expectError(await lookup(s, task, input.client_request_id), 200);
});

test('command cap preserves existing receipts instead of evicting recovery evidence', async () => {
  const s = await session(), task = await create(s), input = body(task, { title: '上限之前的真实写入' });
  const saved = await put(s, task, input); expectError(saved, 200);
  await mutate(s, data => { const now = new Date().toISOString(); data.taskMetadataCommands.push(...Array.from({ length: 9999 }, () => ({ id: uuid(), task_id: task.id, actor_id: s.userId, status: 'cancelled', committed_revision: null, committed_at: now }))); });
  expectError(await close(s, task, uuid()), 429, 'TASK_METADATA_COMMAND_LIMIT');
  expectError(await put(s, task, body(saved.body.task, { title: '不得驱逐旧回执' })), 429, 'TASK_METADATA_COMMAND_LIMIT');
  assert.deepEqual((await lookup(s, task, input.client_request_id)).body.receipt, saved.body.receipt);
  assert.deepEqual((await put(s, task, input)).body.receipt, saved.body.receipt);
  assert.equal((await current(s, task)).metadata_revision, 1); await assertNoDispatch(s);
});

// Independent Node processes use the exact parent executable, temp DATA_DIR,
// synthetic session cookie and (only in the PG wrapper) private loopback SQL.
function worker(s, task, operation, payload, { pauseRead = false, crashAfterWrite = false } = {}) {
  const source = `
    const { initDatabase, getUserDb } = await import('./src/models/db.js');
    const { initAuthDb } = await import('./src/models/authDb.js');
    const { createTestApp } = await import('./test/helpers/createTestApp.js');
    const { closeSupabaseConnection } = await import('./src/models/supabaseAdapter.js');
    const { default: supertest } = await import('supertest');
    const cfg = JSON.parse(process.env.METADATA_WORKER_INPUT);
    await initDatabase(); await initAuthDb();
    const db = await getUserDb(cfg.userId); await db.read({ force: true });
    const read = db.read.bind(db), write = db.write.bind(db); let paused = false, written = false;
    if (cfg.pauseRead) db.read = async (...args) => { await read(...args); if (!paused) { paused = true; process.send({ ready: true, revision: db._revision }); await new Promise(resolve => process.once('message', resolve)); } };
    if (cfg.crashAfterWrite) db.write = async (...args) => { const value = await write(...args); if (!written) { written = true; process.send({ durable: true }); await new Promise(() => {}); } return value; };
    try {
      const request = supertest(createTestApp()), base = '/api/tasks/' + cfg.taskId;
      let call;
      if (cfg.operation === 'put') call = request.put(base + '/metadata').send(cfg.payload);
      else if (cfg.operation === 'close') call = request.post(base + '/metadata/commands/' + cfg.payload.client_request_id + '/close').send({});
      else if (cfg.operation === 'dependency') call = request.put(base + '/dependencies').send(cfg.payload);
      else if (cfg.operation === 'delete') call = request.delete(base);
      else if (cfg.operation === 'accept') call = request.post(base + '/result/accept').send(cfg.payload);
      else call = request.get(base + '/metadata/commands/' + cfg.payload.client_request_id);
      const result = await call.set('Cookie', cfg.cookie).set('X-Expected-User-Id', cfg.userId);
      process.send({ done: true, status: result.status, body: result.body });
    } catch (error) { process.send({ done: true, status: error.status || 500, body: { code: error.code, message: error.message } }); }
    finally { await closeSupabaseConnection(); process.disconnect(); }
  `;
  const cfg = { userId: s.userId, cookie: s.cookie, taskId: task.id, operation, payload, pauseRead, crashAfterWrite };
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, METADATA_WORKER_INPUT: JSON.stringify(cfg) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const ready = deferred(), durable = deferred(); let outcome, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on('message', value => { if (value.ready) ready.resolve(value); if (value.durable) durable.resolve(value); if (value.done) outcome = value; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && outcome) resolve(outcome);
      else if (signal === 'SIGKILL' && crashAfterWrite) resolve({ killed: true, signal });
      else reject(new Error(`metadata worker exited ${code || signal}: ${stderr}`));
    });
  }); done.catch(() => {});
  return { child, done, ready: ready.promise, durable: durable.promise, resume: () => child.send({ go: true }), stop: () => child.kill('SIGKILL') };
}
async function finishedWorker(...args) {
  const child = worker(...args);
  try { return await bounded(child.done, 'independent metadata process did not finish'); }
  finally { if (child.child.exitCode === null && child.child.signalCode === null) child.stop(); }
}

test('fresh process reopens success and cancellation receipts and replays without another mutation', { timeout: 30000 }, async () => {
  const s = await session(), task = await create(s), input = body(task, { title: '跨进程回执', priority: 'medium', estimated_minutes: 45 }), closedId = uuid();
  const saved = await put(s, task, input); expectError(saved, 200); const closed = await close(s, task, closedId); expectError(closed, 200);
  for (const operation of ['get', 'put']) { const result = await finishedWorker(s, task, operation, input); expectError(result, 200); assert.deepEqual(result.body.receipt, saved.body.receipt); }
  const recovered = await finishedWorker(s, task, 'get', { client_request_id: closedId }); expectError(recovered, 200); assert.deepEqual(recovered.body.receipt, closed.body.receipt);
  expectError(await finishedWorker(s, task, 'put', body(task, { title: '封存后不得写' }, { client_request_id: closedId })), 410);
  clearUserDbCache(s.userId); assert.equal((await current(s, task)).metadata_revision, 1); await assertNoDispatch(s);
});

for (const operation of ['put', 'close']) test(`abrupt writer SIGKILL after durable ${operation} commit recovers the original receipt in a new process`, { timeout: 30000 }, async () => {
  const s = await session(), task = await create(s), input = body(task, { title: '持久后进程中断', priority: 'low', estimated_minutes: 0 });
  const child = worker(s, task, operation, input, { crashAfterWrite: true });
  try { await bounded(child.durable, 'writer never reached durable metadata commit'); child.stop(); assert.equal((await child.done).signal, 'SIGKILL'); }
  finally { if (child.child.exitCode === null && child.child.signalCode === null) child.stop(); }
  const recovered = await finishedWorker(s, task, 'get', input); expectError(recovered, 200);
  assert.equal(recovered.body.receipt.status, operation === 'put' ? 'succeeded' : 'cancelled');
  const retried = await finishedWorker(s, task, operation, input); expectError(retried, 200); assert.deepEqual(retried.body.receipt, recovered.body.receipt);
  clearUserDbCache(s.userId); assert.equal((await current(s, task)).metadata_revision, operation === 'put' ? 1 : 0); await assertNoDispatch(s);
});

if (process.env.SUPABASE_DB_URL) {
  async function race(s, operations) {
    const children = operations.map(op => worker(s, op.task, op.operation, op.payload, { pauseRead: true }));
    try {
      const snapshots = await bounded(Promise.all(children.map(child => child.ready)), 'PG workers never held independent snapshots');
      assert.equal(new Set(snapshots.map(value => value.revision)).size, 1, 'both commands must begin with the same durable SQL row revision');
      assert.equal(new Set(children.map(child => child.child.pid)).size, children.length);
      for (const child of children) child.resume();
      return await bounded(Promise.all(children.map(child => child.done)), 'PG metadata race did not settle');
    } finally { for (const child of children) if (child.child.exitCode === null && child.child.signalCode === null) child.stop(); await Promise.allSettled(children.map(child => child.done)); }
  }
  test('real PgLow independent metadata writers sharing a revision have exactly one durable winner', { timeout: 30000 }, async () => {
    const s = await session(), task = await create(s), inputs = [body(task, { title: '进程A标题', priority: 'high', estimated_minutes: 0 }), body(task, { title: '进程B标题', priority: 'low', estimated_minutes: 75 })];
    const results = await race(s, inputs.map(payload => ({ task, operation: 'put', payload })));
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409], JSON.stringify(results));
    const winner = results.findIndex(item => item.status === 200), loser = 1 - winner;
    assert.equal(results[loser].body.code, 'TASK_METADATA_REVISION_CONFLICT');
    clearUserDbCache(s.userId); const latest = await current(s, task); assert.equal(latest.metadata_revision, 1); assert.equal(latest.title, inputs[winner].changes.title); assert.equal(latest.priority, inputs[winner].changes.priority); assert.equal(latest.estimated_minutes, inputs[winner].changes.estimated_minutes);
    expectError(await lookup(s, task, inputs[loser].client_request_id), 404);
    assert.deepEqual((await put(s, task, inputs[winner])).body.receipt, results[winner].body.receipt); await assertNoDispatch(s);
  });
  test('planning real PG independent priority versus estimate commands cannot merge stale metadata intents', { timeout: 30000 }, async () => {
    const s = await session(), task = await create(s), inputs = [body(task, { priority: 'high' }), body(task, { estimated_minutes: 75 })];
    const results = await race(s, inputs.map(payload => ({ task, operation: 'put', payload })));
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409], JSON.stringify(results));
    const winner = results.findIndex(item => item.status === 200), loser = 1 - winner;
    clearUserDbCache(s.userId); const latest = await current(s, task);
    assert.equal(latest.metadata_revision, 1); assert.equal(latest.priority, winner === 0 ? 'high' : null); assert.equal(latest.estimated_minutes, winner === 1 ? 75 : null);
    expectError(await lookup(s, task, inputs[loser].client_request_id), 404);
    expectError(await finishedWorker(s, task, 'put', inputs[loser]), 409, 'TASK_METADATA_REVISION_CONFLICT');
    const closed = await close(s, task, inputs[loser].client_request_id); expectError(closed, 200); assert.equal(closed.body.receipt.status, 'cancelled');
    await assertNoDispatch(s);
  });
  test('planning real PG edit versus deletion never resurrects the task or invents a receipt', { timeout: 30000 }, async () => {
    const s = await session(), task = await create(s), input = body(task, { priority: 'medium', estimated_minutes: 0 });
    const results = await race(s, [{ task, operation: 'put', payload: input }, { task, operation: 'delete', payload: {} }]);
    assert.ok(results.some(item => [200, 204].includes(item.status)), JSON.stringify(results));
    assert.ok(results.every(item => [200, 204, 409].includes(item.status)), JSON.stringify(results));
    clearUserDbCache(s.userId);
    if (results[0].status === 200) {
      const found = await lookup(s, task, input.client_request_id); expectError(found, 200); assert.deepEqual(found.body.receipt, results[0].body.receipt);
      if (await current(s, task)) expectError(await finishedWorker(s, task, 'delete', {}), 204);
      const replay = await put(s, task, input); expectError(replay, 200); assert.equal(replay.body.task, null); assert.equal(replay.body.task_deleted, true);
    } else { expectError(await lookup(s, task, input.client_request_id), 404); expectError(await put(s, task, input), 404); }
    assert.equal((await listTasks(s.userId)).length, 0); await assertNoDispatch(s);
  });
  test('planning real PG metadata versus result acceptance preserves scheduling revision and result authority', { timeout: 30000 }, async () => {
    const s = await session(), task = await armedTask(s);
    let doc = await getTaskResult(s.userId, task.id);
    doc = (await saveTaskResultVersion(s.userId, task.id, { client_request_id: uuid(), expected_revision: doc.revision, base_version_id: doc.head_version_id, content: '并发验收只用人工正文' })).document;
    const version = doc.versions.find(item => item.id === doc.head_version_id), input = body(task, { priority: 'high', estimated_minutes: 0 });
    const accept = { client_request_id: uuid(), expected_revision: doc.revision, version_id: version.id, content_hash: version.content_hash, source_hash: doc.source.hash };
    const results = await race(s, [{ task, operation: 'put', payload: input }, { task, operation: 'accept', payload: accept }]);
    assert.ok(results.some(item => item.status === 200), JSON.stringify(results)); assert.ok([200, 409].includes(results[0].status), JSON.stringify(results));
    assert.ok([200, 409, 503].includes(results[1].status), JSON.stringify(results));
    if (results[1].status === 503) assert.equal(results[1].body.code, 'RESULT_STORAGE_UNCERTAIN');
    clearUserDbCache(s.userId);
    if (results[0].status === 200) {
      if (results[1].status !== 200) expectError(await finishedWorker(s, task, 'accept', accept), 200);
      assert.equal((await current(s, task)).priority, 'high');
      assert.deepEqual((await put(s, task, input)).body.receipt, results[0].body.receipt);
    } else { expectError(await put(s, task, input), 409, 'TASK_METADATA_REVISION_CONFLICT'); assert.equal((await current(s, task)).priority, null); }
    const latest = await current(s, task); assert.equal(latest.auto_run, false); assert.equal(latest.status, 'completed');
    assert.equal((await getTaskResult(s.userId, task.id)).accepted_version_id, version.id); await assertNoDispatch(s);
  });
  test('real PgLow metadata and dependency CAS conflicts never erase another field or silently retry stale intent', { timeout: 30000 }, async () => {
    const s = await session(), predecessor = await create(s), task = await create(s), metadata = body(task, { title: '保留独立标题', priority: 'medium', estimated_minutes: 25 });
    const dependency = { client_request_id: uuid(), expected_revision: task.dependency_revision, dependency_ids: [predecessor.id] };
    const ops = [{ task, operation: 'put', payload: metadata }, { task, operation: 'dependency', payload: dependency }];
    const results = await race(s, ops); assert.ok(results.some(item => item.status === 200), JSON.stringify(results));
    for (const [i, result] of results.entries()) {
      assert.ok([200, 409].includes(result.status), JSON.stringify(results));
      if (result.status === 409) expectError(await finishedWorker(s, task, ops[i].operation, ops[i].payload), 200);
    }
    clearUserDbCache(s.userId); const latest = await current(s, task);
    assert.equal(latest.title, metadata.changes.title); assert.equal(latest.metadata_revision, 1); assert.equal(latest.priority, 'medium'); assert.equal(latest.estimated_minutes, 25);
    assert.deepEqual(latest.dependency_ids, [predecessor.id]); assert.equal(latest.dependency_revision, 1);
    assert.equal((await lookup(s, task, metadata.client_request_id)).body.receipt.committed_revision, 1); await assertNoDispatch(s);
  });
  test('real PgLow metadata PUT versus authoritative closure has one terminal command after independent process conflict', { timeout: 30000 }, async () => {
    const s = await session(), task = await create(s), input = body(task, { title: '竞争封存', priority: 'high', estimated_minutes: 0 });
    const results = await race(s, [{ task, operation: 'put', payload: input }, { task, operation: 'close', payload: input }]);
    assert.ok(results.some(item => item.status === 200), JSON.stringify(results));
    clearUserDbCache(s.userId); const terminal = await lookup(s, task, input.client_request_id); expectError(terminal, 200);
    const closed = await close(s, task, input.client_request_id); expectError(closed, 200); assert.deepEqual(closed.body.receipt, terminal.body.receipt);
    const replay = await put(s, task, input);
    expectError(replay, terminal.body.receipt.status === 'succeeded' ? 200 : 410);
    assert.equal((await current(s, task)).metadata_revision, terminal.body.receipt.status === 'succeeded' ? 1 : 0); await assertNoDispatch(s);
  });
}

// F14.1 private planning attributes: optional display-only metadata. These
// regression tests are deliberately first run on public 533d7be before code.
test('planning legacy projection is unset without rewriting old task bytes', async () => {
  const s = await session(), task = await create(s);
  await mutate(s, data => { const stored = data.tasks.find(item => item.id === task.id); delete stored.priority; delete stored.estimated_minutes; });
  const before = JSON.stringify(s.db.data), original = s.db.write.bind(s.db); let writes = 0;
  s.db.write = async (...args) => { writes++; return original(...args); };
  try {
    const response = await request.get('/api/tasks').set('Cookie', s.cookie);
    expectError(response, 200); const visible = response.body.find(item => item.id === task.id);
    assert.equal(visible.priority, null); assert.equal(visible.estimated_minutes, null);
    assert.equal(writes, 0); assert.equal(JSON.stringify(s.db.data), before);
  } finally { s.db.write = original; }
  await assertNoDispatch(s);
});

test('planning creation accepts unset and bounded attributes without dispatch', async () => {
  const s = await session();
  for (const priority of [null, 'low', 'medium', 'high']) {
    const task = await create(s, { priority, estimated_minutes: priority === null ? null : 0 });
    assert.equal(task.priority, priority); assert.equal(task.estimated_minutes, priority === null ? null : 0);
    assert.equal(task.metadata_revision, 0);
  }
  await assertNoDispatch(s);
});

test('planning edit is one atomic versioned idempotent command with null distinct from zero', async () => {
  const s = await session(), task = await create(s), input = body(task, { priority: 'high', estimated_minutes: 0 });
  const saved = await put(s, task, input); expectError(saved, 200);
  assert.equal(saved.body.task.priority, 'high'); assert.equal(saved.body.task.estimated_minutes, 0);
  assert.equal(saved.body.task.metadata_revision, 1);
  const replay = await put(s, task, input); expectError(replay, 200); assert.deepEqual(replay.body.receipt, saved.body.receipt);
  const cleared = await put(s, task, body(saved.body.task, { priority: null, estimated_minutes: null })); expectError(cleared, 200);
  assert.equal(cleared.body.task.priority, null); assert.equal(cleared.body.task.estimated_minutes, null); assert.equal(cleared.body.task.metadata_revision, 2);
  await assertNoDispatch(s);
});

test('planning old creation and three-field metadata receipts preserve public-533 serialized hash bytes', async () => {
  const s = await session(), requestId = uuid();
  // Frozen public-533 parse order/defaults. No new optional keys may be filled
  // into this old intent, including after its original task gains attributes.
  const oldData = { title: '旧创建意图', prompt: '旧输入原文', category: 'work', model_id: null, group_id: null,
    run_at: null, repeat_minutes: null, auto_run: false };
  const task = await createTask(s.userId, { client_request_id: requestId, title: '旧创建意图', prompt: '旧输入原文' });
  const oldHash = createHash('sha256').update(JSON.stringify(oldData)).digest('hex');
  assert.equal(s.db.data.taskCreateRequests.find(item => item.id === requestId).input_hash, oldHash);
  const metadataId = uuid(), oldInput = { client_request_id: metadataId, expected_revision: 0, changes: { title: '旧编辑已保存', auto_run: false, run_at: null } };
  const oldMetadataHash = createHash('sha256').update(JSON.stringify({ userId: s.userId, taskId: task.id, operation: 'metadata', input: oldInput })).digest('hex');
  // Seed exactly the durable old receipt shape, as if committed by public 533.
  await mutate(s, data => {
    Object.assign(data.tasks.find(item => item.id === task.id), oldInput.changes, { metadata_revision: 1 });
    data.taskMetadataCommands = [{ id: metadataId, task_id: task.id, actor_id: s.userId, input_hash: oldMetadataHash,
      committed_revision: 1, status: 'succeeded', committed_at: '2026-10-01T00:00:00.000Z' }];
  });
  const replay = await put(s, task, { ...oldInput, changes: { run_at: null, auto_run: false, title: '旧编辑已保存' } });
  expectError(replay, 200); assert.equal(replay.body.receipt.committed_revision, 1);
  const planned = await put(s, task, body(replay.body.task, { priority: 'medium', estimated_minutes: 45 })); expectError(planned, 200);
  const createdAgain = await createTask(s.userId, { client_request_id: requestId, title: '旧创建意图', prompt: '旧输入原文' });
  assert.equal(createdAgain.id, task.id); assert.equal(createdAgain.priority, 'medium'); assert.equal(createdAgain.metadata_revision, 2);
  const historical = await put(s, task, oldInput); expectError(historical, 200); assert.deepEqual(historical.body.receipt, replay.body.receipt);
  assert.equal(historical.body.task.estimated_minutes, 45); assert.equal(historical.body.task.metadata_revision, 2);
  await assert.rejects(createTask(s.userId, { client_request_id: requestId, ...oldData, priority: null }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  await assertNoDispatch(s);
});

test('planning strict validation rejects the entire create or edit and old PATCH cannot bypass revision', async () => {
  const s = await session(), task = await create(s);
  const invalid = [
    ...['normal', '', 'urgent', 1, false, [], {}].map(priority => ({ priority })),
    ...[-1, 0.5, 525601, '0', '', false, [], {}, Infinity, NaN].map(estimated_minutes => ({ estimated_minutes }))
  ];
  for (const changes of invalid) {
    await assert.rejects(create(s, changes), error => error.name === 'ZodError');
    // Non-finite JSON normalizes to null, so service validation is the proper
    // evidence for those unrepresentable JSON values rather than send().
    await assert.rejects(updateTaskMetadata(s.userId, task.id, body(task, { title: '不应部分写入', ...changes })), error => error.name === 'ZodError');
    if (Number.isFinite(changes.estimated_minutes) || !Object.hasOwn(changes, 'estimated_minutes') || typeof changes.estimated_minutes !== 'number')
      expectError(await put(s, task, body(task, { title: '不应部分写入', ...changes })), 400);
  }
  for (const changes of [{ priority: undefined }, { estimated_minutes: undefined }]) {
    await assert.rejects(create(s, changes), error => error.name === 'ZodError');
    await assert.rejects(updateTaskMetadata(s.userId, task.id, body(task, changes)), error => error.name === 'ZodError');
  }
  expectError(await put(s, task, body(task, { priority: 'high', unknown: true })), 400);
  for (const changes of [{ priority: 'high' }, { estimated_minutes: 10 }, { status: 'cancelled', cancel_request_id: uuid(), priority: null }]) {
    expectError(await request.patch(`/api/tasks/${task.id}`).set('Cookie', s.cookie).send(changes), 428, 'TASK_METADATA_PRECONDITION_REQUIRED');
    await assert.rejects(updateTask(s.userId, task.id, changes), error => error.status === 428);
  }
  const latest = await current(s, task); assert.equal(latest.title, task.title); assert.equal(latest.metadata_revision, 0);
  assert.equal((await listTasks(s.userId)).length, 1); assert.equal(s.db.data.taskMetadataCommands?.length || 0, 0);
  const edge = await put(s, task, body(task, { priority: null, estimated_minutes: 525600 })); expectError(edge, 200);
  const same = await put(s, task, body(edge.body.task, { priority: null, estimated_minutes: 525600 })); expectError(same, 200); assert.equal(same.body.task.metadata_revision, 2);
  await assertNoDispatch(s);
});

test('planning owner isolation covers values and receipts while identical UUIDs remain account-scoped', async () => {
  const a = await session(), b = await session(), task = await create(a), own = await create(b), id = uuid();
  const input = body(task, { priority: 'high', estimated_minutes: 371 }, { client_request_id: id });
  expectError(await put(a, task, input), 200);
  const foreign = await put(b, task, input), absent = await put(b, { id: uuid() }, input);
  expectError(foreign, 404); assert.deepEqual(foreign.body, absent.body); assert.doesNotMatch(JSON.stringify(foreign.body), /371|high/);
  expectError(await lookup(b, task, id), 404);
  const other = await put(b, own, body(own, { priority: 'low', estimated_minutes: 0 }, { client_request_id: id })); expectError(other, 200);
  const aNow = await current(a, task); assert.equal(aNow.priority, 'high'); assert.equal(aNow.estimated_minutes, 371);
  expectError(await put(a, task, { ...input, changes: { priority: 'low', estimated_minutes: 371 } }), 409, 'TASK_METADATA_IDEMPOTENCY_CONFLICT');
  assert.equal((await request.get('/api/tasks').set('Cookie', b.cookie)).body.some(item => item.id === task.id), false);
  await assertNoDispatch(a); await assertNoDispatch(b);
});

test('planning malformed persisted fields fail closed without rewriting values or exposing them', async () => {
  const s = await session(), task = await create(s);
  for (const changes of [{ priority: 'PRIVATE_INVALID' }, { priority: false }, { priority: {} }, { estimated_minutes: 'PRIVATE_INVALID' }, { estimated_minutes: -1 }, { estimated_minutes: 0.5 }]) {
    await mutate(s, data => { Object.assign(data.tasks.find(item => item.id === task.id), { priority: null, estimated_minutes: null }, changes); });
    const before = JSON.stringify(s.db.data), response = await request.get('/api/tasks').set('Cookie', s.cookie);
    expectError(response, 503, 'TASK_METADATA_STORAGE_UNCERTAIN'); assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_INVALID/);
    expectError(await put(s, task, body(task, { title: '不能掩盖损坏字段' })), 503, 'TASK_METADATA_STORAGE_UNCERTAIN');
    assert.equal(JSON.stringify(s.db.data), before);
  }
});

test('planning updates preserve accepted manual result versions and dependency/source evidence', async () => {
  const s = await session(), task = await create(s);
  let doc = await getTaskResult(s.userId, task.id);
  doc = (await saveTaskResultVersion(s.userId, task.id, { client_request_id: uuid(), expected_revision: doc.revision, base_version_id: doc.head_version_id, content: '规划属性不应作废这份人工作品' })).document;
  const version = doc.versions.find(item => item.id === doc.head_version_id);
  await acceptTaskResultVersion(s.userId, task.id, { client_request_id: uuid(), expected_revision: doc.revision, version_id: version.id, content_hash: version.content_hash, source_hash: doc.source.hash });
  const before = await getTaskResult(s.userId, task.id), prior = await current(s, task);
  const saved = await put(s, task, body(prior, { priority: 'high', estimated_minutes: 0 })); expectError(saved, 200);
  assert.deepEqual(await getTaskResult(s.userId, task.id), before);
  const latest = await current(s, task);
  for (const key of ['dependency_revision', 'dependency_ids', 'dependency_state', 'source_hash', 'accepted_run_id', 'run_count', 'history', 'result_accepted_version_id']) assert.deepEqual(latest[key], prior[key], key);
  await assertNoDispatch(s);
});
