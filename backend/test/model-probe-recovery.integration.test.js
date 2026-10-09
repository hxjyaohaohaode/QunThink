import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-model-probes-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { initDatabase, initUserDatabase, getUserDb, withWriteLock, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const { readCatalog, saveCatalog, resolveModel } = await import('../src/services/ai/catalog.js');
const { MODEL_PROBE_LIMITS } = await import('../src/services/ai/modelProbes.js');
const request = (await import('supertest')).default(createTestApp());
await initDatabase(); await initAuthDb();

const calls = [], held = [];
let behavior = async (req, res) => reply(res);
function reply(res, content = 'OK') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
}
async function color(body) {
  const url = body.messages.at(-1).content.find(item => item.type === 'image_url').image_url.url;
  const pixel = (await sharp(Buffer.from(url.split(',')[1], 'base64')).raw().toBuffer()).subarray(0, 3);
  return pixel[0] > pixel[2] ? '红色' : '蓝色';
}
const provider = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls.push({ body, url: req.url }); await behavior(req, res, body);
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const origin = `http://127.0.0.1:${provider.address().port}`;
process.env.AI_ALLOWED_LOCAL_ORIGINS = origin;
after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
async function session() {
  const userId = crypto.randomUUID(), token = generateSessionToken(); await initUserDatabase(userId);
  const auth = getAuthDb(); await auth.read();
  auth.data.users.push({ id: userId, username: userId, password: 'unused' });
  auth.data.sessions.push({ token, userId, expires_at: new Date(Date.now() + 3600000).toISOString() }); await auth.write();
  const catalog = await readCatalog(userId);
  catalog.providers.push({ id: 'probe_provider', name: '本地模拟', baseUrl: `${origin}/v1`, protocol: 'openai', enabled: true, keyRequired: true, apiKey: 'mock-provider-private-sentinel' });
  for (const id of ['probe_a', 'probe_b', 'probe_c']) catalog.models.push({ id, providerId: 'probe_provider', name: id, model: id, enabled: true,
    capabilities: ['chat', 'vision', 'tts'], contextWindow: 32000, maxTokens: 2048, temperature: null });
  await saveCatalog(userId, catalog); behavior = async (req, res) => reply(res);
  return { userId, cookie: `session_token=${token}` };
}
const input = (extra = {}) => ({ clientRequestId: crypto.randomUUID(), modelId: 'probe_a', capability: 'chat', ...extra });
const post = (s, body) => request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).send(body);
const get = (s, id) => request.get(`/api/user/model-catalog/tests/${id}`).set('Cookie', s.cookie);
async function eventually(fn) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Local test condition was not reached');
}
async function mutate(s, fn) {
  return withWriteLock(s.userId, async () => {
    const db = await getUserDb(s.userId); await db.read({ force: true }); fn(db.data); await db.write();
  });
}
const unverified = (s, cap = 'chat') => assert.rejects(resolveModel(s.userId, 'probe_a', cap), error => error.status === 409);

// Local mock HTTP only: no real provider keys, paid calls, or user data.
test('UUIDs are required and header/body must agree; status is private and no-store', async () => {
  const s = await session(), before = calls.length;
  for (const body of [{ modelId: 'probe_a' }, input({ clientRequestId: 'bad' }), input({ capability: 'video' })]) assert.equal((await post(s, body)).status, 400);
  assert.equal((await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).set('Idempotency-Key', crypto.randomUUID()).send(input())).status, 400);
  assert.equal(calls.length, before);
  const id = crypto.randomUUID(), body = input(); delete body.clientRequestId;
  const success = await request.post('/api/user/model-catalog/test').set('Cookie', s.cookie).set('Idempotency-Key', id.toUpperCase()).send(body);
  assert.equal(success.status, 200); assert.equal(success.body.requestId, id); assert.equal(success.body.healthy, true);
  const lookup = await get(s, id.toUpperCase()); assert.equal(lookup.headers['cache-control'], 'no-store');
  assert.equal((await get(await session(), id)).status, 404); assert.equal((await get(s, 'bad')).status, 400);
  const persisted = JSON.stringify((await getUserDb(s.userId)).data.modelProbeLedger);
  for (const value of ['mock-provider-private-sentinel', origin, 'Authorization', '请回复']) assert.ok(!persisted.includes(value));
  for (const value of ['mock-provider-private-sentinel', origin, 'fingerprint', 'inputHash']) assert.ok(!JSON.stringify(lookup.body).includes(value));
});

test('concurrent same-key/input replays one call and alias UUIDs survive completion/cache eviction', async () => {
  const s = await session(), body = input(), alias = input(), before = calls.length;
  behavior = async (req, res) => { held.push(res); };
  const pending = post(s, body).then(result => result); await eventually(() => held.length);
  const results = await Promise.all([post(s, body), post(s, body), post(s, alias)]);
  assert.ok(results.every(result => result.status === 202 && result.body.requestId === body.clientRequestId && result.body.status === 'running'));
  assert.equal(calls.length, before + 1);
  assert.equal((await post(s, { ...body, modelId: 'probe_b' })).status, 409);
  assert.equal((await post(s, { ...body, capability: 'vision' })).status, 409);
  reply(held.shift()); assert.equal((await pending).body.healthy, true); clearUserDbCache(s.userId);
  const replay = await post(s, alias); assert.equal(replay.status, 200); assert.equal(replay.body.requestId, body.clientRequestId);
  assert.equal((await get(s, alias.clientRequestId)).body.status, 'succeeded'); assert.equal(calls.length, before + 1);
});

