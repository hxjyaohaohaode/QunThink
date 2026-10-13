import test from 'node:test';
import assert from 'node:assert/strict';
const same = (actual, expected) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), 'Runtime legacy values match; sample diagnostics are suppressed');
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createPublic533LegacySample } from './fixtures/generate-public-533-legacy.mjs';

// Unchanged public533 task services generate fresh fictional runtime data.
// Compatibility covers the old protocol and within-run bytes, not a fixed key.
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-planning-legacy-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
const sample = await createPublic533LegacySample();
process.env.ENCRYPTION_KEY = sample.encryptionKey;
for (const name of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(name)) delete process.env[name];
const fixture = sample.tasks;
test.after(() => fs.rm(process.env.DATA_DIR, { recursive: true, force: true }));
const { initializeEmptyInstallation, initDatabase, createNewUserDatabase, getUserDb, clearUserDbCache, withWriteLock } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { createTask, listTasks, updateTaskMetadata, getTaskMetadataCommand, deleteTask } = await import('../src/services/tasks.js');
await initializeEmptyInstallation(); await initDatabase(); await initAuthDb();
const owner = fixture.userId;
let db = await createNewUserDatabase(owner); await provisionNewLocalMemoryAccount(owner, db);
async function seed() {
  db = await getUserDb(owner);
  await withWriteLock(owner, async () => { await db.read({ force: true }); Object.assign(db.data, structuredClone(fixture.authority)); await db.write(); });
  return fixture.authority.tasks[0];
}
function authority(data) { return { tasks: data.tasks, taskCreateRequests: data.taskCreateRequests, taskMetadataCommands: data.taskMetadataCommands }; }
const sha = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

test('runtime fixture is bound to unchanged public-533 sources and its generated hashes', () => {
  assert.equal(fixture.provenance.public_commit, '533d7be3cdd47691602574ccac7c6524e7ed7ab3');
  assert.equal(fixture.provenance.tree, '9392ba1ec25863eaed1e00ece649479981d7e87a');
  assert.equal(fixture.provenance.synthetic_only, true);
  assert.equal(sha(fixture.authority), fixture.provenance.authority_json_sha256);
  assert.equal(Object.hasOwn(fixture.authority.tasks[0], 'priority'), false);
  assert.equal(Object.hasOwn(fixture.authority.tasks[0], 'estimated_minutes'), false);
});

test('actual old task ciphertext and authority bytes survive candidate reads and both old command replays', async () => {
  const task = await seed(), before = JSON.stringify(authority(db.data)), orderBefore = JSON.stringify(db.data.message_order);
  const read = (await listTasks(owner))[0];
  assert.ok(read.prompt === fixture.createInput.prompt, 'legacy prompt survives current read'); assert.equal(read.priority, null); assert.equal(read.estimated_minutes, null);
  const created = await createTask(owner, fixture.createInput); assert.equal(created.id, task.id);
  const replay = await updateTaskMetadata(owner, task.id, fixture.metadataInput);
  same(replay.receipt, fixture.responseReceipt); assert.equal(replay.task.metadata_revision, 1);
  await db.read({ force: true }); assert.ok(JSON.stringify(authority(db.data)) === before, 'replays preserve complete authority bytes');
  assert.equal(JSON.stringify(db.data.message_order), orderBefore, 'old receipt replay must not alter message order');
});

test('actual old command identities still replay after new planning edit and a reopened database', async () => {
  const task = await seed();
  const changed = await updateTaskMetadata(owner, task.id, { client_request_id: randomUUID(), expected_revision: 1, changes: { priority: 'high', estimated_minutes: 0 } });
  assert.equal(changed.task.metadata_revision, 2); clearUserDbCache(owner);
  const recreated = await createTask(owner, fixture.createInput); assert.equal(recreated.id, task.id); assert.equal(recreated.priority, 'high'); assert.equal(recreated.estimated_minutes, 0);
  const replay = await updateTaskMetadata(owner, task.id, fixture.metadataInput);
  same(replay.receipt, fixture.responseReceipt); assert.equal(replay.task.metadata_revision, 2); assert.equal(replay.task.priority, 'high');
  db = await getUserDb(owner); await db.read({ force: true });
  assert.ok(db.data.tasks[0].prompt === fixture.authority.tasks[0].prompt, 'old ciphertext must not be re-encrypted');
  same(db.data.taskCreateRequests, fixture.authority.taskCreateRequests);
  same(db.data.taskMetadataCommands[0], fixture.authority.taskMetadataCommands[0]);
});

test('same old UUID with explicit new defaults is a different intent and cannot silently upgrade an old receipt', async () => {
  const task = await seed();
  await assert.rejects(createTask(owner, { ...fixture.createInput, priority: null }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(createTask(owner, { ...fixture.createInput, estimated_minutes: null }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(updateTaskMetadata(owner, task.id, { ...fixture.metadataInput, changes: { ...fixture.metadataInput.changes, priority: null } }), error => error.code === 'TASK_METADATA_IDEMPOTENCY_CONFLICT');
  await db.read({ force: true }); assert.equal(sha(authority(db.data)), fixture.provenance.authority_json_sha256);
});

test('actual old receipts survive deletion without recreation in the candidate', async () => {
  const task = await seed(); await deleteTask(owner, task.id); clearUserDbCache(owner);
  await assert.rejects(createTask(owner, fixture.createInput), error => error.code === 'TASK_DELETED');
  const found = await getTaskMetadataCommand(owner, task.id, fixture.metadataInput.client_request_id);
  same(found.receipt, fixture.responseReceipt); assert.equal(found.task, null); assert.equal(found.task_deleted, true);
  same((await updateTaskMetadata(owner, task.id, fixture.metadataInput)).receipt, fixture.responseReceipt);
  assert.equal((await listTasks(owner)).length, 0);
});
