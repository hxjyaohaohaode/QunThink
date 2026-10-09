// Actual task service + isolated LowDB, synthetic Axios transport. No socket,
// real account, API key, model request, or external database is used.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
for (const key of Object.keys(process.env)) if (!['PATH', 'HOME', 'TMP', 'TEMP'].includes(key)) delete process.env[key];
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-task-db-lifecycle-'));
Object.assign(process.env, { NODE_ENV: 'test', AUTH_MODE: 'session', DATA_DIR: dir,
  AUTH_DB_PATH: path.join(dir, 'auth.json'), ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  AI_ALLOWED_LOCAL_ORIGINS: 'http://127.0.0.1:55555', AI_HEALTH_PROBES: '0' });
const { initDatabase, initUserDatabase, getUserDb, clearUserDbCache, withWriteLock } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { saveCatalog, readCatalog, recordCapabilityProbe } = await import('../src/services/ai/catalog.js');
const { createTask, runTask, listTasks, updateTask, resolveUnknownTaskRun,
  startTaskScheduler, stopTaskScheduler, tickTasks } = await import('../src/services/tasks.js');
const axios = (await import('axios')).default;
await initDatabase(); await initAuthDb();
for (let i = 0; i < 51; i++) await initUserDatabase(`synthetic-pressure-${i}`);
await startTaskScheduler();
after(async () => { stopTaskScheduler(); await fs.rm(dir, { recursive: true, force: true }); });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = p => p.then(value => ({ value }), error => ({ error }));
const content = 'Synthetic successfully generated response';
let calls = 0, wait = null, providerError = false;
axios.defaults.adapter = async config => {
  calls++;
  const held = wait;
  if (held) { held.entered.resolve(); await held.release.promise; }
  if (providerError) throw Object.assign(new Error('Synthetic transport loss'), { code: 'ECONNRESET' });
  return { status: 200, statusText: 'OK', headers: {}, config,
    data: { choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } } };
};
async function fresh() {
  const user = randomUUID(), db = await initUserDatabase(user);
  await provisionNewLocalMemoryAccount(user, db);
  const catalog = await readCatalog(user);
  catalog.providers.push({ id: 'synthetic', name: 'Synthetic', baseUrl: 'http://127.0.0.1:55555/v1', protocol: 'openai', enabled: true, keyRequired: false });
  catalog.models.push({ id: 'synthetic', providerId: 'synthetic', name: 'Synthetic', model: 'fake', enabled: true,
    capabilities: ['chat'], contextWindow: 32000, maxTokens: 1024, temperature: null });
  catalog.defaults.chat = 'synthetic'; await saveCatalog(user, catalog);
  await recordCapabilityProbe(user, 'synthetic', 'chat', { verified: true, responseTime: 1 });
  const task = await createTask(user, { title: 'Synthetic task', prompt: 'Synthetic prompt', client_request_id: randomUUID() });
  return { user, db, task };
}
async function heldRun(s) {
  providerError = false;
  const gate = { entered: deferred(), release: deferred() }; wait = gate;
  const requestId = randomUUID(), beforeCalls = calls;
  const running = settle(runTask(s.user, s.task.id, { client_request_id: requestId }));
  await gate.entered.promise;
  return { ...gate, requestId, beforeCalls, running };
}
async function snapshot(s) { return (await listTasks(s.user)).find(t => t.id === s.task.id); }
async function disk(s) { return JSON.parse(await fs.readFile(path.join(dir, 'users', `db_${s.user}.json`), 'utf8')); }
async function mutate(s, change) {
  return withWriteLock(s.user, async () => { const db = await getUserDb(s.user); await db.read({ force: true }); change(db.data); await db.write(); });
}

test('normal scheduler sweep preserves an active task response, one receipt/history/version and future work', { timeout: 10000 }, async () => {
  const s = await fresh(), gate = await heldRun(s);
  try {
    await tickTasks();
    assert.equal(await getUserDb(s.user), s.db, 'active provider wait must not lose its canonical handle');
    await mutate(s, data => { data.userProfile.nickname = 'concurrent edit survives'; });
    gate.release.resolve(); wait = null;
    const result = await gate.running; assert.ifError(result.error);
    assert.equal(result.value.status, 'needs_review'); assert.equal(result.value.result, content);
    const saved = await snapshot(s), raw = await disk(s);
    assert.equal(saved.history.length, 1); assert.equal(saved.history[0].client_request_id, gate.requestId);
    assert.equal(saved.history[0].result, content); assert.equal(saved.run_count, 1);
    assert.equal(saved.dispatch_status, 'sent_or_unknown'); assert.equal(raw.taskDailyBudget.count, 1);
    assert.equal(raw.tasks[0].result_editor.versions.length, 1);
    assert.equal(raw.taskCreateRequests.filter(r => r.task_id === s.task.id).length, 1);
    assert.equal(raw.userProfile.nickname, 'concurrent edit survives');
    await runTask(s.user, s.task.id, { client_request_id: gate.requestId });
    assert.equal(calls, gate.beforeCalls + 1, 'same intent must never resend');
    const next = await createTask(s.user, { title: 'Next task', prompt: 'Another synthetic prompt' });
    assert.equal((await runTask(s.user, next.id, { client_request_id: randomUUID() })).status, 'needs_review');
    assert.equal(calls, gate.beforeCalls + 2);
    await tickTasks(); await assert.rejects(s.db.read(), e => e.code === 'USER_DB_REPLACED');
  } finally { wait = null; gate.release.resolve(); await gate.running; }
});

