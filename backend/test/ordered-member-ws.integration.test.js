// Independent review. Real Express + ws + account JSON + deletion journal.
// Only the write acknowledgement is fault-injected; no external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const backend = new URL('../', import.meta.url);
const load = file => import(new URL(file, backend));
const require = createRequire(new URL('package.json', backend));
process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session'; process.env.TRUST_PROXY = '1';
process.env.CORS_ORIGINS = 'http://localhost:3210';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-independent-member-race-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key)) delete process.env[key];
const { initializeEmptyInstallation, initDatabase, getUserDb } = await load('src/models/db.js');
const { initAuthDb } = await load('src/models/authDb.js');
const { createTestApp } = await load('test/helpers/createTestApp.js');
const { setupWebSocket } = await load('src/websocket/index.js');
const { commitGroupMemberChange } = await load('src/services/groupCreationCommit.js');
const { validateMessageOrder } = await load('src/services/messageOrder.js');
const { WebSocketServer, WebSocket } = require('ws');
await initializeEmptyInstallation(); await initDatabase(); await initAuthDb();
const app = createTestApp(), request = require('supertest')(app), server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' }); setupWebSocket(wss);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sockets = new Set(), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function waitMessage(ws, type) {
 return new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { ws.off('message', listener); reject(new Error(`Missing ${type}`)); }, 3000);
  const listener = bytes => { const item = JSON.parse(bytes); if (item.type !== type) return; clearTimeout(timeout); ws.off('message', listener); resolve(item); };
  ws.on('message', listener);
 });
}
test.after(async () => { for (const ws of sockets) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); await fs.rm(process.env.DATA_DIR, { recursive: true, force: true }); });