test('disconnect/5xx/408 remain unknown and block all same-input repeats after reload', async () => {
  for (const failure of ['disconnect', 503, 408]) {
    const s = await session(), body = input(); assert.equal((await post(s, input())).body.healthy, true);
    behavior = async (req, res) => { if (failure === 'disconnect') req.socket.destroy(); else { res.writeHead(failure); res.end('mock-provider-private-sentinel'); } };
    const before = calls.length, failed = await post(s, body);
    assert.equal(failed.status, 202); assert.equal(failed.body.status, 'unknown'); assert.equal(failed.body.possibleCharge, true);
    assert.ok(!failed.body.error.includes('sentinel')); await unverified(s); clearUserDbCache(s.userId);
    const alias = input(), replay = await post(s, alias); assert.equal(replay.body.requestId, body.clientRequestId);
    assert.equal((await get(s, alias.clientRequestId)).body.status, 'unknown'); assert.equal(calls.length, before + 1);
  }
});

test('received rejections/empty output fail verification; same-ID retry never sends again', async () => {
  for (const failure of [401, 429, 'empty']) {
    const s = await session(), body = input(), before = calls.length;
    behavior = async (req, res) => { if (failure === 'empty') reply(res, ''); else { res.writeHead(failure); res.end('mock-provider-private-sentinel'); } };
    const failed = await post(s, body); assert.equal(failed.status, 502); assert.equal(failed.body.status, 'failed'); assert.equal(failed.body.possibleCharge, true);
    assert.equal((await post(s, body)).body.status, 'failed'); await unverified(s); assert.equal(calls.length, before + 1);
  }
});

test('partial vision success then lost second response is unknown and neither sample is repeated', async () => {
  const s = await session(), body = input({ capability: 'vision' }), before = calls.length; let samples = 0;
  behavior = async (req, res, body) => { if (++samples === 2) req.socket.destroy(); else reply(res, await color(body)); };
  const result = await post(s, body); assert.equal(result.status, 202); assert.equal(result.body.status, 'unknown'); assert.equal(samples, 2); await unverified(s, 'vision');
  assert.equal((await post(s, input({ capability: 'vision' }))).body.requestId, body.clientRequestId); assert.equal(calls.length, before + 2);
  const effect = (await getUserDb(s.userId)).data.modelProbeLedger.effects[0]; assert.equal(effect.dispatches, 2); assert.equal(effect.receipts, 1);
});

test('wrong second vision sample is a known charged failure; two valid samples verify', async () => {
  const s = await session(); let samples = 0;
  behavior = async (req, res, body) => reply(res, ++samples === 2 ? '绿色' : await color(body));
  const failed = await post(s, input({ capability: 'vision' })); assert.equal(failed.status, 502); assert.equal(failed.body.possibleCharge, true); await unverified(s, 'vision');
  behavior = async (req, res, body) => reply(res, await color(body)); assert.equal((await post(s, input({ capability: 'vision' }))).body.healthy, true);
});

test('configuration changes between vision samples block the second paid request', async () => {
  const s = await session(), before = calls.length;
  behavior = async (req, res, body) => { held.push({ res, body }); };
  const pending = post(s, input({ capability: 'vision' })).then(result => result); await eventually(() => held.length);
  const catalog = await readCatalog(s.userId); catalog.models.find(model => model.id === 'probe_a').model = 'replacement_model'; await saveCatalog(s.userId, catalog);
  const item = held.shift(); reply(item.res, await color(item.body)); const stale = await pending;
  assert.equal(stale.status, 409); assert.equal(stale.body.stale, true); assert.equal(calls.length, before + 1); await unverified(s, 'vision');
});

test('stale failure cannot revoke a newer credential fingerprint successful verification', async () => {
  const s = await session(), old = input(); behavior = async (req, res) => { held.push(res); };
  const pending = post(s, old).then(result => result); await eventually(() => held.length);
  const catalog = await readCatalog(s.userId); catalog.providers.find(provider => provider.id === 'probe_provider').apiKey = 'new-mock-private-sentinel'; await saveCatalog(s.userId, catalog);
  behavior = async (req, res) => reply(res); const current = await post(s, input()); assert.equal(current.body.healthy, true);
  held.shift().destroy(); assert.equal((await pending).body.status, 'unknown'); assert.equal((await get(s, current.body.requestId)).body.healthy, true);
  assert.equal((await resolveModel(s.userId, 'probe_a', 'chat')).apiKey, 'new-mock-private-sentinel');
  const replay = await post(s, old); assert.equal(replay.body.stale, true); assert.equal(replay.body.healthy, false);
});

