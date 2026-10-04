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
  if (!process.env.SUPABASE_DB_URL) await provisionNewLocalMemoryAccount(userId, db);
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
    const probe = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send({ clientRequestId: crypto.randomUUID(), modelId: 'task_test', capability: 'chat' });
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

const { getTaskResult, getTaskResultCommand, saveTaskResultVersion, acceptTaskResultVersion, adoptTaskResultVersion, rebaseTaskBrief } = await import('../src/services/taskResults.js');
const { getTaskCreationReceipt } = await import('../src/services/tasks.js');
const head = doc => doc.versions.find(version => version.id === doc.head_version_id);
const saveInput = (doc, content, extra = {}) => ({ client_request_id: crypto.randomUUID(), expected_revision: doc.revision, base_version_id: doc.head_version_id, content, ...extra });
const acceptInput = doc => ({ client_request_id: crypto.randomUUID(), expected_revision: doc.revision, version_id: doc.head_version_id, content_hash: head(doc).content_hash, source_hash: doc.source.hash });
async function sources(s) {
  await mutate(s, data => data.messages.push(
    { id: crypto.randomUUID(), group_id: 'group-presidential', sender_type: 'user', sender_id: s.userId, content: '活动原定10月18日', revision: 1, created_at: '2026-10-01T08:00:00.000Z' },
    { id: crypto.randomUUID(), group_id: 'group-presidential', sender_type: 'user', sender_id: s.userId, content: '明确更正为10月20日，请以此为准', revision: 1, created_at: '2026-10-01T09:00:00.000Z' }));
  return create(s, { title: '同一份邀请稿', prompt: '请用最新资料写活动邀请', group_id: 'group-presidential' });
}

test('writing before model setup saves exact body and accepts only its immutable version', async () => {
  const s = await session(), task = await create(s), before = calls.length;
  const empty = await getTaskResult(s.userId, task.id);
  assert.equal(empty.versions.length, 0);
  const body = '  自己先写的邀请\n\n欢迎携带一本书。  ';
  const saved = await saveTaskResultVersion(s.userId, task.id, saveInput(empty, body));
  assert.equal(head(saved.document).content, body);
  assert.equal(head(saved.document).content_hash, crypto.createHash('sha256').update(body).digest('hex'));
  await assert.rejects(acceptTaskResultVersion(s.userId, task.id, { ...acceptInput(saved.document), content_hash: '0'.repeat(64) }), e => e.code === 'RESULT_REVISION_CONFLICT');
  const accepted = await acceptTaskResultVersion(s.userId, task.id, acceptInput(saved.document));
  assert.equal(accepted.document.accepted_version_id, head(saved.document).id);
  clearUserDbCache(s.userId);
  const reopened = await getTaskResult(s.userId, task.id);
  assert.equal(head(reopened).content, body); assert.equal(reopened.accepted_content_hash, head(reopened).content_hash);
  assert.equal(calls.length, before);
});

test('same invitation preserves human correction through acceptance, source change, explicit review and reopen', async () => {
  const s = await session(true), task = await sources(s);
  await runTask(s.userId, task.id);
  assert.match(JSON.stringify(calls.at(-1)), /18日/); assert.match(JSON.stringify(calls.at(-1)), /20日/);
  let doc = await getTaskResult(s.userId, task.id);
  const generated = head(doc).id, human = '10月20日邀请稿\n人工修订：请自带一件旧物，分享它的故事。';
  doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(doc, human))).document;
  const manualId = head(doc).id;
  await assert.rejects(acceptTaskResult(s.userId, task.id, generated), e => e.code === 'RESULT_VERSION_REQUIRED');
  doc = (await acceptTaskResultVersion(s.userId, task.id, acceptInput(doc))).document;
  assert.equal(doc.accepted_version_id, manualId);
  await mutate(s, data => { const message = data.messages.at(-1); message.content = '最终日期调整为10月22日'; message.revision++; message.edited_at = new Date().toISOString(); });
  doc = await getTaskResult(s.userId, task.id);
  assert.equal(doc.source.status, 'changed'); assert.equal(head(doc).content, human); assert.equal(doc.accepted_version_id, manualId);
  assert.ok(doc.source.messages.some(message => message.change === 'changed' && message.content.includes('22日')));
  doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(doc, human + '\n继续写作'))).document;
  assert.equal(doc.source.status, 'changed');
  await assert.rejects(acceptTaskResultVersion(s.userId, task.id, acceptInput(doc)), e => e.code === 'RESULT_SOURCE_CHANGED');
  doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(doc, human.replace('20日', '22日'), { reviewed_source_hash: doc.source.hash }))).document;
  assert.equal(doc.source.status, 'current');
  doc = (await acceptTaskResultVersion(s.userId, task.id, acceptInput(doc))).document;
  clearUserDbCache(s.userId); doc = await getTaskResult(s.userId, task.id);
  assert.equal(doc.task_id, task.id); assert.match(head(doc).content, /22日/); assert.match(head(doc).content, /人工修订/);
  assert.equal(doc.versions.find(version => version.id === manualId).content, human);
  assert.equal(doc.accepted_version_id, doc.head_version_id);
});

