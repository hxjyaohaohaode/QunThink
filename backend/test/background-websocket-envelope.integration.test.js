// Actual authenticated HTTP/WS sessions and product broadcast helpers, using
// only synthetic accounts and local sockets; no auth/session gate substitutions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session'; process.env.TRUST_PROXY = '1';
process.env.CORS_ORIGINS = 'http://localhost:3210';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-background-ws-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
for (const name of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_)/.test(name)) delete process.env[name];
const dbModule = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
const wsModule = await import('../src/websocket/index.js');
const { commitBackgroundMessage } = await import('../src/services/backgroundMessageCommit.js');
const { runAsUser } = await import('../src/services/userScope.js');
const { WebSocketServer, WebSocket } = await import('ws');
const supertest = (await import('supertest')).default;
await dbModule.initializeEmptyInstallation(); await dbModule.initDatabase(); await initAuthDb();
const app = createTestApp(), request = supertest(app), server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' }); wsModule.setupWebSocket(wss);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sockets = new Set(); let ip = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function next(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing WS ${type}`)); }, 2000);
    const cleanup = () => { clearTimeout(timer); ws.off('message', receive); };
    const receive = data => { const value = JSON.parse(data); if (value.type === type) { cleanup(); resolve(value); } };
    ws.on('message', receive);
  });
}
async function account() {
  const response = await request.post('/api/auth/register').send({ username: `bgws_${randomUUID().slice(0, 8)}`, password: 'SyntheticPassword2026!' });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const userId = response.body.user.id, db = await dbModule.getUserDb(userId), groupId = db.data.groups[0].id;
  const cookie = response.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { headers: { Cookie: cookie,
    Origin: 'http://localhost:3210', 'x-forwarded-for': `127.9.0.${++ip}` } });
  sockets.add(ws); await next(ws, 'connected');
  const joined = next(ws, 'joined_group'); ws.send(JSON.stringify({ type: 'join_group', group_id: groupId })); await joined;
  return { userId, db, groupId, ws };
}
const a = await account(), b = await account(); assert.equal(a.groupId, b.groupId);
const alien = []; b.ws.on('message', data => alien.push(JSON.parse(data)));
test.after(async () => { for (const ws of sockets) ws.terminate(); await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => server.close(resolve)); await fs.rm(process.env.DATA_DIR, { recursive: true, force: true }); });
const methods = [
  { name: 'stream end', type: 'message_stream_end', call: (row, confirmed) => wsModule.broadcastStreamEnd(a.groupId, row.sender_id, row.id, row.content, null, null, confirmed) },
  { name: 'legacy AI helper', type: 'new_message', call: (row, confirmed) => wsModule.broadcastAIMessage(a.groupId, row.sender_id, row.content, null, row.id, null, confirmed) },
  { name: 'legacy system helper', type: 'system_message', call: (row, confirmed) => wsModule.broadcastSystemMessage(a.groupId, row.content, confirmed) }
];
for (const method of methods) {
  test(`${method.name}: actual WS confirmed envelope preserves original row and account isolation`, async () => {
    const row = { id: randomUUID(), group_id: a.groupId, sender_type: method.type === 'system_message' ? 'system' : 'ai',
      sender_id: 'synthetic-ai', content: '原始持久内容', content_type: 'text', metadata: { original: true }, created_at: '2026-01-01T00:00:00.000Z' };
    const commit = await runAsUser(a.userId, () => commitBackgroundMessage({ userId: a.userId, db: a.db, message: row }));
    const received = next(a.ws, method.type); runAsUser(a.userId, () => method.call(row, commit.result));
    const event = await received; assert.equal(event.id, row.id); assert.equal(event.group_id, row.group_id);
    assert.equal(event.created_at, row.created_at); assert.equal(event.content, row.content);
    assert.deepEqual(event.metadata, row.metadata); assert.deepEqual(event.server_order, commit.result.server_order);
    assert.equal(event.durable, true); assert.equal(event.persistence_status, 'confirmed');
    await wait(15); assert.equal(alien.some(message => message.id === row.id || message.message_id === row.id), false);
    const stored = JSON.parse(await fs.readFile(path.join(process.env.DATA_DIR, 'users', `db_${a.userId}.json`), 'utf8')).messages.find(message => message.id === row.id);
    assert.deepEqual(stored, row);
  });
  test(`${method.name}: actual WS unconfirmed cleanup carries no creation time or server sequence`, async () => {
    const row = { id: randomUUID(), sender_id: 'synthetic-ai', content: '未保存的清理提示' };
    const received = next(a.ws, method.type); runAsUser(a.userId, () => method.call(row, null));
    const event = await received; assert.equal(event.durable, false); assert.equal(event.persistence_status, 'not_saved');
    assert.equal(Object.hasOwn(event, 'created_at'), false); assert.equal(Object.hasOwn(event, 'server_order'), false);
    assert.ok(event.timestamp);
  });
}
for (const invalid of [
  { group_id: 'another-group' }, { created_at: 'not-a-date' },
  { server_order: { generation: 'invalid', sequence: '1' } },
  { server_order: { generation: '11111111-1111-4111-8111-111111111111', sequence: '0' } },
  { server_order: { generation: '11111111-1111-4111-8111-111111111111', sequence: 1 } },
  { server_order: { generation: '11111111-1111-4111-8111-111111111111', sequence: '01' } },
  { server_order: { generation: '11111111-1111-4111-8111-111111111111', sequence: '9223372036854775808' } }
]) test(`all durable helpers reject malformed confirmed metadata ${JSON.stringify(invalid)}`, () => {
  const row = { id: randomUUID(), group_id: a.groupId, sender_id: 'synthetic-ai', content: 'synthetic', created_at: '2026-01-01T00:00:00.000Z',
    server_order: { generation: '11111111-1111-4111-8111-111111111111', sequence: '1' } };
  for (const method of methods) assert.throws(() => runAsUser(a.userId, () => method.call(row, { ...row, ...invalid })), TypeError);
});
test('stream end and AI helper reject mismatched persisted ID and sender without broadcasting', () => {
  const row = { id: randomUUID(), group_id: a.groupId, sender_id: 'synthetic-ai', content: 'synthetic', created_at: '2026-01-01T00:00:00.000Z',
    server_order: { generation: '11111111-1111-4111-8111-111111111111', sequence: '1' } };
  for (const method of methods.slice(0, 2)) for (const changed of [{ id: randomUUID() }, { sender_id: 'another-ai' }]) {
    assert.throws(() => runAsUser(a.userId, () => method.call(row, { ...row, ...changed })), TypeError);
  }
});