let fixtureCounter = 0;
async function fixture(remove) {
 const registration = await request.post('/api/auth/register').send({ username: `ind_${randomUUID()}`, password: 'SyntheticFixtureOnly2026!' });
 assert.equal(registration.status, 201, JSON.stringify(registration.body));
 const userId = registration.body.user.id, cookie = registration.headers['set-cookie'], db = await getUserDb(userId);
 await db.read(); const groupId = db.data.groups[0].id;
 db.data.groups[0].ai_members = ['fixture_a', 'fixture_b', ...(remove ? ['fixture_c'] : [])];
 db.data.modelCatalog = { revision: 0, providers: [], models: ['fixture_a', 'fixture_b', 'fixture_c'].map(id => ({ id, name: id, enabled: true, capabilities: ['chat'] })), defaults: { chat: null, vision: null, tts: null } };
 await db.write();
 const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { headers: { Cookie: cookie.map(value => value.split(';')[0]).join('; '), Origin: 'http://localhost:3210', 'x-forwarded-for': `127.3.1.${++fixtureCounter}` } }); sockets.add(ws);
 await waitMessage(ws, 'connected'); const joined = waitMessage(ws, 'joined_group'); ws.send(JSON.stringify({ type: 'join_group', group_id: groupId })); await joined;
 const seen = []; ws.on('message', bytes => { const item = JSON.parse(bytes); seen.push(...(item.type === 'batch' ? item.messages : [item])); });
 const send = () => request[remove ? 'delete' : 'post'](`/api/groups/${groupId}/members${remove ? '/fixture_c' : ''}`).set('Cookie', cookie).send(remove ? {} : { aiId: 'fixture_c' });
 return { userId, cookie, db, groupId, ws, seen, send };
}
const relevant = seen => seen.filter(m => ['system_message', 'member_removed'].includes(m.type));
for (const remove of [false, true]) {
 const action = remove ? 'remove' : 'add';
 test(`${action}: ordinary first commit broadcasts exactly once after write ACK and returns matching current projection`, async () => {
  const f = await fixture(remove), realWrite = f.db.write;
  let begin, release; const started = new Promise(resolve => { begin = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let writeCount = 0, settled = false;
  f.db.write = async function(options) { writeCount++; begin(); await gate; return realWrite.call(this, options); };
  const pending = f.send().then(value => { settled = true; return value; });
  let response;
  try { await started; await pause(40); assert.equal(settled, false); assert.deepEqual(relevant(f.seen), []); release(); response = await pending; }
  finally { release(); f.db.write = realWrite; }
  assert.equal(response.status, 200, JSON.stringify(response.body)); await pause(60); await f.db.read({ force: true }); validateMessageOrder(f.db.data, f.userId);
  const events = relevant(f.seen); assert.equal(writeCount, 1); assert.equal(events.filter(m => m.type === 'system_message').length, 1); assert.equal(events.filter(m => m.type === 'member_removed').length, remove ? 1 : 0);
  const system = events.find(m => m.type === 'system_message'); assert.equal(system.id, response.body.systemMessage.id); assert.deepEqual(system.server_order, response.body.systemMessage.server_order); assert.equal(system.server_order.sequence, '1'); assert.equal(system.durable, true); assert.equal(system.persistence_status, 'confirmed');
  assert.equal(response.body.group.ai_members.includes('fixture_c'), !remove); assert.deepEqual(response.body.group.ai_members, f.db.data.groups[0].ai_members); assert.equal(f.db.data.messages.length, 1); f.ws.terminate();
 });

 for (const mode of ['precommit-unknown', 'committed-unreadable-unknown']) test(`${action}: ${mode} broadcasts nothing and never rewrites`, async () => {
  const f = await fixture(remove), realWrite = f.db.write, realRead = f.db.read; let writeCount = 0, unreadable = false;
  f.db.write = async function(options) { writeCount++; if (mode === 'committed-unreadable-unknown') { await realWrite.call(this, options); unreadable = true; } throw new Error('Synthetic unknown acknowledgement'); };
  f.db.read = async function(options) { if (unreadable) throw new Error('Synthetic unreadable confirmation'); return realRead.call(this, options); };
  let response; try { response = await f.send(); } finally { f.db.write = realWrite; f.db.read = realRead; }
  assert.equal(response.status, 503, JSON.stringify(response.body)); assert.equal(response.body.code, 'MESSAGE_COMMIT_UNKNOWN'); await pause(60); assert.deepEqual(relevant(f.seen), []); assert.equal(writeCount, 1);
  await f.db.read({ force: true }); validateMessageOrder(f.db.data, f.userId); const committed = mode === 'committed-unreadable-unknown'; assert.equal(f.db.data.messages.length, committed ? 1 : 0); assert.equal(f.db.data.groups[0].ai_members.includes('fixture_c'), committed ? !remove : remove); f.ws.terminate();
 });

 test(`${action}: recovered original commit returns its receipt without repeating creation broadcasts`, async () => {
  const f = await fixture(remove), realWrite = f.db.write; let writeCount = 0;
  f.db.write = async function(options) { writeCount++; await realWrite.call(this, options); throw new Error('Synthetic ACK loss after durable member change'); };
  let response; try { response = await f.send(); } finally { f.db.write = realWrite; }
  assert.equal(response.status, 200, JSON.stringify(response.body)); await pause(60); assert.deepEqual(relevant(f.seen), []); assert.equal(writeCount, 1);
  await f.db.read({ force: true }); validateMessageOrder(f.db.data, f.userId); assert.equal(f.db.data.messages.length, 1); assert.equal(response.body.systemMessage.id, f.db.data.messages[0].id); assert.deepEqual(response.body.group.ai_members, f.db.data.groups[0].ai_members); assert.equal(response.body.group.ai_members.includes('fixture_c'), !remove); f.ws.terminate();
 });

 test(`${action}: lost ACK followed by opposite committed change must not broadcast a stale recovered state action`, async t => {
  const f = await fixture(remove), realWrite = f.db.write; let writeCount = 0, opposite;
  f.db.write = async function(options) {
   writeCount++; await realWrite.call(this, options);
   if (writeCount === 1) {
    // Enqueue before failed scope releases mutex, so the real opposite commit
    // wins before reconciliation. This is not a forced business-data rewrite.
    opposite = commitGroupMemberChange({ userId: f.userId, db: f.db, groupId: f.groupId, aiId: 'fixture_c', name: 'fixture_c', remove: !remove });
    throw new Error('Synthetic ACK lost after first change is durable');
   }
  };
  let response; try { response = await f.send(); await opposite; } finally { f.db.write = realWrite; }
  assert.equal(response.status, 200, JSON.stringify(response.body)); await pause(60); await f.db.read({ force: true }); validateMessageOrder(f.db.data, f.userId);
  assert.equal(writeCount, 2); assert.equal(f.db.data.messages.length, 2); assert.equal(f.db.data.groups[0].ai_members.includes('fixture_c'), remove); assert.deepEqual(response.body.group.ai_members, f.db.data.groups[0].ai_members);
  assert.deepEqual(f.db.data.messages.map(m => m.metadata.type), remove ? ['member_removed', 'member_joined'] : ['member_joined', 'member_removed']); assert.equal(response.body.systemMessage.id, f.db.data.messages[0].id); assert.equal(response.body.systemMessage.server_order.sequence, '1');
  t.diagnostic(JSON.stringify({ action, http: response.status, writes: writeCount, currentMembers: response.body.group.ai_members, returnedOriginalType: response.body.systemMessage.metadata.type, received: relevant(f.seen).map(m => ({ type: m.type, aiId: m.aiId, sequence: m.server_order?.sequence })) }));
  assert.deepEqual(relevant(f.seen), [], 'recovered old member change must not apply a fresh state side effect after its opposite committed'); f.ws.terminate();
 });
}