test('source removal hides all derived bodies and receipt replay never resurrects them', async () => {
  const s = await session(), task = await sources(s), doc = await getTaskResult(s.userId, task.id);
  const input = saveInput(doc, '含来源的私密邀请稿');
  const saved = await saveTaskResultVersion(s.userId, task.id, input);
  await mutate(s, data => { data.messages = []; });
  const blocked = await getTaskResult(s.userId, task.id);
  assert.equal(blocked.source.status, 'blocked'); assert.ok(blocked.versions.every(version => version.content_hidden && !version.content));
  const replay = await saveTaskResultVersion(s.userId, task.id, input);
  assert.equal(replay.receipt.id, saved.receipt.id); assert.equal(head(replay.document).content, '');
  const receipt = await getTaskResultCommand(s.userId, task.id, input.client_request_id);
  assert.equal(head(receipt.document).content, '');
  await assert.rejects(saveTaskResultVersion(s.userId, task.id, saveInput(blocked, '另存旧内容', { reviewed_source_hash: blocked.source.hash })), e => e.code === 'RESULT_SOURCE_BLOCKED');
  await assert.rejects(acceptTaskResultVersion(s.userId, task.id, acceptInput(blocked)), e => e.code === 'RESULT_SOURCE_BLOCKED');
});

test('concurrent saves compare revision; identical command replay survives eviction and task deletion', async () => {
  const s = await session(), task = await create(s), doc = await getTaskResult(s.userId, task.id);
  const first = saveInput(doc, '第一页正文'), second = saveInput(doc, '第二页正文');
  const outcomes = await Promise.allSettled([saveTaskResultVersion(s.userId, task.id, first), saveTaskResultVersion(s.userId, task.id, second)]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'RESULT_REVISION_CONFLICT');
  const winning = outcomes[0].status === 'fulfilled' ? first : second;
  const saved = outcomes.find(result => result.status === 'fulfilled').value;
  clearUserDbCache(s.userId);
  assert.equal((await saveTaskResultVersion(s.userId, task.id, winning)).receipt.version_id, saved.receipt.version_id);
  await assert.rejects(saveTaskResultVersion(s.userId, task.id, { ...winning, content: '同编号变内容' }), e => e.code === 'RESULT_IDEMPOTENCY_CONFLICT');
  await deleteTask(s.userId, task.id);
  const tombstone = await getTaskResultCommand(s.userId, task.id, winning.client_request_id);
  assert.equal(tombstone.task_deleted, true); assert.equal(tombstone.document, null);
  assert.equal((await saveTaskResultVersion(s.userId, task.id, winning)).task_deleted, true);
});

