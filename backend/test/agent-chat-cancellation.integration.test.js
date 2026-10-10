import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Synthetic account and keyless loopback provider only. Never inherit real
// providers, database URLs, dotenv configuration or auth/deletion-ledger paths.
const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const key of Object.keys(process.env)) delete process.env[key];
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-agent-chat-cancellation-'));
Object.assign(process.env, inherited, {
  NODE_ENV: 'test', AUTH_MODE: 'session', DATA_DIR: dataDir,
  AUTH_DB_PATH: path.join(dataDir, 'auth.json'),
  MEMORY_DELETION_DIR: path.join(dataDir, 'memory-deletions'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  QUNTHINK_SHARED_PROVIDER_KEYS: '0', AI_HEALTH_PROBES: '0',
  QUNTHINK_GOAL_BRIEF_SCHEDULER: '0'
});

// Every request is against this keyless local fixture; no live model is called.
let mode = 'partial';
const calls = [];
const provider = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, undefined);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const call = { body: JSON.parse(raw), closed: false, finish: () => res.end('data: [DONE]\n\n') };
  calls.push(call);
  res.on('close', () => { call.closed = true; });
  if (!call.body.stream) {
    if (mode === 'annotation-wait') return;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '描述:合成附件\n标签:测试' } }] })); return;
  }
  if (mode === 'before-token') return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '合成部分回答' } }] })}\n\n`);
  if (mode === 'complete') res.end('data: [DONE]\n\n');
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
process.env.AI_ALLOWED_LOCAL_ORIGINS = `http://127.0.0.1:${provider.address().port}`;
const { initDatabase, getUserDb } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { recordCapabilityProbe } = await import('../src/services/ai/catalog.js');
const { chatWithAgent } = await import('../src/services/agent/index.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;
await initDatabase(); await initAuthDb();
const app = createTestApp(), request = supertest(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await check()) return; await delay(10); }
  assert.fail(message);
}
async function account(name) {
  const registered = await request.post('/api/auth/register').send({ username: name, password: 'SyntheticOnly-Chat!', nickname: 'Synthetic test' });
  assert.equal(registered.status, 201);
  const userId = registered.body.user.id, db = await getUserDb(userId);
  db.data.modelCatalog = {
    revision: 1,
    providers: [{ id: 'fixture', name: 'Synthetic loopback', protocol: 'openai', baseUrl: process.env.AI_ALLOWED_LOCAL_ORIGINS, enabled: true, keyRequired: false }],
    models: [{ id: 'fixture', providerId: 'fixture', name: 'fixture', model: 'fixture', enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 4096, temperature: null, tokenParameter: 'max_tokens' }],
    defaults: { chat: 'fixture', vision: null, tts: null }
  };
  // Deliberately identical agent ID in different account stores.
  db.data.agents = [{ id: 'shared-agent-id', name: 'Synthetic agent', description: 'Test', system_prompt: 'Synthetic assistant', model_roles: [{ modelId: 'fixture', role: '主回复' }] }];
  await db.write();
  await recordCapabilityProbe(userId, 'fixture', 'chat', { verified: true, responseTime: 0 });
  return { userId, cookie: registered.headers['set-cookie'].map(value => value.split(';')[0]).join('; '), db };
}
async function history(user) {
  const res = await request.get('/api/agents/shared-agent-id/messages').set('Cookie', user.cookie);
  assert.equal(res.status, 200); return res.body;
}
async function start(user, withFiles = false) {
  const controller = new AbortController();
  const before = calls.length;
  let body, headers;
  if (withFiles) {
    body = new FormData(); body.set('message', 'Synthetic attachment'); body.set('files', new Blob(['Synthetic document content for an isolated fixture.'], { type: 'text/plain' }), 'fixture.txt');
    headers = { Cookie: user.cookie };
  } else {
    body = JSON.stringify({ message: 'Synthetic input' }); headers = { Cookie: user.cookie, 'Content-Type': 'application/json' };
  }
  const encoded = new Request(`${origin}/api/agents/shared-agent-id/${withFiles ? 'chat-with-files' : 'chat'}`, { method: 'POST', headers, body });
  const bytes = Buffer.from(await encoded.arrayBuffer());
  const result = new Promise((resolve, reject) => {
    const req = httpRequest(encoded.url, { method: 'POST', headers: Object.fromEntries(encoded.headers), signal: controller.signal }, res => resolve({ body: Readable.toWeb(res) }));
    req.on('error', reject); req.end(bytes);
  });
  // Attach rejection handling before aborting a request with no response headers.
  result.catch(() => {});
  await until(() => calls.slice(before).some(call => mode === 'annotation-wait' || call.body.stream), 'local provider was not dispatched');
  const call = calls.slice(before).find(call => mode === 'annotation-wait' || call.body.stream);
  return { controller, result, call };
}