test('browser cancellation stops waiting, while the bounded probe finishes without duplicates', async () => {
  const s = await session(), body = input(), before = calls.length; behavior = async (req, res) => { held.push(res); };
  const server = createTestApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${server.address().port}/api/user/model-catalog/test`, {
      method: 'POST', headers: { Cookie: s.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal
    }).catch(error => error);
    await eventually(() => held.length); controller.abort(); await pending;
    const retry = await post(s, input()); assert.equal(retry.body.requestId, body.clientRequestId); assert.equal(retry.body.status, 'running');
    reply(held.shift()); await eventually(async () => (await get(s, body.clientRequestId)).body.status === 'succeeded'); assert.equal(calls.length, before + 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('actual process termination after dispatch recovers unknown after deadline without resend', async () => {
  const s = await session(), body = input(), before = calls.length; behavior = async (req, res) => { held.push(res); };
  const child = spawn(process.execPath, ['--input-type=module', '-e', `const { runModelProbe } = await import('./src/services/ai/modelProbes.js'); await runModelProbe(${JSON.stringify(s.userId)}, ${JSON.stringify(body)});`], { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  try {
    await eventually(() => held.length || child.exitCode !== null); assert.equal(child.exitCode, null, stderr);
    child.kill('SIGKILL'); await once(child, 'exit'); clearUserDbCache(s.userId);
    assert.equal((await get(s, body.clientRequestId)).body.status, 'running');
    await mutate(s, data => { data.modelProbeLedger.effects[0].deadlineAt = Date.now() - 1; });
    const recovered = await get(s, body.clientRequestId); assert.equal(recovered.body.status, 'unknown'); assert.equal(recovered.body.possibleCharge, true);
    assert.equal((await post(s, input())).body.requestId, body.clientRequestId); assert.equal(calls.length, before + 1); await unverified(s); held.shift().destroy();
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } }
});

test('late success cannot promote an expired pending effect out of unknown', async () => {
  const s = await session(), body = input(); behavior = async (req, res) => { held.push(res); };
  const pending = post(s, body).then(result => result); await eventually(() => held.length);
  await mutate(s, data => { data.modelProbeLedger.effects[0].deadlineAt = Date.now() - 1; });
  assert.equal((await get(s, body.clientRequestId)).body.status, 'unknown'); reply(held.shift()); assert.equal((await pending).body.status, 'unknown'); await unverified(s);
});

test('claim/CAS and dispatch checkpoint write failures send zero provider requests', async () => {
  for (const failWrite of [1, 2]) {
    const s = await session(), body = input(), before = calls.length, db = await getUserDb(s.userId), original = db.write; let writes = 0;
    db.write = async function () { if (++writes === failWrite) throw Object.assign(new Error('mock-storage-private-sentinel'), { code: 'REVISION_CONFLICT' }); return original.call(this); };
    const result = await post(s, body); db.write = original;
    assert.equal(await getUserDb(s.userId), db, 'write failure must not strand queued writers with an evicted DB instance');
    assert.equal(result.status, failWrite === 1 ? 503 : 502); assert.equal(calls.length, before); await unverified(s); assert.ok(!JSON.stringify(result.body).includes('private-sentinel'));
  }
});

test('claim committed without ACK replays only, then expires before dispatch', async () => {
  const s = await session(), body = input(), before = calls.length, db = await getUserDb(s.userId), original = db.write; let first = true;
  db.write = async function () { await original.call(this); if (first) { first = false; throw new Error('lost ACK'); } };
  assert.equal((await post(s, body)).status, 503); db.write = original; assert.equal(calls.length, before);
  const replay = await post(s, body); assert.equal(replay.body.status, 'running'); assert.equal(replay.body.possibleCharge, false);
  await mutate(s, data => { data.modelProbeLedger.effects[0].deadlineAt = Date.now() - 1; });
  assert.equal((await get(s, body.clientRequestId)).body.status, 'failed'); assert.equal((await post(s, body)).body.status, 'failed'); assert.equal(calls.length, before);
});

test('failed final save stays unknown; committed lost ACK recovers by query without resend', async () => {
  for (const committed of [false, true]) {
    const s = await session(), body = input(), db = await getUserDb(s.userId), original = db.write, before = calls.length; let writes = 0;
    db.write = async function () { if (++writes === 3) { if (committed) await original.call(this); throw new Error('final-write-private-sentinel'); } return original.call(this); };
    const response = await post(s, body); db.write = original; assert.equal(response.status, 202); assert.equal(response.body.status, 'unknown');
    const lookup = await get(s, body.clientRequestId); assert.equal(lookup.body.status, committed ? 'succeeded' : 'running');
    if (committed) assert.equal(lookup.body.healthy, true);
    else { await unverified(s); await mutate(s, data => { data.modelProbeLedger.effects[0].deadlineAt = Date.now() - 1; }); assert.equal((await post(s, input())).body.requestId, body.clientRequestId); }
    assert.equal((await post(s, body)).body.status, committed ? 'succeeded' : 'unknown'); assert.equal(calls.length, before + 1);
  }
});

test('rate/storage/concurrency bounds never evict old identities', async () => {
  const s = await session(), body = input(); assert.equal((await post(s, body)).status, 200);
  for (let i = 1; i < MODEL_PROBE_LIMITS.perMinute; i++) assert.equal((await post(s, input())).status, 200);
  const before = calls.length; assert.equal((await post(s, input())).status, 429); assert.equal((await post(s, body)).status, 200); assert.equal(calls.length, before);
  await mutate(s, data => {
    const template = data.modelProbeLedger.effects[0];
    data.modelProbeLedger.effects = Array.from({ length: MODEL_PROBE_LIMITS.effects }, (_, i) => {
      const id = i === 0 ? body.clientRequestId : crypto.randomUUID(); return { ...template, id, requests: [{ id }], createdAt: Date.now() - 86400000 * 2, updatedAt: Date.now() - 86400000 * 2 };
    });
  });
  assert.equal((await post(s, input())).status, 429); assert.equal((await post(s, body)).status, 200); assert.equal(calls.length, before);
  const concurrent = await session(); behavior = async (req, res) => { held.push(res); };
  const first = post(concurrent, input()).then(result => result), second = post(concurrent, input({ modelId: 'probe_b' })).then(result => result);
  await eventually(() => held.length === 2); assert.equal((await post(concurrent, input({ modelId: 'probe_c' }))).status, 429);
  reply(held.shift()); reply(held.shift()); await Promise.all([first, second]);
});

test('corrupt ledger fails closed without leaking content or calling a provider', async () => {
  const s = await session(), before = calls.length;
  await mutate(s, data => { data.modelProbeLedger = { version: 1, effects: 'mock-provider-private-sentinel' }; });
  assert.equal((await post(s, input())).status, 503); const lookup = await get(s, crypto.randomUUID());
  assert.equal(lookup.status, 503); assert.ok(!JSON.stringify(lookup.body).includes('sentinel')); assert.equal(calls.length, before);
});

test('real HTTP response timeout stays unknown, with exactly one provider call', async () => {
  const s = await session(), body = input(), before = calls.length;
  behavior = async (req, res) => { held.push(res); };
  const response = await post(s, body);
  assert.equal(response.status, 202); assert.equal(response.body.status, 'unknown'); assert.equal(response.body.possibleCharge, true);
  assert.equal((await post(s, input())).body.requestId, body.clientRequestId); assert.equal(calls.length, before + 1);
  held.shift().destroy(); await unverified(s);
});

function wav() {
  const value = Buffer.alloc(44 + 512); value.write('RIFF', 0); value.writeUInt32LE(value.length - 8, 4); value.write('WAVE', 8);
  value.write('fmt ', 12); value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20); value.writeUInt16LE(1, 22);
  value.writeUInt32LE(16000, 24); value.writeUInt32LE(32000, 28); value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34);
  value.write('data', 36); value.writeUInt32LE(512, 40); return value;
}
test('both TTS modes validate actual mock audio and never transmit arbitrary user inputs', async () => {
  for (const mode of ['speech', 'chat-audio']) {
    const s = await session(), before = calls.length, catalog = await readCatalog(s.userId);
    catalog.models.find(model => model.id === 'probe_a').ttsMode = mode; await saveCatalog(s.userId, catalog);
    let valid = false;
    behavior = async (req, res, body) => {
      assert.ok(!JSON.stringify(body).includes('private-user-sentinel'));
      const audio = valid ? wav() : Buffer.alloc(512);
      if (mode === 'speech') { assert.equal(req.url, '/v1/audio/speech'); res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(audio); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { audio: { data: audio.toString('base64') } } }] })); }
    };
    const failed = await post(s, input({ capability: 'tts', prompt: 'private-user-sentinel', text: 'private-user-sentinel' }));
    assert.equal(failed.status, 502); await unverified(s, 'tts'); valid = true;
    const body = input({ capability: 'tts' }); assert.equal((await post(s, body)).body.healthy, true);
    assert.equal((await post(s, body)).body.healthy, true); assert.equal(calls.length, before + 2);
  }
});

test('daily and alias identity caps fail closed but preserve canonical status lookup', async () => {
  const s = await session(), body = input(); assert.equal((await post(s, body)).status, 200); const before = calls.length;
  await mutate(s, data => {
    const template = data.modelProbeLedger.effects[0], now = Date.now();
    data.modelProbeLedger.effects = Array.from({ length: MODEL_PROBE_LIMITS.perDay }, (_, i) => {
      const id = i === 0 ? body.clientRequestId : crypto.randomUUID();
      return { ...template, id, requests: [{ id }], createdAt: now - 120000, updatedAt: now - 120000 };
    });
  });
  assert.equal((await post(s, input())).status, 429);
  await mutate(s, data => {
    const effect = data.modelProbeLedger.effects[0]; effect.status = 'unknown'; effect.code = 'PROBE_UNKNOWN';
    effect.requests = [{ id: effect.id }, ...Array.from({ length: MODEL_PROBE_LIMITS.identities - 1 }, () => ({ id: crypto.randomUUID() }))];
    data.modelProbeLedger.effects = [effect];
  });
  assert.equal((await post(s, input())).status, 429);
  assert.equal((await post(s, body)).body.status, 'unknown'); assert.equal((await get(s, body.clientRequestId)).body.status, 'unknown');
  assert.equal(calls.length, before);
});

test('URL denial before dispatch leaves a known uncharged failure and does not contact provider', async () => {
  const s = await session(), body = input(), before = calls.length;
  process.env.AI_ALLOWED_LOCAL_ORIGINS = '';
  try {
    const result = await post(s, body); assert.equal(result.body.status, 'failed'); assert.equal(result.body.possibleCharge, false);
    assert.equal(result.body.code, 'PROBE_NOT_SENT'); assert.equal(calls.length, before); await unverified(s);
  } finally { process.env.AI_ALLOWED_LOCAL_ORIGINS = origin; }
});

if (process.env.SUPABASE_DB_URL) {
  for (const sameId of [true, false]) test(`independent workers race ${sameId ? 'identical' : 'different'} UUIDs with at most one paid PgLow effect`, async () => {
    const s = await session(), body = input(), before = calls.length;
    behavior = async (req, res) => { held.push(res); };
    const children = Array.from({ length: 4 }, () => {
      const contender = sameId ? body : input();
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { runModelProbe } = await import('./src/services/ai/modelProbes.js');
        const { closeSupabaseConnection } = await import('./src/models/supabaseAdapter.js');
        try { console.log('RESULT:' + JSON.stringify(await runModelProbe(${JSON.stringify(s.userId)}, ${JSON.stringify(contender)}))); }
        catch (error) { console.log('RESULT:' + JSON.stringify({ errorStatus: error.status, errorCode: error.code })); }
        finally { await closeSupabaseConnection(); }
      `], { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
      const record = { child, output: '', result: null };
      child.stdout.on('data', data => { record.output += data; }); child.stderr.on('data', data => { record.output += data; });
      record.exited = once(child, 'exit'); return record;
    });
    try {
      await eventually(() => held.length || children.every(record => record.child.exitCode !== null));
      assert.ok(held.length <= 1, children.map(record => record.output).join('\n'));
      if (held.length) {
        // Keep the winner in flight until the remaining intents have attempted
        // admission; a later fresh UUID after success would be a valid new test.
        await eventually(() => children.filter(record => record.child.exitCode !== null).length === 3);
        reply(held.shift());
      }
      await Promise.all(children.map(record => record.exited));
      const results = children.map(record => {
        assert.equal(record.child.exitCode, 0, record.output);
        const result = record.output.split('\n').find(line => line.startsWith('RESULT:'));
        assert.ok(result, record.output); return JSON.parse(result.slice(7));
      });
      const db = await getUserDb(s.userId); await db.read({ force: true });
      const effects = db.data.modelProbeLedger.effects, check = db.data.modelCapabilityChecks.probe_a.chat;
      const paid = effects.filter(effect => effect.dispatches > 0), callCount = calls.length - before;
      const evidence = JSON.stringify({ results, effects, check, callCount });
      // An alias can win CAS after the initial claim but before its dispatch
      // checkpoint. That claim must fail known-unsent; a later fresh UUID may
      // then be admitted. Neither this failure nor a second paid effect may hide
      // behind a broad "failed" allowance.
      assert.ok(results.every(result => ['succeeded', 'running'].includes(result.status) ||
        (result.errorStatus === 503 && result.errorCode === 'PROBE_STORAGE_UNCERTAIN') ||
        (result.status === 'failed' && result.code === 'PROBE_NOT_SENT' && result.possibleCharge === false && result.healthy === false)), evidence);
      assert.ok(callCount <= 1, evidence);
      if (sameId) assert.equal(callCount, 1, evidence);
      assert.equal(paid.length, callCount, evidence);
      assert.ok(effects.length > 0, evidence);
      for (const effect of effects) {
        if (effect.dispatches) {
          assert.equal(effect.status, 'succeeded', evidence);
          assert.equal(effect.dispatches, 1, evidence); assert.equal(effect.receipts, 1, evidence);
          assert.equal(effect.code, undefined, evidence);
        } else {
          assert.equal(effect.status, 'failed', evidence); assert.equal(effect.code, 'PROBE_NOT_SENT', evidence);
          assert.equal(effect.dispatches, 0, evidence); assert.equal(effect.receipts, 0, evidence);
        }
      }
      assert.equal(effects.some(effect => effect.id === check.probeRequestId), true, evidence);
      if (callCount) {
        assert.ok(results.some(result => result.status === 'succeeded' && result.requestId === paid[0].id && result.healthy === true), evidence);
        assert.equal(check.status, 'verified', evidence); assert.equal(check.probeRequestId, paid[0].id, evidence);
        assert.equal(check.fingerprint, paid[0].fingerprint, evidence);
      } else {
        assert.ok(results.every(result => result.status !== 'succeeded'), evidence);
        assert.equal(check.status, 'unknown', evidence); assert.equal(check.evidence, null, evidence);
      }
      for (const result of results.filter(result => result.requestId)) {
        const effect = effects.find(effect => effect.id === result.requestId); assert.ok(effect, evidence);
        if (result.status !== 'running') {
          assert.equal(result.status, effect.status, evidence); assert.equal(result.code, effect.code, evidence);
          assert.equal(result.possibleCharge, effect.dispatches > 0, evidence);
        }
      }
      clearUserDbCache(s.userId);
      for (const effect of effects) for (const identity of effect.requests) {
        const lookup = await get(s, identity.id);
        assert.equal(lookup.status, 200, evidence); assert.equal(lookup.body.requestId, effect.id, evidence);
        assert.equal(lookup.body.status, effect.status, evidence); assert.equal(lookup.body.possibleCharge, effect.dispatches > 0, evidence);
        const replay = await post(s, { ...body, clientRequestId: identity.id });
        assert.equal(replay.status, effect.dispatches ? 200 : 502, evidence);
        assert.equal(replay.body.status, effect.status, evidence); assert.equal(replay.body.requestId, effect.id, evidence);
        assert.equal(replay.body.healthy, effect.dispatches > 0, evidence);
      }
      assert.equal(calls.length, before + callCount, evidence);
    } finally {
      for (const record of children) if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL');
      await Promise.all(children.map(record => record.exited));
    }
  });
}