test('save lost acknowledgement restores from same receipt; failure before commit never exposes a staged version', async () => {
  const s = await session(), task = await create(s), empty = await getTaskResult(s.userId, task.id);
  const originalWrite = s.db.write.bind(s.db), input = saveInput(empty, '已到磁盘的人工句'); let loseAck = true;
  s.db.write = async () => { await originalWrite(); if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); } };
  try { await assert.rejects(saveTaskResultVersion(s.userId, task.id, input), e => e.code === 'RESULT_STORAGE_UNCERTAIN'); }
  finally { s.db.write = originalWrite; }
  const recovered = await getTaskResultCommand(s.userId, task.id, input.client_request_id);
  assert.equal(head(recovered.document).content, input.content);
  assert.equal((await saveTaskResultVersion(s.userId, task.id, input)).document.versions.length, 1);
  const failed = saveInput(recovered.document, '不该出现在目录的未提交正文');
  s.db.write = async () => { throw new Error('disk failed before commit'); };
  try { await assert.rejects(saveTaskResultVersion(s.userId, task.id, failed), e => e.code === 'RESULT_STORAGE_UNCERTAIN'); }
  finally { s.db.write = originalWrite; }
  assert.equal(head(await getTaskResult(s.userId, task.id)).content, input.content);
  await assert.rejects(getTaskResultCommand(s.userId, task.id, failed.client_request_id), e => e.code === 'RESULT_COMMAND_NOT_FOUND');
});

test('late model response is a candidate and cannot replace a concurrently saved human head', async () => {
  const s = await session(true), task = await sources(s), before = held.length;
  behavior = 'hold'; const running = runTask(s.userId, task.id);
  await eventually(() => held.length > before);
  let doc = await getTaskResult(s.userId, task.id);
  doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(doc, '等待期间手动写的完整正文'))).document;
  const human = head(doc).id;
  await assert.rejects(acceptTaskResultVersion(s.userId, task.id, acceptInput(doc)), e => e.code === 'RESULT_RUN_PENDING');
  reply(held.at(-1), '较晚回来的AI新候选'); await running; behavior = 'ok';
  doc = await getTaskResult(s.userId, task.id);
  assert.equal(doc.head_version_id, human); assert.equal(head(doc).content, '等待期间手动写的完整正文');
  const candidate = doc.versions.find(version => version.kind === 'generated'); assert.ok(candidate);
  assert.equal((await listTasks(s.userId))[0].result, head(doc).content);
  doc = (await adoptTaskResultVersion(s.userId, task.id, { client_request_id: crypto.randomUUID(), expected_revision: doc.revision, version_id: candidate.id })).document;
  assert.equal(doc.head_version_id, candidate.id); assert.equal(doc.versions.find(version => version.id === human).content, '等待期间手动写的完整正文');
  doc = (await acceptTaskResultVersion(s.userId, task.id, acceptInput(doc))).document;
  assert.equal((await listTasks(s.userId))[0].history.at(-1).status, 'accepted');
});

test('actual HTTP routes enforce account, payload, revision and idempotency boundaries', async () => {
  const alice = await session(), bob = await session(), task = await create(alice);
  const endpoint = `/api/tasks/${task.id}/result`;
  assert.equal((await request.get(endpoint).set('Cookie', bob.cookie)).status, 404);
  assert.equal((await request.get(endpoint).set('Cookie', bob.cookie).set('X-Expected-User-Id', alice.userId)).status, 409);
  const doc = (await request.get(endpoint).set('Cookie', alice.cookie)).body, input = saveInput(doc, '仅Alice可见');
  assert.equal((await request.post(endpoint + '/versions').set('Cookie', alice.cookie).send({ ...input, accepted: true })).status, 400);
  assert.equal((await request.post(endpoint + '/versions').set('Cookie', alice.cookie).set('Idempotency-Key', crypto.randomUUID()).send(input)).status, 400);
  const saved = await request.post(endpoint + '/versions').set('Cookie', alice.cookie).set('Idempotency-Key', input.client_request_id).send(input);
  assert.equal(saved.status, 200); assert.equal(saved.headers['cache-control'], 'no-store');
  assert.equal((await request.get(endpoint + '/commands/' + input.client_request_id).set('Cookie', bob.cookie)).status, 404);
  assert.equal((await request.get(endpoint + '/commands/not-a-uuid').set('Cookie', alice.cookie)).status, 400);
  const publicTasks = await request.get('/api/tasks').set('Cookie', alice.cookie);
  assert.ok(publicTasks.body.every(task => !Object.hasOwn(task, 'result_editor'))); assert.ok(!JSON.stringify(publicTasks.body).includes('input_hash'));
});

