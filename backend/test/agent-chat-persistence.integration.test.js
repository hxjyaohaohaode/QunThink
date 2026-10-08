import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Synthetic account and keyless loopback provider only. Never inherit real
// providers, database URLs, dotenv configuration or auth/deletion-ledger paths.
const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
for (const key of Object.keys(process.env)) delete process.env[key];
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-agent-chat-persistence-'));
Object.assign(process.env, inherited, {
  NODE_ENV: 'test', AUTH_MODE: 'session', DATA_DIR: dataDir,
  AUTH_DB_PATH: path.join(dataDir, 'auth.json'),
  MEMORY_DELETION_DIR: path.join(dataDir, 'memory-deletions'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  QUNTHINK_SHARED_PROVIDER_KEYS: '0', AI_HEALTH_PROBES: '0',
  QUNTHINK_GOAL_BRIEF_SCHEDULER: '0'
});

let mode = 'success';
const calls = [];
const partial = '部分回答：汉字🙂';
const complete = '完整回答：汉字🙂';
const suffix = '\n\n[连接中断，回复未完成]';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const provider = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, undefined);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  calls.push({ mode, stream: body.stream, model: body.model });
  if (!body.stream) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ system_prompt: 'Synthetic assistant. No external actions.' }) } }] }));
    return;
  }
  if (mode === 'http_failure') { res.writeHead(503); res.end('{}'); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  if (mode === 'empty_eof') { res.end(); return; }
  const bytes = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: mode === 'success' ? complete : partial } }] })}\n\n`);
  // Split inside a three-byte character, not merely between JSON/SSE events.
  const split = bytes.indexOf(Buffer.from('汉')) + 1;
  res.write(bytes.subarray(0, split));
  await delay(20);
  res.write(bytes.subarray(split));
  await delay(30);
  if (mode === 'socket_failure') { res.destroy(); return; }
  if (mode === 'error_event') { res.end('data: {"error":{"message":"synthetic failure"}}\n\n'); return; }
  if (mode === 'clean_eof') { res.end(); return; }
  res.end('data: [DONE]\n\n');
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
process.env.AI_ALLOWED_LOCAL_ORIGINS = `http://127.0.0.1:${provider.address().port}`;
after(async () => {
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
});

const { initDatabase, getUserDb } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { recordCapabilityProbe } = await import('../src/services/ai/catalog.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const supertest = (await import('supertest')).default;
await initDatabase();
await initAuthDb();

// This established test app mounts the real auth and agent routes, but omits
// production CSRF/rate middleware. Catalog capability is an explicit fixture,
// not a claim about model-center probing or real provider/model quality.
test('agent route streaming matches saved replies without duplicate interruption tails', async t => {
  const request = supertest(createTestApp());
  const registration = await request.post('/api/auth/register').send({ username: 'synthetic_chat_persistence', password: 'SyntheticOnly-Chat!', nickname: 'Synthetic test' });
  assert.equal(registration.status, 201);
  const cookies = registration.headers['set-cookie'];
  const userId = registration.body.user.id;
  const db = await getUserDb(userId);
  const model = id => ({ id, providerId: 'fixture', name: id, model: id, enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 4096, temperature: null, tokenParameter: 'max_tokens' });
  db.data.modelCatalog = {
    revision: 1,
    providers: [{ id: 'fixture', name: 'Synthetic loopback', protocol: 'openai', baseUrl: process.env.AI_ALLOWED_LOCAL_ORIGINS, enabled: true, keyRequired: false }],
    models: [model('fixture-selected'), model('fixture-default')],
    defaults: { chat: 'fixture-default', vision: null, tts: null }
  };
  await db.write();
  for (const id of ['fixture-selected', 'fixture-default']) await recordCapabilityProbe(userId, id, 'chat', { verified: true, responseTime: 0 });
  let agentId;
  await t.test('selected and default model creation persist through real routes', async () => {
    const fields = { description: 'Synthetic persistence test', openingMessage: 'Synthetic hello', enableSuggestions: false, capabilities: {} };
    const selected = await request.post('/api/agents').set('Cookie', cookies).send({ ...fields, name: 'Selected', modelId: 'fixture-selected' });
    const defaulted = await request.post('/api/agents').set('Cookie', cookies).send({ ...fields, name: 'Default' });
    assert.equal(selected.status, 200);
    assert.equal(defaulted.status, 200);
    assert.equal(selected.body.model_roles[0].modelId, 'fixture-selected');
    assert.equal(defaulted.body.model_roles[0].modelId, 'fixture-default');
    assert.deepEqual(calls.map(call => call.model), ['fixture-selected', 'fixture-default']);
    agentId = selected.body.id;
  });
  const readMessages = async client => {
    const response = await client.get(`/api/agents/${agentId}/messages`).set('Cookie', cookies);
    assert.equal(response.status, 200);
    return response.body;
  };
  for (const nextMode of ['success', 'http_failure', 'socket_failure', 'error_event', 'clean_eof', 'empty_eof']) {
    await t.test(`${nextMode}: real route SSE and durable rows agree`, async () => {
      mode = nextMode;
      const before = await readMessages(request);
      const response = await request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: `Synthetic ${mode}` });
      assert.equal(response.status, 200);
      assert.match(response.headers['content-type'], /text\/event-stream/);
      const events = response.text.split('\n\n').filter(Boolean).map(event => event.slice(6)).map(event => event === '[DONE]' ? event : JSON.parse(event));
      assert.equal(events.filter(event => event === '[DONE]').length, 1);
      assert.equal(events.at(-1), '[DONE]');
      const added = (await readMessages(request)).slice(before.length);
      assert.equal(added[0].sender_type, 'user');
      assert.equal(added[0].content, `Synthetic ${mode}`);
      const joined = events.map(event => event.content || '').join('');
      if (mode === 'http_failure' || mode === 'empty_eof') {
        assert.equal(added.length, 1);
        assert.equal(events.filter(event => event.error).length, 1);
        assert.equal(joined, '');
      } else {
        assert.equal(added.length, 2);
        assert.equal(added[1].sender_type, 'agent');
        const expected = mode === 'success' ? complete : partial + suffix;
        assert.equal(added[1].content, expected);
        assert.equal(joined, expected);
        assert.equal(events.filter(event => event.error).length, 0);
        assert.equal(events.filter(event => event.content === suffix).length, mode === 'success' ? 0 : 1);
        assert.ok(!joined.includes('\uFFFD'), 'split UTF-8 must not introduce replacement characters');
      }
      const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'users', `db_${userId}.json`), 'utf8'));
      assert.deepEqual(disk.agent_messages.filter(message => message.agent_id === agentId), await readMessages(request));
    });
  }
  await t.test('new route app and disk retain all 2 agents and 10 messages', async () => {
    const reloaded = await readMessages(supertest(createTestApp()));
    assert.deepEqual(reloaded, await readMessages(request));
    assert.equal(reloaded.length, 10);
    const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'users', `db_${userId}.json`), 'utf8'));
    assert.equal(disk.agents.length, 2);
    assert.equal(disk.agent_messages.length, 10);
    assert.equal(calls.length, 8);
    assert.equal(calls.filter(call => call.stream).length, 6);
  });
});