if (process.env.SUPABASE_DB_URL) test('alias CAS before dispatch preserves known-unsent receipt and permits only a new explicit paid intent', async () => {
  const s = await session(), body = input(), alias = input(), fresh = input(), before = calls.length;
  const db = await getUserDb(s.userId), original = db.write;
  let writes = 0, child, exited, output = '', aliasResult, childWaitError;
  db.write = async function (...args) {
    if (++writes === 2) {
      // The claim is durable, but the dispatch checkpoint still has its old CAS
      // revision. Commit an alias from an actual independent PgLow process.
      child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { runModelProbe } = await import('./src/services/ai/modelProbes.js');
        const { closeSupabaseConnection } = await import('./src/models/supabaseAdapter.js');
        try { console.log('RESULT:' + JSON.stringify(await runModelProbe(${JSON.stringify(s.userId)}, ${JSON.stringify(alias)}))); }
        catch (error) { console.log('ERROR:' + error.message); process.exitCode = 1; }
        finally { await closeSupabaseConnection(); }
      `], { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      exited = once(child, 'exit');
      let timer;
      try {
        await Promise.race([exited, new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Independent alias worker did not exit within 10 seconds')), 10000);
        })]);
      } catch (error) { childWaitError = error; throw error; }
      finally { clearTimeout(timer); }
      assert.equal(child.exitCode, 0, output);
      aliasResult = JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:')).slice(7));
    }
    return original.apply(this, args);
  };
  try {
    const failed = await post(s, body);
    if (childWaitError) throw childWaitError; // persist sanitizes write errors; retain the test failure.
    assert.equal(aliasResult.requestId, body.clientRequestId); assert.equal(aliasResult.status, 'running'); assert.equal(aliasResult.possibleCharge, false);
    assert.equal(failed.status, 502); assert.equal(failed.body.status, 'failed'); assert.equal(failed.body.code, 'PROBE_NOT_SENT');
    assert.equal(failed.body.possibleCharge, false); assert.equal(failed.body.healthy, false); assert.equal(calls.length, before);
    db.write = original; await db.read({ force: true });
    const failedEffect = structuredClone(db.data.modelProbeLedger.effects[0]);
    assert.equal(db.data.modelProbeLedger.effects.length, 1); assert.equal(failedEffect.dispatches, 0); assert.equal(failedEffect.receipts, 0);
    assert.deepEqual(new Set(failedEffect.requests.map(request => request.id)), new Set([body.clientRequestId, alias.clientRequestId]));
    assert.equal(db.data.modelCapabilityChecks.probe_a.chat.status, 'unknown'); await unverified(s);
    for (const intent of [body, alias]) {
      const replay = await post(s, intent); assert.equal(replay.status, 502); assert.equal(replay.body.code, 'PROBE_NOT_SENT'); assert.equal(replay.body.possibleCharge, false);
      const lookup = await get(s, intent.clientRequestId); assert.equal(lookup.status, 200); assert.equal(lookup.body.status, 'failed');
    }
    assert.equal(calls.length, before);
    const succeeded = await post(s, fresh);
    assert.equal(succeeded.status, 200); assert.equal(succeeded.body.healthy, true); assert.equal(calls.length, before + 1);
    clearUserDbCache(s.userId); const durable = await getUserDb(s.userId); await durable.read({ force: true });
    const effects = durable.data.modelProbeLedger.effects, check = durable.data.modelCapabilityChecks.probe_a.chat;
    assert.equal(effects.length, 2); assert.deepEqual(effects[0], failedEffect);
    assert.equal(effects[1].id, fresh.clientRequestId); assert.equal(effects[1].status, 'succeeded');
    assert.equal(effects[1].dispatches, 1); assert.equal(effects[1].receipts, 1);
    assert.equal(check.status, 'verified'); assert.equal(check.probeRequestId, fresh.clientRequestId); assert.equal(check.fingerprint, effects[1].fingerprint);
    for (const intent of [body, alias, fresh]) {
      const replay = await post(s, intent); assert.equal(replay.body.status, intent === fresh ? 'succeeded' : 'failed');
    }
    assert.equal((await get(s, fresh.clientRequestId)).body.healthy, true); assert.equal(calls.length, before + 1);
  } finally {
    db.write = original;
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});

if (process.env.SUPABASE_DB_URL) {
  for (const sameId of [true, false]) test(`catalog resolution cannot overwrite a competing ${sameId ? 'same-key' : 'same-input'} probe from a newer CAS revision`, async () => {
    const s = await session(), body = input(), before = calls.length;
    const contender = sameId ? body : input();
    const db = await getUserDb(s.userId), original = db.read;
    let reads = 0, child, exited, output = '';
    db.read = async function (...args) {
      if (++reads === 2) {
        // The old implementation's second read was inside resolveModel after
        // capturing an empty ledger. A competitor can fully commit here, so
        // using its newer CAS revision with the old ledger sends twice.
        // With pure snapshot resolution, this is instead the dispatch gate's
        // fresh read: the first claim is durable and the competitor dedupes.
        child = spawn(process.execPath, ['--input-type=module', '-e', `
          const { runModelProbe } = await import('./src/services/ai/modelProbes.js');
          const { closeSupabaseConnection } = await import('./src/models/supabaseAdapter.js');
          try { console.log('RESULT:' + JSON.stringify(await runModelProbe(${JSON.stringify(s.userId)}, ${JSON.stringify(contender)}))); }
          catch (error) { console.log('ERROR:' + error.message); process.exitCode = 1; }
          finally { await closeSupabaseConnection(); }
        `], { cwd: process.cwd(), env: process.env, stdio: 'pipe' });
        child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
        exited = once(child, 'exit');
        await exited;
        assert.equal(child.exitCode, 0, output);
      }
      return original.apply(this, args);
    };
    try {
      const { runModelProbe } = await import('../src/services/ai/modelProbes.js');
      const receipt = await runModelProbe(s.userId, body);
      assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.healthy, true);
      assert.equal(calls.length, before + 1, 'one authority snapshot must protect one paid effect');
      const childResult = JSON.parse(output.split('\n').find(line => line.startsWith('RESULT:')).slice(7));
      assert.equal(childResult.status, 'running'); assert.equal(childResult.requestId, body.clientRequestId);
      assert.equal((await get(s, contender.clientRequestId)).body.requestId, body.clientRequestId);
      assert.equal((await post(s, contender)).body.status, 'succeeded'); assert.equal(calls.length, before + 1);
    } finally {
      db.read = original;
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  });
}

test('temperature edits invalidate old capability evidence without an automatic paid retest', async () => {
  const s = await session(), body = input(); assert.equal((await post(s, body)).body.healthy, true);
  const before = calls.length, catalog = await readCatalog(s.userId);
  catalog.models.find(model => model.id === 'probe_a').temperature = 0.7;
  await saveCatalog(s.userId, catalog); await unverified(s);
  const old = await get(s, body.clientRequestId); assert.equal(old.body.stale, true); assert.equal(old.body.healthy, false);
  assert.equal((await post(s, body)).body.healthy, false); assert.equal(calls.length, before);
  assert.equal((await post(s, input())).body.healthy, true); assert.equal(calls.length, before + 1);
});

test('current required-key readiness prevents historical receipts claiming healthy', async () => {
  const s = await session(), catalog = await readCatalog(s.userId), body = input();
  const provider = catalog.providers.find(provider => provider.id === 'probe_provider');
  provider.clearApiKey = true; provider.keyRequired = false; await saveCatalog(s.userId, catalog);
  assert.equal((await post(s, body)).body.healthy, true);
  const changed = await readCatalog(s.userId); changed.providers.find(provider => provider.id === 'probe_provider').keyRequired = true;
  await saveCatalog(s.userId, changed);
  const old = await get(s, body.clientRequestId); assert.equal(old.body.stale, true); assert.equal(old.body.healthy, false);
});

if (!process.env.SUPABASE_DB_URL) {
  test('lost claim ACK invalidates shared LowDB cache for catalog consumers even within one millisecond', async () => {
    const s = await session(), db = await getUserDb(s.userId), originalWrite = db.write, originalRead = db.adapter.read, originalNow = Date.now;
    const fixedNow = originalNow(); Date.now = () => fixedNow;
    try {
      assert.equal((await post(s, input())).body.healthy, true);
      assert.deepEqual((await readCatalog(s.userId)).models.find(model => model.id === 'probe_a').verifiedCapabilities, ['chat']);
      let first = true;
      db.write = async function () { await originalWrite.call(this); if (first) { first = false; throw new Error('claim ACK lost'); } };
      assert.equal((await post(s, input())).status, 503); db.write = originalWrite;
      assert.equal(await getUserDb(s.userId), db, 'queued consumers retain one shared instance');
      // If durable reading fails, old verified data must not be treated as a
      // successful cache hit. Retrying must still attempt a fresh durable read.
      let readAttempts = 0;
      db.adapter.read = async () => { readAttempts++; throw new Error('local read unavailable'); };
      await assert.rejects(readCatalog(s.userId)); await assert.rejects(readCatalog(s.userId));
      assert.equal(readAttempts, 2);
      db.adapter.read = originalRead;
      assert.deepEqual((await readCatalog(s.userId)).models.find(model => model.id === 'probe_a').verifiedCapabilities, []);
      await unverified(s);
    } finally { Date.now = originalNow; db.write = originalWrite; db.adapter.read = originalRead; }
  });
}

test('expectedRevision blocks retargeted new admission, while admitted frozen requests remain replayable', async () => {
  const s = await session(), original = await readCatalog(s.userId);
  const body = input({ expectedRevision: original.revision }), before = calls.length;
  assert.equal((await get(s, body.clientRequestId)).status, 404);
  original.models.find(model => model.id === 'probe_a').model = 'retargeted-model';
  const changed = await saveCatalog(s.userId, original);
  const rejected = await post(s, body);
  assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'PROBE_CONFIG_CHANGED');
  assert.equal(rejected.body.status, 'failed'); assert.equal(rejected.body.possibleCharge, false); assert.equal(calls.length, before);
  assert.equal((await get(s, body.clientRequestId)).status, 404);
  const acceptedBody = input({ expectedRevision: changed.revision });
  assert.equal((await post(s, acceptedBody)).body.healthy, true);
  changed.models.find(model => model.id === 'probe_a').name = '新显示名'; await saveCatalog(s.userId, changed);
  assert.equal((await post(s, acceptedBody)).body.status, 'succeeded');
  assert.equal((await post(s, { ...acceptedBody, expectedRevision: changed.revision + 1 })).status, 409);
  const removedCondition = { ...acceptedBody }; delete removedCondition.expectedRevision;
  assert.equal((await post(s, removedCondition)).status, 409); assert.equal(calls.length, before + 1);
});

test('explicit same-UUID 404 resubmission and a delayed original POST admit only one paid probe', async () => {
  const s = await session(), body = input({ expectedRevision: (await readCatalog(s.userId)).revision }), before = calls.length;
  assert.equal((await get(s, body.clientRequestId)).status, 404);
  behavior = async (req, res) => { held.push(res); };
  // The first submission was delayed before reaching admission. Both copies
  // keep the original account, payload, UUID and revision, never a fresh ID.
  const resubmitted = post(s, body).then(result => result); await eventually(() => held.length);
  const original = await post(s, body); assert.equal(original.status, 202); assert.equal(original.body.requestId, body.clientRequestId);
  reply(held.shift()); assert.equal((await resubmitted).body.healthy, true);
  assert.equal((await get(s, body.clientRequestId)).body.status, 'succeeded'); assert.equal(calls.length, before + 1);
});

test('same-input alias binds its own revision condition and remains queryable under canonical UUID', async () => {
  const s = await session(), originalCatalog = await readCatalog(s.userId), body = input({ expectedRevision: originalCatalog.revision });
  behavior = async (req, res) => { held.push(res); };
  const pending = post(s, body).then(result => result); await eventually(() => held.length);
  originalCatalog.models.find(model => model.id === 'probe_b').name = '不影响请求输入';
  const next = await saveCatalog(s.userId, originalCatalog), alias = input({ expectedRevision: next.revision });
  const replay = await post(s, alias); assert.equal(replay.body.requestId, body.clientRequestId); assert.equal(replay.body.status, 'running');
  assert.equal((await post(s, alias)).body.status, 'running');
  assert.equal((await post(s, { ...alias, expectedRevision: originalCatalog.revision })).status, 409);
  reply(held.shift()); assert.equal((await pending).body.code, 'PROBE_STALE');
  assert.equal((await get(s, alias.clientRequestId)).body.requestId, body.clientRequestId);
  assert.equal((await post(s, alias)).body.status, 'failed');
});

test('catalog and model resolution cannot expose staged verification before final write acknowledgement', async () => {
  for (const fail of [true, false]) {
    const s = await session(), body = input(), db = await getUserDb(s.userId), originalWrite = db.write, originalNow = Date.now;
    const fixedNow = originalNow(); Date.now = () => fixedNow;
    let writes = 0, releaseWrite, stagedResolve;
    const heldWrite = new Promise(resolve => { releaseWrite = resolve; });
    const staged = new Promise(resolve => { stagedResolve = resolve; });
    db.write = async function () {
      if (++writes === 3) {
        stagedResolve(); await heldWrite;
        if (fail) throw new Error('final capability commit failed');
      }
      return originalWrite.call(this);
    };
    let pending;
    try {
      pending = post(s, body).then(result => result); await staged;
      let catalogSettled = false, configSettled = false;
      const catalog = readCatalog(s.userId).then(value => { catalogSettled = true; return value; });
      const config = resolveModel(s.userId, 'probe_a', 'chat').then(value => { configSettled = true; return value; }, error => { configSettled = true; return error; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(catalogSettled, false); assert.equal(configSettled, false);
      releaseWrite(); const response = await pending;
      const models = (await catalog).models;
      assert.deepEqual(models.find(model => model.id === 'probe_a').verifiedCapabilities, fail ? [] : ['chat']);
      if (fail) { assert.equal(response.body.status, 'unknown'); assert.equal((await config).status, 409); }
      else { assert.equal(response.body.healthy, true); assert.equal((await config).model, 'probe_a'); }
    } finally { releaseWrite(); if (pending) await pending; db.write = originalWrite; Date.now = originalNow; }
  }
});

if (!process.env.SUPABASE_DB_URL) {
  test('a catalog read begun before commit cannot overwrite newer acknowledged LowDB verification', async () => {
    const s = await session(), body = input(), db = await getUserDb(s.userId);
    const originalRead = db.adapter.read, originalWrite = db.write, originalNow = Date.now, fixedNow = Date.now();
    let releaseRead, markRead, releaseAck, markCommit, delayed = false, pending, reading;
    const readStarted = new Promise(resolve => { markRead = resolve; }), readHold = new Promise(resolve => { releaseRead = resolve; });
    const committed = new Promise(resolve => { markCommit = resolve; }), ackHold = new Promise(resolve => { releaseAck = resolve; });
    Date.now = () => fixedNow;
    try {
      behavior = async (req, res) => { held.push(res); };
      pending = post(s, body).then(result => result); await eventually(() => held.length);
      db.adapter.read = async function () {
        const snapshot = await originalRead.call(this);
        if (!delayed) { delayed = true; markRead(); await readHold; }
        return snapshot;
      };
      db.invalidateReadCache(); reading = readCatalog(s.userId); await readStarted;
      db.write = async function () { await originalWrite.call(this); markCommit(); await ackHold; };
      reply(held.shift()); await committed;
      releaseRead(); await new Promise(resolve => setImmediate(resolve)); releaseAck();
      assert.equal((await pending).body.healthy, true);
      assert.deepEqual((await reading).models.find(model => model.id === 'probe_a').verifiedCapabilities, ['chat']);
      assert.equal((await get(s, body.clientRequestId)).body.healthy, true);
    } finally {
      releaseRead(); releaseAck(); if (pending) await pending; if (reading) await reading;
      db.adapter.read = originalRead; db.write = originalWrite; Date.now = originalNow;
    }
  });
}