test('minimal create receipt distinguishes committed task, absent intent and deletion after reload', async () => {
  const s = await session(), requestId = crypto.randomUUID();
  await assert.rejects(getTaskCreationReceipt(s.userId, requestId), e => e.code === 'TASK_CREATE_COMMAND_NOT_FOUND');
  const task = await create(s, { client_request_id: requestId }); clearUserDbCache(s.userId);
  const receipt = await getTaskCreationReceipt(s.userId, requestId);
  assert.equal(receipt.task_id, task.id); assert.equal(receipt.task_deleted, false);
  await deleteTask(s.userId, task.id);
  const tombstone = await request.get(`/api/tasks/commands/${requestId}`).set('Cookie', s.cookie);
  assert.equal(tombstone.status, 200); assert.equal(tombstone.body.task_deleted, true); assert.equal(tombstone.body.task, null);
});

test('committed acceptance with lost acknowledgement is recovered by exact old receipt, never accepts a later draft', async () => {
  const s = await session(), task = await create(s);
  let doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(await getTaskResult(s.userId, task.id), '版本一'))).document;
  const oldVersion = doc.head_version_id, input = acceptInput(doc), write = s.db.write.bind(s.db); let fail = true;
  s.db.write = async () => { await write(); if (fail) { fail = false; throw new Error('lost accept ACK'); } };
  try { await assert.rejects(acceptTaskResultVersion(s.userId, task.id, input), e => e.code === 'RESULT_STORAGE_UNCERTAIN'); }
  finally { s.db.write = write; }
  doc = (await getTaskResultCommand(s.userId, task.id, input.client_request_id)).document;
  assert.equal(doc.accepted_version_id, oldVersion);
  doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(doc, '版本二尚未确认'))).document;
  const replay = await acceptTaskResultVersion(s.userId, task.id, input);
  assert.equal(replay.receipt.version_id, oldVersion); assert.equal(replay.document.accepted_version_id, oldVersion);
  assert.equal(replay.document.head_version_id, doc.head_version_id); assert.notEqual(doc.head_version_id, oldVersion);
  assert.equal((await listTasks(s.userId))[0].status, 'needs_review');
});

test('pending result write blocks shared catalog reader until failure restores committed state', async () => {
  const s = await session(), task = await create(s), empty = await getTaskResult(s.userId, task.id);
  const write = s.db.write.bind(s.db); let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; }), heldWrite = new Promise(resolve => { release = resolve; });
  s.db.write = async () => { entered(); await heldWrite; throw new Error('write never committed'); };
  const saving = saveTaskResultVersion(s.userId, task.id, saveInput(empty, '尚未承诺的正文'));
  await enteredPromise;
  let readFinished = false;
  const reading = readCatalog(s.userId).then(value => { readFinished = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(readFinished, false);
  release(); await assert.rejects(saving, e => e.code === 'RESULT_STORAGE_UNCERTAIN'); s.db.write = write;
  await reading;
  assert.equal((await getTaskResult(s.userId, task.id)).versions.length, 0);
});