for (const mode of ['clear', 'global clear', 'deleted task', 'changed run']) test(`explicit ${mode} never attaches old content or resurrects a run`, { timeout: 10000 }, async () => {
  const s = await fresh(), gate = await heldRun(s);
  try {
    clearUserDbCache(mode === 'global clear' ? undefined : s.user);
    const current = await getUserDb(s.user); assert.notEqual(current, s.db);
    let replacementRun;
    await mutate(s, data => {
      data.userProfile.nickname = 'replacement data';
      if (mode === 'deleted task') data.tasks = [];
      if (mode === 'changed run') { replacementRun = randomUUID(); data.tasks[0].run_id = replacementRun; }
    });
    gate.release.resolve(); wait = null;
    const result = await gate.running; assert.equal(result.error?.code, 'USER_DB_REPLACED');
    assert.equal(calls, gate.beforeCalls + 1);
    const saved = await snapshot(s), raw = await disk(s);
    assert.equal(raw.userProfile.nickname, 'replacement data');
    if (mode === 'deleted task') assert.equal(saved, undefined);
    else if (mode === 'changed run') {
      assert.equal(saved.run_id, replacementRun); assert.equal(saved.status, 'running'); assert.equal(saved.history.length, 0);
    } else {
      assert.equal(saved.status, 'outcome_unknown'); assert.equal(saved.result, '');
      assert.equal(saved.history.length, 1); assert.equal(saved.history[0].result, ''); assert.equal(saved.run_count, 1);
      await runTask(s.user, s.task.id, { client_request_id: gate.requestId });
      assert.equal(calls, gate.beforeCalls + 1, 'refresh/replay cannot resend the paid effect');
      await resolveUnknownTaskRun(s.user, s.task.id, 'abandon', saved.run_id);
      const next = await createTask(s.user, { title: 'Next after recovery', prompt: 'Synthetic prompt' });
      assert.equal((await runTask(s.user, next.id)).status, 'needs_review');
    }
    await assert.rejects(s.db.write(), e => e.code === 'USER_DB_REPLACED');
  } finally { wait = null; gate.release.resolve(); await gate.running; }
});

for (const mode of ['provider failure', 'stop']) test(`${mode} under scheduler pressure releases hold and never double-dispatches`, { timeout: 10000 }, async () => {
  const s = await fresh(), gate = await heldRun(s);
  try {
    await tickTasks();
    if (mode === 'stop') {
      const state = await snapshot(s);
      await updateTask(s.user, s.task.id, { status: 'cancelled', run_id: state.run_id });
    } else providerError = true;
    gate.release.resolve(); wait = null;
    const result = await gate.running; assert.ifError(result.error);
    const saved = await snapshot(s);
    assert.equal(saved.status, 'outcome_unknown'); assert.equal(saved.history.length, 1); assert.equal(saved.run_count, 1);
    assert.equal(calls, gate.beforeCalls + 1);
    await tickTasks(); await assert.rejects(s.db.read(), e => e.code === 'USER_DB_REPLACED');
  } finally { wait = null; providerError = false; gate.release.resolve(); await gate.running; }
});

test('clear after admission commit but before acknowledgement closes the not-sent checkpoint', { timeout: 10000 }, async () => {
  const s = await fresh(), beforeCalls = calls;
  const write = s.db.adapter.write.bind(s.db.adapter); let injected = false;
  s.db.adapter.write = async data => {
    await write(data);
    if (!injected && data.tasks[0].status === 'running' && data.tasks[0].dispatch_status === 'not_sent') {
      injected = true; clearUserDbCache(s.user);
    }
  };
  const result = await settle(runTask(s.user, s.task.id, { client_request_id: randomUUID() }));
  assert.equal(result.error?.code, 'USER_DB_REPLACED'); assert.equal(calls, beforeCalls);
  const saved = await snapshot(s);
  assert.equal(saved.status, 'failed'); assert.equal(saved.dispatch_status, 'not_sent');
  assert.equal(saved.history.length, 1); assert.equal(saved.history[0].status, 'failed'); assert.equal(saved.history[0].dispatch_status, 'not_sent');
  assert.equal(saved.run_count, 1);
  const next = await createTask(s.user, { title: 'Next after admission failure', prompt: 'Synthetic prompt' });
  assert.equal((await runTask(s.user, next.id)).status, 'needs_review'); assert.equal(calls, beforeCalls + 1);
});
