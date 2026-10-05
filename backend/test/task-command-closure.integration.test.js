import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'qunthink-command-closure-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
const { initDatabase, initUserDatabase, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { createTask, deleteTask, getTaskCreationReceipt, closeTaskCreationCommand } = await import('../src/services/tasks.js');
const { getTaskResult, getTaskResultCommand, saveTaskResultVersion, acceptTaskResultVersion, closeTaskResultCommand } = await import('../src/services/taskResults.js');
const request = (await import('supertest')).default(createTestApp());
await initDatabase(); await initAuthDb();
after(async () => { if (process.env.SUPABASE_DB_URL) await (await import('../src/models/supabaseAdapter.js')).closeSupabaseConnection(); });
const input = key => ({ client_request_id: key, title: '独立恢复测试文稿', prompt: '只写人工正文，不调用模型' });
async function account() {
  const user = randomUUID(), token = generateSessionToken(), db = await initUserDatabase(user);
  if (!process.env.SUPABASE_DB_URL) await provisionNewLocalMemoryAccount(user, db);
  const auth = getAuthDb(); await auth.read();
  auth.data.users.push({ id: user, username: user, password: 'unused' });
  auth.data.sessions.push({ token, userId: user, expires_at: new Date(Date.now() + 3600000).toISOString() });
  await auth.write(); return { user, db, cookie: `session_token=${token}` };
}
const post = (s, url, body = {}) => request.post('/api' + url).set('Cookie', s.cookie).set('X-Expected-User-Id', s.user).send(body);
const versionInput = (key, doc, body) => ({ client_request_id: key, expected_revision: doc.revision, base_version_id: doc.head_version_id, content: body });

test('an absent create can be authoritatively closed; late same-key POST never creates a task', async () => {
  const s = await account(), key = randomUUID();
  await assert.rejects(getTaskCreationReceipt(s.user, key), e => e.status === 404);
  const closed = await post(s, `/tasks/commands/${key.toUpperCase()}/close`);
  assert.equal(closed.status, 200); assert.equal(closed.body.status, 'cancelled');
  assert.equal(closed.body.client_request_id, key); assert.equal(closed.body.task_id, null); assert.equal(closed.body.task, null);
  const repeated = await closeTaskCreationCommand(s.user, key); assert.deepEqual(repeated, closed.body);
  assert.deepEqual(await getTaskCreationReceipt(s.user, key), closed.body);
  const late = await post(s, '/tasks', input(key)); assert.equal(late.status, 410); assert.equal(late.body.code, 'TASK_CREATE_COMMAND_CLOSED');
  await s.db.read({ force: true }); assert.equal(s.db.data.tasks?.length || 0, 0); assert.equal(s.db.data.taskCreateRequests.length, 1);
  assert.equal((await post(s, '/tasks', input(randomUUID()))).status, 201);
});

test('close never removes a committed create or revives its later deletion', async () => {
  const s = await account(), key = randomUUID(), task = await createTask(s.user, input(key));
  const found = await closeTaskCreationCommand(s.user, key);
  assert.equal(found.status, 'succeeded'); assert.equal(found.task.id, task.id); assert.equal(found.task_deleted, false);
  await deleteTask(s.user, task.id);
  const deleted = await closeTaskCreationCommand(s.user, key);
  assert.equal(deleted.status, 'succeeded'); assert.equal(deleted.task_id, task.id); assert.equal(deleted.task_deleted, true); assert.equal(deleted.task, null);
  await assert.rejects(createTask(s.user, input(key)), e => e.code === 'TASK_DELETED');
});

test('closure API rejects invalid payload and stale identity; UUID is scoped to the authenticated account', async () => {
  const a = await account(), b = await account(), key = randomUUID();
  assert.equal((await post(a, '/tasks/commands/not-a-uuid/close')).status, 400);
  assert.equal((await post(a, `/tasks/commands/${key}/close`, { content: 'not accepted' })).status, 400);
  assert.equal((await request.post(`/api/tasks/commands/${key}/close`).set('Cookie', b.cookie).set('X-Expected-User-Id', a.user).send({})).status, 409);
  assert.equal((await request.post(`/api/tasks/commands/${key}/close`).send({})).status, 401);
  const closed = await post(a, `/tasks/commands/${key}/close`); assert.equal(closed.headers['cache-control'], 'no-store');
  const created = await createTask(b.user, input(key)); assert.ok(created.id);
  assert.equal((await getTaskCreationReceipt(a.user, key)).status, 'cancelled');
});

test('closing an uncommitted body save retains current and accepted versions and rejects late mutation', async () => {
  const s = await account(), task = await createTask(s.user, input(randomUUID()));
  const initial = await getTaskResult(s.user, task.id);
  const first = await saveTaskResultVersion(s.user, task.id, versionInput(randomUUID(), initial, '已经保存的人工作品'));
  const v = first.document.versions[0];
  const accepted = await acceptTaskResultVersion(s.user, task.id, { client_request_id: randomUUID(), expected_revision: first.document.revision, version_id: v.id, content_hash: v.content_hash, source_hash: null });
  const key = randomUUID(), pending = versionInput(key, accepted.document, '尚未到服务器的另一段文字');
  await assert.rejects(getTaskResultCommand(s.user, task.id, key), e => e.status === 404);
  const closed = await post(s, `/tasks/${task.id}/result/commands/${key}/close`, { operation: 'save' });
  assert.equal(closed.status, 200); assert.equal(closed.body.receipt.status, 'cancelled'); assert.equal(closed.body.receipt.committed_revision, null);
  assert.deepEqual(closed.body.document, accepted.document);
  await assert.rejects(saveTaskResultVersion(s.user, task.id, pending), e => e.code === 'RESULT_COMMAND_CLOSED');
  await assert.rejects(acceptTaskResultVersion(s.user, task.id, { client_request_id: key, expected_revision: accepted.document.revision, version_id: v.id, content_hash: v.content_hash, source_hash: null }), e => e.code === 'RESULT_IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await getTaskResult(s.user, task.id), accepted.document);
  assert.deepEqual(await getTaskResultCommand(s.user, task.id, key), closed.body);
});

test('an already committed result is returned with its original version, not the later head', async () => {
  const s = await account(), task = await createTask(s.user, input(randomUUID())), key = randomUUID();
  const first = await saveTaskResultVersion(s.user, task.id, versionInput(key, await getTaskResult(s.user, task.id), '原版本'));
  const second = await saveTaskResultVersion(s.user, task.id, versionInput(randomUUID(), first.document, '后来的人工稿'));
  const found = await closeTaskResultCommand(s.user, task.id, key, { operation: 'save' });
  assert.equal(found.receipt.status, 'succeeded'); assert.equal(found.receipt.version_id, first.receipt.version_id);
  assert.equal(found.document.head_version_id, second.receipt.version_id); assert.equal(found.document.versions.length, 2);
  assert.equal((await post(s, `/tasks/${task.id}/result/commands/${key}/close`, { operation: 'accept' })).status, 409);
  assert.equal((await post(s, `/tasks/${task.id}/result/commands/${randomUUID()}/close`, { operation: 'erase' })).status, 400);
  await deleteTask(s.user, task.id);
  const deleted = await closeTaskResultCommand(s.user, task.id, key, { operation: 'save' });
  assert.equal(deleted.receipt.status, 'succeeded'); assert.equal(deleted.task_deleted, true); assert.equal(deleted.document, null);
  const absent = await closeTaskResultCommand(s.user, task.id, randomUUID(), { operation: 'save' });
  assert.equal(absent.receipt.status, 'cancelled'); assert.equal(absent.task_deleted, true);
});

for (const committed of [false, true]) for (const kind of ['create', 'result']) {
  test(`${kind} close ${committed ? 'lost ACK' : 'write failure'} remains queryable without a phantom terminal response`, async () => {
    const s = await account(), key = randomUUID(), task = kind === 'result' ? await createTask(s.user, input(randomUUID())) : null;
    const original = s.db.write.bind(s.db); let called = false;
    s.db.write = async () => { if (called) return original(); called = true; if (committed) await original(); throw new Error('synthetic close acknowledgement failure'); };
    try { await assert.rejects(kind === 'create' ? closeTaskCreationCommand(s.user, key) : closeTaskResultCommand(s.user, task.id, key, { operation: 'save' })); }
    finally { s.db.write = original; }
    clearUserDbCache(s.user);
    const query = () => kind === 'create' ? getTaskCreationReceipt(s.user, key) : getTaskResultCommand(s.user, task.id, key);
    if (committed) { const receipt = await query(); assert.equal(receipt.receipt?.status || receipt.status, 'cancelled'); }
    else await assert.rejects(query(), e => e.status === 404);
    const retried = kind === 'create' ? await closeTaskCreationCommand(s.user, key) : await closeTaskResultCommand(s.user, task.id, key, { operation: 'save' });
    assert.equal(retried.receipt?.status || retried.status, 'cancelled');
  });
}

test('successful result closure lookup still hides content after source withdrawal', async () => {
  const s = await account(), origin = randomUUID();
  s.db.data.messages.push({ id: origin, group_id: 'group-presidential', sender_type: 'user', content: '只用于这份文稿的资料', revision: 1 }); await s.db.write();
  const task = await createTask(s.user, { ...input(randomUUID()), group_id: 'group-presidential', source_message_id: origin });
  const key = randomUUID(); await saveTaskResultVersion(s.user, task.id, versionInput(key, await getTaskResult(s.user, task.id), '撤回后不得重新暴露的正文'));
  await s.db.read({ force: true }); s.db.data.messages = []; await s.db.write();
  const found = await closeTaskResultCommand(s.user, task.id, key, { operation: 'save' });
  assert.equal(found.receipt.status, 'succeeded'); assert.equal(found.document.source.status, 'blocked');
  assert.equal(found.document.versions[0].content, ''); assert.equal(found.document.versions[0].content_hidden, true);
  assert.equal((await closeTaskCreationCommand(s.user, task.client_request_id)).task.prompt, '');
});

test('closure caps preserve old receipts and reject new commands without evicting recovery history', async () => {
  const s = await account(), task = await createTask(s.user, input(randomUUID()));
  const now = new Date().toISOString();
  s.db.data.taskCreateRequests = Array.from({ length: 10000 }, () => ({ id: randomUUID(), status: 'cancelled', closed_at: now }));
  s.db.data.taskResultCommands = Array.from({ length: 10000 }, () => ({ id: randomUUID(), task_id: task.id, operation: 'save', status: 'cancelled', closed_at: now, version_id: null, committed_revision: null, committed_at: null }));
  await s.db.write();
  const createKey = s.db.data.taskCreateRequests[0].id, resultKey = s.db.data.taskResultCommands[0].id;
  await assert.rejects(closeTaskCreationCommand(s.user, randomUUID()), e => e.status === 429);
  await assert.rejects(createTask(s.user, input(randomUUID())), e => e.status === 429);
  await assert.rejects(closeTaskResultCommand(s.user, task.id, randomUUID(), { operation: 'save' }), e => e.status === 429);
  assert.equal((await closeTaskCreationCommand(s.user, createKey)).status, 'cancelled');
  assert.equal((await closeTaskResultCommand(s.user, task.id, resultKey, { operation: 'save' })).receipt.status, 'cancelled');
  await s.db.read({ force: true }); assert.equal(s.db.data.taskCreateRequests.length, 10000); assert.equal(s.db.data.taskResultCommands.length, 10000);
});

function independentWriter(user, operation, payload, taskId, hold = false, deleteAfter = false) {
  const source = `
    const { getUserDb } = await import('./src/models/db.js');
    const { createTask, deleteTask, closeTaskCreationCommand } = await import('./src/services/tasks.js');
    const { saveTaskResultVersion, closeTaskResultCommand } = await import('./src/services/taskResults.js');
    const { closeSupabaseConnection } = await import('./src/models/supabaseAdapter.js');
    const user=process.env.CLOSURE_USER, operation=process.env.CLOSURE_OPERATION, payload=JSON.parse(process.env.CLOSURE_INPUT), taskId=process.env.CLOSURE_TASK;
    const db=await getUserDb(user), read=db.read.bind(db);let first=true;
    db.read=async(...args)=>{await read(...args);if(first&&process.env.CLOSURE_HOLD==='1'){first=false;process.send({ready:true,revision:db._revision});await new Promise(resolve=>process.once('message',resolve));}};
    try {
      const value=operation==='create'?await createTask(user,payload):operation==='closeCreate'?await closeTaskCreationCommand(user,payload.key):operation==='save'?await saveTaskResultVersion(user,taskId,payload):await closeTaskResultCommand(user,taskId,payload.key,{operation:'save'});
      if(process.env.CLOSURE_DELETE==='1')await deleteTask(user,value.id);
      process.send({done:true,ok:true,value});
    } catch(error){process.send({done:true,ok:false,code:error.code,status:error.status});}
    finally{await closeSupabaseConnection();process.disconnect();}
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, CLOSURE_USER: user, CLOSURE_OPERATION: operation, CLOSURE_INPUT: JSON.stringify(payload), CLOSURE_TASK: taskId || '', CLOSURE_HOLD: hold ? '1' : '0', CLOSURE_DELETE: deleteAfter ? '1' : '0' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', readyResolve, readyReject, completed;
  child.stderr.on('data', value => { stderr += value; });
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A process which never needs the readiness signal must not create an
  // unhandled rejection while the parent is awaiting its completion instead.
  ready.catch(() => {});
  const done = new Promise((resolve, reject) => {
    child.on('message', value => { if (value.ready) readyResolve(value); if (value.done) completed = value; });
    child.once('error', error => { readyReject(error); reject(error); });
    child.once('exit', code => { if (code === 0 && completed) { if (!hold) readyResolve(); resolve(completed); } else { const error = new Error(stderr || `writer exited ${code}`); readyReject(error); reject(error); } });
  });
  return { child, ready, done, resume: () => child.send({ go: true }) };
}

if (process.env.SUPABASE_DB_URL) {
  test('ordinary catalog read cannot replace source-only create admission during an async source check', { timeout: 15000 }, async () => {
    const s = await account(), message = randomUUID();
    s.db.data.messages.push({ id: message, group_id: 'group-presidential', sender_type: 'user', content: '独立交错来源', revision: 1 }); await s.db.write();
    const payload = { ...input(randomUUID()), group_id: 'group-presidential', source_message_id: message, source_message_edited_at: null };
    // Both reads below are real SQL. Delay publication of the ordinary reader
    // until create enters its source snapshot. Without the outer barrier this
    // advances CAS while keeping create's old absent-receipt decision.
    const source = `
      const {getUserDb}=await import('./src/models/db.js');
      const {createTask}=await import('./src/services/tasks.js');
      const {readCatalog}=await import('./src/services/ai/catalog.js');
      const {getPool,closeSupabaseConnection}=await import('./src/models/supabaseAdapter.js');
      const user=process.env.SOURCE_USER,input=JSON.parse(process.env.SOURCE_INPUT),db=await getUserDb(user),pool=await getPool();
      const read=db.read.bind(db),query=pool.query.bind(pool);let count=0,holdNext=false,releaseFirst,releaseQuery,reader;
      pool.query=async(...args)=>{const result=await query(...args);if(holdNext&&typeof args[0]==='string'&&args[0].startsWith('SELECT data, revision')&&args[1]?.[0]==='user:'+user){holdNext=false;process.send({fetched:true});await new Promise(resolve=>releaseQuery=resolve);}return result;};
      db.read=async(...args)=>{await read(...args);if(++count===1){const groups=db.data.groups;Object.defineProperty(db.data,'groups',{configurable:true,enumerable:true,get(){if(releaseQuery){const resolve=releaseQuery;releaseQuery=null;resolve();}return groups;}});process.send({ready:true});await new Promise(resolve=>releaseFirst=resolve);}};
      process.on('message',message=>{if(message.startReader){holdNext=true;reader=readCatalog(user);}if(message.go)releaseFirst();});
      try{const task=await createTask(user,input);await reader;process.send({done:true,ok:true,id:task.id});}
      catch(error){await reader;process.send({done:true,ok:false,status:error.status});}
      finally{await closeSupabaseConnection();process.disconnect();}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, SOURCE_USER: s.user, SOURCE_INPUT: JSON.stringify(payload) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let readyResolve, fetchedResolve, outcome, stderr = '';
    const ready = new Promise(resolve => { readyResolve = resolve; }), fetched = new Promise(resolve => { fetchedResolve = resolve; });
    child.stderr.on('data', value => { stderr += value; });
    const done = new Promise((resolve, reject) => { child.on('message', value => { if (value.ready) readyResolve(); if (value.fetched) fetchedResolve(); if (value.done) outcome = value; }); child.once('error', reject); child.once('exit', code => outcome && code === 0 ? resolve(outcome) : reject(new Error(stderr || `writer exited ${code}`))); });
    try {
      await ready; const winner = await createTask(s.user, payload);
      child.send({ startReader: true }); await fetched; child.send({ go: true });
      const late = await done; assert.equal(late.ok, false); assert.equal(late.status, 409);
      await s.db.read({ force: true }); assert.equal(s.db.data.tasks.length, 1); assert.equal(s.db.data.taskCreateRequests.length, 1);
      assert.equal((await getTaskCreationReceipt(s.user, payload.client_request_id)).task_id, winner.id);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await Promise.allSettled([done]); }
  });

  for (const deleteAfter of [false, true]) test(`real PG stale create admission cannot ${deleteAfter ? 'revive the deleted original' : 'duplicate the same UUID'}`, { timeout: 15000 }, async () => {
    const s = await account(), key = randomUUID();
    const { capabilityFingerprint } = await import('../src/services/ai/catalog.js');
    const provider = { id: 'synthetic', name: 'synthetic', baseUrl: 'http://127.0.0.1:1/v1', protocol: 'openai', enabled: true, keyRequired: false };
    const model = { id: 'synthetic', providerId: provider.id, name: 'synthetic', model: 'synthetic', enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 2048, temperature: null };
    s.db.data.modelCatalog = { revision: 1, providers: [provider], models: [model], defaults: { chat: model.id, vision: null, tts: null } };
    s.db.data.modelCapabilityChecks = { synthetic: { chat: { status: 'verified', fingerprint: capabilityFingerprint(model, provider, s.db.data) } } }; await s.db.write();
    const payload = { ...input(key), model_id: model.id }, slow = independentWriter(s.user, 'create', payload, null, true);
    try {
      await slow.ready;
      const winner = await independentWriter(s.user, 'create', payload, null, false, deleteAfter).done; assert.equal(winner.ok, true);
      slow.resume(); const late = await slow.done; assert.equal(late.ok, false); assert.equal(late.status, 409);
      await s.db.read({ force: true }); assert.equal(s.db.data.taskCreateRequests.filter(item => item.id === key).length, 1);
      assert.equal(s.db.data.tasks.length, deleteAfter ? 0 : 1);
      const receipt = await getTaskCreationReceipt(s.user, key); assert.equal(receipt.task_id, winner.value.id); assert.equal(receipt.task_deleted, deleteAfter);
    } finally { if (slow.child.exitCode === null) slow.child.kill('SIGKILL'); await Promise.allSettled([slow.done]); }
  });

  for (const kind of ['create', 'result']) for (const closeWins of [false, true]) test(`real PG ${kind} ${closeWins ? 'close' : 'original write'} wins once against the other command`, { timeout: 15000 }, async () => {
    const s = await account(), key = randomUUID(), task = kind === 'result' ? await createTask(s.user, input(randomUUID())) : null;
    const payload = task ? versionInput(key, await getTaskResult(s.user, task.id), '单次提交的人工稿') : input(key);
    const writeOperation = kind === 'create' ? 'create' : 'save', closeOperation = kind === 'create' ? 'closeCreate' : 'closeResult';
    const slow = independentWriter(s.user, closeWins ? writeOperation : closeOperation, closeWins ? payload : { key }, task?.id, true);
    try {
      await slow.ready;
      await assert.rejects(kind === 'create' ? getTaskCreationReceipt(s.user, key) : getTaskResultCommand(s.user, task.id, key), error => error.status === 404);
      const winner = await independentWriter(s.user, closeWins ? closeOperation : writeOperation, closeWins ? { key } : payload, task?.id).done; assert.equal(winner.ok, true);
      slow.resume(); assert.equal((await slow.done).ok, false);
      const receipt = kind === 'create' ? await closeTaskCreationCommand(s.user, key) : await closeTaskResultCommand(s.user, task.id, key, { operation: 'save' });
      assert.equal(receipt.receipt?.status || receipt.status, closeWins ? 'cancelled' : 'succeeded');
      if (closeWins) await assert.rejects(task ? saveTaskResultVersion(s.user, task.id, payload) : createTask(s.user, payload), error => error.status === 410);
      await s.db.read({ force: true });
      assert.equal(kind === 'create' ? s.db.data.tasks?.length || 0 : (await getTaskResult(s.user, task.id)).versions.length, closeWins ? 0 : 1);
    } finally { if (slow.child.exitCode === null) slow.child.kill('SIGKILL'); await Promise.allSettled([slow.done]); }
  });
}