test('explicit brief update binds changed origin for a new candidate without replacing human content', async () => {
  const s = await session(true); await sources(s);
  const originMessage = s.db.data.messages.at(-1);
  const task = await create(s, { title: '消息发起的邀请', prompt: '以20日材料写邀请', group_id: 'group-presidential', source_message_id: originMessage.id, source_message_edited_at: null });
  let doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(await getTaskResult(s.userId, task.id), '人工邀请保留'))).document;
  await mutate(s, data => { const message = data.messages.find(message => message.id === originMessage.id); message.content = '日期22日'; message.revision++; message.edited_at = new Date().toISOString(); });
  await assert.rejects(runTask(s.userId, task.id), e => e.code === 'TASK_SOURCE_CHANGED');
  doc = await getTaskResult(s.userId, task.id);
  const rebased = await rebaseTaskBrief(s.userId, task.id, { client_request_id: crypto.randomUUID(), expected_revision: doc.revision, prompt: '按22日材料写新候选', source_hash: doc.source.hash });
  assert.equal(head(rebased.document).content, '人工邀请保留'); assert.equal(rebased.document.source.status, 'changed');
  await runTask(s.userId, task.id);
  doc = await getTaskResult(s.userId, task.id);
  assert.equal(head(doc).content, '人工邀请保留'); assert.equal(doc.versions.filter(version => version.kind === 'generated').length, 1);
  assert.match(JSON.stringify(calls.at(-1)), /按22日材料写新候选/);
});

test('legacy generated body without source identity fails closed on changed hash, but known empty source set remains editable', async () => {
  const s = await session(true), task = await sources(s); await runTask(s.userId, task.id);
  await mutate(s, data => { const stored = data.tasks.find(value => value.id === task.id); delete stored.result_editor; delete stored.history.at(-1).source_messages; });
  assert.equal(head(await getTaskResult(s.userId, task.id)).content_hidden, false);
  await mutate(s, data => { data.messages = []; });
  const blocked = await getTaskResult(s.userId, task.id);
  assert.equal(blocked.source.status, 'blocked'); assert.equal(head(blocked).content, '');
  await assert.rejects(saveTaskResultVersion(s.userId, task.id, saveInput(blocked, '洗回旧内容', { reviewed_source_hash: blocked.source.hash })), e => e.code === 'RESULT_SOURCE_BLOCKED');
  const emptyTask = await create(s, { group_id: 'group-debate' });
  let doc = (await saveTaskResultVersion(s.userId, emptyTask.id, saveInput(await getTaskResult(s.userId, emptyTask.id), '先写空白会话的人工稿'))).document;
  await mutate(s, data => data.messages.push({ id: crypto.randomUUID(), group_id: 'group-debate', sender_type: 'user', content: '后来补的资料', revision: 1 }));
  doc = await getTaskResult(s.userId, emptyTask.id);
  assert.equal(doc.source.status, 'changed'); assert.equal(head(doc).content_hidden, false);
  assert.equal((await listTasks(s.userId)).find(task => task.id === emptyTask.id).source_stale, true);
});

if (process.env.SUPABASE_DB_URL) test('independent PostgreSQL writers cannot commit two bodies from the same document revision', async () => {
  const { spawn } = await import('node:child_process');
  const s = await session(), task = await create(s), doc = await getTaskResult(s.userId, task.id);
  const inputs = [saveInput(doc, '独立进程A正文'), saveInput(doc, '独立进程B正文')];
  const source = `
    import { getUserDb } from './src/models/db.js';
    import { saveTaskResultVersion } from './src/services/taskResults.js';
    import { closeSupabaseConnection } from './src/models/supabaseAdapter.js';
    const user=process.env.RESULT_TEST_USER, task=process.env.RESULT_TEST_TASK;
    const db=await getUserDb(user), write=db.write.bind(db); let first=true;
    db.write=async()=>{ if(first){first=false;process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));} return write(); };
    try { const response=await saveTaskResultVersion(user,task,JSON.parse(process.env.RESULT_TEST_INPUT));process.send({done:true,ok:true,receipt:response.receipt}); }
    catch(error){process.send({done:true,ok:false,code:error.code,status:error.status});}
    finally{await closeSupabaseConnection();process.disconnect();}
  `;
  const children = [], completions = [], ready = [];
  try {
    for (const input of inputs) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, RESULT_TEST_USER: s.userId, RESULT_TEST_TASK: task.id, RESULT_TEST_INPUT: JSON.stringify(input) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      let stderr = ''; child.stderr.on('data', value => { stderr += value; });
      ready.push(new Promise((resolve, reject) => { child.on('message', value => { if (value.ready) resolve(); }); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(stderr || `child exit ${code}`)); }); }));
      completions.push(new Promise((resolve, reject) => { let outcome; child.on('message', value => { if (value.done) outcome = value; }); child.once('error', reject); child.once('exit', code => outcome && code === 0 ? resolve(outcome) : reject(new Error(stderr || `child exited ${code} without result`))); }));
    }
    let timeout;
    const deadline = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('independent result writers exceeded deadline')), 10000); });
    try {
      await Promise.race([Promise.all(ready), deadline]); children.forEach(child => child.send({go:true}));
      const outcomes = await Promise.race([Promise.all(completions), deadline]);
      assert.equal(outcomes.filter(value => value.ok).length, 1);
      assert.equal(outcomes.find(value => !value.ok).code, 'RESULT_STORAGE_UNCERTAIN');
      clearUserDbCache(s.userId); const current = await getTaskResult(s.userId, task.id);
      assert.equal(current.versions.length, 1); assert.equal(current.revision, 1);
      const winner = outcomes.findIndex(value => value.ok), loser = 1 - winner;
      assert.equal(head(current).content, inputs[winner].content);
      assert.equal((await getTaskResultCommand(s.userId, task.id, inputs[winner].client_request_id)).receipt.version_id, current.head_version_id);
      await assert.rejects(getTaskResultCommand(s.userId, task.id, inputs[loser].client_request_id), e => e.code === 'RESULT_COMMAND_NOT_FOUND');
      await assert.rejects(saveTaskResultVersion(s.userId, task.id, inputs[loser]), e => e.code === 'RESULT_REVISION_CONFLICT');
    } finally { clearTimeout(timeout); }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.allSettled(completions);
  }
});