test('agent cancellation closes upstream, preserves truthful history, and permits a new explicit send', async t => {
  const user = await account('cancel_account');
  await t.test('already-aborted request never persists or dispatches', async () => {
    const controller = new AbortController(); controller.abort();
    const count = calls.length;
    await assert.rejects(chatWithAgent(user.userId, 'shared-agent-id', 'Do not send', null, [], controller.signal));
    assert.equal(calls.length, count); assert.deepEqual(await history(user), []);
  });
  await t.test('disconnect before first token closes provider without empty assistant success', async () => {
    mode = 'before-token';
    const pending = await start(user); pending.controller.abort();
    await assert.rejects(pending.result);
    await until(() => pending.call.closed, 'upstream remained open after client disconnect');
    assert.equal((await history(user)).length, 1);
    assert.equal((await history(user))[0].sender_type, 'user');
  });
  for (const withFiles of [false, true]) {
    await t.test(`disconnect after partial output (${withFiles ? 'multipart' : 'JSON'}) saves stopped marker once`, async () => {
      mode = 'partial';
      const count = (await history(user)).length;
      const pending = await start(user, withFiles);
      const response = await pending.result;
      const reader = response.body.getReader();
      const chunk = await reader.read();
      assert.match(new TextDecoder().decode(chunk.value), /合成部分回答/);
      pending.controller.abort();
      await reader.cancel().catch(() => {});
      await until(() => pending.call.closed, 'partial provider stream remained open');
      await until(async () => (await history(user)).length === count + 2, 'stopped reply was not saved');
      const rows = await history(user);
      assert.equal(rows.at(-1).content, '合成部分回答\n\n[生成已停止]');
      assert.equal(rows.at(-1).response_state, 'incomplete');
      assert.equal(rows.at(-1).response_error, '生成已停止');
      if (withFiles) await until(async () => (await fs.readdir(path.join(dataDir, 'uploads', user.userId)).catch(() => [])).length === 0, 'temporary attachment not removed');
    });
  }
  await t.test('disconnect while annotating attachments aborts both calls and never starts a reply', async () => {
    mode = 'annotation-wait'; const before = calls.length, rowsBefore = (await history(user)).length;
    const pending = await start(user, true);
    await until(() => calls.length === before + 2, 'expected two annotation calls');
    pending.controller.abort(); await assert.rejects(pending.result);
    await until(() => calls.slice(before).every(call => call.closed), 'annotation requests stayed open');
    await until(async () => (await fs.readdir(path.join(dataDir, 'uploads', user.userId))).length === 0, 'temporary attachment not removed');
    assert.equal(calls.length, before + 2); assert.ok(calls.slice(before).every(call => !call.body.stream));
    assert.equal((await history(user)).length, rowsBefore);
  });
  await t.test('explicit new send completes normally without retrying stopped input', async () => {
    mode = 'complete'; const count = calls.length;
    const res = await request.post('/api/agents/shared-agent-id/chat').set('Cookie', user.cookie).send({ message: 'New explicit input' });
    assert.equal(res.status, 200); assert.ok(!res.text.includes('"error"'));
    assert.equal(calls.length, count + 1); assert.equal((await history(user)).at(-1).content, '合成部分回答');
  });
});

test('deleting an agent during generation never resurrects messages or cancels a different account', async () => {
  const a = await account('delete_account_a'), b = await account('delete_account_b');
  mode = 'partial';
  const first = await start(a), second = await start(b);
  const firstResponse = await first.result, secondResponse = await second.result;
  const firstReader = firstResponse.body.getReader(), secondReader = secondResponse.body.getReader();
  await firstReader.read(); await secondReader.read();
  const removed = await request.delete('/api/agents/shared-agent-id').set('Cookie', a.cookie);
  assert.equal(removed.status, 200);
  await until(() => first.call.closed, 'deleted agent provider still running');
  assert.equal(second.call.closed, false, 'same agent ID in another account must remain live');
  const result = await firstReader.read();
  assert.match(new TextDecoder().decode(result.value), /已删除/);
  await firstReader.cancel();
  assert.deepEqual(await history(a), []);
  const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'users', `db_${a.userId}.json`), 'utf8'));
  assert.deepEqual(disk.agents, []); assert.deepEqual(disk.agent_messages, []);
  second.controller.abort(); await secondReader.cancel().catch(() => {});
  await until(() => second.call.closed, 'second provider did not stop');
  await until(async () => (await history(b)).length === 2, 'other-account partial reply missing');
  assert.equal((await history(b)).at(-1).content, '合成部分回答\n\n[生成已停止]');
});


test('a reply released after deletion cannot write orphan history back to disk', async () => {
  const user = await account('delete_late_result'); mode = 'partial';
  const pending = await start(user), response = await pending.result;
  const reader = response.body.getReader(); await reader.read();
  assert.equal((await request.delete('/api/agents/shared-agent-id').set('Cookie', user.cookie)).status, 200);
  pending.call.finish();
  while (!(await reader.read()).done) { /* Drain the route's terminal outcome. */ }
  assert.deepEqual(await history(user), [], 'late response resurrected deleted agent history');
  const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'users', `db_${user.userId}.json`), 'utf8'));
  assert.deepEqual(disk.agent_messages, []);
});

test('overlength multipart message removes uploaded temporary files without dispatch', async () => {
  const user = await account('review_invalid_upload'), callsBefore = calls.length;
  const response = await request.post('/api/agents/shared-agent-id/chat-with-files')
    .set('Cookie', user.cookie).field('message', 'x'.repeat(8001))
    .attach('files', Buffer.from('Synthetic rejected attachment'), 'rejected.txt');
  assert.equal(response.status, 400);
  const files = await fs.readdir(path.join(dataDir, 'uploads', user.userId));
  assert.deepEqual(files, [], 'rejected request left uploaded file on disk');
  assert.equal(calls.length, callsBefore);
  assert.deepEqual(await history(user), []);
});
