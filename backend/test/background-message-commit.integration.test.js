// Real product domain adapter + account wrapper + required JSON adapter + local
// independent deletion journal. Every account/key/message here is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-background-commit-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
for (const name of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_)/.test(name)) delete process.env[name];
const dbModule = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const memory = await import('../src/services/memory/persistentMemory.js');
const { commitBackgroundMessage } = await import('../src/services/backgroundMessageCommit.js');
const order = await import('../src/services/messageOrder.js');
const { runAsUser } = await import('../src/services/userScope.js');
await dbModule.initializeEmptyInstallation(); await dbModule.initDatabase(); await initAuthDb();
test.after(() => fs.rm(process.env.DATA_DIR, { recursive: true, force: true }));
const fault = code => Object.assign(new Error(code), { code });
async function fixture() {
  const userId = randomUUID(), db = await dbModule.createNewUserDatabase(userId);
  await memory.provisionNewLocalMemoryAccount(userId, db);
  const groupId = db.data.groups[0].id;
  const message = { id: randomUUID(), group_id: groupId, sender_type: 'ai', sender_id: 'synthetic-ai',
    content: '已准备的固定回复', content_type: 'text', created_at: '2026-10-13T03:00:00.000Z' };
  const file = path.join(process.env.DATA_DIR, 'users', `db_${userId}.json`);
  const durable = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const run = options => runAsUser(userId, () => commitBackgroundMessage({ userId, db, message, ...options }));
  return { userId, db, groupId, message, file, durable, run };
}
test('confirmed background result preserves stored identity/time, allocates sidecar and atomically updates encrypted preview', async () => {
  const f = await fixture(), before = await f.durable(), result = await f.run(), saved = await f.durable();
  assert.equal(result.disposition, 'committed');
  assert.deepEqual(saved.messages, [f.message]);
  assert.equal(Object.hasOwn(saved.messages[0], 'server_order'), false);
  assert.deepEqual(result.result, { ...f.message, server_order: { generation: before.message_order.groups[0].generation, sequence: '1' } });
  const group = saved.groups.find(row => row.id === f.groupId);
  assert.equal(group.last_message_at, f.message.created_at); assert.ok(group.last_message_preview);
  assert.match(saved.message_order.groups[0].bindings[0].creation_intent_hash, /^[a-f0-9]{64}$/);
});
test('explicit CAS rebuild preserves UUID/time/body/hash and randomized preview byte-for-byte', async () => {
  const f = await fixture(), write = f.db.write.bind(f.db), attempts = [];
  f.db.write = async options => { attempts.push(structuredClone(options.snapshot)); if (attempts.length < 3) throw fault('REVISION_CONFLICT'); return write(options); };
  const result = await f.run(); assert.equal(result.disposition, 'committed'); assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[0], attempts[1]); assert.deepEqual(attempts[1], attempts[2]);
});
for (const mode of ['cancelled', 'wrong owner', 'group revoked', 'source revoked', 'source is AI']) test(`background final authorization rejects ${mode} without write`, async () => {
  const f = await fixture(); let sourceMessageId = null;
  if (mode.startsWith('source')) {
    const source = { ...f.message, id: randomUUID(), sender_type: mode === 'source is AI' ? 'ai' : 'user' };
    const { data } = order.prepareOrderedAppend(f.db.data, f.userId, source, { creationIntentHash: 'a'.repeat(64) });
    await f.db.write({ snapshot: data }); sourceMessageId = source.id;
    if (mode === 'source revoked') await memory.markMessageDeleted(f.userId, f.db, f.groupId, [source.id]);
  }
  if (mode === 'group revoked') await memory.markGroupDeleted(f.userId, f.db, f.groupId);
  const before = await fs.readFile(f.file), options = { context: { cancel: mode === 'cancelled' }, sourceMessageId };
  const result = mode === 'wrong owner'
    ? await runAsUser('another-account', () => commitBackgroundMessage({ userId: f.userId, db: f.db, message: f.message }))
    : await f.run(options);
  assert.equal(result, null); assert.deepEqual(await fs.readFile(f.file), before);
});
test('reaction accepts a current AI source but rejects its independent revocation on a restored raw snapshot', async () => {
  const f = await fixture(), source = { ...f.message, id: randomUUID() };
  const { data } = order.prepareOrderedAppend(f.db.data, f.userId, source, { creationIntentHash: 'a'.repeat(64) });
  await f.db.write({ snapshot: data });
  const result = await f.run({ sourceMessageId: source.id, sourceSenderType: null }); assert.ok(result);
  await memory.markMessageDeleted(f.userId, f.db, f.groupId, [source.id]);
  f.message.id = randomUUID(); assert.equal(await f.run({ sourceMessageId: source.id, sourceSenderType: null }), null);
});
for (const phase of ['before', 'after']) test(`background ${phase}-write unknown never replays and only durable original recovers`, async () => {
  const f = await fixture(), write = f.db.write.bind(f.db); let writes = 0;
  f.db.write = async options => { writes++; if (phase === 'after') await write(options); throw fault('SYNTHETIC_LOST_ACK'); };
  if (phase === 'after') {
    const result = await f.run(); assert.equal(result.disposition, 'recovered'); assert.equal(result.result.id, f.message.id);
  } else await assert.rejects(f.run(), { code: 'MESSAGE_COMMIT_UNKNOWN' });
  assert.equal(writes, 1); assert.equal((await f.durable()).messages.length, phase === 'after' ? 1 : 0);
});
test('cancel during write never broadcasts a candidate and retains possible stored same ID for reread', async () => {
  const f = await fixture(), context = { cancel: false }, write = f.db.write.bind(f.db);
  f.db.write = async options => { await write(options); context.cancel = true; };
  assert.equal(await f.run({ context }), null); assert.equal(context.resultUnknown, true);
  assert.equal((await f.durable()).messages[0].id, f.message.id);
});
test('ACK loss then journal revocation of saved output cannot expose the restored live row', async () => {
  const f = await fixture(), write = f.db.write.bind(f.db);
  f.db.write = async options => { await write(options); await memory.markMessageDeleted(f.userId, f.db, f.groupId, [f.message.id]); throw fault('SYNTHETIC_LOST_ACK'); };
  await assert.rejects(f.run(), { code: 'MESSAGE_DELETED' });
});