test('reviewed manual body and old generation brief expose independent source states in task summaries', async () => {
  const s = await session(); await sources(s); const message = s.db.data.messages.at(-1);
  const task = await create(s, { group_id: message.group_id, source_message_id: message.id, source_message_edited_at: null });
  let doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(await getTaskResult(s.userId, task.id), '人工稿保留'))).document;
  await mutate(s, data => { const source = data.messages.find(value => value.id === message.id); source.content = '22日'; source.revision++; source.edited_at = new Date().toISOString(); });
  doc = await getTaskResult(s.userId, task.id);
  doc = (await saveTaskResultVersion(s.userId, task.id, saveInput(doc, '人工稿22日保留', { reviewed_source_hash: doc.source.hash }))).document;
  await acceptTaskResultVersion(s.userId, task.id, acceptInput(doc));
  const summary = (await listTasks(s.userId)).find(value => value.id === task.id);
  assert.equal(summary.source_stale, false); assert.equal(summary.source_input_stale, true);
  assert.equal(summary.result, '人工稿22日保留'); assert.equal(summary.status, 'completed');
  assert.equal(summary.result_head_version_id, summary.result_accepted_version_id); assert.equal(summary.accepted_run_id, null);
});

test('revoking original message outside current40 context still hides manual body in legacy task summaries', async () => {
  const s = await session(); const origin = crypto.randomUUID();
  await mutate(s, data => data.messages.push({ id: origin, group_id: 'group-presidential', sender_type: 'user', content: '原始来源', revision: 1 }, ...Array.from({length:40},(_,index)=>({id:crypto.randomUUID(),group_id:'group-presidential',sender_type:'user',content:`后续材料${index}`,revision:1}))));
  const task = await create(s,{group_id:'group-presidential',source_message_id:origin,source_message_edited_at:null});
  let doc=(await saveTaskResultVersion(s.userId,task.id,saveInput(await getTaskResult(s.userId,task.id),'不能在删源后泄露的人工正文'))).document;
  await acceptTaskResultVersion(s.userId,task.id,acceptInput(doc));
  await mutate(s,data=>{data.messages=data.messages.filter(message=>message.id!==origin);});
  const summary=(await listTasks(s.userId))[0];assert.equal(summary.source_stale,true);assert.equal(summary.result,'');
  doc=await getTaskResult(s.userId,task.id);assert.equal(doc.source.status,'blocked');assert.equal(head(doc).content,'');
});
