// Synthetic local integration evidence. Product starts/stops and route responses
// are not replaced. Storage timing and genuine context publication are observed.
// Injection: a per-instance db.read wrapper holds a genuine write read-fence only
// after the real start function has published its real owner-scoped active context.
// A separate latch pauses only that triggering background read's return, keeping
// provider dispatch unreachable while actual HTTP requests use the original read.
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../..');
const backend = path.join(source, 'backend');
const requireBackend = createRequire(path.join(backend, 'package.json'));
const imp = file => import(pathToFileURL(path.join(backend, file)));
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-stop-controls-'));
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = runtime;
process.env.AUTH_DB_PATH = path.join(runtime, 'auth.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.QUNTHINK_SHARED_PROVIDER_KEYS = '0';
for (const key of Object.keys(process.env)) {
  if (/(API_KEY|DATABASE_URL|MONGODB_URI|SUPABASE_URL)$/.test(key) ||
      /^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key)) delete process.env[key];
}
const forbiddenNetwork = [];
const realFetch = globalThis.fetch;
let origin;
globalThis.fetch = (url, ...args) => {
  if (!origin || !String(url).startsWith(`${origin}/`)) {
    forbiddenNetwork.push({ transport: 'fetch', target: String(url) });
    throw new Error('External network forbidden in stop-control fixture');
  }
  return realFetch(url, ...args);
};
for (const [name, module] of [['http', http], ['https', https]]) {
  const request = module.request;
  module.request = function (options, ...args) {
    const host = typeof options === 'string' || options instanceof URL
      ? new URL(options).hostname : options.hostname || options.host;
    if (!['127.0.0.1', 'localhost'].includes(host)) {
      forbiddenNetwork.push({ transport: name, target: String(host) });
      throw new Error('External network forbidden in stop-control fixture');
    }
    return request.call(this, options, ...args);
  };
}
const dbApi = await imp('src/models/db.js');
const authApi = await imp('src/models/authDb.js');
const { provisionNewLocalMemoryAccount, markGroupDeleted } = await imp('src/services/memory/persistentMemory.js');
const { addFixtureGroups } = await imp('test/helpers/accountStoreFixtures.js');
const { createTestApp } = await imp('test/helpers/createTestApp.js');
const { beginUserDbWriteBarrier } = await imp('src/models/readBarrier.js');
const { runAsUser, currentUserId, UserScopedMap } = await imp('src/services/userScope.js');
const { commitBackgroundMessage } = await imp('src/services/backgroundMessageCommit.js');
const scheduler = await imp('src/services/scheduler/index.js');
const debate = await imp('src/services/debate/index.js');
const { setupWebSocket } = await imp('src/websocket/index.js');
const { WebSocket, WebSocketServer } = requireBackend('ws');
await dbApi.initializeEmptyInstallation();
await dbApi.initDatabase();
await authApi.initAuthDb();
const server = http.createServer(createTestApp());
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
origin = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const latch = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const within = async (promise, ms = 2500) => {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Deadline ${ms}ms exceeded`)), ms); })]); }
  finally { clearTimeout(timeout); }
};
async function eventually(fn, ms = 2500) {
  const deadline = Date.now() + ms;
  while (!fn()) { if (Date.now() >= deadline) throw new Error('Expected observation not reached'); await sleep(5); }
}
async function session(groupId, kind) {
  const userId = crypto.randomUUID(), token = authApi.generateSessionToken();
  const db = await dbApi.createNewUserDatabase(userId);
  await provisionNewLocalMemoryAccount(userId, db);
  await dbApi.withWriteLock(userId, async () => {
    await db.read();
    addFixtureGroups(db.data, { id: groupId, name: 'Synthetic stop control',
      ai_members: ['deepseek', 'qwen_flash'], ...(kind === 'private' ? { type: 'ai_private', is_ai_private: true } : {}) });
    await db.write();
  });
  const authDb = authApi.getAuthDb(); await authDb.read();
  authDb.data.users.push({ id: userId, username: userId, password: 'unused-synthetic', created_at: new Date().toISOString() });
  authDb.data.sessions.push({ token, userId, expires_at: new Date(Date.now() + 29 * 86400000).toISOString() });
  await authDb.write();
  return { userId, cookie: `session_token=${token}`, db };
}
async function connect(s, groupId) {
  const messages = [];
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`, { headers: { Cookie: s.cookie, Origin: 'http://localhost:3010' } });
  ws.on('message', raw => { const item = JSON.parse(raw.toString()); messages.push(...(item.type === 'batch' ? item.messages : [item])); });
  await once(ws, 'open');
  await eventually(() => messages.some(e => e.type === 'connected'));
  ws.send(JSON.stringify({ type: 'join_group', group_id: groupId }));
  await eventually(() => messages.some(e => e.type === 'joined_group'));
  return { ws, messages };
}
async function post(route, s, requestBody = {}) {
  const started = performance.now();
  const response = await fetch(`${origin}/api${route}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(s ? { Cookie: s.cookie } : {}) }, body: JSON.stringify(requestBody) });
  const raw = await response.text();
  let body; try { body = JSON.parse(raw); } catch { body = null; }
  return { status: response.status, body, elapsedMs: Math.round(performance.now() - started) };
}
function armContextRead(s, groupId, active, fenced) {
  const original = s.db.read;
  const entered = latch(), runner = latch();
  const calls = [];
  let armed = true, releaseFence;
  s.db.read = async function (...args) {
    if (armed && runAsUser(s.userId, () => active(groupId).isRunning)) {
      armed = false;
      if (fenced) releaseFence = beginUserDbWriteBarrier(s.db);
      entered.release();
      const result = await original.apply(this, args);
      await runner.promise;
      return result;
    }
    if (!armed) calls.push(new Error('read caller').stack.split('\n').slice(2, 7).map(line => line.replace(source, '<source>')).join('\n'));
    return original.apply(this, args);
  };
  return { entered: entered.promise, calls,
    releaseFence: () => releaseFence?.(), releaseRunner: runner.release,
    restore: () => { releaseFence?.(); runner.release(); s.db.read = original; } };
}

const observations = [];
const violations = [];
async function scenario(kind, t) {
  const groupId = `synthetic-shared-${kind}`;
  const active = kind === 'private' ? scheduler.getChatStatus : debate.getDebateStatus;
  const start = kind === 'private' ? scheduler.startAIPrivateChat : debate.startFormalDebate;
  const stop = kind === 'private' ? scheduler.stopAIPrivateChat : debate.stopFormalDebate;
  const route = id => kind === 'private' ? `/ai-private-chats/${id}/stop` : `/groups/${id}/formal-debate/stop`;
  const a = await session(groupId, kind), b = await session(groupId, kind);
  const wa = await connect(a, groupId), wb = await connect(b, groupId);
  const isStoppedEvent = e => e.group_id === groupId && (kind === 'private'
    ? e.type === 'chat_status' && e.status === 'stopped' : e.type === 'debate_stopped');
  const gateA = armContextRead(a, groupId, active, true);
  const gateB = armContextRead(b, groupId, active, false);
  let runA, runB, responseA;
  const record = { kind, sameGroupId: groupId, injection: 'Real active context; real readBarrier on owner A; only triggering background read returns are latched for provider safety' };
  try {
    runA = runAsUser(a.userId, () => start(groupId, 'Synthetic bounded stop'));
    runB = runAsUser(b.userId, () => start(groupId, 'Synthetic bounded stop'));
    await within(Promise.all([gateA.entered, gateB.entered]));
    assert.equal(runAsUser(a.userId, () => active(groupId).isRunning), true);
    assert.equal(runAsUser(b.userId, () => active(groupId).isRunning), true);
    record.anonymous = await within(post(route(groupId)));
    assert.equal(record.anonymous.status, 401);
    record.missingGroup = await within(post(route('does-not-exist'), b));
    assert.equal(record.missingGroup.status, 404);
    record.emptyId = await within(post(route(''), b));
    assert.equal(record.emptyId.status, 404);
    assert.equal(wa.messages.some(isStoppedEvent), false);
    assert.equal(wb.messages.some(isStoppedEvent), false);
    record.ownerBStopWithoutFence = await within(post(route(groupId), b, { userId: a.userId, ownerId: a.userId }));
    assert.deepEqual(record.ownerBStopWithoutFence.body, { success: true, stopRequested: true, message: kind === 'private' ? 'AI私聊停止请求已登记' : '辩论停止请求已登记' });
    assert.equal(record.ownerBStopWithoutFence.status, 200);
    await eventually(() => wb.messages.some(isStoppedEvent));
    assert.equal(wa.messages.some(isStoppedEvent), false, 'B stop event must not be delivered to owner A');
    assert.equal(runAsUser(a.userId, () => active(groupId).isRunning), true);
    record.sameIdIsolation = { bothContextsStarted: true, bodyOwnerSpoofIgnored: true, bStopEvent: true, aStopEvent: false, aStillRunning: true };
    if (kind === 'formal' && (record.ownerBStopWithoutFence.status !== 200 || record.ownerBStopWithoutFence.body?.success !== true)) {
      violations.push('formal stop without fence signals real B context but HTTP returns 404 {} because the promise is not awaited');
    }
    gateB.releaseRunner();
    await within(runB);
    const readsBefore = gateA.calls.length;
    let settled = false;
    responseA = post(route(groupId), a).then(result => { settled = true; return result; });
    await eventually(() => gateA.calls.length > readsBefore || settled);
    await sleep(350);
    record.whileFenceHeld = { httpSettled: settled, stoppedEvent: wa.messages.some(isStoppedEvent),
      active: runAsUser(a.userId, () => active(groupId).isRunning),
      observedReadCalls: gateA.calls.slice(readsBefore) };
    if (!settled) violations.push(`${kind} authenticated active owner stop waits behind its own real storage read fence`);
    assert.equal(record.whileFenceHeld.httpSettled, true, 'original red: stop must not wait for the held commit read fence');
    assert.equal(record.whileFenceHeld.stoppedEvent, true);
    assert.equal(record.whileFenceHeld.active, true, 'signal must retain the context until its own worker drains');
    assert.deepEqual(record.whileFenceHeld.observedReadCalls, [], 'active-only stop must not read account data');
    const duplicate = await within(post(route(groupId), a));
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.stopRequested, true);
    await sleep(20);
    assert.equal(wa.messages.filter(isStoppedEvent).length, 1, 'repeat signal must not repeat the stop event');
    gateA.releaseFence();
    record.ownerAStopAfterFenceRelease = await within(responseA, 6500);
    await eventually(() => wa.messages.some(isStoppedEvent));
    gateA.releaseRunner();
    await within(runA);
    record.final = { aRunning: runAsUser(a.userId, () => active(groupId).isRunning),
      bRunning: runAsUser(b.userId, () => active(groupId).isRunning), stopEventsOwnerA: wa.messages.filter(isStoppedEvent).length,
      stopEventsOwnerB: wb.messages.filter(isStoppedEvent).length };
    assert.equal(record.final.aRunning, false);
    assert.equal(record.final.bRunning, false);
    const inactive = await within(post(route(groupId), b));
    assert.equal(inactive.status, kind === 'private' ? 200 : 404);
    assert.equal(inactive.body.success, false);
    const fallbackFence = beginUserDbWriteBarrier(b.db);
    let fallbackSettled = false;
    const fallback = post(route('does-not-exist'), b).then(value => { fallbackSettled = true; return value; });
    try { await sleep(70); assert.equal(fallbackSettled, false, 'unknown ID must retain the storage-backed authorization path'); }
    finally { fallbackFence(); }
    assert.equal((await within(fallback)).status, 404);
    observations.push(record);
    t.diagnostic(JSON.stringify({ observation: record }));
  } finally {
    // Product stop functions remain original. Cleanup is a separately scoped,
    // explicitly recorded real stop and cannot make a blocked HTTP test pass.
    const cleanupA = runAsUser(a.userId, () => stop(groupId));
    const cleanupB = runAsUser(b.userId, () => stop(groupId));
    gateA.restore(); gateB.restore();
    await Promise.allSettled([runA, runB, responseA, cleanupA, cleanupB].filter(Boolean));
    wa.ws.terminate(); wb.ws.terminate();
  }
}

for (const kind of ['private', 'formal']) test(`${kind}: actual HTTP stop bypasses only its own active-context fence, with session/ID isolation and idempotent signals`, { timeout: 15000 }, t => scenario(kind, t));

// Observe, but never fabricate or replace, the real context published by start.
// The original scoped-map setter always runs before this fixture callback.
function observeContext(kind, userId, groupId, created) {
  const original = UserScopedMap.prototype.set;
  const wanted = `${kind === 'private' ? 'ai_private' : 'debate'}:${groupId}`;
  const restore = () => { if (UserScopedMap.prototype.set === observe) UserScopedMap.prototype.set = original; };
  function observe(key, value) {
    const result = original.call(this, key, value);
    if (key === wanted && currentUserId() === userId) { restore(); created(value); }
    return result;
  }
  UserScopedMap.prototype.set = observe;
  return restore;
}

for (const kind of ['private', 'formal']) test(`${kind}: HTTP stop during actual commit I/O acknowledges only a request, retains possible durable original and reports unknown to the worker`, { timeout: 15000 }, async t => {
  const groupId = `synthetic-committing-${kind}`, s = await session(groupId, kind), ws = await connect(s, groupId);
  const start = kind === 'private' ? scheduler.startAIPrivateChat : debate.startFormalDebate;
  const requestStop = kind === 'private' ? scheduler.requestAIPrivateChatStop : debate.requestFormalDebateStop;
  const active = kind === 'private' ? scheduler.getChatStatus : debate.getDebateStatus;
  const route = kind === 'private' ? `/ai-private-chats/${groupId}/stop` : `/groups/${groupId}/formal-debate/stop`;
  const originalWrite = s.db.write, originalRead = s.db.read, entered = latch(), release = latch();
  const message = { id: crypto.randomUUID(), group_id: groupId, sender_type: 'ai', sender_id: 'synthetic-prepared-model',
    content: 'Already-prepared synthetic response; no provider called', content_type: 'text', created_at: '2026-10-13T04:00:00.000Z' };
  const file = path.join(runtime, 'users', `db_${s.userId}.json`);
  let context, committing, running, writes = 0, reads = 0;
  s.db.read = function (...args) { reads++; return originalRead.apply(this, args); };
  s.db.write = async function (...args) {
    if (args[0]?.snapshot?.messages.some(row => row.id === message.id)) {
      writes++; entered.release(); await release.promise;
    }
    return originalWrite.apply(this, args);
  };
  // At the already-prepared-message boundary, enqueue the real domain commit
  // using the actual newly-created context. It acquires the account lock before
  // the scheduler's next read; there is no AI/provider replacement or dispatch.
  const restoreObserver = observeContext(kind, s.userId, groupId, value => {
    context = value;
    committing = commitBackgroundMessage({ userId: s.userId, db: s.db, message, context });
    committing.catch(() => {});
  });
  try {
    running = runAsUser(s.userId, () => start(groupId, 'Synthetic already-prepared response'));
    await within(entered.promise);
    assert.ok(context);
    assert.equal(context.cancel, false);
    const readsBeforeStop = reads;
    const stopped = await within(post(route, s));
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.body, { success: true, stopRequested: true,
      message: kind === 'private' ? 'AI私聊停止请求已登记' : '辩论停止请求已登记' });
    assert.equal(reads, readsBeforeStop, 'actual in-flight commit must not delay owner stop behind a read');
    assert.equal(context.cancel, true);
    assert.equal(runAsUser(s.userId, () => active(groupId).isRunning), true);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).messages.some(row => row.id === message.id), false);
    assert.equal((await within(post(route, s))).body.stopRequested, true);
    await eventually(() => ws.messages.some(e => e.group_id === groupId && e.stopRequested));
    assert.equal(ws.messages.filter(e => e.group_id === groupId && e.stopRequested).length, 1);
    release.release();
    const committed = await within(committing);
    assert.equal(committed, null);
    assert.equal(context.resultUnknown, true, 'stop cannot turn a possibly durable message into a known rollback');
    await within(running);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved.messages.filter(row => row.id === message.id), [message]);
    assert.equal(writes, 1, 'unknown original must not be replayed');
    assert.equal(ws.messages.some(e => e.durable && e.id === message.id), false);
    t.diagnostic(JSON.stringify({ kind, stop: stopped, originalDurable: true, workerResultUnknown: context.resultUnknown, writes, externalProviderAttempts: forbiddenNetwork.length }));
  } finally {
    restoreObserver();
    runAsUser(s.userId, () => requestStop(groupId));
    release.release();
    await Promise.allSettled([committing, running].filter(Boolean));
    s.db.read = originalRead; s.db.write = originalWrite;
    ws.ws.terminate();
  }
});

test('formal legacy drain clears both timers and a stale callback cannot remove a replacement context', { timeout: 15000 }, async t => {
  const groupId = 'synthetic-formal-replacement', s = await session(groupId, 'formal');
  const oldGate = armContextRead(s, groupId, debate.getDebateStatus, false);
  let first, second, nextGate, nextContext, restoreObserver, captured;
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  try {
    first = runAsUser(s.userId, () => debate.startFormalDebate(groupId, 'Original context'));
    await within(oldGate.entered);
    globalThis.setTimeout = (callback, delay, ...args) => {
      const handle = originalSetTimeout(callback, delay, ...args);
      if (delay === 5000 && !captured) captured = { handle, callback: () => callback(...args), cleared: false };
      return handle;
    };
    globalThis.clearTimeout = handle => {
      if (captured?.handle === handle) captured.cleared = true;
      return originalClearTimeout(handle);
    };
    const draining = runAsUser(s.userId, () => debate.stopFormalDebate(groupId));
    assert.ok(captured, 'observe the actual legacy five-second drain timer');
    oldGate.releaseRunner();
    await within(first);
    assert.equal((await within(draining)).success, true);
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
    oldGate.restore();
    nextGate = armContextRead(s, groupId, debate.getDebateStatus, false);
    restoreObserver = observeContext('formal', s.userId, groupId, value => { nextContext = value; });
    second = runAsUser(s.userId, () => debate.startFormalDebate(groupId, 'Replacement context'));
    await within(nextGate.entered);
    // Simulate a callback already queued at cancellation time; the callback is
    // the real product closure, not a copied reimplementation of its behavior.
    runAsUser(s.userId, captured.callback);
    const contract = { timeoutCleared: captured.cleared,
      replacementPreserved: runAsUser(s.userId, () => debate.getDebateStatus(groupId).isRunning) };
    t.diagnostic(JSON.stringify(contract));
    assert.deepEqual(contract, { timeoutCleared: true, replacementPreserved: true },
      'original red: completed drain must clear its timeout and never delete a replacement context');
    assert.equal(nextContext.cancel, false);
    t.diagnostic('Actual legacy timer was cleared; replaying its captured callback preserved the real replacement context.');
  } finally {
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
    if (captured) originalClearTimeout(captured.handle);
    restoreObserver?.();
    runAsUser(s.userId, () => debate.requestFormalDebateStop(groupId));
    // If the old, deliberately-red implementation lost the new map entry, this
    // cleanup-only cancellation lets its actual worker drain without dispatch.
    if (nextContext) nextContext.cancel = true;
    oldGate.restore(); nextGate?.restore();
    await Promise.allSettled([first, second].filter(Boolean));
  }
});

for (const kind of ['private', 'formal']) test(`${kind}: revoked group with existing context accepts only an opaque stop signal, never group access or new dispatch`, { timeout: 15000 }, async t => {
  const groupId = `synthetic-revoked-${kind}`, s = await session(groupId, kind);
  const start = kind === 'private' ? scheduler.startAIPrivateChat : debate.startFormalDebate;
  const signal = kind === 'private' ? scheduler.requestAIPrivateChatStop : debate.requestFormalDebateStop;
  const active = kind === 'private' ? scheduler.getChatStatus : debate.getDebateStatus;
  const prefix = kind === 'private' ? `/ai-private-chats/${groupId}` : `/groups/${groupId}/formal-debate`;
  const gate = armContextRead(s, groupId, active, true);
  let running;
  try {
    running = runAsUser(s.userId, () => start(groupId, 'Sensitive synthetic topic must not be returned'));
    await within(gate.entered);
    await markGroupDeleted(s.userId, s.db, groupId);
    const reads = gate.calls.length;
    const stopped = await within(post(`${prefix}/stop`, s));
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.body, { success: true, stopRequested: true,
      message: kind === 'private' ? 'AI私聊停止请求已登记' : '辩论停止请求已登记' });
    assert.equal(gate.calls.length, reads);
    assert.equal(JSON.stringify(stopped.body).includes('Sensitive synthetic'), false);
    assert.equal(runAsUser(s.userId, () => active(groupId).isRunning), true);
    gate.releaseFence(); gate.releaseRunner();
    await within(running);
    assert.equal((await within(post(`${prefix}/stop`, s))).status, 404);
    assert.equal((await within(post(`${prefix}/start`, s, { topic: 'Must not restart' }))).status, 404);
    assert.equal(runAsUser(s.userId, () => active(groupId).isRunning), false);
    t.diagnostic(JSON.stringify({ kind, revokedActiveSignal: stopped.body, afterDrainStop: 404, restart: 404, externalProviderAttempts: forbiddenNetwork.length }));
  } finally {
    runAsUser(s.userId, () => signal(groupId));
    gate.restore();
    if (running) await running;
  }
});

test('signal helpers fail closed without authenticated scope or an existing context', () => {
  for (const requestStop of [scheduler.requestAIPrivateChatStop, debate.requestFormalDebateStop]) {
    assert.equal(requestStop('synthetic-absent').success, false);
    assert.equal(runAsUser('synthetic-owner', () => requestStop('synthetic-absent')).success, false);
  }
});

test.after(async () => {
  assert.deepEqual(forbiddenNetwork, [], 'No provider or external-network attempt permitted');
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(runtime, { recursive: true, force: true });
});
