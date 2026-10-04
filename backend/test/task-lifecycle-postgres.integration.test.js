import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';


if (!process.env.QUNTHINK_TEST_PG_URL) {
  test('real PgLow task lifecycle (requires isolated QUNTHINK_TEST_PG_URL)', { skip: true }, () => {});
} else {
  const pgUrl = new URL(process.env.QUNTHINK_TEST_PG_URL);
  pgUrl.searchParams.set('sslmode', 'disable');
  process.env.SUPABASE_DB_URL = pgUrl.toString();
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
  // PgLow does not use the local deletion ledger.
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


const { closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
after(async ()=>closeSupabaseConnection());

test('real PgLow retains dispatch checkpoint across catalog re-reads and bound cancellation', async () => {
  const s=await session(true), task=await create(s), before=calls.length;
  behavior='hold'; const heldBefore=held.length;
  const running=runTask(s.userId,task.id);
  await eventually(()=>held.length>heldBefore);
  assert.equal(calls.length,before+1);
  const during=(await listTasks(s.userId))[0];
  const cancelled=await updateTask(s.userId,task.id,{status:'cancelled',run_id:during.run_id});
  await running;
  assert.equal(cancelled.history.at(-1).dispatch_status, 'sent_or_unknown');
  assert.equal(during.dispatch_status,'sent_or_unknown');
  assert.equal(cancelled.status,'outcome_unknown');
});

}
