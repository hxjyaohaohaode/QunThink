import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

// This fixture was produced by the real public-533 service code, before
// planning fields existed. Its key has never authenticated any system: it is
// fixed public synthetic encryption material used only for this fixture.
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-planning-legacy-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/task-planning-public-533.json', import.meta.url), 'utf8'));
const { initDatabase, initUserDatabase, getUserDb, clearUserDbCache, withWriteLock } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { createTask, listTasks, updateTaskMetadata, getTaskMetadataCommand, deleteTask } = await import('../src/services/tasks.js');
await initDatabase(); await initAuthDb();
const owner = fixture.userId;
let db = await initUserDatabase(owner); await provisionNewLocalMemoryAccount(owner, db);
async function seed() {
  db = await getUserDb(owner);
  await withWriteLock(owner, async () => { await db.read({ force: true }); Object.assign(db.data, structuredClone(fixture.authority)); await db.write(); });
  return fixture.authority.tasks[0];
}
function authority(data) { return { tasks: data.tasks, taskCreateRequests: data.taskCreateRequests, taskMetadataCommands: data.taskMetadataCommands }; }
const sha = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

test('actual public-533 fixture provenance and hashes remain exact', () => {
  assert.equal(fixture.provenance.public_commit, '533d7be3cdd47691602574ccac7c6524e7ed7ab3');
  assert.equal(fixture.provenance.tree, '9392ba1ec25863eaed1e00ece649479981d7e87a');
  assert.equal(fixture.provenance.synthetic_only, true);
  assert.equal(sha(fixture.authority), fixture.provenance.authority_json_sha256);
  assert.equal(Object.hasOwn(fixture.authority.tasks[0], 'priority'), false);
  assert.equal(Object.hasOwn(fixture.authority.tasks[0], 'estimated_minutes'), false);
});

test('actual old task ciphertext and authority bytes survive candidate reads and both old command replays', async () => {
  const task = await seed(), before = JSON.stringify(authority(db.data));
  const read = (await listTasks(owner))[0];
  assert.equal(read.prompt, fixture.createInput.prompt); assert.equal(read.priority, null); assert.equal(read.estimated_minutes, null);
  const created = await createTask(owner, fixture.createInput); assert.equal(created.id, task.id);
  const replay = await updateTaskMetadata(owner, task.id, fixture.metadataInput);
  assert.deepEqual(replay.receipt, fixture.responseReceipt); assert.equal(replay.task.metadata_revision, 1);
  await db.read({ force: true }); assert.equal(JSON.stringify(authority(db.data)), before);
});

test('actual old command identities still replay after new planning edit and a reopened database', async () => {
  const task = await seed();
  const changed = await updateTaskMetadata(owner, task.id, { client_request_id: randomUUID(), expected_revision: 1, changes: { priority: 'high', estimated_minutes: 0 } });
  assert.equal(changed.task.metadata_revision, 2); clearUserDbCache(owner);
  const recreated = await createTask(owner, fixture.createInput); assert.equal(recreated.id, task.id); assert.equal(recreated.priority, 'high'); assert.equal(recreated.estimated_minutes, 0);
  const replay = await updateTaskMetadata(owner, task.id, fixture.metadataInput);
  assert.deepEqual(replay.receipt, fixture.responseReceipt); assert.equal(replay.task.metadata_revision, 2); assert.equal(replay.task.priority, 'high');
  db = await getUserDb(owner); await db.read({ force: true });
  assert.equal(db.data.tasks[0].prompt, fixture.authority.tasks[0].prompt, 'old ciphertext must not be re-encrypted');
  assert.deepEqual(db.data.taskCreateRequests, fixture.authority.taskCreateRequests);
  assert.deepEqual(db.data.taskMetadataCommands[0], fixture.authority.taskMetadataCommands[0]);
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
  assert.deepEqual(found.receipt, fixture.responseReceipt); assert.equal(found.task, null); assert.equal(found.task_deleted, true);
  assert.deepEqual((await updateTaskMetadata(owner, task.id, fixture.metadataInput)).receipt, fixture.responseReceipt);
  assert.equal((await listTasks(owner)).length, 0);
});
