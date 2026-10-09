import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
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
let streamGate = null;
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
  calls.push({ mode, stream: body.stream, model: body.model, messages: body.messages });
  if (!body.stream) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ system_prompt: 'Synthetic assistant. No external actions.' }) } }] }));
    return;
  }
  if (streamGate) { const gate = streamGate; gate.enter(); await gate.promise; }
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

const { initDatabase, initUserDatabase, getUserDb, clearUserDbCache } = await import('../src/models/db.js');
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
  let agentId, secondAgentId;
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
    secondAgentId = defaulted.body.id;
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

  for (const sender of ['user', 'agent']) {
    for (const committed of [false, true]) {
      await t.test(`${sender} write failure (${committed ? 'lost acknowledgement' : 'not committed'}): history reflects disk and never auto-retries`, async () => {
        mode = 'success';
        await db.read({ force: true });
        const before = await readMessages(request), callsBefore = calls.length;
        const originalWrite = db.adapter.write.bind(db.adapter);
        let injected = 0;
        db.adapter.write = async data => {
          const candidate = data.agent_messages.at(-1);
          if (!injected && candidate?.sender_type === sender) {
            injected++;
            if (committed) await originalWrite(data);
            throw Object.assign(new Error('Synthetic storage write failure'), { code: 'ENOSPC' });
          }
          return originalWrite(data);
        };
        let response;
        try {
          response = await request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: `Synthetic ${sender} storage ${committed}` });
        } finally { db.adapter.write = originalWrite; }
        assert.equal(injected, 1);
        const events = response.text.split('\n\n').filter(Boolean).map(event => event.slice(6)).map(event => event === '[DONE]' ? event : JSON.parse(event));
        assert.equal(events.filter(event => event.error).length, 1);
        assert.equal(events.filter(event => event === '[DONE]').length, 1);
        assert.equal(events.map(event => event.content || '').join(''), sender === 'agent' ? complete : '');
        assert.equal(calls.length - callsBefore, sender === 'agent' ? 1 : 0, 'storage failure must never trigger a provider retry');
        const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'users', `db_${userId}.json`), 'utf8'));
        const saved = disk.agent_messages.filter(message => message.agent_id === agentId);
        assert.equal(saved.length - before.length, (sender === 'agent' ? 1 : 0) + (committed ? 1 : 0));
        assert.deepEqual(await readMessages(request), saved, 'GET must not expose a cached row that never reached disk');
        assert.deepEqual(JSON.parse(JSON.stringify(db.data.agent_messages.filter(message => message.agent_id === agentId))), saved);
      });
    }
  }

  for (const sender of ['user', 'agent']) {
    for (const committed of [false, true]) {
      await t.test(`${sender} pending write (${committed ? 'lost acknowledgement' : 'not committed'}): concurrent history, same-account group write and another agent preserve durable truth`, async () => {
        mode = 'success';
        await db.read({ force: true });
        const before = await readMessages(request), callsBefore = calls.length;
        const groupId = db.data.groups[0].id, pinned = !db.data.groups[0].pinned;
        const originalWrite = db.adapter.write.bind(db.adapter);
        let enter, release;
        const entered = new Promise(resolve => { enter = resolve; });
        const released = new Promise(resolve => { release = resolve; });
        let injected = false, historySettled = false;
        db.adapter.write = async data => {
          const candidate = data.agent_messages.at(-1);
          if (!injected && candidate?.agent_id === agentId && candidate.sender_type === sender) {
            injected = true;
            enter();
            await released;
            if (committed) await originalWrite(data);
            throw new Error('Synthetic pending write failure');
          }
          return originalWrite(data);
        };
        const pending = request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: `Pending ${sender} ${committed}` }).then(value => value);
        await entered;
        const history = readMessages(request).then(value => { historySettled = true; return value; });
        const otherWrite = request.put(`/api/groups/${groupId}/pin`).set('Cookie', cookies).send({ pinned }).then(value => value);
        const otherAgent = request.post(`/api/agents/${secondAgentId}/chat`).set('Cookie', cookies).send({ message: `Other agent ${sender} ${committed}` }).then(value => value);
        let settledBeforeWrite, results;
        try {
          await delay(30);
          settledBeforeWrite = historySettled;
          release();
          results = await Promise.all([pending, history, otherWrite, otherAgent]);
        } finally { release(); db.adapter.write = originalWrite; }
        assert.equal(settledBeforeWrite, false, 'history must wait for the in-flight write result');
        assert.match(results[0].text, /"error"/);
        assert.equal(results[2].status, 200);
        assert.equal(results[3].status, 200);
        assert.ok(!results[3].text.includes('"error"'));
        const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'users', `db_${userId}.json`), 'utf8'));
        const saved = disk.agent_messages.filter(message => message.agent_id === agentId);
        assert.equal(saved.length - before.length, (sender === 'agent' ? 1 : 0) + (committed ? 1 : 0));
        assert.deepEqual(results[1], saved);
        assert.deepEqual(await readMessages(request), saved);
        assert.equal(disk.groups.find(group => group.id === groupId).pinned, pinned, 'recovery must not undo the queued group write');
        const others = disk.agent_messages.filter(message => message.agent_id === secondAgentId);
        assert.equal(others.at(-2).content, `Other agent ${sender} ${committed}`);
        assert.equal(others.at(-1).content, complete);
        assert.equal(calls.length - callsBefore, sender === 'agent' ? 2 : 1);
      });
    }
  }
  for (const committed of [false, true]) {
    await t.test(`assistant write failure followed by failed reload (${committed ? 'lost acknowledgement' : 'not committed'}) never serves a guessed snapshot`, async () => {
      mode = 'success';
      await db.read({ force: true });
      const originalWrite = db.adapter.write.bind(db.adapter), originalRead = db.adapter.read.bind(db.adapter);
      let injected = false;
      db.adapter.write = async data => {
        if (!injected && data.agent_messages.at(-1)?.sender_type === 'agent') {
          injected = true;
          if (committed) await originalWrite(data);
          throw new Error('Synthetic write failure before recovery read');
        }
        return originalWrite(data);
      };
      try {
        const response = await request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: `Read recovery ${committed}` });
        assert.match(response.text, /"error"/);
        db.adapter.write = originalWrite;
        db.adapter.read = async () => { throw new Error('Synthetic unavailable durable snapshot'); };
        for (let attempt = 0; attempt < 2; attempt++) {
          const failedRead = await request.get(`/api/agents/${agentId}/messages`).set('Cookie', cookies);
          assert.ok(failedRead.status >= 500);
          assert.ok(!Array.isArray(failedRead.body), 'unavailable storage must not return cached success');
        }
      } finally { db.adapter.write = originalWrite; db.adapter.read = originalRead; }
      const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'users', `db_${userId}.json`), 'utf8'));
      assert.deepEqual(await readMessages(request), disk.agent_messages.filter(message => message.agent_id === agentId));
    });
  }

  await t.test('history started before a failing append never serializes a ghost across 36 microtask timings', async () => {
    const micro = n => n === 0 ? Promise.resolve() : Promise.resolve().then(() => micro(n - 1));
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    const originalRead = db.adapter.read.bind(db.adapter), originalWrite = db.adapter.write.bind(db.adapter);
    const callsBefore = calls.length;
    for (let writerDelay = 0; writerDelay < 6; writerDelay++) {
      for (let readerDelay = 0; readerDelay < 6; readerDelay++) {
        await db.read({ force: true });
        const first = deferred(), both = deferred(), entered = deferred(), release = deferred();
        let reads = 0;
        db.adapter.read = async () => {
          const data = await originalRead(), index = reads++;
          if (index === 0) first.resolve();
          if (index < 2) {
            if (index === 1) both.resolve();
            await both.promise;
            await micro(index === 0 ? writerDelay : readerDelay);
          }
          return data;
        };
        db.adapter.write = async () => { entered.resolve(); await release.promise; throw new Error('Synthetic microtask write failure'); };
        const content = `Synthetic microtask ghost ${writerDelay} ${readerDelay}`;
        const chat = request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: content }).then(value => value);
        let history, responses;
        try {
          await first.promise;
          db.invalidateReadCache();
          history = request.get(`/api/agents/${agentId}/messages`).set('Cookie', cookies).then(value => value);
          await entered.promise;
          await new Promise(resolve => setImmediate(resolve));
          release.resolve();
          responses = await Promise.all([chat, history]);
        } finally {
          release.resolve();
          await Promise.allSettled([chat, history]);
          db.adapter.read = originalRead; db.adapter.write = originalWrite;
        }
        assert.match(responses[0].text, /"error"/);
        assert.equal(responses[1].status, 200);
        assert.ok(!responses[1].body.some(message => message.content === content), `ghost returned at writer=${writerDelay}, reader=${readerDelay}`);
      }
    }
    assert.equal(calls.length, callsBefore, 'a rejected user-message write never reaches the provider');
  });

  await t.test('suggestions never send an uncommitted concurrent message to the local provider across 36 read timings', async () => {
    const micro = n => n === 0 ? Promise.resolve() : Promise.resolve().then(() => micro(n - 1));
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    await db.read({ force: true });
    db.data.agents.find(agent => agent.id === agentId).enable_suggestions = true;
    await db.write();
    const originalRead = db.adapter.read.bind(db.adapter), originalWrite = db.adapter.write.bind(db.adapter);
    const leaks = [];
    for (let writerDelay = 0; writerDelay < 6; writerDelay++) {
      for (let readerDelay = 0; readerDelay < 6; readerDelay++) {
        await db.read({ force: true });
        const callsBefore = calls.length;
        const first = deferred(), both = deferred(), entered = deferred(), release = deferred();
        let reads = 0;
        db.adapter.read = async () => {
          const data = await originalRead(), index = reads++;
          if (index === 0) first.resolve();
          if (index < 2) {
            if (index === 1) both.resolve();
            await both.promise;
            await micro(index === 0 ? writerDelay : readerDelay);
          }
          return data;
        };
        db.adapter.write = async () => { entered.resolve(); await release.promise; throw new Error('Synthetic suggestions source write failure'); };
        const content = `Synthetic suggestion ghost ${writerDelay} ${readerDelay}`;
        const chat = request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: content }).then(value => value);
        let suggestions, responses;
        try {
          await first.promise;
          db.invalidateReadCache();
          suggestions = request.get(`/api/agents/${agentId}/suggestions`).set('Cookie', cookies).then(value => value);
          await entered.promise;
          await new Promise(resolve => setImmediate(resolve));
          release.resolve();
          responses = await Promise.all([chat, suggestions]);
        } finally {
          release.resolve();
          await Promise.allSettled([chat, suggestions]);
          db.adapter.read = originalRead; db.adapter.write = originalWrite;
        }
        assert.match(responses[0].text, /"error"/);
        assert.equal(responses[1].status, 200);
        assert.equal(calls.length - callsBefore, 1);
        if (JSON.stringify(calls.at(-1).messages).includes(content)) leaks.push({ writerDelay, readerDelay });
      }
    }
    assert.deepEqual(leaks, [], 'model prompts must never contain a message whose write did not commit');
  });

  await t.test('chat never sends an uncommitted concurrent message in recent history across 72 read timings', async () => {
    const micro = n => n === 0 ? Promise.resolve() : Promise.resolve().then(() => micro(n - 1));
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    await db.read({ force: true });
    const baseline = structuredClone(db.data.agent_messages);
    const originalRead = db.adapter.read.bind(db.adapter), originalWrite = db.adapter.write.bind(db.adapter);
    const leaks = [];
    for (let historyDelay = 0; historyDelay < 12; historyDelay++) {
      for (let writerDelay = 0; writerDelay < 6; writerDelay++) {
        await db.read({ force: true });
        db.data.agent_messages = structuredClone(baseline);
        await db.write();
        const first = deferred(), both = deferred(), entered = deferred(), release = deferred();
        const original = `Synthetic accepted input ${historyDelay} ${writerDelay}`;
        const ghost = `Synthetic chat-context ghost ${historyDelay} ${writerDelay}`;
        const callsBefore = calls.length;
        let armHistory = false, reads = 0;
        db.adapter.read = async () => {
          const data = await originalRead();
          if (armHistory) {
            const index = reads++;
            if (index === 0) first.resolve();
            if (index < 2) {
              if (index === 1) both.resolve();
              await both.promise;
              await micro(index === 0 ? historyDelay : writerDelay);
            }
          }
          return data;
        };
        db.adapter.write = async data => {
          const candidate = data.agent_messages.at(-1);
          if (candidate?.content === ghost) { entered.resolve(); await release.promise; throw new Error('Synthetic concurrent chat source write failure'); }
          if (candidate?.content === original) {
            // Ensure the production cache observes a later write timestamp, so
            // its next history read reaches the real adapter deterministically.
            await delay(2);
            await originalWrite(data);
            armHistory = true;
            return;
          }
          return originalWrite(data);
        };
        const main = request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: original }).then(value => value);
        let concurrent, responses;
        try {
          await first.promise;
          concurrent = request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: ghost }).then(value => value);
          await entered.promise;
          await new Promise(resolve => setImmediate(resolve));
          release.resolve();
          responses = await Promise.all([main, concurrent]);
        } finally {
          release.resolve();
          await Promise.allSettled([main, concurrent]);
          db.adapter.read = originalRead; db.adapter.write = originalWrite;
        }
        assert.equal(responses[0].status, 200);
        assert.ok(!responses[0].text.includes('"error"'));
        assert.match(responses[1].text, /"error"/);
        assert.equal(calls.length - callsBefore, 1);
        if (JSON.stringify(calls.at(-1).messages).includes(ghost)) leaks.push({ historyDelay, writerDelay });
      }
    }
    assert.deepEqual(leaks, [], 'chat model history must exclude a concurrent message that never committed');
  });

  for (const replacement of ['explicit clear', 'natural LRU', 'restored source']) {
    await t.test(`${replacement}: late old chat fails visibly and never overwrites the active account instance`, async () => {
      mode = 'success';
      const active = await getUserDb(userId);
      await active.read({ force: true });
      const diskPath = path.join(dataDir, 'users', `db_${userId}.json`);
      const baseline = JSON.parse(await fs.readFile(diskPath, 'utf8'));
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      streamGate = { enter: entered, promise: gate };
      const late = request.post(`/api/agents/${agentId}/chat`).set('Cookie', cookies).send({ message: `Retired ${replacement} input` }).then(value => value);
      let current;
      try {
        await started;
        streamGate = null;
        if (replacement === 'natural LRU') {
          // Existing production eviction threshold, exercised with isolated
          // synthetic accounts while the chat is awaiting its local provider.
          for (let index = 0; index < 51; index++) await initUserDatabase(randomUUID());
        } else {
          clearUserDbCache(userId);
          if (replacement === 'restored source') await fs.writeFile(diskPath, JSON.stringify(baseline));
        }
        current = await getUserDb(userId);
        assert.notEqual(current, active);
        const groupId = current.data.groups[0].id;
        assert.equal((await request.put(`/api/groups/${groupId}/pin`).set('Cookie', cookies).send({ pinned: true })).status, 200);
        await current.read({ force: true });
        release();
        const response = await late;
        assert.match(response.text, /"error"/);
        assert.ok(response.text.includes(complete), 'already received response text remains available despite uncertain storage');
        const savedBefore = JSON.parse(await fs.readFile(diskPath, 'utf8'));
        assert.equal(savedBefore.agent_messages.length, baseline.agent_messages.length + (replacement === 'restored source' ? 0 : 1));
        assert.equal((await request.put(`/api/groups/${groupId}/pin`).set('Cookie', cookies).send({ pinned: false })).status, 200);
        const savedAfter = JSON.parse(await fs.readFile(diskPath, 'utf8'));
        assert.deepEqual(savedAfter.agent_messages, savedBefore.agent_messages);
        await assert.rejects(active.write(), error => error.code === 'USER_DB_REPLACED');
        await assert.rejects(active.read(), error => error.code === 'USER_DB_REPLACED');
        assert.equal(savedAfter.groups.find(group => group.id === groupId).pinned, false);
      } finally { streamGate = null; release(); await late; }
    });
  }
});
