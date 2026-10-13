// Real JSON files + real independent local deletion registry/journal. No model
// or route mocks; this exercises the wrapper's disposable authorization copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-commit-source-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key)) delete process.env[key];
const { initializeEmptyInstallation, initDatabase, createNewUserDatabase, CustomLow } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { commitAccountSnapshot } = await import('../src/services/accountSnapshotCommit.js');
const { accountSnapshotSourceView } = await import('../src/services/accountSnapshotSources.js');
const { prepareOrderedAppend, validateMessageOrder, projectMessageOrder } = await import('../src/services/messageOrder.js');
const { provisionNewLocalMemoryAccount, readableSourceGroups, readableSourceMessages, markFileDeleted, markMessageDeleted } = await import('../src/services/memory/persistentMemory.js');
await initializeEmptyInstallation(); await initDatabase(); await initAuthDb();
test.after(() => fs.rm(process.env.DATA_DIR, { recursive: true, force: true }));
const sourceError = () => Object.assign(new Error('Source is no longer available'), { code: 'SOURCE_NOT_FOUND', status: 404 });
async function fixture({ provision = true } = {}) {
  const userId = randomUUID(), db = await createNewUserDatabase(userId), groupId = db.data.groups[0].id;
  if (provision) await provisionNewLocalMemoryAccount(userId, db);
  const source = { id: randomUUID(), group_id: groupId, content: 'synthetic source', created_at: '2026-10-13T03:00:00.000Z',
    attachments: [{ id: 'visible-file', description: 'visible' }, { id: 'revoked-file', description: 'private cached text' }] };
  await commitAccountSnapshot({ userId, db, prepared: { source }, compose: ({ snapshot, prepared }) => {
    snapshot.files.push(...['visible-file', 'revoked-file'].map(id => ({ id, group_id: groupId, owner_user_id: userId })));
    const { data } = prepareOrderedAppend(snapshot, userId, prepared.source, { creationIntentHash: 'a'.repeat(64) });
    return { snapshot: data, result: source.id };
  } });
  const prepared = { message: { id: randomUUID(), group_id: groupId, content: 'synthetic prepared reply', created_at: '2026-10-13T03:01:00.000Z' }, hash: 'b'.repeat(64), sourceId: source.id };
  const authorize = async ({ snapshot }) => {
    const view = accountSnapshotSourceView(db, snapshot);
    assert.ok(view instanceof CustomLow, 'source view must retain the real adapter identity');
    const groups = await readableSourceGroups(userId, view, snapshot.groups);
    const messages = await readableSourceMessages(userId, view, snapshot.messages);
    const readable = messages.find(row => row.id === source.id);
    if (!groups.some(group => group.id === groupId) || !readable) throw sourceError();
    return { readable };
  };
  const compose = ({ snapshot, prepared }) => {
    const { data } = prepareOrderedAppend(snapshot, userId, prepared.message, { creationIntentHash: prepared.hash });
    return { snapshot: data, result: projectMessageOrder(data.messages.at(-1), validateMessageOrder(data, userId)) };
  };
  const confirm = ({ snapshot, prepared }) => {
    const index = validateMessageOrder(snapshot, userId), binding = index.bindings.get(prepared.message.id);
    if (!binding || binding.creationIntentHash !== prepared.hash) return null;
    const message = snapshot.messages.find(row => row.id === prepared.message.id);
    return message ? { confirmed: true, result: projectMessageOrder(message, index) } : null;
  };
  const run = extra => commitAccountSnapshot({ userId, db, prepared, authorize, compose, confirm, ...extra });
  const raw = () => fs.readFile(path.join(process.env.DATA_DIR, 'users', `db_${userId}.json`), 'utf8');
  return { userId, db, groupId, source, prepared, run, compose, raw };
}

test('real local file tombstone filters only authorization view and does not mutate baseline or persisted source attachments', async () => {
  const f = await fixture(); await markFileDeleted(f.userId, f.db, f.groupId, 'revoked-file');
  const result = await f.run({ compose: args => {
    assert.deepEqual(args.authorization.readable.attachments.map(row => row.id), ['visible-file']);
    assert.deepEqual(args.snapshot.messages[0].attachments.map(row => row.id), ['visible-file', 'revoked-file']);
    assert.deepEqual(f.db.data.messages[0].attachments.map(row => row.id), ['visible-file', 'revoked-file']);
    return f.compose(args);
  } });
  assert.equal(result.disposition, 'committed');
  assert.deepEqual(JSON.parse(await f.raw()).messages[0].attachments.map(row => row.id), ['visible-file', 'revoked-file']);
});

test('restored source still present in JSON is denied by its independent deletion tombstone before candidate composition', async () => {
  const f = await fixture(), before = await f.raw(); let composed = false;
  await markMessageDeleted(f.userId, f.db, f.groupId, [f.source.id]);
  await assert.rejects(f.run({ compose: () => { composed = true; } }), error => error.code === 'SOURCE_NOT_FOUND');
  assert.equal(composed, false); assert.equal(await f.raw(), before);
});

test('unprovisioned independent account journal fails closed instead of bypassing source authority through a plain object', async () => {
  const f = await fixture({ provision: false }), before = await f.raw();
  await assert.rejects(f.run(), error => error.code === 'MEMORY_BARRIER_UNAVAILABLE');
  assert.equal(await f.raw(), before);
});

test('lost ACK reconciliation reruns real source journal and suppresses result after source revocation', async () => {
  const f = await fixture(), write = f.db.adapter.write.bind(f.db.adapter); let attempts = 0;
  f.db.adapter.write = async data => {
    attempts++; await write(data);
    await markMessageDeleted(f.userId, f.db, f.groupId, [f.source.id]);
    throw Object.assign(new Error('Synthetic lost ACK after real JSON write and journal revoke'), { code: 'SYNTHETIC_LOST_ACK' });
  };
  try { await assert.rejects(f.run(), error => error.code === 'SOURCE_NOT_FOUND'); }
  finally { f.db.adapter.write = write; }
  assert.equal(attempts, 1); assert.equal(JSON.parse(await f.raw()).messages.length, 2);
  assert.equal(f.db.data.messages.at(-1).id, f.prepared.message.id, 'committed data is never rolled back on denied response');
});


test('production source view preserves adapter identity and rejects hidden database I/O', async () => {
  const f = await fixture(), snapshot = structuredClone(f.db.data);
  const view = accountSnapshotSourceView(f.db, snapshot);
  assert.ok(view instanceof CustomLow); assert.equal(view.data, snapshot);
  for (const method of ['read', 'write', 'create']) assert.throws(() => view[method](), /cannot perform database I\/O/);
  assert.throws(() => { view.data = f.db.data; }, TypeError);
  snapshot.messages[0].content = 'disposable projection';
  assert.equal(f.db.data.messages[0].content, 'synthetic source');
});
